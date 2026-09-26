import test from "node:test";
import assert from "node:assert/strict";
import { once, EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { CodexClient } = require("../desktop/codex-client.cjs");
const { Engine } = require("../desktop/engine.cjs");
const { Store } = require("../desktop/store.cjs");
const settle = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "acceptance state deadline exceeded");
    await settle();
  }
}

test("independent: delayed turn/start response must remain owned after the deadline", async (t) => {
  const client = new CodexClient(process.execPath, [resolve("scripts/fixtures/delayed-server.cjs")]);
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let outcome = "pending";
    const received = once(client, "notification");
    const started = client.request("turn/start", { threadId: "owned-thread" });
    started.then(() => { outcome = "resolved"; }, () => { outcome = "rejected"; });
    await received;
    t.mock.timers.tick(30001);
    await Promise.resolve();
    assert.notEqual(outcome, "rejected", "timeout discarded a potentially running server operation");
    await client.request("test/release");
    assert.equal((await started).turn.id, "late-owned-turn-1");
    assert.equal(outcome, "resolved");
  } finally {
    t.mock.timers.reset();
    const exited = once(client.process, "exit");
    client.close();
    await exited;
  }
});

function recoveryFixture(turnId = "owned-turn") {
  const directory = mkdtempSync(join(tmpdir(), "studio-recovery-acceptance-"));
  const store = new Store(directory);
  const role = { id: "A", name: "A", model: "model", effort: "low", prompt: "role", cwd: directory, projectId: "", sessionMode: "existing", threadId: "owned-thread" };
  const workflow = { id: "wf", name: "wf", globalPrompt: "original authority", sandbox: "read-only", maxReworks: 0, roles: [role], nodes: [{ id: "A", data: { label: "A", roleId: "A", task: "task", outputPrompt: "output", inputIds: [], terminalRoutes: ["done"], allowQuestions: false, defaultRule: "blocked" } }], edges: [] };
  const attempt = { attempt: 1, snapshotIndex: 0, startedAt: "2026-09-26T00:00:00.000Z", finishedAt: null, status: "running", artifactDirectory: directory, threadId: "owned-thread", turnId, marker: "STUDIO-EXACT-ATTEMPT-7391", output: null, rawText: "partial original", error: "", usage: null };
  store.saveRun({ id: "recover-run", workflow, snapshots: [workflow], task: "original", materials: "materials", createdAt: attempt.startedAt, status: "running", error: "", feedback: "", reworks: 0, reworkRequests: [], sessions: {}, states: { A: { ...attempt, attempts: [attempt], feedback: "", logs: [] } } });
  const client = new EventEmitter();
  client.calls = [];
  client.pages = [];
  client.request = async (method, params) => {
    client.calls.push({ method, params });
    assert.equal(method, "thread/turns/list", "recovery unexpectedly sent an execution request");
    return client.pages.shift();
  };
  const engine = new Engine(client, store);
  return { directory, store, client, engine, run: engine.runs.get("recover-run"), workflow };
}

test("independent: restart blocks replay and reconciles the exact turn through paginated history", async () => {
  const { engine, client, store, run, workflow } = recoveryFixture();
  try {
    assert.equal(run.states.A.recovery.required, true);
    await assert.rejects(async () => engine.rerun(run.id, "A", workflow, "retry"));
    client.pages.push(
      { data: [{ id: "unrelated-newer-turn", status: "completed", items: [] }], nextCursor: "page-two" },
      { data: [{ id: "owned-turn", status: "completed", items: [{ type: "agentMessage", phase: "final_answer", text: "RECOVERED-EXACT-OUTPUT" }] }], nextCursor: null },
    );
    const inspection = await engine.inspectRecovery(run.id, "A");
    assert.equal(inspection.phase, "terminal");
    assert.equal(inspection.required, true);
    assert.equal(client.calls[1].params.cursor, "page-two");
    assert.equal(run.states.A.attempts[0].rawText, "RECOVERED-EXACT-OUTPUT");
    assert.throws(() => engine.confirmRecovery(run.id, "A", "  "));
    engine.confirmRecovery(run.id, "A", "Checked outputs; no external operation was performed.");
    assert.equal(run.states.A.recovery.required, false);
    assert.equal(run.states.A.attempt, 1, "confirmation replayed the operation");
    assert.equal(client.calls.length, 2);
    assert.equal(store.runs()[0].states.A.recovery.phase, "confirmed");
  } finally { store.close(); }
});

test("independent: a lost start response resolves by its own attempt marker, not the latest turn", async () => {
  const { engine, client, store, run } = recoveryFixture("");
  try {
    client.pages.push({ data: [
      { id: "newer-unrelated", status: "completed", items: [{ type: "userMessage", content: [{ type: "text", text: "UNRELATED" }] }] },
      { id: "found-owned-turn", status: "interrupted", items: [{ type: "userMessage", content: [{ type: "text", text: "STUDIO-EXACT-ATTEMPT-7391" }] }] },
    ], nextCursor: null });
    const inspection = await engine.inspectRecovery(run.id, "A");
    assert.equal(inspection.phase, "terminal");
    assert.equal(run.states.A.turnId, "found-owned-turn");
    assert.equal(run.states.A.attempts[0].turnId, "found-owned-turn");
    assert.equal(run.states.A.recovery.required, true);
  } finally { store.close(); }
});

test("independent: still-running or missing turns cannot be acknowledged as safe to replay", async () => {
  const { engine, client, store, run } = recoveryFixture();
  try {
    client.pages.push({ data: [{ id: "owned-turn", status: "inProgress", items: [] }], nextCursor: null });
    await engine.inspectRecovery(run.id, "A");
    assert.equal(run.states.A.recovery.phase, "in_progress");
    assert.throws(() => engine.confirmRecovery(run.id, "A", "I checked"));
    client.pages.push({ data: [], nextCursor: null });
    await engine.inspectRecovery(run.id, "A");
    assert.equal(run.states.A.recovery.phase, "unresolved");
    assert.throws(() => engine.confirmRecovery(run.id, "A", "I checked"));
    assert.equal(run.states.A.recovery.required, true);
  } finally { store.close(); }
});

test("independent: completed history may be explicitly adopted without replay or automatic downstream dispatch", async () => {
  const { engine, client, store, run } = recoveryFixture();
  try {
    const result = { status: "completed", route: "done", content: "ALREADY-DONE", summary: "done", evidence: "history", unverified: "", question: "", artifacts: [] };
    client.pages.push({ data: [{ id: "owned-turn", status: "completed", items: [{ type: "agentMessage", phase: "final_answer", text: JSON.stringify(result) }] }], nextCursor: null });
    await engine.inspectRecovery(run.id, "A");
    await engine.acceptRecoveryResult(run.id, "A", "Verified the saved result and side effects.");
    assert.equal(run.states.A.output.content, "ALREADY-DONE");
    assert.equal(run.states.A.attempt, 1);
    assert.equal(run.states.A.status, "completed");
    assert.equal(run.status, "paused");
    assert.equal(client.calls.length, 1, "adopting history started an execution");
  } finally { store.close(); }
});

test("independent: a timed-out start cannot unlock a shared thread or become rerunnable", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "studio-owned-start-"));
  const store = new Store(directory);
  const client = new CodexClient(process.execPath, [resolve("scripts/fixtures/delayed-server.cjs")]);
  const engine = new Engine(client, store);
  const workflow = {
    id: "owned-workflow", name: "ownership", maxReworks: 0, globalPrompt: "authority", sandbox: "read-only",
    roles: ["A", "B"].map((id) => ({ id, name: id, model: id, effort: "low", prompt: id, cwd: directory, sessionMode: "existing", threadId: "shared", projectId: "" })),
    nodes: ["A", "B"].map((id) => ({ id, data: { label: id, roleId: id, task: id, outputPrompt: "result", allowQuestions: false, defaultRule: "blocked", inputIds: [], terminalRoutes: ["done"] } })), edges: [],
  };
  const sent = [];
  const originalRequest = client.request.bind(client);
  client.request = (method, params, ...options) => {
    sent.push({ method, params });
    return originalRequest(method, params, ...options);
  };
  let run;
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const received = once(client, "notification");
    run = engine.start(workflow, "original", "materials");
    await received;
    t.mock.timers.tick(30001);
    await settle();
    assert.notEqual(run.states.A.status, "failed", "unconfirmed server operation was incorrectly finalized");
    assert.equal(sent.filter((call) => call.method === "turn/start").length, 1);
    assert.equal(run.states.B.attempt, 0);
    await assert.rejects(async () => engine.rerun(run.id, "A", workflow, "retry"));
    await client.request("test/release");
    await until(() => sent.filter((call) => call.method === "turn/start").length === 2);
    await client.request("test/release");
    await until(() => run.status === "completed");
    assert.equal(run.states.A.attempt, 1);
    assert.equal(run.states.B.attempt, 1);
    assert.equal(run.states.A.output.content, "A");
  } finally {
    t.mock.timers.reset();
    run.status = "interrupted";
    const exited = once(client.process, "exit");
    client.process.kill();
    await exited;
    await settle();
    store.close();
  }
});

test("independent: known turn identity wins over a marker quoted in another turn", async () => {
  const { engine, client, store, run } = recoveryFixture();
  try {
    client.pages.push({ data: [
      { id: "unrelated-quoting-marker", status: "completed", items: [{ type: "userMessage", content: [{ type: "text", text: "STUDIO-EXACT-ATTEMPT-7391" }] }] },
      { id: "owned-turn", status: "inProgress", items: [] },
    ], nextCursor: null });
    await engine.inspectRecovery(run.id, "A");
    assert.equal(run.states.A.turnId, "owned-turn");
    assert.equal(run.states.A.recovery.phase, "in_progress");
    assert.throws(() => engine.confirmRecovery(run.id, "A", "checked"));
  } finally { store.close(); }
});

test("independent: recovery cannot adopt an invalid artifact or manufacture a completed output", async () => {
  const { engine, client, store, run, directory } = recoveryFixture();
  try {
    const invalid = { status: "completed", route: "done", content: "claims success", summary: "done", evidence: "history", unverified: "", question: "", artifacts: [join(directory, "never-created.txt")] };
    client.pages.push({ data: [{ id: "owned-turn", status: "completed", items: [{ type: "agentMessage", phase: "final_answer", text: JSON.stringify(invalid) }] }], nextCursor: null });
    await engine.inspectRecovery(run.id, "A");
    await assert.rejects(async () => engine.acceptRecoveryResult(run.id, "A", "Checked the claimed result."));
    assert.notEqual(run.states.A.status, "completed");
    assert.equal(run.states.A.output, null);
    assert.equal(run.states.A.recovery.required, true);
    assert.equal(client.calls.length, 1);
  } finally { store.close(); }
});

function activeFixture() {
  const directory = mkdtempSync(join(tmpdir(), "studio-disconnect-independent-"));
  const store = new Store(directory);
  const client = new EventEmitter();
  client.calls = [];
  client.request = async (method, params) => {
    client.calls.push({ method, params });
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    if (method === "turn/start") return { turn: { id: "active-turn" } };
    throw new Error(`Unexpected request ${method}`);
  };
  const role = { id: "A", name: "A", model: "model", effort: "low", prompt: "role", cwd: directory, projectId: "", sessionMode: "existing", threadId: "owned-thread" };
  const workflow = { id: "active-workflow", name: "active", globalPrompt: "authority", sandbox: "read-only", maxReworks: 0, roles: [role], nodes: [{ id: "A", data: { label: "A", roleId: "A", task: "task", outputPrompt: "output", inputIds: [], terminalRoutes: ["done"], allowQuestions: false, defaultRule: "blocked" } }], edges: [] };
  const engine = new Engine(client, store);
  return { store, client, workflow, engine };
}

test("independent: active disconnect preserves unknown completion and never replays after reconnect", async () => {
  const { engine, client, store, workflow } = activeFixture();
  try {
    const run = engine.start(workflow, "task", "");
    await until(() => Boolean(run.states.A.turnId));
    client.emit("disconnected", "transport closed during execution");
    await until(() => engine.active.size === 0);
    const attempt = run.states.A.attempts[0];
    assert.equal(attempt.status, "unknown");
    assert.equal(attempt.finishedAt, null, "client disconnect invented a server completion timestamp");
    assert.equal(run.states.A.recovery.required, true);
    engine.attachClient(client);
    await settle();
    await assert.rejects(async () => engine.rerun(run.id, "A", workflow, "try again"));
    assert.equal(client.calls.filter((call) => call.method === "turn/start").length, 1);
    assert.equal(store.runs()[0].states.A.attempts[0].finishedAt, null);
  } finally { store.close(); }
});

test("independent: real-shaped compaction events are attributed to the owning attempt", async () => {
  const { engine, client, store, workflow } = activeFixture();
  try {
    const run = engine.start(workflow, "task", "");
    await until(() => Boolean(run.states.A.turnId));
    const notification = { method: "item/completed", params: { threadId: "owned-thread", turnId: "active-turn", item: { id: "compaction-one", type: "contextCompaction" } } };
    client.emit("notification", notification);
    client.emit("notification", notification);
    client.emit("notification", { ...notification, params: { ...notification.params, turnId: "unrelated-turn", item: { id: "wrong", type: "contextCompaction" } } });
    assert.equal(run.memory.compactions.length, 1, "duplicate or unrelated compaction changed memory");
    assert.equal(run.memory.compactions[0].nodeId, "A");
    assert.equal(run.memory.compactions[0].attempt, 1);
    client.emit("notification", { method: "item/completed", params: { threadId: "owned-thread", turnId: "active-turn", item: { type: "agentMessage", phase: "final_answer", text: JSON.stringify({ status: "completed", route: "done", content: "done", summary: "done", evidence: "fixture", unverified: "", question: "", artifacts: [] }) } } });
    client.emit("notification", { method: "turn/completed", params: { threadId: "owned-thread", turn: { id: "active-turn", status: "completed" } } });
    await until(() => run.status === "completed");
  } finally {
    if (engine.active.size) { client.emit("disconnected", "test cleanup"); await until(() => engine.active.size === 0); }
    store.close();
  }
});
