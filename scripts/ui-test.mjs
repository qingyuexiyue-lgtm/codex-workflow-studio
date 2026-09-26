import { _electron as electron } from "playwright";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const testProject = process.env.STUDIO_TEST_PROJECT_NAME;
const testThread = process.env.STUDIO_TEST_THREAD_NAME;
const testThreadId = process.env.STUDIO_TEST_THREAD_ID;
if (!testProject || !testThread || !testThreadId)
  throw new Error("Set STUDIO_TEST_PROJECT_NAME, STUDIO_TEST_THREAD_NAME and STUDIO_TEST_THREAD_ID to dedicated test resources.");
await mkdir("test-results", { recursive: true });
const env = {
  ...process.env,
  STUDIO_DATA_DIR: await mkdtemp(path.resolve(".integration/ui-profile-")),
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
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByText("Codex 已连接", { exact: true }).waitFor();
  await page.locator(".step-node").first().waitFor();
  await page.screenshot({ path: "test-results/desktop.png" });
  await page.getByRole("button", { name: "输入与输出", exact: true }).click();
  const terminalRoutes = page.getByLabel("结束路线（逗号分隔）", { exact: true });
  await terminalRoutes.fill("done");
  await terminalRoutes.pressSequentially(", approved");
  assert.equal(await terminalRoutes.inputValue(), "done, approved");
  await page.getByRole("button", { name: "角色与会话", exact: true }).click();
  await page.getByLabel("模型", { exact: true }).selectOption({ index: 1 });
  await page
    .getByLabel("Codex 项目", { exact: true })
    .selectOption({ label: testProject });
  await page.getByRole("button", { name: "已有对话", exact: true }).click();
  await page.getByRole("button", { name: "选择已有对话", exact: true }).click();
  await page.getByLabel("搜索对话").fill(testThread);
  await page.locator(".thread-list>button").first().click();
  assert.ok(
    (await page.locator(".thread-id").textContent()).includes(testThreadId),
  );
  await page.getByRole("button", { name: "保存流程", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "输入与输出", exact: true }).click();
  assert.equal(await terminalRoutes.inputValue(), "done, approved");
  await page.getByRole("button", { name: "角色与会话", exact: true }).click();
  await page.locator(".thread-id").waitFor();
  assert.ok(
    (await page.locator(".thread-id").textContent()).includes(testThreadId),
  );
  await page.getByRole("button", { name: "查看历史", exact: true }).click();
  await page.locator(".preview-text").waitFor();
  assert.ok(
    (await page.locator(".preview-text").textContent()).includes("completed"),
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.getByRole("button", { name: "添加节点", exact: true }).click();
  assert.equal(await page.locator(".step-node").count(), 4);
  await page.getByRole("button", { name: "删除节点", exact: true }).click();
  assert.equal(await page.locator(".step-node").count(), 3);
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1050, 760),
  );
  await page.waitForFunction(() => {
    const canvas = document
      .querySelector(".canvas-area")
      .getBoundingClientRect();
    return [...document.querySelectorAll(".step-node")].every((node) => {
      const rect = node.getBoundingClientRect();
      return rect.left >= canvas.left && rect.right <= canvas.right;
    });
  });
  await page.screenshot({ path: "test-results/desktop-compact.png" });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  await page.getByRole("button", { name: "运行流程", exact: true }).click();
  await page
    .getByLabel("本次任务", { exact: true })
    .fill("UI validation only; do not run.");
  await page.getByRole("button", { name: "开始执行", exact: true }).click();
  await page.locator(".modal-error").waitFor();
  assert.ok(
    (await page.locator(".modal-error").textContent()).includes("请选择模型"),
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.getByRole("button", { name: "收起到托盘", exact: true }).click();
  assert.equal(
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isVisible(),
    ),
    false,
  );
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].show(),
  );
  console.log(
    "Electron UI: real catalog, existing thread binding, history, save, add/delete, compact viewport passed.",
  );
} finally {
  await application.close();
}
