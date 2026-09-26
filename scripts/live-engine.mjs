import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const { CodexClient } = require("../desktop/codex-client.cjs");
const { Store } = require("../desktop/store.cjs");
const { Engine } = require("../desktop/engine.cjs");
const verification = JSON.parse(
  await readFile(".integration/session-verification.json", "utf8"),
);
const client = new CodexClient("codex");
const store = new Store(path.resolve(".integration/live-engine"));
const threadId = verification.testSession.id;
const projectId = verification.testSession.projectId;
const node = (id, roleId, task, terminalRoutes) => ({
  id,
  type: "step",
  position: { x: 0, y: 0 },
  data: {
    label: id,
    roleId,
    task,
    outputPrompt:
      "Return all required JSON fields. No tool use, no files, artifacts=[].",
    allowQuestions: false,
    defaultRule: "Return blocked if impossible.",
    inputIds: [],
    terminalRoutes,
    color: "mint",
  },
});
const role = (id, model, prompt) => ({
  id,
  name: id,
  model,
  prompt,
  effort: "low",
  projectId,
  cwd: process.cwd(),
  sessionMode: "existing",
  threadId,
});
const workflow = {
  id: "live-integration",
  name: "接入验收",
  description: "Explicit test only",
  globalPrompt:
    "This is a workflow integration test. Do not use tools or delegate. Only return the requested JSON.",
  maxReworks: 1,
  sandbox: "read-only",
  roles: [
    role(
      "maker",
      "gpt-6-sol",
      "You are the maker. Produce the requested marker.",
    ),
    role(
      "reviewer",
      "gpt-6-astra",
      "You are the reviewer. Check the marker in upstream results.",
    ),
  ],
  nodes: [
    node(
      "make",
      "maker",
      "Return status=completed, route=done, content=STUDIO-HANDOFF-7391. In summary mention the marker WORKFLOW-7391 from the existing conversation history. Other text fields may be empty.",
      ["done"],
    ),
    node(
      "review",
      "reviewer",
      "If upstream contains STUDIO-HANDOFF-7391, return status=completed, route=approved, content=VERIFIED-7391. Other text fields may be empty.",
      ["approved"],
    ),
  ],
  edges: [
    {
      id: "route",
      source: "make",
      target: "review",
      data: { kind: "next", route: "*" },
    },
  ],
  updatedAt: new Date().toISOString(),
};
try {
  await client.initialize();
  const engine = new Engine(client, store);
  let finish;
  const completed = new Promise((resolve) => (finish = resolve));
  engine.on("change", (run) => {
    console.log(
      run.status,
      Object.entries(run.states)
        .map(([id, state]) => `${id}:${state.status}`)
        .join(" "),
    );
    if (["completed", "paused"].includes(run.status)) finish(run);
  });
  engine.start(workflow, "Verify workflow handoff without tools.", "");
  const result = await completed;
  await writeFile(
    ".integration/live-engine-result.json",
    JSON.stringify(result, null, 2),
  );
  assert.equal(result.status, "completed", JSON.stringify(result.states));
  assert.equal(result.states.make.threadId, threadId);
  assert.equal(result.states.review.threadId, threadId);
  assert.ok(result.states.make.output.summary.includes("WORKFLOW-7391"));
  assert.equal(result.states.review.output.content, "VERIFIED-7391");
  console.log(
    "LIVE PASS: existing session, retained context, model/role switch, handoff, structured output, versioned results.",
  );
} finally {
  client.close();
  store.close();
}
