import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  validate,
  readiness,
  descendants,
  packet,
} = require("../desktop/workflow.cjs");
const { SessionQueue } = require("../desktop/engine.cjs");

const role = {
  id: "r",
  name: "角色",
  model: "configured-model",
  cwd: "C:/project",
  prompt: "角色约束",
  sessionMode: "existing",
  threadId: "real-thread",
};
const node = (id) => ({
  id,
  data: {
    label: id,
    roleId: "r",
    task: "任务",
    outputPrompt: "要求",
    inputIds: [],
    terminalRoutes: ["done"],
    allowQuestions: false,
    defaultRule: "报告阻塞",
  },
});
const edge = (source, target, route = "*", kind = "next") => ({
  source,
  target,
  data: { route, kind },
});
const flow = () => ({
  nodes: ["a", "b", "c", "d"].map(node),
  roles: [role],
  edges: [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")],
  globalPrompt: "原始约束",
  maxReworks: 3,
});
const done = (route) => ({ status: "completed", output: { route } });
test("parallel join waits for every branch", () => {
  assert.equal(
    readiness(
      flow(),
      { a: done("done"), b: done("done"), c: { status: "running" } },
      "d",
    ),
    "waiting",
  );
  assert.equal(
    readiness(
      flow(),
      { a: done("done"), b: done("done"), c: done("done") },
      "d",
    ),
    "ready",
  );
});
test("unselected branches skip, merge can accept an active branch", () => {
  const workflow = flow();
  workflow.edges[0].data.route = "approved";
  assert.equal(readiness(workflow, { a: done("revise") }, "b"), "skip");
  assert.equal(
    readiness(workflow, { b: { status: "skipped" }, c: done("done") }, "d"),
    "ready",
  );
  assert.equal(
    readiness(
      workflow,
      { b: { status: "skipped" }, c: { status: "skipped" } },
      "d",
    ),
    "skip",
  );
});
test("normal cycles are rejected; explicit rework cycles are valid", () => {
  const workflow = flow();
  workflow.edges.push(edge("d", "a"));
  assert.ok(
    validate(workflow, "task").some((issue) => issue.includes("形成环")),
  );
  workflow.edges.at(-1).data.kind = "rework";
  assert.deepEqual(validate(workflow, "task"), []);
  assert.deepEqual([...descendants(workflow, "b")], ["b", "d"]);
});
test("missing existing conversation remains invalid instead of becoming a new conversation", () => {
  const workflow = flow();
  workflow.roles = [{ ...role, threadId: "" }];
  assert.ok(
    validate(workflow, "task").some((issue) => issue.includes("已有对话")),
  );
});
test("authoritative instructions and selected upstream output are packaged", () => {
  const workflow = flow();
  const run = {
    task: "原始任务",
    materials: "指定材料",
    feedback: "修订意见",
    states: {
      a: done("done"),
      b: { output: { content: "原文成果" } },
      c: { output: null },
      d: { output: null },
    },
  };
  const text = packet(workflow, workflow.nodes[3], run);
  for (const value of [
    "原始约束",
    "角色约束",
    "原始任务",
    "原文成果",
    "修订意见",
  ])
    assert.ok(text.includes(value));
});
test("shared sessions are serial; different sessions can overlap; failure is surfaced", async () => {
  const queue = new SessionQueue();
  const log = [];
  let finish;
  const first = queue.run("same", async () => {
    log.push("a-start");
    await new Promise((resolve) => (finish = resolve));
    log.push("a-end");
  });
  const second = queue.run("same", async () => log.push("b"));
  await queue.run("other", async () => log.push("parallel"));
  assert.deepEqual(log, ["a-start", "parallel"]);
  finish();
  await first;
  await second;
  assert.deepEqual(log, ["a-start", "parallel", "a-end", "b"]);
  await assert.rejects(
    queue.run("same", async () => {
      throw new Error("failure");
    }),
    /failure/,
  );
  await queue.run("same", async () => log.push("next"));
  assert.equal(log.at(-1), "next");
});
