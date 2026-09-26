import { _electron as electron } from "playwright";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

await mkdir("test-results", { recursive: true });
const env = {
  ...process.env,
  STUDIO_DATA_DIR: await mkdtemp(path.resolve(".integration/control-ui-")),
};
delete env.ELECTRON_RUN_AS_NODE;
const application = await electron.launch(
  process.env.STUDIO_TEST_EXE
    ? {
        executablePath: path.resolve(process.env.STUDIO_TEST_EXE),
        args: [],
        env,
      }
    : { args: ["."], env },
);
try {
  const page = await application.firstWindow();
  await page.locator(".step-node").first().waitFor();
  const boot = await page.evaluate(() => window.studio.boot());
  const workflow = structuredClone(boot.workflows[0]);
  workflow.edges = [];
  const ids = workflow.nodes.map((node) => node.id);
  const output = {
    status: "question",
    route: "done",
    content: "待确认的初稿",
    summary: "需要方向选择",
    evidence: "UI fixture",
    unverified: "",
    question: "请选择本次交付方向。",
    artifacts: [],
  };
  const run = {
    id: "ui-controls-fixture",
    workflow,
    snapshots: [workflow],
    task: "独立验收：分支等待与中断",
    materials: "",
    createdAt: new Date().toISOString(),
    status: "running",
    feedback: "",
    reworks: 0,
    sessions: {},
    states: Object.fromEntries(
      ids.map((id, index) => [
        id,
        {
          status: ["question", "running", "completed"][index],
          attempt: 1,
          output: index === 0 ? output : null,
          error: "",
          threadId: `ui-thread-${index}`,
          turnId: `ui-turn-${index}`,
          logs: [],
          usage: null,
        },
      ]),
    ),
  };
  // Renderer/IPC acceptance only: controlled states, no model or external operation is executed.
  await application.evaluate(({ BrowserWindow, ipcMain }, fixture) => {
    globalThis.__controlUiCalls = [];
    globalThis.__controlUiRun = fixture;
    const publish = () =>
      BrowserWindow.getAllWindows()[0].webContents.send(
        "studio:run",
        globalThis.__controlUiRun,
      );
    ipcMain.removeHandler("studio:rerun");
    ipcMain.handle("studio:rerun", (_, runId, nodeId, workflow, feedback) => {
      globalThis.__controlUiCalls.push({
        action: "rerun",
        runId,
        nodeId,
        feedback,
      });
      globalThis.__controlUiRun.states[nodeId].status = "running";
      globalThis.__controlUiRun.states[nodeId].output = null;
      publish();
    });
    ipcMain.removeHandler("studio:interrupt");
    ipcMain.handle("studio:interrupt", (_, runId) => {
      globalThis.__controlUiCalls.push({ action: "interrupt", runId });
      globalThis.__controlUiRun.status = "interrupted";
      for (const state of Object.values(globalThis.__controlUiRun.states))
        if (state.status === "running") state.status = "interrupted";
      publish();
    });
    publish();
  }, run);
  await page.getByRole("button", { name: /运行记录/ }).click();
  await page.locator(".table-row").filter({ hasText: run.task }).click();
  await page.getByRole("button", { name: "立即中断", exact: true }).waitFor();
  const answer = page.locator(".answer-row input");
  await answer.waitFor();
  await answer.fill("选择方向 X");
  await page.getByRole("button", { name: "从此重跑", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".answer-row"));
  await page.getByRole("button", { name: "立即中断", exact: true }).click();
  await page
    .locator(".dock-header .status-badge")
    .filter({ hasText: "已中断" })
    .waitFor();
  const calls = await application.evaluate(() => globalThis.__controlUiCalls);
  assert.deepEqual(calls, [
    { action: "rerun", runId: run.id, nodeId: ids[0], feedback: "选择方向 X" },
    { action: "interrupt", runId: run.id },
  ]);
  await page.screenshot({ path: "test-results/controls-interrupted.png" });
  await application.evaluate(({ BrowserWindow }, nodeId) => {
    const state = globalThis.__controlUiRun.states[nodeId];
    const previous = {
      attempt: 1,
      snapshotIndex: 0,
      startedAt: "",
      finishedAt: "",
      status: "completed",
      artifactDirectory: "",
      threadId: "old-thread",
      turnId: "old-turn",
      output: {
        status: "completed",
        route: "done",
        content: "",
        summary: "old",
        evidence: "",
        unverified: "",
        question: "",
        artifacts: [],
      },
      rawText: "",
      error: "",
      usage: null,
    };
    const current = {
      ...previous,
      attempt: 2,
      snapshotIndex: 1,
      status: "interrupted",
      artifactDirectory: "C:/current-attempt",
      output: {
        ...previous.output,
        content: "CURRENT-CONTENT",
        question: "CURRENT-QUESTION",
      },
      error: "CURRENT-ERROR",
      usage: { marker: "CURRENT-USAGE" },
    };
    Object.assign(state, {
      attempt: 2,
      attempts: [previous, current],
      artifactDirectory: current.artifactDirectory,
      output: current.output,
      error: current.error,
      usage: current.usage,
    });
    BrowserWindow.getAllWindows()[0].webContents.send(
      "studio:run",
      globalThis.__controlUiRun,
    );
  }, ids[0]);
  await page.getByLabel("选择尝试", { exact: true }).selectOption("1");
  assert.ok(
    !(await page.locator(".output-scroll").textContent()).includes("CURRENT-"),
    "old attempt displayed current content/error/question",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "打开成果目录", exact: true })
      .count(),
    0,
    "old attempt borrowed current artifact directory",
  );
  await page.getByRole("button", { name: "用量", exact: true }).click();
  assert.ok(
    !(await page.locator(".output-scroll").textContent()).includes(
      "CURRENT-USAGE",
    ),
    "old attempt borrowed current usage",
  );
  await application.evaluate(({ BrowserWindow }, nodeId) => {
    globalThis.__controlUiRun.status = "needs_attention";
    globalThis.__controlUiRun.error = "立即中断失败：fixture error";
    globalThis.__controlUiRun.states[nodeId].status = "running";
    BrowserWindow.getAllWindows()[0].webContents.send(
      "studio:run",
      globalThis.__controlUiRun,
    );
  }, ids[0]);
  await page.getByRole("button", { name: "立即中断", exact: true }).waitFor();
  console.log(
    "PASS: running branch answer/retry, interrupt IPC identity, attempt-specific data isolation, and failed-interrupt retry visibility. Controlled UI fixtures only.",
  );
} finally {
  await application.close();
}
