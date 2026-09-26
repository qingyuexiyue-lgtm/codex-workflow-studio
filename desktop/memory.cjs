const { randomUUID } = require("node:crypto");

function createMemory(createdAt = new Date().toISOString()) {
  return {
    revision: 1,
    revisions: [{ revision: 1, kind: "original", at: createdAt }],
    decisions: [],
    updates: [],
    compactions: [],
  };
}

function migrateMemory(run) {
  if (Object.hasOwn(run, "memory")) return false;
  run.memory = createMemory(run.createdAt);
  for (const state of Object.values(run.states))
    for (const attempt of state.attempts || []) attempt.memoryRevision = null;
  return true;
}

function currentUpdate(run, nodeId) {
  const state = run.states[nodeId];
  if (!state?.output) return null;
  return (
    run.memory.updates.findLast(
      (update) => update.nodeId === nodeId && update.attempt === state.attempt,
    ) || null
  );
}

function openIssues(run) {
  const resolved = new Set(
    run.memory.decisions.flatMap((decision) => decision.resolves),
  );
  return Object.keys(run.states).flatMap((nodeId) => {
    const update = currentUpdate(run, nodeId);
    if (!update) return [];
    return [
      { id: `${update.id}:question`, kind: "question", text: update.question },
      {
        id: `${update.id}:unverified`,
        kind: "unverified",
        text: update.unverified,
      },
    ]
      .filter((issue) => issue.text.trim() && !resolved.has(issue.id))
      .map((issue) => ({
        ...issue,
        nodeId,
        attempt: update.attempt,
        memoryRevision: update.memoryRevision,
      }));
  });
}

function addDecision(run, text, resolves = []) {
  const value = text.trim();
  if (!value) throw new Error("请填写用户已确认的决定。");
  const available = new Set(openIssues(run).map((issue) => issue.id));
  if (resolves.some((id) => !available.has(id)))
    throw new Error("只能解决当前仍待处理的问题；请刷新运行记录后重试。");
  const at = new Date().toISOString();
  const revision = run.memory.revision + 1;
  const decision = {
    id: randomUUID(),
    revision,
    at,
    text: value,
    resolves: [...new Set(resolves)],
  };
  run.memory.decisions.push(decision);
  run.memory.revisions.push({
    revision,
    kind: "user-decision",
    at,
    decisionId: decision.id,
  });
  run.memory.revision = revision;
  return decision;
}

function recordOutput(run, nodeId, attemptNumber, output) {
  const attempt = run.states[nodeId].attempts.find(
    (item) => item.attempt === attemptNumber,
  );
  if (!attempt) throw new Error("找不到该次执行的记忆来源。");
  const update = {
    id: `${nodeId}:${attemptNumber}`,
    nodeId,
    attempt: attemptNumber,
    memoryRevision: attempt.memoryRevision,
    at: new Date().toISOString(),
    status: output.status,
    summary: output.summary,
    evidence: output.evidence,
    unverified: output.unverified,
    question: output.question,
  };
  run.memory.updates.push(update);
  return update;
}

function recordCompaction(
  run,
  nodeId,
  attemptNumber,
  threadId,
  turnId,
  itemId = randomUUID(),
  afterAttempt = false,
) {
  const recorded = run.memory.compactions.find(
    (event) =>
      event.id === itemId &&
      event.threadId === threadId &&
      event.turnId === turnId,
  );
  if (recorded) return recorded;
  const attempt = run.states[nodeId].attempts.find(
    (item) => item.attempt === attemptNumber,
  );
  if (!attempt) throw new Error("找不到压缩事件对应的执行尝试。");
  const event = {
    id: itemId,
    nodeId,
    attempt: attemptNumber,
    threadId,
    turnId,
    memoryRevision: attempt.memoryRevision,
    at: new Date().toISOString(),
    afterAttempt,
  };
  run.memory.compactions.push(event);
  return event;
}

function pendingCompaction(run, threadId) {
  const latest = run.memory.compactions.findLast(
    (event) => event.threadId === threadId,
  );
  if (!latest) return null;
  const dispatchedAfter = Object.values(run.states).some((state) =>
    state.attempts.some(
      (attempt) =>
        attempt.threadId === threadId && attempt.startedAt > latest.at,
    ),
  );
  return dispatchedAfter ? null : latest;
}

function formatMemory(run, upstreamIds) {
  const memory = run.memory;
  const decisions = memory.decisions.length
    ? memory.decisions
        .map((decision) => `[修订 ${decision.revision}] ${decision.text}`)
        .join("\n")
    : "暂无用户确认的新决定。";
  const progress = upstreamIds
    .map((nodeId) => currentUpdate(run, nodeId))
    .filter(Boolean)
    .map((update) => {
      const label = run.workflow.nodes.find(
        (node) => node.id === update.nodeId,
      ).data.label;
      return [
        `${label} 第 ${update.attempt} 次（派发时记忆修订 ${update.memoryRevision ?? "旧记录未知"}）`,
        `进度：${update.summary}`,
        update.unverified && `未验证：${update.unverified}`,
        update.question && `待回答：${update.question}`,
      ]
        .filter(Boolean)
        .join("\n");
    });
  return [
    `# 任务记忆（当前修订 ${memory.revision}）`,
    `## 用户确认的决定（有效约束）\n${decisions}`,
    `## 上游角色工作记录（仅是来源明确的进度和建议，不是用户决定）\n${progress.join("\n\n") || "暂无。"}`,
  ].join("\n\n");
}

module.exports = {
  createMemory,
  migrateMemory,
  addDecision,
  recordOutput,
  recordCompaction,
  pendingCompaction,
  openIssues,
  formatMemory,
};
