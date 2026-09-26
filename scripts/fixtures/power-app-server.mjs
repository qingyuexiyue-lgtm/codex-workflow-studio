// Controlled stdio App Server for real Electron powerMonitor wiring acceptance.
// It never contacts Codex, a model, or user conversations.
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const scenario = process.env.STUDIO_POWER_SCENARIO;
const directory = process.cwd();
const result = {
  status: "completed",
  route: "done",
  content: `POWER-${scenario}-DONE`,
  summary: `POWER-${scenario}-DONE`,
  evidence: "controlled Electron fixture",
  unverified: "",
  question: "",
  artifacts: [],
};
const finalText = JSON.stringify(result);
const reply = (id, value) =>
  process.stdout.write(JSON.stringify({ id, result: value }) + "\n");
const notify = (method, params) =>
  process.stdout.write(JSON.stringify({ method, params }) + "\n");
let pendingThread;
let activeTurn;
let sequence = 0;

function completeTurn() {
  if (!activeTurn || activeTurn.completed) return;
  activeTurn.completed = true;
  notify("item/completed", {
    threadId: activeTurn.params.threadId,
    turnId: activeTurn.turnId,
    item: {
      id: `answer-${activeTurn.turnId}`,
      type: "agentMessage",
      phase: "final_answer",
      text: finalText,
    },
  });
  notify("turn/completed", {
    threadId: activeTurn.params.threadId,
    turn: { id: activeTurn.turnId, status: "completed" },
  });
}

setInterval(() => {
  if (pendingThread && existsSync(join(directory, ".release-thread"))) {
    reply(pendingThread.id, { thread: { id: pendingThread.threadId } });
    pendingThread = null;
    writeFileSync(join(directory, ".thread-released"), "done");
  }
  if (
    !activeTurn ||
    activeTurn.released ||
    !existsSync(join(directory, ".release-turn"))
  )
    return;
  if (activeTurn.pendingResponse) {
    reply(activeTurn.id, {
      turn: { id: activeTurn.turnId, status: "inProgress" },
    });
    activeTurn.pendingResponse = false;
  }
  completeTurn();
  writeFileSync(join(directory, ".turn-released"), "done");
  activeTurn.released = true;
}, 30).unref();

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (!("id" in request)) return;
  const { id, method, params } = request;
  appendFileSync(
    join(directory, "requests.jsonl"),
    JSON.stringify({ method, threadId: params?.threadId || null }) + "\n",
  );
  if (method === "initialize") {
    reply(id, { serverInfo: { name: "power-fixture", version: "1" } });
  } else if (method === "thread/start") {
    const threadId = `power-thread-${scenario}`;
    if (scenario === "thread-pending") pendingThread = { id, threadId };
    else reply(id, { thread: { id: threadId } });
  } else if (method === "thread/resume") {
    reply(id, { thread: { id: params.threadId } });
  } else if (method === "turn/start") {
    const turnId = `power-turn-${scenario}-${++sequence}`;
    activeTurn = {
      id,
      params,
      turnId,
      completed: false,
      pendingResponse: scenario === "turn-pending",
    };
    if (!activeTurn.pendingResponse)
      reply(id, { turn: { id: turnId, status: "inProgress" } });
    notify("turn/started", {
      threadId: params.threadId,
      turn: { id: turnId, status: "inProgress" },
    });
    if (scenario === "terminal") setTimeout(completeTurn, 40);
  } else if (method === "thread/turns/list") {
    reply(id, {
      data: activeTurn
        ? [
            {
              id: activeTurn.turnId,
              status: activeTurn.completed ? "completed" : "inProgress",
              items: [
                { type: "userMessage", content: activeTurn.params.input },
                ...(activeTurn.completed
                  ? [
                      {
                        type: "agentMessage",
                        phase: "final_answer",
                        text: finalText,
                      },
                    ]
                  : []),
              ],
            },
          ]
        : [],
      nextCursor: null,
    });
  } else {
    process.stdout.write(
      JSON.stringify({
        id,
        error: { code: -32601, message: `Unsupported: ${method}` },
      }) + "\n",
    );
  }
});
