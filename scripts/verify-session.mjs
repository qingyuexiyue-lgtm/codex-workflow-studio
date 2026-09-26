import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
const require = createRequire(import.meta.url);
const { CodexClient } = require("../desktop/codex-client.cjs");
const threadId = process.env.STUDIO_TEST_THREAD_ID;
const projectId = process.env.STUDIO_TEST_PROJECT_ID;
if (!threadId || !projectId)
  throw new Error("Set STUDIO_TEST_THREAD_ID and STUDIO_TEST_PROJECT_ID to dedicated test resources.");
await mkdir(".integration", { recursive: true });
const first = new CodexClient(process.env.STUDIO_CODEX_PATH || "codex");
const second = new CodexClient(process.env.STUDIO_CODEX_PATH || "codex");
const report = {};
try {
  await first.initialize();
  await second.initialize();
  const projects = await first.request("project/list", {});
  report.projects = projects.data.map(({ id, name }) => ({ id, name }));
  const threads = await first.request("thread/list", {
    limit: 20,
    useStateDbOnly: true,
  });
  report.threads = threads.data.map(({ id, name, projectId, status }) => ({
    id,
    name,
    projectId,
    status,
  }));
  const before = await first.request("thread/turns/list", {
    threadId,
    limit: 2,
    itemsView: "summary",
  });
  report.historyBefore = before.data.map((turn) => ({
    id: turn.id,
    status: turn.status,
    items: turn.items.length,
  }));
  try {
    const resumed = await first.request("thread/resume", {
      threadId,
      excludeTurns: true,
    });
    report.resume = {
      id: resumed.thread.id,
      status: resumed.thread.status,
      model: resumed.model,
    };
  } catch (error) {
    report.resume = { error: error.message };
  }
  try {
    const competing = await second.request("thread/resume", {
      threadId,
      excludeTurns: true,
    });
    report.competingResume = {
      id: competing.thread.id,
      status: competing.thread.status,
    };
  } catch (error) {
    report.competingResume = { error: error.message };
  }
  const after = await first.request("thread/turns/list", {
    threadId,
    limit: 2,
    itemsView: "summary",
  });
  report.historyAfter = after.data.map((turn) => ({
    id: turn.id,
    status: turn.status,
    items: turn.items.length,
  }));
  const created = await first.request("thread/start", {
    cwd: process.cwd(),
    projectId,
    sandbox: "read-only",
    approvalPolicy: "never",
  });
  await first.request("thread/name/set", {
    threadId: created.thread.id,
    name: "Workflow Studio 接入验收",
  });
  report.testSession = {
    id: created.thread.id,
    projectId: created.thread.projectId,
  };
  const completed = new Promise((resolve) =>
    first.on("notification", (message) => {
      if (
        message.method === "turn/completed" &&
        message.params.threadId === created.thread.id
      )
        resolve(message.params);
    }),
  );
  await first.request("turn/start", {
    threadId: created.thread.id,
    input: [
      {
        type: "text",
        text: "This is an integration test. Do not use tools or subagents. Remember marker WORKFLOW-7391 and reply exactly WORKFLOW-7391.",
        text_elements: [],
      },
    ],
    effort: "low",
  });
  report.testTurn = await completed;
  try {
    await second.request("thread/resume", {
      threadId: created.thread.id,
      excludeTurns: true,
    });
    report.testWriterLock = "not enforced";
  } catch (error) {
    report.testWriterLock = error.message;
  }
  await new Promise((resolve) => {
    first.process.once("exit", resolve);
    first.close();
  });
  const continued = await second.request("thread/resume", {
    threadId: created.thread.id,
    excludeTurns: true,
  });
  report.testResumedSameId = continued.thread.id === created.thread.id;
  const history = await second.request("thread/turns/list", {
    threadId: created.thread.id,
    itemsView: "full",
    limit: 5,
  });
  report.testHistoryPreserved =
    JSON.stringify(history).includes("WORKFLOW-7391");
  console.log(JSON.stringify(report, null, 2));
  await writeFile(
    ".integration/session-verification.json",
    JSON.stringify(report, null, 2),
  );
} finally {
  first.close();
  second.close();
}
