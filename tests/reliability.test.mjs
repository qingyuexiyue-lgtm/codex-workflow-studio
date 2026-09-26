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
const { packet } = require("../desktop/workflow.cjs");

const settle = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "state did not settle");
    await settle();
  }
}
const result = (content = "done") => ({
  status: "completed",
  route: "done",
  content,
  summary: content,
  evidence: "fixture",
  unverified: "",
  question: "",
  artifacts: [],
});
function workflow(directory, mode = "existing") {
  return {
    id: "wf",
    name: "reliability",
    maxReworks: 0,
    globalPrompt: "original authority",
    sandbox: "read-only",
    roles: [{
      id: "A", name: "A", model: "model", effort: "low", prompt: "role",
      cwd: directory, projectId: "", sessionMode: mode,
      threadId: mode === "existing" ? "owned-thread" : "",
    }],
    nodes: [{
      id: "A",
      data: {
        label: "A", roleId: "A", task: "task", outputPrompt: "output",
        inputIds: [], terminalRoutes: ["done"], allowQuestions: false,
        defaultRule: "blocked",
      },
    }],
    edges: [],
  };
}
function fixture(mode = "existing") {
  const directory = mkdtempSync(join(tmpdir(), "studio-reliability-"));
  const store = new Store(directory);
  const client = new EventEmitter();
  client.calls = [];
  client.request = async (method, params) => {
    client.calls.push({ method, params });
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    if (method === "thread/start") return { thread: { id: "new-thread" } };
    if (method === "turn/start") return { turn: { id: "turn-1" } };
    throw new Error(method);
  };
  const engine = new Engine(client, store);
  return { directory, store, client, engine, workflow: workflow(directory, mode) };
}
function complete(client, text = JSON.stringify(result()), turnId = "turn-1") {
  client.emit("notification", {
    method: "item/completed",
    params: {
      threadId: "owned-thread", turnId,
      item: { id: `answer-${turnId}`, type: "agentMessage", phase: "final_answer", text },
    },
  });
  client.emit("notification", {
    method: "turn/completed",
    params: { threadId: "owned-thread", turn: { id: turnId, status: "completed" } },
  });
}

test("ending an unresolved run preserves evidence and frees only unrelated conversations", async () => {
  const { store, client, engine, workflow: graph } = fixture();
  let restored;
  try {
    const run = engine.start(graph, "original", "");
    await until(() => run.states.A.turnId === "turn-1");
    assert.throws(() => engine.abandon(run.id));
    client.emit("disconnected", "lost connection");
    await until(() => engine.active.size === 0 && engine.pendingOperations.size === 0);
    const evidence = structuredClone(run.states);
    engine.abandon(run.id);
    assert.equal(run.status, "abandoned");
    assert.deepEqual(run.states, evidence);
    assert.equal(run.states.A.attempts[0].finishedAt, null);

    engine.client.off("notification", engine.onNotification);
    engine.client.off("disconnected", engine.onDisconnected);
    restored = new Engine(client, store);
    assert.equal(restored.runs.get(run.id).status, "abandoned");
    assert.throws(() => restored.start(graph, "same conversation", ""), /未知结果/);
    assert.throws(() => restored.rerun(run.id, "A", graph, ""), /已结束/);
    assert.throws(() => restored.acceptRecoveryResult(run.id, "A", "checked"), /已结束/);

    const other = structuredClone(graph);
    other.roles[0].threadId = "unrelated-thread";
    const next = restored.start(other, "unrelated task", "");
    await until(() => next.states.A.turnId === "turn-1");
    assert.equal(client.calls.filter(({ method }) => method === "turn/start").length, 2);
    assert.equal(client.calls.at(-1).params.threadId, "unrelated-thread");
    assert.deepEqual(restored.runs.get(run.id).states, evidence);
  } finally {
    client.emit("disconnected", "test cleanup");
    if (restored) await until(() => restored.active.size === 0 && restored.pendingOperations.size === 0);
    store.close();
  }
});

test("disconnect during thread creation has no turn to replay and can be confirmed without a thread id", async () => {
  const { store, client, engine, workflow: graph } = fixture("new");
  client.request = (method, params) => {
    client.calls.push({ method, params });
    if (method === "thread/start") return new Promise(() => {});
    throw new Error(`unexpected ${method}`);
  };
  try {
    const run = engine.start(graph, "original", "");
    await until(() => run.states.A.attempts[0]?.operation === "thread/start");
    client.emit("disconnected", "transport lost");
    await until(() => engine.pendingOperations.size === 0);
    assert.equal(run.states.A.attempts[0].status, "unknown");
    assert.equal(run.states.A.attempts[0].finishedAt, null);
    assert.equal(run.states.A.threadId, "");
    engine.attachClient(client);
    const inspection = await engine.inspectRecovery(run.id, "A");
    assert.equal(inspection.turnStatus, "notStarted");
    assert.equal(client.calls.filter(({ method }) => method === "thread/turns/list").length, 0);
    engine.confirmRecovery(run.id, "A", "No turn was sent; verified local files.");
    assert.equal(run.states.A.recovery.required, false);
  } finally { store.close(); }
});

test("sleep cancels an unacknowledged turn/start locally and adopts only its exact historical result", async () => {
  const { store, client, engine, workflow: graph } = fixture();
  let run;
  client.request = (method, params) => {
    client.calls.push({ method, params });
    if (method === "thread/resume") return Promise.resolve({ thread: { id: params.threadId } });
    if (method === "turn/start") return new Promise(() => {});
    if (method === "thread/turns/list") return Promise.resolve({
      data: [{
        id: "lost-response-turn", status: "completed", items: [
          { type: "userMessage", content: [{ type: "text", text: `<!-- ${run.states.A.attempts[0].marker} -->` }] },
          { type: "agentMessage", phase: "final_answer", text: JSON.stringify(result("from-history")) },
        ],
      }],
      nextCursor: null,
    });
    throw new Error(method);
  };
  try {
    run = engine.start(graph, "original", "");
    await until(() => run.states.A.attempts[0]?.operation === "turn/start");
    engine.markSleep();
    await until(() => engine.active.size === 0 && engine.pendingOperations.size === 0);
    assert.equal(run.states.A.attempts[0].status, "unknown");
    assert.equal(run.states.A.attempts[0].finishedAt, null);
    assert.equal(run.states.A.recovery.reason, "sleep");
    await engine.inspectRecovery(run.id, "A");
    assert.equal(run.states.A.turnId, "lost-response-turn");
    engine.acceptRecoveryResult(run.id, "A", "Verified the exact result and side effects.");
    assert.equal(run.states.A.output.content, "from-history");
    assert.equal(run.status, "paused");
    assert.equal(client.calls.filter(({ method }) => method === "turn/start").length, 1);
  } finally { store.close(); }
});

test("a separate compaction turn between steps is recorded only for its unique paused run", async () => {
  const { store, client, engine, workflow: graph } = fixture();
  try {
    const run = engine.start(graph, "original", "");
    await until(() => run.states.A.turnId === "turn-1");
    engine.pause(run.id);
    complete(client);
    await until(() => run.status === "paused" && Boolean(run.states.A.attempts[0].finishedAt));
    const compacted = {
      method: "item/completed",
      params: {
        threadId: "owned-thread", turnId: "separate-compact-turn",
        item: { id: "compact-item", type: "contextCompaction" },
      },
    };
    client.emit("notification", { ...compacted, params: { ...compacted.params, threadId: "unrelated-thread" } });
    assert.equal(run.memory.compactions.length, 0);
    client.emit("notification", compacted);
    client.emit("notification", compacted);
    assert.equal(run.memory.compactions.length, 1);
    assert.equal(run.memory.compactions[0].turnId, "separate-compact-turn");
    assert.equal(run.memory.compactions[0].afterAttempt, true);
    assert.match(packet(graph, graph.nodes[0], run), /第 1 次执行之后发生上下文压缩/);
    assert.equal(store.runs()[0].memory.compactions.length, 1);
    const other = structuredClone(run);
    other.id = "another-paused-run";
    engine.runs.set(other.id, other);
    client.emit("notification", {
      ...compacted,
      params: { ...compacted.params, turnId: "ambiguous-turn", item: { id: "ambiguous", type: "contextCompaction" } },
    });
    assert.equal(run.memory.compactions.length, 1);
    assert.equal(other.memory.compactions.length, 1);
    engine.runs.delete(other.id);
    engine.resume(run.id);
    await until(() => run.status === "completed");
    client.emit("notification", { ...compacted, params: { ...compacted.params, turnId: "later-compact-turn", item: { id: "later", type: "contextCompaction" } } });
    assert.equal(run.memory.compactions.length, 1, "a completed run is not the owner of later compaction");
  } finally { store.close(); }
});

test("adoption validates against the attempt's snapshot, not later workflow edits", async () => {
  const { store, client, workflow: original } = fixture();
  const edited = structuredClone(original);
  edited.nodes[0].data.terminalRoutes = ["new-route"];
  const attempt = {
    attempt: 1, snapshotIndex: 0, startedAt: "2026-09-26T00:00:00.000Z",
    finishedAt: null, status: "running", artifactDirectory: store.directory,
    threadId: "owned-thread", turnId: "old-turn", operation: "turn/active",
    marker: "EXACT-MARKER", output: null, rawText: "", error: "", usage: null,
  };
  store.saveRun({
    id: "snapshot-run", workflow: edited, snapshots: [original, edited],
    task: "original", materials: "", createdAt: attempt.startedAt,
    status: "running", error: "", feedback: "", reworks: 0,
    reworkRequests: [], sessions: {},
    states: { A: { ...attempt, attempts: [attempt], feedback: "", logs: [] } },
  });
  client.request = async (method) => {
    assert.equal(method, "thread/turns/list");
    return { data: [{ id: "old-turn", status: "completed", items: [
      { type: "agentMessage", phase: "final_answer", text: JSON.stringify(result()) },
    ] }], nextCursor: null };
  };
  try {
    const recovering = new Engine(client, store);
    await recovering.inspectRecovery("snapshot-run", "A");
    recovering.acceptRecoveryResult("snapshot-run", "A", "Checked old route and side effects.");
    assert.equal(recovering.runs.get("snapshot-run").states.A.output.route, "done");
    assert.deepEqual(recovering.runs.get("snapshot-run").workflow.nodes[0].data.terminalRoutes, ["new-route"]);
  } finally { store.close(); }
});

test("only explicit transient pre-turn resume rejection retries, with a hard limit of two", async () => {
  const { store, client, engine, workflow: graph } = fixture();
  let resumes = 0;
  client.request = async (method, params) => {
    client.calls.push({ method, params });
    if (method === "thread/resume") {
      resumes++;
      if (resumes <= 2)
        throw Object.assign(new Error("overloaded"), {
          code: -32000, data: { codexErrorInfo: "serverOverloaded" },
        });
      return { thread: { id: params.threadId } };
    }
    if (method === "turn/start") {
      setImmediate(() => complete(client));
      return { turn: { id: "turn-1" } };
    }
    throw new Error(method);
  };
  try {
    const run = engine.start(graph, "original", "");
    await until(() => run.status === "completed");
    assert.equal(resumes, 3);
    assert.equal(run.states.A.attempts[0].safeRetries, 2);
    assert.equal(client.calls.filter(({ method }) => method === "turn/start").length, 1);
  } finally { store.close(); }
});

test("a third transient resume rejection stops without ever dispatching a turn", async () => {
  const { store, client, engine, workflow: graph } = fixture();
  client.request = async (method, params) => {
    client.calls.push({ method, params });
    if (method !== "thread/resume") throw new Error(`unexpected ${method}`);
    throw Object.assign(new Error("overloaded"), {
      code: -32000, data: { codexErrorInfo: "serverOverloaded" },
    });
  };
  try {
    const run = engine.start(graph, "original", "");
    await until(() => run.status === "needs_attention");
    assert.equal(run.states.A.status, "failed");
    assert.equal(run.states.A.attempts[0].safeRetries, 2);
    assert.equal(client.calls.filter(({ method }) => method === "thread/resume").length, 3);
    assert.equal(client.calls.filter(({ method }) => method === "turn/start").length, 0);
  } finally { store.close(); }
});

test("a failed accepted turn requires side-effect inspection before rerun", async () => {
  const { store, client, engine, workflow: graph } = fixture();
  client.request = async (method, params) => {
    client.calls.push({ method, params });
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    if (method === "turn/start") return { turn: { id: `turn-${client.calls.filter(({ method }) => method === "turn/start").length}` } };
    if (method === "thread/turns/list") return {
      data: [{ id: "turn-1", status: "failed", items: [] }], nextCursor: null,
    };
    throw new Error(method);
  };
  try {
    const run = engine.start(graph, "original", "");
    await until(() => run.states.A.turnId === "turn-1");
    client.emit("notification", {
      method: "turn/completed",
      params: { threadId: "owned-thread", turn: { id: "turn-1", status: "failed", error: { message: "server failure" } } },
    });
    await until(() => run.status === "needs_attention");
    assert.equal(run.states.A.status, "failed");
    assert.equal(run.states.A.recovery.required, true);
    assert.throws(() => engine.rerun(run.id, "A", graph, "retry"), /核对/);
    await engine.inspectRecovery(run.id, "A");
    engine.confirmRecovery(run.id, "A", "Checked the failed turn and side effects.");
    engine.rerun(run.id, "A", graph, "retry");
    await until(() => run.states.A.attempt === 2);
    assert.equal(client.calls.filter(({ method }) => method === "turn/start").length, 2);
    client.emit("disconnected", "test cleanup");
    await until(() => engine.active.size === 0);
  } finally { store.close(); }
});

test("long materials are persisted once and only indexed in each task packet", async () => {
  const { store, client, engine, workflow: graph } = fixture();
  try {
    const materials = "SOURCE-OPEN\n" + "A".repeat(7000) + "\nSOURCE-END";
    const run = engine.start(graph, "original request", materials);
    await until(() => Boolean(run.states.A.turnId));
    assert.equal(readFileSync(run.materialsVersionPath, "utf8"), materials);
    const prompt = client.calls.find(({ method }) => method === "turn/start").params.input[0].text;
    assert.match(prompt, /original request/);
    assert.ok(prompt.includes(run.materialsVersionPath));
    assert.match(prompt, /必须读取版本文件/);
    assert.ok(!prompt.includes("SOURCE-END"));
    client.emit("disconnected", "test cleanup");
    await until(() => engine.active.size === 0);
  } finally { store.close(); }
});
