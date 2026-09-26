import { createInterface } from "node:readline";
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

const disconnectFlag = join(process.cwd(), ".disconnect");
setInterval(() => {
  if (!existsSync(disconnectFlag)) return;
  renameSync(disconnectFlag, join(process.cwd(), ".disconnected-once"));
  process.exit(23);
}, 100).unref();

// All requests terminate here; no model or user account is contacted.
let sequence = 0;
const reply = (id, result) =>
  process.stdout.write(JSON.stringify({ id, result }) + "\n");
const notify = (method, params) =>
  process.stdout.write(JSON.stringify({ method, params }) + "\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (!("id" in request)) return;
  const { id, method, params } = request;
  if (method === "initialize") {
    reply(id, { serverInfo: { name: "acceptance-fixture", version: "1" } });
  } else if (method === "project/list") {
    reply(id, {
      data: [{ id: "acceptance-project", name: "验收项目", roots: [{ path: process.cwd() }] }],
      nextCursor: null,
    });
  } else if (method === "thread/list") {
    reply(id, { data: [], nextCursor: null });
  } else if (method === "model/list") {
    reply(id, {
      data: [{
        id: "acceptance-model",
        model: "acceptance-model",
        displayName: "验收模型",
        supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      }],
    });
  } else if (method === "thread/start") {
    reply(id, { thread: { id: `acceptance-thread-${++sequence}` } });
  } else if (method === "thread/resume") {
    reply(id, { thread: { id: params.threadId } });
  } else if (method === "turn/start") {
    const turnId = `acceptance-turn-${++sequence}`;
    reply(id, { turn: { id: turnId, status: "inProgress" } });
    setTimeout(() => {
      notify("item/completed", {
        threadId: params.threadId,
        turnId,
        item: {
          type: "agentMessage",
          text: JSON.stringify({
            status: "question",
            route: "done",
            content: "受控验收结果：需要用户选择。",
            summary: "受控进度，不是用户决定。",
            evidence: "假 App Server fixture",
            unverified: "交付方式尚未确认。",
            question: "选择交付方式 A 或 B？",
            artifacts: [],
          }),
        },
      });
      notify("turn/completed", {
        threadId: params.threadId,
        turn: { id: turnId, status: "completed" },
      });
    }, 30);
  } else {
    process.stdout.write(JSON.stringify({
      id,
      error: { code: -32601, message: `Unsupported fixture method: ${method}` },
    }) + "\n");
  }
});
