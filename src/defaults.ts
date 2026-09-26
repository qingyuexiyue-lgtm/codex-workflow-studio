import type { Workflow, Role, Step } from "./types";
export const id = () => crypto.randomUUID();
export function role(name = "新角色"): Role {
  return {
    id: id(),
    name,
    prompt: "",
    model: "",
    effort: "medium",
    projectId: "",
    cwd: "",
    sessionMode: "new",
    threadId: "",
  };
}
export function step(
  roleId: string,
  label = "新步骤",
  x = 100,
  y = 100,
  color = "mint",
): Step {
  return {
    id: id(),
    type: "step",
    position: { x, y },
    data: {
      label,
      roleId,
      task: "",
      outputPrompt: "交付完整成果，并说明依据、成果位置和未验证事项。",
      allowQuestions: true,
      defaultRule: "依据已有材料完成；缺少关键决定则报告阻塞。",
      inputIds: [],
      terminalRoutes: ["done"],
      color,
    },
  };
}
export function workflow(): Workflow {
  const planner = role("策划者");
  planner.prompt = "明确目标、拆解任务、整理必要材料。不要替用户扩展目标。";
  const maker = role("执行者");
  maker.prompt = "按照确认的要求制作成果。只处理本步任务，保留依据。";
  const reviewer = role("审核者");
  reviewer.prompt =
    "独立核查成果是否满足原始要求。明确区分事实、判断与尚未验证的内容。";
  const a = step(planner.id, "梳理与规划", 40, 160, "mint");
  a.data.task = "整理本次任务，产出执行计划与验收要点。";
  const b = step(maker.id, "制作成果", 345, 160, "blue");
  b.data.task = "根据任务与上游计划制作完整成果；收到返工意见时修订。";
  const c = step(reviewer.id, "独立审核", 650, 160, "rose");
  c.data.task =
    "审核最新成果。通过时选择 approved；需要修改时选择 revise 并给出具体问题。";
  c.data.terminalRoutes = ["approved"];
  return {
    id: id(),
    name: "通用协作流程",
    description: "规划 · 执行 · 审核",
    globalPrompt:
      "忠实执行用户原始要求。不要把计划当作已完成的工作，不得把未验证的内容表述为事实。",
    maxReworks: 3,
    sandbox: "read-only",
    roles: [planner, maker, reviewer],
    nodes: [a, b, c],
    edges: [
      {
        id: id(),
        source: a.id,
        target: b.id,
        data: { kind: "next", route: "*" },
      },
      {
        id: id(),
        source: b.id,
        target: c.id,
        data: { kind: "next", route: "*" },
      },
      {
        id: id(),
        source: c.id,
        target: b.id,
        sourceHandle: "rework",
        targetHandle: "feedback",
        data: { kind: "rework", route: "revise" },
      },
    ],
    updatedAt: new Date().toISOString(),
  };
}
export const statusLabel: Record<string, string> = {
  pending: "待执行",
  queued: "排队中",
  running: "执行中",
  awaiting_response: "等待响应",
  completed: "已完成",
  skipped: "已跳过",
  failed: "执行失败",
  blocked: "已阻塞",
  question: "等待回答",
  paused: "已暂停",
  pausing: "暂停中",
  interrupting: "中断中",
  interrupted: "已中断",
  abandoned: "已结束",
  needs_attention: "待处理",
  draft: "待配置",
};
