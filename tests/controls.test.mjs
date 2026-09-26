import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { Engine } = require("../desktop/engine.cjs");
const { Store } = require("../desktop/store.cjs");
const settle = () => new Promise((resolve) => setImmediate(resolve));
const output = (content, route = "done", status = "completed") => ({
  status,
  route,
  content,
  summary: content,
  evidence: "test",
  unverified: "",
  question: status === "question" ? "Choose one" : "",
  artifacts: [],
});

class Client extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
    this.live = new Map();
    this.sequence = 0;
    this.failNextInterrupt = false;
  }
  async request(method, params) {
    this.calls.push({ method, params: structuredClone(params) });
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    if (method === "thread/start")
      return { thread: { id: `created-${params.model}` } };
    if (method === "turn/start") {
      assert.ok(
        ![...this.live.values()].some(
          (turn) => turn.threadId === params.threadId,
        ),
        "a thread received overlapping turns",
      );
      const turn = {
        id: `turn-${++this.sequence}`,
        threadId: params.threadId,
        model: params.model,
      };
      this.live.set(params.model, turn);
      return { turn: { id: turn.id } };
    }
    if (method === "turn/interrupt") {
      if (this.failNextInterrupt) {
        this.failNextInterrupt = false;
        throw new Error("interrupt unavailable");
      }
      const turn = [...this.live.values()].find(
        (turn) =>
          turn.id === params.turnId && turn.threadId === params.threadId,
      );
      assert.ok(turn, "interrupt cannot target another turn");
      setImmediate(() => {
        this.live.delete(turn.model);
        this.emit("notification", {
          method: "turn/completed",
          params: {
            threadId: turn.threadId,
            turn: { id: turn.id, status: "interrupted" },
          },
        });
      });
      return {};
    }
    throw new Error(method);
  }
  message(model, text) {
    const turn = this.live.get(model);
    assert.ok(turn);
    this.emit("notification", {
      method: "item/completed",
      params: {
        threadId: turn.threadId,
        turnId: turn.id,
        item: { type: "agentMessage", text },
      },
    });
  }
  complete(model, result) {
    const turn = this.live.get(model);
    assert.ok(turn, `${model} was not dispatched`);
    this.message(model, JSON.stringify(result));
    this.live.delete(model);
    this.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: turn.threadId,
        turn: { id: turn.id, status: "completed" },
      },
    });
  }
}

function fixture(names, links, maxReworks = 2, shared = []) {
  const directory = mkdtempSync(join(tmpdir(), "studio-control-"));
  const store = new Store(directory);
  const client = new Client();
  const workflow = {
    id: "wf",
    name: "control test",
    maxReworks,
    globalPrompt: "original instructions",
    sandbox: "read-only",
    roles: names.map((name) => ({
      id: name,
      name,
      model: name,
      prompt: `${name} original prompt`,
      cwd: directory,
      sessionMode: "existing",
      threadId: shared.includes(name) ? "shared-thread" : `thread-${name}`,
      effort: "low",
      projectId: "",
    })),
    nodes: names.map((name) => ({
      id: name,
      data: {
        label: name,
        roleId: name,
        task: `${name} original task`,
        outputPrompt: "complete",
        allowQuestions: true,
        defaultRule: "blocked",
        inputIds: [],
        terminalRoutes: ["done"],
      },
    })),
    edges: links.map(([source, target, kind = "next", route = "*"], index) => ({
      id: `edge-${index}`,
      source,
      target,
      data: { kind, route },
    })),
  };
  const engine = new Engine(client, store);
  return { directory, store, client, workflow, engine };
}

test("two rework targets sharing a join remain separately pending when over budget; manual rerun A does not erase B", async () => {
  const { store, client, workflow, engine } = fixture(
    ["A", "B", "RA", "RB", "join"],
    [
      ["A", "RA"],
      ["B", "RB"],
      ["RA", "join"],
      ["RB", "join"],
      ["RA", "A", "rework", "revise"],
      ["RB", "B", "rework", "revise"],
    ],
    0,
  );
  try {
    const run = engine.start(workflow, "task", "");
    await settle();
    client.complete("A", output("A-v1"));
    client.complete("B", output("B-v1"));
    await settle();
    client.complete("RA", output("fix A", "revise"));
    client.complete("RB", output("fix B", "revise"));
    await settle();
    assert.equal(run.status, "needs_attention");
    assert.deepEqual(
      run.reworkRequests.map(({ source, sourceAttempt, target }) => ({
        source,
        sourceAttempt,
        target,
      })),
      [
        { source: "RA", sourceAttempt: 1, target: "A" },
        { source: "RB", sourceAttempt: 1, target: "B" },
      ],
    );
    assert.equal(run.states.join.status, "pending");
    const firstA = run.states.RA.artifactDirectory;
    const firstB = run.states.RB.artifactDirectory;

    engine.rerun(run.id, "A", workflow, "manual A");
    await settle();
    assert.deepEqual(
      run.reworkRequests.map((request) => request.target),
      ["B"],
    );
    const aPacket = client.calls
      .filter(
        (call) => call.method === "turn/start" && call.params.model === "A",
      )
      .at(-1).params.input[0].text;
    assert.match(aPacket, /fix A/);
    assert.match(aPacket, /manual A/);
    assert.doesNotMatch(aPacket, /fix B/);
    client.complete("A", output("A-v2"));
    await settle();
    client.complete("RA", output("RA-v2"));
    await settle();
    assert.equal(run.status, "needs_attention");
    assert.equal(run.states.B.attempt, 1);
    assert.equal(run.states.RB.attempt, 1);
    assert.equal(run.states.join.status, "pending");
    assert.equal(client.live.has("join"), false);
    assert.deepEqual(
      run.reworkRequests.map((request) => request.target),
      ["B"],
    );

    engine.rerun(run.id, "B", workflow, "manual B");
    await settle();
    const bPacket = client.calls
      .filter(
        (call) => call.method === "turn/start" && call.params.model === "B",
      )
      .at(-1).params.input[0].text;
    assert.match(bPacket, /fix B/);
    assert.doesNotMatch(bPacket, /fix A/);
    client.complete("B", output("B-v2"));
    await settle();
    client.complete("RB", output("RB-v2"));
    await settle();
    assert.ok(client.live.has("join"));
    const joinPacket = client.calls
      .filter(
        (call) => call.method === "turn/start" && call.params.model === "join",
      )
      .at(-1).params.input[0].text;
    assert.match(joinPacket, /RA-v2/);
    assert.match(joinPacket, /RB-v2/);
    client.complete("join", output("merged"));
    await settle();
    assert.equal(run.status, "completed");
    assert.equal(run.snapshots.length, 3);
    assert.equal(run.reworks, 0);
    assert.equal(run.states.RA.attempts.length, 2);
    assert.equal(run.states.RB.attempts.length, 2);
    assert.equal(readFileSync(join(firstA, "result.md"), "utf8"), "fix A");
    assert.equal(readFileSync(join(firstB, "result.md"), "utf8"), "fix B");
  } finally {
    store.close();
  }
});

test("two matching rework edges each consume budget and apply feedback to both targets", async () => {
  const { store, client, workflow, engine } = fixture(
    ["A", "B", "R"],
    [
      ["A", "R"],
      ["B", "R"],
      ["R", "A", "rework", "revise"],
      ["R", "B", "rework", "revise"],
    ],
    2,
  );
  try {
    const run = engine.start(workflow, "task", "");
    await settle();
    client.complete("A", output("A-v1"));
    client.complete("B", output("B-v1"));
    await settle();
    client.complete("R", output("fix both", "revise"));
    await settle();
    assert.equal(run.reworks, 2);
    assert.equal(run.reworkRequests.length, 0);
    assert.equal(run.states.A.attempt, 2);
    assert.equal(run.states.B.attempt, 2);
    assert.match(run.states.A.feedback, /fix both/);
    assert.match(run.states.B.feedback, /fix both/);
    client.complete("A", output("A-v2"));
    client.complete("B", output("B-v2"));
    await settle();
    client.complete("R", output("approved"));
    await settle();
    assert.equal(run.status, "completed");
  } finally {
    store.close();
  }
});

test("failed interrupt remains visible and can be retried for the same owned turn without replay", async () => {
  const { store, client, workflow, engine } = fixture(
    ["A", "next"],
    [["A", "next"]],
  );
  try {
    const run = engine.start(workflow, "task", "");
    await settle();
    client.message("A", "partial result before interrupt");
    client.failNextInterrupt = true;
    await assert.rejects(engine.interrupt(run.id), /interrupt unavailable/);
    assert.equal(run.status, "needs_attention");
    assert.equal(run.states.A.status, "running");
    assert.match(run.error, /interrupt unavailable/);
    await engine.interrupt(run.id);
    await settle();
    assert.equal(run.status, "interrupted");
    assert.equal(run.states.A.status, "interrupted");
    assert.equal(run.states.A.attempt, 1);
    assert.equal(run.states.A.attempts[0].status, "interrupted");
    assert.equal(run.states.next.status, "pending");
    assert.equal(
      readFileSync(
        join(run.states.A.artifactDirectory, "response.txt"),
        "utf8",
      ),
      "partial result before interrupt",
    );
    assert.equal(
      client.calls.filter((call) => call.method === "turn/start").length,
      1,
    );
  } finally {
    store.close();
  }
});

test("queued work uses the configuration snapshot captured before an unrelated branch rerun", async () => {
  const { store, client, workflow, engine } = fixture(["A", "B", "C"], [], 0, [
    "A",
    "B",
  ]);
  try {
    const run = engine.start(workflow, "task", "");
    await settle();
    assert.ok(client.live.has("A"));
    assert.ok(client.live.has("C"));
    assert.equal(run.states.B.status, "queued");
    client.complete("C", output("needs answer", "done", "question"));
    await settle();
    const revised = structuredClone(workflow);
    revised.roles.find((role) => role.id === "B").prompt = "B changed prompt";
    revised.nodes.find((node) => node.id === "B").data.task = "B changed task";
    engine.rerun(run.id, "C", revised, "answer");
    await settle();
    client.complete("A", output("A-v1"));
    await settle();
    assert.ok(client.live.has("B"));
    const bPacket = client.calls
      .filter(
        (call) => call.method === "turn/start" && call.params.model === "B",
      )
      .at(-1).params.input[0].text;
    assert.match(bPacket, /B original prompt/);
    assert.match(bPacket, /B original task/);
    assert.doesNotMatch(bPacket, /B changed prompt|B changed task/);
    assert.equal(run.states.B.attempts[0].snapshotIndex, 0);
    client.complete("B", output("B-v1"));
    client.complete("C", output("C-v2"));
    await settle();
    assert.equal(run.status, "completed");
  } finally {
    store.close();
  }
});

test("initial 0.1 persisted runs migrate artifact attempts and pending rework without inventing snapshot mappings", () => {
  const { directory, store, client, workflow } = fixture(
    ["A", "R"],
    [
      ["A", "R"],
      ["R", "A", "rework", "revise"],
    ],
    0,
  );
  const firstDirectory = join(directory, "artifacts", "legacy-run", "A", "1");
  const secondDirectory = join(directory, "artifacts", "legacy-run", "A", "2");
  const reviewDirectory = join(directory, "artifacts", "legacy-run", "R", "1");
  mkdirSync(firstDirectory, { recursive: true });
  mkdirSync(secondDirectory, { recursive: true });
  mkdirSync(reviewDirectory, { recursive: true });
  writeFileSync(
    join(firstDirectory, "handoff.json"),
    JSON.stringify(output("v1", "done", "question")),
  );
  writeFileSync(join(firstDirectory, "response.txt"), "old raw response");
  const latest = output("v2");
  const review = output("please revise", "revise");
  writeFileSync(join(secondDirectory, "handoff.json"), JSON.stringify(latest));
  writeFileSync(join(reviewDirectory, "handoff.json"), JSON.stringify(review));
  store.saveRun({
    id: "legacy-run",
    workflow,
    snapshots: [workflow, structuredClone(workflow)],
    task: "task",
    materials: "",
    createdAt: "2026-09-25T00:00:00.000Z",
    status: "paused",
    feedback: "please revise\nplease revise\n已达到返工上限。",
    reworks: 0,
    reworkTarget: "A",
    sessions: {},
    states: {
      A: {
        status: "completed",
        attempt: 2,
        output: latest,
        error: "",
        threadId: "thread-A",
        turnId: "turn-2",
        artifactDirectory: secondDirectory,
        logs: [],
        usage: null,
      },
      R: {
        status: "completed",
        attempt: 1,
        output: review,
        error: "",
        threadId: "thread-R",
        turnId: "turn-3",
        artifactDirectory: reviewDirectory,
        logs: [],
        usage: null,
      },
    },
  });
  try {
    const engine = new Engine(client, store);
    const run = engine.runs.get("legacy-run");
    assert.deepEqual(
      run.reworkRequests.map((request) => request.target),
      ["A"],
    );
    assert.equal(run.states.A.attempts.length, 2);
    assert.equal(run.states.A.attempts[0].snapshotIndex, null);
    assert.equal(run.states.A.attempts[0].output.content, "v1");
    assert.equal(run.states.A.attempts[0].rawText, "old raw response");
    assert.equal(run.states.A.attempts[1].output.content, "v2");
    assert.equal(run.states.A.attempts[1].artifactDirectory, secondDirectory);
    assert.equal(run.states.R.attempts[0].output.content, "please revise");
    assert.equal(run.states.A.status, "completed");
    assert.equal(existsSync(firstDirectory), true);
    assert.equal(
      store.runs().find((saved) => saved.id === "legacy-run").states.A.attempts
        .length,
      2,
    );
  } finally {
    store.close();
  }
});
