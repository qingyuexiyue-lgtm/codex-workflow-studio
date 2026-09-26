// Real App Server acceptance: one dedicated thread, an explicit compact, then one continuation.
// Explicit compaction does not establish behavior at the natural context threshold.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";

const require = createRequire(import.meta.url);
const { CodexClient } = require("../desktop/codex-client.cjs");
const { Engine } = require("../desktop/engine.cjs");
const { Store } = require("../desktop/store.cjs");
const projectId = process.env.STUDIO_TEST_PROJECT_ID;
assert.ok(projectId, "Set STUDIO_TEST_PROJECT_ID to a dedicated test project.");

await mkdir(".integration", { recursive: true });
const directory = await mkdtemp(path.resolve(".integration/live-compaction-"));
const executable =
  process.env.STUDIO_CODEX_PATH ||
  path.join(process.env.LOCALAPPDATA, "Programs/OpenAI/Codex/bin/codex.exe");
const client = new CodexClient(executable);
const store = new Store(directory);
const report = {
  directory,
  kind: "explicit thread/compact/start, not natural threshold compaction",
  threadId: null,
  calls: [],
  events: [],
  checks: [],
};
const rawRequest = client.request.bind(client);
client.request = async (method, params, options) => {
  report.calls.push({ method, threadId: params?.threadId || null });
  const result = await rawRequest(method, params, options);
  if (method === "thread/start") {
    report.threadId = result.thread.id;
    await rawRequest("thread/name/set", {
      threadId: result.thread.id,
      name: "Workflow Studio 压缩恢复验收 (专用测试)",
    });
  }
  return result;
};
client.on("notification", (message) => {
  if (
    ![
      "turn/started",
      "turn/completed",
      "item/completed",
      "thread/compacted",
    ].includes(message.method)
  )
    return;
  const item = message.params?.item;
  if (message.method === "item/completed" && item?.type !== "contextCompaction")
    return;
  report.events.push({
    method: message.method,
    threadId: message.params?.threadId,
    turnId: message.params?.turn?.id || message.params?.turnId,
    turnStatus: message.params?.turn?.status,
    itemType: item?.type,
    itemId: item?.id,
  });
});

async function until(label, condition, deadlineMs = 120000) {
  const deadline = Date.now() + deadlineMs;
  while (!condition()) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

try {
  await client.initialize();
  const role = {
    id: "shared",
    name: "只读验收角色",
    model: "gpt-6-sol",
    effort: "low",
    prompt:
      "Only answer this read-only acceptance. Do not call tools or edit files.",
    cwd: process.cwd(),
    projectId,
    sessionMode: "new",
    threadId: "",
  };
  const node = (id, task) => ({
    id,
    type: "step",
    position: { x: 0, y: 0 },
    data: {
      label: id,
      roleId: "shared",
      task,
      outputPrompt:
        "Return the required JSON object only. evidence='dedicated live test'; unverified=''; question=''; artifacts=[].",
      allowQuestions: false,
      defaultRule: "Return blocked if impossible.",
      inputIds: [],
      terminalRoutes: ["done"],
      color: "mint",
    },
  });
  const workflow = {
    id: "live-compact",
    name: "Explicit compaction acceptance",
    description: "Dedicated test thread",
    globalPrompt:
      "TEST-ORIGINAL-CONSTRAINT-719: read-only, no tools, no file changes.",
    maxReworks: 0,
    sandbox: "read-only",
    updatedAt: new Date().toISOString(),
    roles: [role],
    nodes: [
      node(
        "first",
        "Return status=completed, route=done, content='FIRST-719', summary='FIRST-719'.",
      ),
      node(
        "second",
        "Return status=completed, route=done, content='SECOND-719', summary='SECOND-719'.",
      ),
    ],
    edges: [
      {
        id: "first-second",
        source: "first",
        target: "second",
        data: { kind: "next", route: "*" },
      },
    ],
  };
  const engine = new Engine(client, store);
  let runId;
  let pausedFirst = false;
  client.on("notification", (message) => {
    if (pausedFirst || message.method !== "turn/completed" || !runId) return;
    if (
      message.params.threadId !== engine.runs.get(runId).states.first.threadId
    )
      return;
    pausedFirst = true;
    engine.pause(runId);
  });
  const run = engine.start(
    workflow,
    "TEST-ORIGINAL-TASK-719: verify next dispatch after explicit compaction.",
    "",
  );
  runId = run.id;
  await until(
    "first step paused",
    () => run.status === "paused" && run.states.first.status === "completed",
  );
  assert.equal(run.states.second.attempt, 0);
  assert.equal(run.states.first.output.content, "FIRST-719");
  assert.equal(run.sessions.shared, report.threadId);
  report.checks.push(
    "first real turn completed and next step held before dispatch",
  );

  engine.addDecision(
    run.id,
    "TEST-USER-DECISION-719: retain the original read-only constraint.",
  );
  report.compactResponse = await client.request("thread/compact/start", {
    threadId: report.threadId,
  });
  await until(
    "explicit contextCompaction item",
    () => report.events.some((event) => event.itemType === "contextCompaction"),
    90000,
  );
  const item = report.events.find(
    (event) => event.itemType === "contextCompaction",
  );
  await until(
    "compaction turn terminal",
    () =>
      report.events.some(
        (event) =>
          event.method === "turn/completed" && event.turnId === item.turnId,
      ),
    90000,
  );
  report.memoryAfterCompact = structuredClone(run.memory.compactions);
  assert.equal(
    run.memory.compactions.length,
    1,
    "real explicit compaction was not recorded for the paused run",
  );
  assert.equal(run.memory.compactions[0].id, item.itemId);
  assert.equal(
    store.runs().find((saved) => saved.id === run.id).memory.compactions[0].id,
    item.itemId,
  );
  report.checks.push(
    "real compaction item attributed to the same run and persisted",
  );

  engine.resume(run.id);
  await until("second step completed", () => run.status === "completed");
  assert.equal(run.states.second.output.content, "SECOND-719");
  assert.equal(run.states.second.threadId, report.threadId);
  assert.equal(
    report.calls.filter((call) => call.method === "thread/start").length,
    1,
  );
  const sent = await readFile(
    path.join(run.states.second.artifactDirectory, "task.md"),
    "utf8",
  );
  for (const text of [
    "# 压缩后恢复",
    "TEST-ORIGINAL-CONSTRAINT-719",
    "TEST-ORIGINAL-TASK-719",
    "TEST-USER-DECISION-719",
  ])
    assert.ok(sent.includes(text), `next actual task packet omitted ${text}`);
  report.checks.push(
    "next real turn reused the thread and received original constraint, task, decision, and compaction recovery",
  );
  report.finalRun = structuredClone(run);
  console.log("LIVE COMPACTION PASS:", report.checks.join("; "));
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  throw error;
} finally {
  await writeFile(
    path.join(directory, "report.json"),
    JSON.stringify(report, null, 2),
  );
  if (client.process.exitCode === null) {
    const exited = once(client.process, "exit");
    client.close();
    await exited;
  }
  store.close();
  console.log("Live compaction report:", path.join(directory, "report.json"));
}
