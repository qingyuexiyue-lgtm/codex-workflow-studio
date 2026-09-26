// Synthetic protocol plus controlled recovery IPC: UI wiring and persistence only.
// This cannot establish real Codex timeout, side-effect, or recovery behavior.
import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { Store } = require("../desktop/store.cjs");
const root = path.resolve(".");
const results = path.join(root, "test-results");
await mkdir(path.join(root, ".integration"), { recursive: true });
await mkdir(results, { recursive: true });
const fixtureRoot = await mkdtemp(path.join(root, ".integration", "reliability-ui-"));
const serverDirectory = path.join(fixtureRoot, "server");
const dataDirectory = path.join(fixtureRoot, "data");
const codexHome = path.join(fixtureRoot, "codex-home");
await mkdir(serverDirectory);
await mkdir(codexHome);
await copyFile(
  path.join(root, "scripts", "fixtures", "acceptance-app-server.mjs"),
  path.join(serverDirectory, "app-server"),
);
await writeFile(
  path.join(codexHome, ".codex-global-state.json"),
  JSON.stringify({
    "app-server-project-id-by-legacy-project-id-by-host": {
      [`local:${codexHome}`]: {},
    },
    "thread-project-assignments": {},
  }),
);

const originalTask = "UI-ACCEPTANCE-ORIGINAL: 比较两份虚构示例，只在受控验收中展示。";
const originalMaterials = "fixture://synthetic-materials-only";
const userDecision = "UI-ACCEPTANCE-DECISION: 用户确认选择交付方式 A。";
const nodeId = "reliability-ui-step";
const roleId = "reliability-ui-role";
const workflow = {
  id: "reliability-ui-workflow",
  name: "可靠性桌面验收",
  description: "受控 fixture，不使用用户业务数据",
  globalPrompt: "只处理验收中的虚构内容。",
  maxReworks: 0,
  sandbox: "read-only",
  roles: [{
    id: roleId,
    name: "验收角色",
    prompt: "返回受控验收结果。",
    model: "acceptance-model",
    effort: "medium",
    projectId: "acceptance-project",
    cwd: fixtureRoot,
    sessionMode: "new",
    threadId: "",
  }],
  nodes: [{
    id: nodeId,
    type: "step",
    position: { x: 80, y: 120 },
    data: {
      label: "验收步骤",
      roleId,
      task: "仅处理虚构任务。",
      outputPrompt: "返回受控 JSON。",
      allowQuestions: true,
      defaultRule: "无法决定时提问。",
      inputIds: [],
      terminalRoutes: ["done"],
      color: "mint",
    },
  }],
  edges: [],
  updatedAt: new Date().toISOString(),
};
const store = new Store(dataDirectory);
store.saveWorkflow(workflow);
store.close();
function persistedRun(id) {
  const reader = new Store(dataDirectory);
  try {
    return reader.runs().find((run) => run.id === id);
  } finally {
    reader.close();
  }
}

const env = {
  ...process.env,
  CODEX_HOME: codexHome,
  STUDIO_CODEX_PATH: process.execPath,
  STUDIO_DATA_DIR: dataDirectory,
};
delete env.ELECTRON_RUN_AS_NODE;
const launch = () =>
  electron.launch(
    process.env.STUDIO_TEST_EXE
      ? {
          executablePath: path.resolve(process.env.STUDIO_TEST_EXE),
          args: [],
          cwd: serverDirectory,
          env,
        }
      : { args: [root], cwd: serverDirectory, env },
  );

async function windowSize(application, page, width, height, name) {
  await application.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0].setSize(size.width, size.height);
  }, { width, height });
  await page.waitForFunction(
    (size) => innerWidth === size.width && innerHeight === size.height,
    { width, height },
  );
  const layout = await page.evaluate(() => ({
    headingOverlap: (() => {
      const title = document.querySelector(".canvas-heading h1")?.getBoundingClientRect();
      const controls = document.querySelector(".react-flow__controls")?.getBoundingClientRect();
      const nodes = [...document.querySelectorAll(".step-node")].map((node) => node.getBoundingClientRect());
      const area = (a, b) => a && b
        ? Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
          Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
        : 0;
      return {
        node: Math.max(0, ...nodes.map((node) => area(title, node))),
        controls: area(title, controls),
      };
    })(),
    width: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    dock: document.querySelector(".run-dock")?.getBoundingClientRect().toJSON(),
    sidebar: document.querySelector(".sidebar")?.getBoundingClientRect().toJSON(),
    attemptSelect: (() => {
      const select = document.querySelector(".attempt-select");
      if (!select) return null;
      const style = getComputedStyle(select);
      const context = document.createElement("canvas").getContext("2d");
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      return {
        contentHeight: select.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
        fontSize: parseFloat(style.fontSize),
        textWidth: context.measureText(select.selectedOptions[0].text).width,
        availableWidth: select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 22,
      };
    })(),
  }));
  assert.ok(layout.documentWidth <= layout.width + 1, `${name}: horizontal page overflow`);
  assert.ok(layout.dock?.width > 300 && layout.dock.right <= layout.width + 1, `${name}: dock clipped`);
  assert.ok(layout.sidebar?.right <= layout.dock?.left + 1, `${name}: sidebar overlaps dock`);
  assert.equal(layout.headingOverlap.node, 0, `${name}: canvas title overlaps a node`);
  assert.equal(layout.headingOverlap.controls, 0, `${name}: canvas title overlaps zoom controls`);
  if (layout.attemptSelect) {
    assert.ok(
      layout.attemptSelect.contentHeight >= layout.attemptSelect.fontSize * 1.1,
      `${name}: attempt selector text is vertically clipped`,
    );
    assert.ok(
      layout.attemptSelect.availableWidth >= layout.attemptSelect.textWidth,
      `${name}: attempt selector text is horizontally clipped`,
    );
  }
  await page.screenshot({ path: path.join(results, `reliability-${name}-${width}x${height}.png`) });
}

async function installRecoveryFixture(application, run) {
  await application.evaluate(({ BrowserWindow, ipcMain }, fixture) => {
    const original = structuredClone(fixture.run);
    const nodeId = fixture.nodeId;
    globalThis.__reliabilityCalls = [];
    globalThis.__reliabilityScenario = "";
    const publish = () => BrowserWindow.getAllWindows()[0].webContents.send(
      "studio:run",
      globalThis.__reliabilityRun,
    );
    globalThis.__reliabilitySelectScenario = (scenario) => {
      const next = structuredClone(original);
      const state = next.states[nodeId];
      state.output = null;
      state.rawText = "";
      state.error = "原执行结果未知，请核对现场。";
      next.error = "";
      if (scenario === "awaiting") {
        next.status = "running";
        state.status = "awaiting_response";
        state.recovery = {
          required: false,
          reason: "uncertain_start",
          phase: "inspect",
          detail: "启动请求尚未返回；不可再次发送。",
        };
      } else {
        next.status = "interrupted";
        state.status = "interrupted";
        state.recovery = {
          required: true,
          reason: "restart",
          phase: "inspect",
          detail: "进程重启，结果待核对。",
        };
      }
      const attempt = state.attempts.at(-1);
      attempt.status = "unknown";
      attempt.output = null;
      attempt.finishedAt = null;
      attempt.recovery = state.recovery;
      globalThis.__reliabilityRun = next;
      globalThis.__reliabilityScenario = scenario;
      publish();
    };
    const checkedState = (runId, requestedNodeId) => {
      if (runId !== globalThis.__reliabilityRun.id || requestedNodeId !== nodeId)
        throw new Error("Recovery IPC targeted the wrong run or node");
      return globalThis.__reliabilityRun.states[nodeId];
    };
    ipcMain.removeHandler("studio:inspectRecovery");
    ipcMain.handle("studio:inspectRecovery", (_, runId, requestedNodeId) => {
      const state = checkedState(runId, requestedNodeId);
      globalThis.__reliabilityCalls.push({ action: "inspect", runId, nodeId: requestedNodeId });
      const scenario = globalThis.__reliabilityScenario;
      state.recovery = {
        ...state.recovery,
        phase: scenario === "inProgress" ? "in_progress" : scenario === "unresolved" ? "unresolved" : "terminal",
        turnStatus: scenario === "unresolved" ? undefined : scenario,
        inspectedAt: new Date().toISOString(),
        detail: "已从受控会话历史核对终态，副作用仍需人工确认。",
        finalAnswerText: scenario === "completed" ? "受控已完成结果" : undefined,
      };
      state.attempts.at(-1).recovery = state.recovery;
      publish();
      return state.recovery;
    });
    ipcMain.removeHandler("studio:acceptRecoveryResult");
    ipcMain.handle("studio:acceptRecoveryResult", (_, runId, requestedNodeId, note) => {
      const state = checkedState(runId, requestedNodeId);
      if (state.recovery?.phase !== "terminal" || state.recovery.turnStatus !== "completed" || !note?.trim())
        throw new Error("Only a checked completed turn may be adopted");
      globalThis.__reliabilityCalls.push({ action: "accept", runId, nodeId: requestedNodeId, note });
      state.status = "completed";
      state.output = {
        status: "completed",
        route: "done",
        content: "已核对的受控成果。",
        summary: "采用已完成结果",
        evidence: "受控 fixture",
        unverified: "",
        question: "",
        artifacts: [],
      };
      state.attempts.at(-1).status = "completed";
      state.attempts.at(-1).output = state.output;
      state.attempts.at(-1).finishedAt = new Date().toISOString();
      delete state.recovery;
      globalThis.__reliabilityRun.status = "paused";
      publish();
    });
    ipcMain.removeHandler("studio:confirmRecovery");
    ipcMain.handle("studio:confirmRecovery", (_, runId, requestedNodeId, note) => {
      const state = checkedState(runId, requestedNodeId);
      if (state.recovery?.phase !== "terminal" || !note?.trim())
        throw new Error("A checked terminal result and a side-effect note are required");
      globalThis.__reliabilityCalls.push({ action: "confirm", runId, nodeId: requestedNodeId, note });
      state.recovery = { ...state.recovery, required: false, phase: "confirmed", note };
      state.attempts.at(-1).recovery = state.recovery;
      globalThis.__reliabilityRun.status = "needs_attention";
      publish();
    });
    ipcMain.removeHandler("studio:rerun");
    ipcMain.handle("studio:rerun", (_, runId, requestedNodeId, _workflow, feedback) => {
      const state = checkedState(runId, requestedNodeId);
      if (state.recovery?.required || state.status === "awaiting_response")
        throw new Error("Unsafe rerun before recovery confirmation");
      globalThis.__reliabilityCalls.push({ action: "rerun", runId, nodeId: requestedNodeId, feedback });
      state.status = "running";
      globalThis.__reliabilityRun.status = "running";
      publish();
    });
  }, { run, nodeId });
}

let application;
let page;
try {
  application = await launch();
  page = await application.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator(".step-node").first().waitFor();
  const boot = await page.evaluate(() => window.studio.boot());
  assert.equal(boot.server.serverInfo.name, "acceptance-fixture", "real Codex server would make this test unsafe");
  assert.deepEqual(
    (await page.evaluate(() => window.studio.catalog())).projects.map((project) => project.id),
    ["acceptance-project"],
  );
  await page.getByRole("button", { name: "运行流程", exact: true }).click();
  await page.getByLabel("本次任务", { exact: true }).fill(originalTask);
  await page.getByLabel("材料与附件路径", { exact: true }).fill(originalMaterials);
  await page.getByRole("button", { name: "开始执行", exact: true }).click();
  await page.locator(".dock-header .status-badge").filter({ hasText: "待处理" }).waitFor();
  const created = (await page.evaluate(() => window.studio.boot())).runs.find(
    (item) => item.task === originalTask,
  );
  assert.ok(created, "new task missing from real engine/store");
  assert.equal(created.materials, originalMaterials);
  assert.equal(created.memory.revision, 1);
  assert.equal(created.memory.revisions[0].kind, "original");
  assert.equal(created.memory.decisions.length, 0);
  assert.equal(created.memory.updates.length, 1);
  assert.equal(created.memory.updates[0].summary, "受控进度，不是用户决定。");
  assert.equal(created.states[nodeId].attempts[0].memoryRevision, 1);

  await page.getByRole("button", { name: "任务记忆", exact: true }).click();
  const originalSection = page.getByRole("heading", { name: "原始需求", exact: true }).locator("..");
  const decisionsSection = page.getByRole("heading", { name: /用户已确认的决定/ }).locator("..");
  const progressSection = page.getByRole("heading", { name: "角色进度", exact: true }).locator("..");
  assert.ok((await originalSection.textContent()).includes(originalTask));
  assert.ok((await originalSection.textContent()).includes(originalMaterials));
  assert.ok((await decisionsSection.textContent()).includes("暂无已确认的新决定"));
  assert.ok((await progressSection.textContent()).includes("受控进度，不是用户决定。"));
  await page.getByLabel("新增用户决定", { exact: true }).fill(userDecision);
  await page.getByLabel("关联待处理问题", { exact: true }).selectOption(`${nodeId}:1:question`);
  await page.getByRole("button", { name: "保存决定", exact: true }).click();
  await decisionsSection.getByText(userDecision, { exact: true }).waitFor();
  const saved = persistedRun(created.id);
  assert.equal(saved.task, originalTask);
  assert.equal(saved.materials, originalMaterials);
  assert.equal(saved.memory.revision, 2);
  assert.deepEqual(saved.memory.revisions.map((revision) => revision.kind), ["original", "user-decision"]);
  assert.equal(saved.memory.decisions[0].text, userDecision);
  assert.deepEqual(saved.memory.decisions[0].resolves, [`${nodeId}:1:question`]);
  assert.equal(saved.memory.updates[0].summary, "受控进度，不是用户决定。");
  assert.ok(!(await originalSection.textContent()).includes(userDecision));
  assert.ok(!(await progressSection.textContent()).includes(userDecision));
  assert.ok(!(await decisionsSection.textContent()).includes(originalTask));

  await page.reload();
  await page.getByText("Codex 已连接", { exact: true }).waitFor();
  await page.getByRole("button", { name: /运行记录/ }).click();
  await page.locator(".table-row").filter({ hasText: originalTask }).click();
  await page.getByRole("button", { name: "任务记忆", exact: true }).click();
  await page.getByText(userDecision, { exact: true }).waitFor();
  assert.ok((await page.getByRole("heading", { name: "原始需求", exact: true }).locator("..").textContent()).includes(originalTask));
  await windowSize(application, page, 1500, 980, "memory");
  await windowSize(application, page, 1050, 760, "memory");

  await writeFile(path.join(serverDirectory, ".disconnect"), "fixture disconnect");
  await page.locator(".connection-banner").waitFor();
  assert.equal(await page.getByRole("button", { name: "运行流程", exact: true }).isDisabled(), true);
  assert.equal((await page.evaluate(() => window.studio.boot())).connection.status, "disconnected");
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".connection-banner").count(), 1, "unexpected automatic reconnect");
  await page.screenshot({ path: path.join(results, "reliability-disconnected-1050x760.png") });
  await page.locator(".connection-banner").getByRole("button", { name: "重新连接", exact: true }).click();
  await page.getByText("Codex 已连接", { exact: true }).waitFor();
  assert.equal(await page.locator(".connection-banner").count(), 0);
  assert.equal((await page.evaluate(() => window.studio.boot())).server.serverInfo.name, "acceptance-fixture");

  await page.getByRole("button", { name: "成果", exact: true }).click();
  await installRecoveryFixture(application, saved);
  await application.evaluate(() => globalThis.__reliabilitySelectScenario("awaiting"));
  await page.locator(".awaiting-notice").waitFor();
  const directRerun = page.getByRole("button", { name: "从此重跑", exact: true });
  assert.ok(!(await directRerun.count()) || await directRerun.isDisabled(), "awaiting response can rerun");
  assert.deepEqual(await application.evaluate(() => globalThis.__reliabilityCalls), []);

  await application.evaluate(() => globalThis.__reliabilitySelectScenario("inProgress"));
  const recovery = page.getByRole("region", { name: "故障恢复" });
  await recovery.waitFor();
  assert.equal(await directRerun.isDisabled(), true, "uninspected recovery can rerun");
  await recovery.getByRole("button", { name: "核对现场", exact: true }).click();
  await recovery.getByText("仍在执行", { exact: true }).waitFor();
  assert.equal(await recovery.getByRole("button", { name: "确认副作用后重跑", exact: true }).count(), 0);
  assert.equal(await directRerun.isDisabled(), true, "live turn can rerun");

  await application.evaluate(() => globalThis.__reliabilitySelectScenario("completed"));
  await recovery.getByText("等待核对", { exact: true }).waitFor();
  assert.equal(await directRerun.isDisabled(), true);
  assert.equal(await recovery.getByRole("button", { name: "采用已完成结果", exact: true }).count(), 0);
  await recovery.getByRole("button", { name: "核对现场", exact: true }).click();
  await recovery.getByText("已找到终态", { exact: true }).waitFor();
  const adopt = recovery.getByRole("button", { name: "采用已完成结果", exact: true });
  assert.equal(await adopt.isDisabled(), true, "adoption lacks a side-effect note");
  await recovery.getByLabel("副作用核对结论", { exact: true }).fill("受控已完成结果及副作用均已核对。");
  await page.locator(".toast").waitFor({ state: "hidden" });
  await windowSize(application, page, 1500, 980, "recovery-checked");
  await windowSize(application, page, 1050, 760, "recovery-checked");
  await adopt.click();
  await page.locator(".dock-header .status-badge").filter({ hasText: "已暂停" }).waitFor();
  assert.equal(await recovery.count(), 0, "adopted result remains marked uncertain");
  assert.deepEqual(
    (await application.evaluate(() => globalThis.__reliabilityCalls)).map((call) => call.action),
    ["inspect", "inspect", "accept"],
    "adoption unexpectedly dispatched a rerun",
  );

  await application.evaluate(() => globalThis.__reliabilitySelectScenario("failed"));
  await recovery.waitFor();
  assert.equal(await directRerun.isDisabled(), true);
  await recovery.getByRole("button", { name: "核对现场", exact: true }).click();
  await recovery.getByText("已找到终态", { exact: true }).waitFor();
  assert.equal(await recovery.getByRole("button", { name: "采用已完成结果", exact: true }).count(), 0);
  const confirm = recovery.getByRole("button", { name: "确认副作用后重跑", exact: true });
  assert.equal(await confirm.isDisabled(), true, "confirmation lacks a side-effect note");
  const recoveryDecision = "受控失败结果已核对，未发现需撤销的副作用。";
  await recovery.getByLabel("副作用核对结论", { exact: true }).fill(recoveryDecision);
  await confirm.click();
  await page.locator(".dock-header .status-badge").filter({ hasText: "待处理" }).waitFor();
  assert.equal(await directRerun.isEnabled(), true);
  assert.equal((await application.evaluate(() => globalThis.__reliabilityCalls)).at(-1).action, "confirm");
  await directRerun.click();
  await page.locator(".dock-header .status-badge").filter({ hasText: "执行中" }).waitFor();
  const calls = await application.evaluate(() => globalThis.__reliabilityCalls);
  assert.deepEqual(calls.map((call) => call.action), ["inspect", "inspect", "accept", "inspect", "confirm", "rerun"]);
  assert.equal(calls.at(-2).note, recoveryDecision);
  assert.equal(calls.at(-1).runId, created.id);
  assert.equal(calls.at(-1).nodeId, nodeId);

  assert.deepEqual(errors, []);
  console.log("PASS: new-task memory and decision SQLite/reload; awaiting-response and recovery UI gates; checked result adoption; explicit side-effect confirmation then rerun; manual reconnect; 1500x980/1050x760 Electron screenshots. Controlled fixtures do not prove real Codex recovery. No user Codex data accessed.");
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(results, "reliability-failure.png") }).catch(() => {});
  }
  throw error;
} finally {
  await application?.close();
}
