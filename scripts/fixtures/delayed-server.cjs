const { createInterface } = require("node:readline");
let pending;
let sequence = 0;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "turn/start") {
    pending = message;
    pending.turnId = `late-owned-turn-${++sequence}`;
    send({ method: "test/received", params: { id: message.id } });
  } else if (message.method === "test/release") {
    const turn = pending;
    send({ id: turn.id, result: { turn: { id: turn.turnId } } });
    send({ id: message.id, result: {} });
    send({ method: "item/completed", params: { threadId: turn.params.threadId, turnId: turn.turnId, item: { type: "agentMessage", text: JSON.stringify({ status: "completed", route: "done", content: turn.params.model || "result", summary: "fixture", evidence: "fixture", unverified: "", question: "", artifacts: [] }) } } });
    send({ method: "turn/completed", params: { threadId: turn.params.threadId, turn: { id: turn.turnId, status: "completed", error: null } } });
  } else if (message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  } else {
    send({ id: message.id, result: {} });
  }
});
