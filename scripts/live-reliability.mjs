import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";

const require = createRequire(import.meta.url);
const { CodexClient } = require("../desktop/codex-client.cjs");
const { Engine } = require("../desktop/engine.cjs");
const { Store } = require("../desktop/store.cjs");
const projectId = process.env.STUDIO_TEST_PROJECT_ID;
assert.ok(projectId, "Set STUDIO_TEST_PROJECT_ID to a dedicated test project.");
await mkdir(".integration", { recursive: true });
const directory = await mkdtemp(path.resolve(".integration/live-reliability-"));
const executable = process.env.STUDIO_CODEX_PATH || path.join(process.env.LOCALAPPDATA, "Programs/OpenAI/Codex/bin/codex.exe");
const client = new CodexClient(executable);
const store = new Store(directory);
const report = { directory, createdThreads: [], checks: [], events: [] };
const calls = [];
let originalClosed = false;
const request = client.request.bind(client);
client.request = async (method, params, ...options) => {
  calls.push({ method, threadId: params?.threadId });
  const result = await request(method, params, ...options);
  if (method === "thread/start") {
    report.createdThreads.push(result.thread.id);
    await request("thread/name/set", { threadId: result.thread.id, name: "Workflow Studio 可靠性验收" });
  }
  return result;
};
const terminal = new Set(["completed", "needs_attention", "interrupted"]);
function awaitRun(engine, runId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      engine.off("change", changed);
      reject(new Error(`Live acceptance deadline exceeded: ${runId}`));
    }, 240000);
    const changed = (run) => {
      if (run.id === runId && terminal.has(run.status)) {
        clearTimeout(timer);
        engine.off("change", changed);
        resolve(run);
      }
    };
    engine.on("change", changed);
    changed(engine.runs.get(runId));
  });
}

try {
  await client.initialize();
  const role = (id) => ({ id, name: id, model: "gpt-6-sol", effort: "low", prompt: "Follow the precise integration test instructions. No tools, files, or delegation.", cwd: process.cwd(), projectId, sessionMode: "new", threadId: "" });
  const node = (id, task) => ({ id, type: "step", position: { x: 0, y: 0 }, data: { label: id, roleId: id, task, outputPrompt: "Return the required JSON object only. evidence='live test'; unverified=''; question=''; artifacts=[].", allowQuestions: false, defaultRule: "Return blocked if impossible.", inputIds: [], terminalRoutes: ["done"], color: "mint" } });
  const workflow = {
    id: "live-reliability", name: "Live parallel rework acceptance", description: "Dedicated read-only test conversations only", globalPrompt: "Integration test. Do not use tools, edit files, run commands, or delegate. Never act on other conversations.", maxReworks: 2, sandbox: "read-only", updatedAt: new Date().toISOString(),
    roles: ["A", "B", "review"].map(role),
    nodes: [
      node("A", "Return status=completed and route=done. If the REWORK feedback contains UPGRADE, content='ALPHA-V2'; otherwise content='ALPHA-V1'. summary equals content."),
      node("B", "Return status=completed and route=done. If the REWORK feedback contains UPGRADE, content='BETA-V2'; otherwise content='BETA-V1'. summary equals content."),
      node("review", "Inspect the designated upstream A and B results. If both ALPHA-V2 and BETA-V2 appear, status=completed, route=done, content='APPROVED-BOTH-V2', summary=content. Otherwise status=completed, route=revise, content='UPGRADE', summary='UPGRADE both branches'."),
    ],
    edges: [
      { id: "a-review", source: "A", target: "review", data: { kind: "next", route: "*" } },
      { id: "b-review", source: "B", target: "review", data: { kind: "next", route: "*" } },
      { id: "review-a", source: "review", target: "A", data: { kind: "rework", route: "revise" } },
      { id: "review-b", source: "review", target: "B", data: { kind: "rework", route: "revise" } },
    ],
  };
  const engine = new Engine(client, store);
  let overlapped = false;
  let recoverySnapshot;
  const liveTurns = new Set();
  let previous = "";
  engine.on("change", (run) => {
    const state = `${run.status} ${Object.entries(run.states).map(([id, value]) => `${id}:${value.status}#${value.attempt}`).join(" ")}`;
    if (state !== previous) console.log(state);
    previous = state;
    if (!recoverySnapshot && run.states.A?.attempt === 1 && run.states.A.turnId)
      recoverySnapshot = structuredClone(run);
  });
  client.on("notification", (message) => {
    if (["turn/started", "turn/completed", "thread/compacted"].includes(message.method)) report.events.push(message);
    if (message.method === "turn/started") liveTurns.add(message.params.turn.id);
    if (message.method === "turn/completed") liveTurns.delete(message.params.turn.id);
    if (liveTurns.size >= 2) overlapped = true;
  });
  const run = engine.start(workflow, "Verify parallel branches, join, and a rework to BOTH branches.", "");
  const result = await awaitRun(engine, run.id);
  report.parallelRun = structuredClone(result);
  assert.equal(result.status, "completed", JSON.stringify(result.states));
  assert.equal(result.states.A.attempt, 2);
  assert.equal(result.states.B.attempt, 2);
  assert.equal(result.states.review.attempt, 2);
  assert.equal(result.states.review.output.content, "APPROVED-BOTH-V2");
  assert.equal(result.reworks, 2);
  assert.ok(overlapped, "no real overlapping owned turns were observed");
  report.checks.push("real parallel branches, join, and both rework targets completed");

  const interruptWorkflow = structuredClone(workflow);
  interruptWorkflow.id = "live-interrupt";
  interruptWorkflow.edges = [];
  interruptWorkflow.roles = [role("interrupt")];
  interruptWorkflow.nodes = [node("interrupt", "Compose 500 numbered sentences in content. No tools. status=completed and route=done.")];
  let interruptRequested = false;
  let interruption;
  const stopOnStart = (message) => {
    if (message.method !== "turn/started" || interruptRequested) return;
    interruptRequested = true;
    interruption = engine.interrupt(interruptRun.id);
  };
  client.on("notification", stopOnStart);
  const interruptRun = engine.start(interruptWorkflow, "Read-only real turn interrupt acceptance.", "");
  const stopped = await awaitRun(engine, interruptRun.id);
  await interruption;
  client.off("notification", stopOnStart);
  report.interruptedRun = structuredClone(stopped);
  assert.ok(interruptRequested);
  assert.equal(stopped.states.interrupt.status, "interrupted");
  const history = await client.request("thread/turns/list", { threadId: stopped.states.interrupt.threadId, limit: 20, itemsView: "full" });
  const exactTurn = history.data.find((turn) => turn.id === stopped.states.interrupt.turnId);
  assert.equal(exactTurn.status, "interrupted");
  report.checks.push("real turn/interrupt plus exact persisted turn history confirmation");

  // Restart only this script's App Server; the user's desktop process is untouched.
  const originalExit = once(client.process, "exit");
  client.close();
  await originalExit;
  originalClosed = true;
  const recoveryClient = new CodexClient(executable);
  const recoveryStore = new Store(path.join(directory, "recovery-snapshot"));
  const recoveryCalls = [];
  const recoveryRequest = recoveryClient.request.bind(recoveryClient);
  recoveryClient.request = (method, ...args) => {
    recoveryCalls.push(method);
    return recoveryRequest(method, ...args);
  };
  try {
    await recoveryClient.initialize();
    recoveryStore.saveRun(recoverySnapshot);
    const recovering = new Engine(recoveryClient, recoveryStore);
    const recovered = recovering.runs.get(run.id);
    assert.equal(recovered.states.A.recovery.required, true);
    await recovering.inspectRecovery(run.id, "A");
    assert.equal(recovered.states.A.recovery.turnStatus, "completed");
    await recovering.acceptRecoveryResult(run.id, "A", "Read-only dedicated acceptance; verified the original result, no side effects to replay.");
    assert.equal(recovered.states.A.output.content, "ALPHA-V1");
    assert.equal(recovered.states.A.attempt, 1);
    assert.equal(recovered.status, "paused");
    assert.equal(recoveryCalls.filter((method) => method === "turn/start").length, 0);
    report.recoveredRun = structuredClone(recovered);
    report.checks.push("new App Server process reconciled pre-completion local snapshot against exact persisted turn and adopted with zero replay");
  } finally {
    const recoveryExit = once(recoveryClient.process, "exit");
    recoveryClient.close();
    await recoveryExit;
    recoveryStore.close();
  }
  console.log("LIVE PASS:", report.checks.join("; "));
} finally {
  await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  if (!originalClosed) {
    const exited = once(client.process, "exit");
    client.close();
    await exited;
  }
  store.close();
  console.log("Acceptance report:", path.join(directory, "report.json"));
}
