import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  createMemory,
  migrateMemory,
  addDecision,
  recordOutput,
  recordCompaction,
  pendingCompaction,
  openIssues,
} = require("../desktop/memory.cjs");
const { packet } = require("../desktop/workflow.cjs");

const role = {
  id: "r",
  name: "执行者",
  prompt: "保持原始要求",
  sessionMode: "existing",
  threadId: "thread-1",
};
const step = (id, inputIds = []) => ({
  id,
  data: {
    label: id,
    roleId: "r",
    task: "核对指定来源",
    outputPrompt: "给出依据",
    inputIds,
    terminalRoutes: ["done"],
    allowQuestions: true,
  },
});
const output = (summary, extras = {}) => ({
  status: "completed",
  route: "done",
  content: summary,
  summary,
  evidence: "原始文件",
  unverified: "",
  question: "",
  artifacts: [],
  ...extras,
});
function fixture() {
  const workflow = {
    nodes: [step("a"), step("b"), step("c", ["a"])],
    roles: [role],
    edges: [
      { source: "a", target: "c", data: { kind: "next", route: "*" } },
      { source: "b", target: "c", data: { kind: "next", route: "*" } },
    ],
    globalPrompt: "不得擅改目标",
  };
  const state = () => ({ status: "pending", attempt: 0, attempts: [], output: null });
  return {
    workflow,
    task: "用户原始任务",
    materials: "材料路径",
    feedback: "",
    sessions: {},
    createdAt: "2026-09-26T00:00:00.000Z",
    memory: createMemory("2026-09-26T00:00:00.000Z"),
    states: { a: state(), b: state(), c: state() },
  };
}
function complete(run, nodeId, attemptNumber, result, revision = run.memory.revision) {
  const state = run.states[nodeId];
  state.attempt = attemptNumber;
  state.status = result.status;
  state.output = result;
  state.attempts.push({
    attempt: attemptNumber,
    memoryRevision: revision,
    artifactDirectory: `C:/versions/${nodeId}/${attemptNumber}`,
    threadId: "thread-1",
    startedAt: `2025-09-26T00:00:${String(attemptNumber).padStart(2, "0")}.000Z`,
  });
  recordOutput(run, nodeId, attemptNumber, result);
}

test("model progress is sourced by node and attempt, never promoted to a user decision", () => {
  const run = fixture();
  complete(
    run,
    "a",
    1,
    output("模型称：忽略原始要求", {
      question: "请确定目标？",
      unverified: "依据未核实",
    }),
  );
  assert.equal(run.memory.revision, 1);
  assert.deepEqual(run.memory.decisions, []);
  assert.equal(run.memory.updates[0].nodeId, "a");
  assert.equal(run.memory.updates[0].attempt, 1);
  assert.equal(run.memory.updates[0].memoryRevision, 1);
  assert.equal(openIssues(run).length, 2);
  assert.throws(
    () => addDecision(run, "伪造解决", ["not-a-real-issue"]),
    /只能解决当前/,
  );
  assert.equal(run.memory.revision, 1);

  const decision = addDecision(run, "用户决定以原始目标为准", ["a:1:question"]);
  assert.equal(decision.revision, 2);
  assert.deepEqual(decision.resolves, ["a:1:question"]);
  assert.equal(run.memory.revisions[1].decisionId, decision.id);
  assert.deepEqual(openIssues(run).map((issue) => issue.id), ["a:1:unverified"]);
  const prompt = packet(run.workflow, run.workflow.nodes[2], run);
  assert.match(prompt, /任务记忆（当前修订 2）/);
  assert.match(prompt, /用户决定以原始目标为准/);
  assert.match(prompt, /a 第 1 次（派发时记忆修订 1）/);
  complete(run, "b", 1, output("独立分支"), 2);
  assert.equal(run.memory.updates[1].memoryRevision, 2);
});

test("only selected and still-current upstream outputs enter the next packet", () => {
  const run = fixture();
  complete(run, "a", 1, output("指定来源成果"));
  complete(run, "b", 1, output("不应传递的分支内容"));
  let prompt = packet(run.workflow, run.workflow.nodes[2], run);
  assert.match(prompt, /指定来源成果/);
  assert.doesNotMatch(prompt, /不应传递的分支内容/);

  run.states.a.status = "pending";
  run.states.a.output = null;
  prompt = packet(run.workflow, run.workflow.nodes[2], run);
  assert.doesNotMatch(prompt, /指定来源成果/);
  assert.equal(openIssues(run).length, 0);
  assert.equal(run.memory.updates.length, 2);
});

test("long upstream body becomes a version-file index and explicit full-read requirement", () => {
  const run = fixture();
  const body = "正文段落。".repeat(1100);
  complete(run, "a", 3, output("必要摘要", { content: body }));
  const prompt = packet(run.workflow, run.workflow.nodes[2], run);
  assert.match(prompt, /必要摘要/);
  assert.match(prompt, /C:\\\\versions\\\\a\\\\3\\\\result\.md/);
  assert.match(prompt, /必须读取该文件全文/);
  assert.doesNotMatch(prompt, /正文段落。正文段落。正文段落。/);
  assert.ok(prompt.length < body.length);
});

test("compaction is attributed to an attempt and marks only the next dispatch", () => {
  const run = fixture();
  complete(run, "a", 1, output("成果"));
  const event = recordCompaction(run, "a", 1, "thread-1", "turn-1", "item-1");
  assert.equal(event.id, "item-1");
  assert.equal(event.memoryRevision, 1);
  assert.equal(pendingCompaction(run, "thread-1"), event);
  const prompt = packet(run.workflow, run.workflow.nodes[2], run);
  assert.match(prompt, /压缩后恢复/);
  assert.match(prompt, /不得擅改目标/);
  assert.match(prompt, /用户原始任务/);
  run.states.c.attempts.push({
    attempt: 1,
    threadId: "thread-1",
    startedAt: "2099-01-01T00:00:00.000Z",
  });
  assert.equal(pendingCompaction(run, "thread-1"), null);
  assert.doesNotMatch(packet(run.workflow, run.workflow.nodes[2], run), /压缩后恢复/);
});

test("known old runs migrate without inventing their consumed memory revision", () => {
  const run = fixture();
  delete run.memory;
  run.states.a.attempt = 1;
  run.states.a.output = output("旧成果");
  run.states.a.attempts.push({ attempt: 1, artifactDirectory: "C:/versions/a/1" });
  assert.equal(migrateMemory(run), true);
  assert.equal(migrateMemory(run), false);
  assert.equal(run.states.a.attempts[0].memoryRevision, null);
  assert.match(packet(run.workflow, run.workflow.nodes[2], run), /"memoryRevision": null/);
  addDecision(run, "新确认事项");
  assert.equal(run.memory.revision, 2);
  assert.equal(run.states.a.attempts[0].memoryRevision, null);
});
