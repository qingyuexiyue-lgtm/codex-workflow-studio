import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { Engine } = require("../desktop/engine.cjs");
const { Store } = require("../desktop/store.cjs");
const settle = () => new Promise((resolve) => setImmediate(resolve));
const output = (content, status = "completed") => ({
  status,
  route: "done",
  content,
  summary: content,
  evidence: "acceptance fixture",
  unverified: "",
  question: status === "question" ? "Choose a direction" : "",
  artifacts: [],
});

class ControlledCodex extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
    this.live = new Map();
    this.sequence = 0;
    this.failThreads = new Set();
    this.deferStarts = new Set();
    this.startAcknowledgements = new Map();
  }
  async request(method, params) {
    this.calls.push({ method, params: structuredClone(params) });
    if (method === "thread/resume") {
      if (this.failThreads.has(params.threadId))
        throw new Error("already has an active writer");
      return { thread: { id: params.threadId } };
    }
    if (method === "thread/start")
      return { thread: { id: `created-${params.model}` } };
    if (method === "turn/start") {
      assert.ok(
        ![...this.live.values()].some(
          (turn) => turn.threadId === params.threadId,
        ),
        "two active turns were sent to one thread",
      );
      const turn = {
        id: `turn-${++this.sequence}`,
        threadId: params.threadId,
        model: params.model,
      };
      this.live.set(params.model, turn);
      if (this.deferStarts.has(params.model)) {
        return new Promise((resolve) =>
          this.startAcknowledgements.set(params.model, () =>
            resolve({ turn: { id: turn.id } }),
          ),
        );
      }
      return { turn: { id: turn.id } };
    }
    if (method === "turn/interrupt") {
      const turn = [...this.live.values()].find(
        (turn) =>
          turn.id === params.turnId && turn.threadId === params.threadId,
      );
      assert.ok(turn, "interrupt targeted a turn not owned by this run");
      setImmediate(() => {
        this.live.delete(turn.model);
        this.emit("notification", {
          method: "turn/completed",
          params: {
            threadId: turn.threadId,
            turn: { id: turn.id, status: "interrupted", error: null },
          },
        });
      });
      return {};
    }
    throw new Error(`Unexpected protocol method: ${method}`);
  }
  complete(model, result) {
    const turn = this.live.get(model);
    assert.ok(turn, `${model} was not dispatched`);
    this.live.delete(model);
    this.emit("notification", {
      method: "item/completed",
      params: {
        threadId: turn.threadId,
        turnId: turn.id,
        item: {
          id: `item-${turn.id}`,
          type: "agentMessage",
          phase: "final_answer",
          text: JSON.stringify(result),
        },
      },
    });
    this.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: turn.threadId,
        turn: { id: turn.id, status: "completed", error: null },
      },
    });
  }
}

function fixture(names, links, shared = false) {
  const directory = mkdtempSync(
    join(tmpdir(), "studio-independent-acceptance-"),
  );
  const store = new Store(directory);
  const client = new ControlledCodex();
  const workflow = {
    id: "acceptance-workflow",
    name: "independent acceptance",
    maxReworks: 2,
    globalPrompt: "authority",
    sandbox: "read-only",
    roles: names.map((name) => ({
      id: name,
      name,
      model: name,
      prompt: `role ${name}`,
      cwd: directory,
      sessionMode: "existing",
      threadId: shared ? "shared-thread" : `thread-${name}`,
      effort: "low",
      projectId: "",
    })),
    nodes: names.map((name) => ({
      id: name,
      data: {
        label: name,
        roleId: name,
        task: `task ${name}`,
        outputPrompt: "complete",
        allowQuestions: true,
        defaultRule: "blocked",
        inputIds: [],
        terminalRoutes: ["done"],
      },
    })),
    edges: links.map(([source, target], index) => ({
      id: `edge-${index}`,
      source,
      target,
      data: { kind: "next", route: "*" },
    })),
  };
  const engine = new Engine(client, store);
  return { client, engine, store, workflow };
}

test(
  "independent acceptance: a question blocks only its branch and rerun preserves the other branch",
  { timeout: 4000 },
  async () => {
    const { client, engine, store, workflow } = fixture(
      ["A", "B", "A2", "B2", "join"],
      [
        ["A", "A2"],
        ["B", "B2"],
        ["A2", "join"],
        ["B2", "join"],
      ],
    );
    try {
      const run = engine.start(workflow, "task", "");
      await settle();
      client.complete("A", output("question-v1", "question"));
      await settle();
      const questionDirectory = run.states.A.artifactDirectory;
      client.complete("B", output("B-v1"));
      await settle();
      assert.ok(
        client.live.has("B2"),
        "unrelated branch stopped after A asked a question",
      );
      assert.ok(!client.live.has("A2") && !client.live.has("join"));
      client.complete("B2", output("B2-v1"));
      await settle();
      assert.notEqual(run.status, "completed");
      await engine.rerun(run.id, "A", workflow, "User selected direction X");
      await settle();
      client.complete("A", output("A-v2"));
      await settle();
      client.complete("A2", output("A2-v2"));
      await settle();
      const joinPacket = client.calls
        .filter(
          (call) =>
            call.method === "turn/start" && call.params.model === "join",
        )
        .at(-1).params.input[0].text;
      assert.ok(joinPacket.includes("A2-v2") && joinPacket.includes("B2-v1"));
      assert.equal(run.states.B.attempt, 1);
      assert.equal(run.states.B2.attempt, 1);
      assert.equal(run.states.A.attempt, 2);
      assert.equal(run.snapshots.length, 2);
      assert.equal(
        readFileSync(join(questionDirectory, "result.md"), "utf8"),
        "question-v1",
      );
      client.complete("join", output("merged"));
      await settle();
      assert.equal(run.status, "completed");
    } finally {
      store.close();
    }
  },
);

test(
  "independent acceptance: writer-lock failure does not stop unrelated downstream or create a replacement conversation",
  { timeout: 4000 },
  async () => {
    const { client, engine, store, workflow } = fixture(
      ["A", "B", "B2"],
      [["B", "B2"]],
    );
    try {
      client.failThreads.add("thread-A");
      const run = engine.start(workflow, "task", "");
      await settle();
      assert.equal(run.states.A.status, "failed");
      client.complete("B", output("B"));
      await settle();
      assert.ok(client.live.has("B2"));
      client.complete("B2", output("B2"));
      await settle();
      assert.notEqual(run.status, "completed");
      assert.equal(
        client.calls.filter((call) => call.method === "thread/start").length,
        0,
      );
      assert.equal(run.states.A.attempt, 1);
    } finally {
      store.close();
    }
  },
);

test(
  "independent acceptance: immediate interrupt targets exactly the owned active turns and never dispatches descendants",
  { timeout: 4000 },
  async () => {
    const { client, engine, store, workflow } = fixture(
      ["A", "B", "next"],
      [
        ["A", "next"],
        ["B", "next"],
      ],
    );
    try {
      const run = engine.start(workflow, "task", "");
      await settle();
      const owned = [...client.live.values()].map((turn) => ({
        threadId: turn.threadId,
        turnId: turn.id,
      }));
      await engine.interrupt(run.id);
      await settle();
      assert.deepEqual(
        client.calls
          .filter((call) => call.method === "turn/interrupt")
          .map((call) => call.params)
          .sort((a, b) => a.threadId.localeCompare(b.threadId)),
        owned.sort((a, b) => a.threadId.localeCompare(b.threadId)),
      );
      assert.equal(run.states.A.status, "interrupted");
      assert.equal(run.states.B.status, "interrupted");
      assert.notEqual(run.status, "completed");
      assert.equal(
        client.calls.filter(
          (call) =>
            call.method === "turn/start" && call.params.model === "next",
        ).length,
        0,
      );
    } finally {
      store.close();
    }
  },
);

test(
  "independent acceptance: global pause does not interrupt and same-thread queued work waits for resume",
  { timeout: 4000 },
  async () => {
    const { client, engine, store, workflow } = fixture(["A", "B"], [], true);
    try {
      const run = engine.start(workflow, "task", "");
      await settle();
      assert.equal(client.live.size, 1);
      engine.pause(run.id);
      client.complete("A", output("A"));
      await settle();
      assert.equal(client.live.size, 0);
      assert.equal(
        client.calls.filter((call) => call.method === "turn/interrupt").length,
        0,
      );
      await engine.resume(run.id);
      await settle();
      assert.ok(client.live.has("B"));
      client.complete("B", output("B"));
      await settle();
      assert.equal(run.status, "completed");
    } finally {
      store.close();
    }
  },
);

test(
  "independent acceptance: late events from a previous turn cannot finish the next role in a shared conversation",
  { timeout: 4000 },
  async () => {
    const { client, engine, store, workflow } = fixture(["A", "B"], [], true);
    try {
      const run = engine.start(workflow, "task", "");
      await settle();
      const oldTurn = client.live.get("A");
      client.complete("A", output("A-original"));
      await settle();
      assert.ok(client.live.has("B"));
      client.emit("notification", {
        method: "item/completed",
        params: {
          threadId: oldTurn.threadId,
          turnId: oldTurn.id,
          item: {
            type: "agentMessage",
            phase: "final_answer",
            text: JSON.stringify(output("A-late")),
          },
        },
      });
      client.emit("notification", {
        method: "turn/completed",
        params: {
          threadId: oldTurn.threadId,
          turn: { id: oldTurn.id, status: "completed" },
        },
      });
      await settle();
      assert.equal(run.states.B.status, "running");
      client.complete("B", output("B-result"));
      await settle();
      assert.equal(run.states.B.output.content, "B-result");
      assert.equal(run.status, "completed");
    } finally {
      store.close();
    }
  },
);

test(
  "independent acceptance: interrupt waits for ownership when turn/start has not returned its id",
  { timeout: 4000 },
  async () => {
    const { client, engine, store, workflow } = fixture(["A"], []);
    try {
      client.deferStarts.add("A");
      const run = engine.start(workflow, "task", "");
      await settle();
      const stopping = engine.interrupt(run.id);
      await settle();
      assert.equal(
        client.calls.filter((call) => call.method === "turn/interrupt").length,
        0,
      );
      client.startAcknowledgements.get("A")();
      await stopping;
      await settle();
      assert.equal(
        client.calls.filter((call) => call.method === "turn/interrupt").length,
        1,
      );
      assert.equal(run.states.A.status, "interrupted");
    } finally {
      store.close();
    }
  },
);

test(
  "independent acceptance: answering a blocked branch does not wait for an unrelated running branch",
  { timeout: 4000 },
  async () => {
    const { client, engine, store, workflow } = fixture(
      ["A", "B", "A2"],
      [["A", "A2"]],
    );
    try {
      const run = engine.start(workflow, "task", "");
      await settle();
      client.complete("A", output("A-question", "question"));
      await settle();
      assert.ok(client.live.has("B"));
      const updated = structuredClone(workflow);
      updated.roles[0].prompt = "updated A role";
      await engine.rerun(run.id, "A", updated, "Answer while B works");
      await settle();
      assert.ok(client.live.has("A") && client.live.has("B"));
      assert.equal(run.states.B.attempt, 1);
      client.complete("A", output("A-new"));
      await settle();
      client.complete("A2", output("A2-new"));
      await settle();
      assert.equal(run.states.B.status, "running");
      client.complete("B", output("B-original"));
      await settle();
      assert.equal(run.status, "completed");
      assert.equal(run.states.B.attempt, 1);
    } finally {
      store.close();
    }
  },
);

test(
  "independent acceptance: rebinding to a currently running newly-created thread cannot bypass serialization",
  { timeout: 4000 },
  async () => {
    const { client, engine, store, workflow } = fixture(["A", "B"], []);
    try {
      workflow.roles[1].sessionMode = "new";
      workflow.roles[1].threadId = "";
      const run = engine.start(workflow, "task", "");
      await settle();
      client.complete("A", output("question", "question"));
      await settle();
      const rebound = structuredClone(workflow);
      rebound.roles[0].threadId = run.states.B.threadId;
      let rejected = false;
      try {
        await engine.rerun(run.id, "A", rebound, "Share B context");
      } catch (error) {
        rejected = true;
        assert.match(error.message, /会话|thread|活跃|执行/);
      }
      await settle();
      assert.equal(
        client.calls.filter(
          (call) => call.method === "turn/start" && call.params.model === "A",
        ).length,
        1,
        "rebind sent a second turn while the same real thread was busy",
      );
      assert.ok(client.live.has("B"));
      client.complete("B", output("B-done"));
      await settle();
      if (!rejected) {
        assert.ok(client.live.has("A"));
        client.complete("A", output("A-done"));
        await settle();
        assert.equal(run.status, "completed");
      }
      assert.equal(
        client.calls.filter((call) => call.method === "thread/start").length,
        1,
        "only explicitly configured B may create a conversation",
      );
    } finally {
      store.close();
    }
  },
);

test(
  "independent acceptance: one configured rework route must not silently omit its second target",
  { timeout: 4000 },
  async () => {
    const { client, engine, store, workflow } = fixture(
      ["A", "B", "review"],
      [
        ["A", "review"],
        ["B", "review"],
      ],
    );
    try {
      workflow.edges.push(
        {
          id: "back-a",
          source: "review",
          target: "A",
          data: { kind: "rework", route: "revise" },
        },
        {
          id: "back-b",
          source: "review",
          target: "B",
          data: { kind: "rework", route: "revise" },
        },
      );
      const run = engine.start(workflow, "task", "");
      await settle();
      client.complete("A", output("A-v1"));
      client.complete("B", output("B-v1"));
      await settle();
      client.complete("review", {
        ...output("revise both branches"),
        route: "revise",
      });
      await settle();
      assert.ok(
        client.live.has("A") && client.live.has("B"),
        "one of two explicit rework targets was omitted",
      );
      client.complete("A", output("A-v2"));
      client.complete("B", output("B-v2"));
      await settle();
      client.complete("review", output("approved"));
      await settle();
      assert.equal(run.status, "completed");
      assert.equal(run.states.A.attempt, 2);
      assert.equal(run.states.B.attempt, 2);
    } finally {
      store.close();
    }
  },
);
