import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { Engine } = require("../desktop/engine.cjs");
const { Store } = require("../desktop/store.cjs");
function fixture({ reworks = 1, review = "approved" } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "studio-engine-"));
  const store = new Store(directory);
  class Client extends EventEmitter {
    constructor() {
      super();
      this.count = 0;
      this.starts = [];
    }
    async request(method, params) {
      if (method === "thread/resume")
        return { thread: { id: params.threadId } };
      if (method === "thread/start") {
        this.starts.push(params);
        return { thread: { id: "new-thread" } };
      }
      if (method === "turn/start") {
        const turnId = String(++this.count);
        const route = params.model === "maker" ? "done" : review;
        const output = {
          status: "completed",
          route,
          content: "result-" + turnId,
          summary: "done",
          evidence: "test",
          unverified: "",
          question: "",
          artifacts: [],
        };
        setImmediate(() => {
          this.emit("notification", {
            method: "item/completed",
            params: {
              threadId: params.threadId,
              turnId,
              item: { type: "agentMessage", text: JSON.stringify(output) },
            },
          });
          this.emit("notification", {
            method: "turn/completed",
            params: {
              threadId: params.threadId,
              turn: { id: turnId, status: "completed" },
            },
          });
        });
        return { turn: { id: turnId } };
      }
      throw new Error(method);
    }
  }
  const client = new Client();
  const role = (id) => ({
    id,
    name: id,
    model: id,
    prompt: "role",
    cwd: directory,
    sessionMode: "existing",
    threadId: "same",
    effort: "low",
    projectId: "",
  });
  const node = (id) => ({
    id,
    data: {
      label: id,
      roleId: id,
      task: "task",
      outputPrompt: "complete",
      allowQuestions: true,
      defaultRule: "blocked",
      inputIds: [],
      terminalRoutes: id === "reviewer" ? ["approved"] : ["done"],
    },
  });
  const workflow = {
    id: "wf",
    name: "flow",
    maxReworks: reworks,
    globalPrompt: "requirements",
    sandbox: "read-only",
    roles: ["maker", "reviewer"].map(role),
    nodes: ["maker", "reviewer"].map(node),
    edges: [
      {
        id: "go",
        source: "maker",
        target: "reviewer",
        data: { kind: "next", route: "*" },
      },
      {
        id: "back",
        source: "reviewer",
        target: "maker",
        data: { kind: "rework", route: "revise" },
      },
    ],
  };
  const engine = new Engine(client, store);
  const finish = new Promise((resolve) =>
    engine.on("change", (run) => {
      if (["completed", "needs_attention"].includes(run.status)) resolve(run);
    }),
  );
  return { engine, client, store, workflow, finish };
}
test("engine finishes configured route and persists results and snapshots", async () => {
  const { engine, client, store, workflow, finish } = fixture();
  const run = engine.start(workflow, "task", "");
  workflow.globalPrompt = "later edit";
  const result = await finish;
  assert.equal(result.status, "completed");
  assert.equal(result.workflow.globalPrompt, "requirements");
  assert.equal(result.states.reviewer.attempts[0].snapshotIndex, 0);
  assert.equal(client.starts.length, 0);
  assert.equal(store.runs()[0].id, run.id);
  assert.equal(
    readFileSync(
      join(result.states.reviewer.artifactDirectory, "result.md"),
      "utf8",
    ),
    "result-2",
  );
  store.close();
});
test("rework preserves attempts and pauses at configured limit", async () => {
  const { engine, client, store, workflow, finish } = fixture({
    reworks: 1,
    review: "revise",
  });
  engine.start(workflow, "task", "");
  const result = await finish;
  assert.equal(result.status, "needs_attention");
  assert.equal(result.reworks, 1);
  assert.equal(client.count, 4);
  assert.equal(result.states.maker.attempt, 2);
  assert.match(result.error, /返工上限/);
  assert.equal(result.reworkRequests.length, 1);
  store.close();
});
test("executor failure pauses with no replacement thread or automatic replay", async () => {
  const { engine, client, store, workflow, finish } = fixture();
  client.request = async () => {
    throw new Error("active writer");
  };
  engine.start(workflow, "task", "");
  const result = await finish;
  assert.equal(result.states.maker.status, "failed");
  assert.equal(result.states.maker.error, "active writer");
  assert.equal(client.starts.length, 0);
  assert.equal(result.states.maker.attempt, 1);
  store.close();
});
test("restart marks in-flight state interrupted without automatically running", async () => {
  const { client, store, workflow } = fixture();
  store.saveRun({
    id: "unfinished",
    workflow,
    snapshots: [workflow],
    task: "task",
    materials: "",
    createdAt: new Date().toISOString(),
    status: "running",
    feedback: "",
    reworks: 0,
    sessions: {},
    states: {
      maker: {
        status: "running",
        attempt: 1,
        output: null,
        error: "",
        threadId: "same",
        turnId: "in-flight",
        logs: [],
        usage: null,
      },
      reviewer: {
        status: "pending",
        attempt: 0,
        output: null,
        error: "",
        threadId: "",
        turnId: "",
        logs: [],
        usage: null,
      },
    },
  });
  const engine = new Engine(client, store);
  const restored = engine.runs.get("unfinished");
  assert.equal(restored.status, "interrupted");
  assert.equal(restored.states.maker.status, "interrupted");
  assert.equal(client.count, 0);
  store.close();
});
