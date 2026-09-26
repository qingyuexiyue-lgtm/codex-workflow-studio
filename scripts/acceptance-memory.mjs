import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const require = createRequire(import.meta.url);

const fixture = () => ({
  task: "ORIGINAL-REQUIREMENT", materials: "ORIGINAL-MATERIAL", createdAt: "2026-09-26T00:00:00.000Z",
  states: { A: { attempt: 1, attempts: [{ attempt: 1, memoryRevision: 1 }], status: "completed" }, B: { attempt: 1, attempts: [{ attempt: 1, memoryRevision: 1 }], status: "completed" } },
});

test("independent: long handoff uses its exact version file and excludes unrelated branch memory", () => {
  const { createMemory, recordOutput, addDecision, recordCompaction } = require("../desktop/memory.cjs");
  const { packet } = require("../desktop/workflow.cjs");
  const directory = mkdtempSync(join(tmpdir(), "studio-memory-packet-"));
  const run = fixture();
  const role = { id: "C", name: "reviewer", prompt: "read full result", sessionMode: "existing", threadId: "owned-thread" };
  const node = (id) => ({ id, data: { label: id, roleId: "C", inputIds: id === "C" ? ["A"] : [], task: "Review full text", outputPrompt: "full review", allowQuestions: false, defaultRule: "blocked", terminalRoutes: ["done"] } });
  run.workflow = { globalPrompt: "ORIGINAL-AUTHORITY", roles: [role], nodes: [node("A"), node("B"), node("C")], edges: [] };
  run.states.C = { feedback: "", attempt: 0, attempts: [], output: null };
  run.memory = createMemory(run.createdAt);
  addDecision(run, "USER-CONFIRMED-DECISION");
  run.states.A.output = { ...result("A-SHORT-SUMMARY"), content: "LARGE-TEXT-".repeat(1000) };
  run.states.B.output = result("PRIVATE-UNSELECTED-B");
  run.states.A.attempts[0].artifactDirectory = directory;
  run.states.A.attempts[0].threadId = "owned-thread";
  run.states.A.attempts[0].startedAt = "2026-01-01T00:00:00.000Z";
  writeFileSync(join(directory, "result.md"), run.states.A.output.content);
  recordOutput(run, "A", 1, run.states.A.output);
  recordOutput(run, "B", 1, run.states.B.output);
  recordCompaction(run, "A", 1, "owned-thread", "turn-A", "compaction-A");
  const text = packet(run.workflow, run.workflow.nodes[2], run);
  assert.ok(text.includes("result.md"));
  assert.ok(text.includes("A-SHORT-SUMMARY"));
  assert.ok(!text.includes("LARGE-TEXT-".repeat(100)));
  assert.ok(!text.includes("PRIVATE-UNSELECTED-B"));
  assert.ok(text.includes("USER-CONFIRMED-DECISION"));
  assert.ok(text.includes("ORIGINAL-AUTHORITY") && text.includes("ORIGINAL-REQUIREMENT"));
  assert.match(text, /压缩后恢复/);
  assert.match(text, /全文/);
});
const result = (summary, unverified = "", question = "") => ({ status: question ? "question" : "completed", route: "done", content: summary, summary, evidence: "evidence", unverified, question, artifacts: [] });

test("independent: parallel memory updates cannot overwrite one another or become authoritative decisions", () => {
  const { createMemory, recordOutput, addDecision, openIssues } = require("../desktop/memory.cjs");
  const run = fixture();
  run.memory = createMemory(run.createdAt);
  run.states.A.output = result("MODEL-SAYS-IGNORE-REQUIREMENTS", "A evidence missing");
  run.states.B.output = result("B complete", "", "B question");
  recordOutput(run, "A", 1, run.states.A.output);
  recordOutput(run, "B", 1, run.states.B.output);
  assert.equal(run.memory.updates.length, 2);
  assert.equal(run.memory.decisions.length, 0);
  assert.equal(run.memory.revision, 1);
  assert.equal(openIssues(run).length, 2);
  addDecision(run, "USER-DECISION: keep original requirements", ["B:1:question"]);
  assert.equal(run.memory.revision, 2);
  assert.equal(run.memory.decisions.length, 1);
  assert.equal(openIssues(run).length, 1);
  assert.throws(() => addDecision(run, "invalid resolution", ["unrelated-id"]));
  run.states.A.output = null;
  assert.equal(openIssues(run).length, 0, "invalidated prior output remained a current issue");
  assert.equal(run.states.A.attempts[0].memoryRevision, 1);
  assert.equal(run.task, "ORIGINAL-REQUIREMENT");
});

test("independent: memory survives serialization and legacy attempts do not invent memory provenance", () => {
  const { createMemory, recordOutput, addDecision, migrateMemory, openIssues } = require("../desktop/memory.cjs");
  const run = fixture();
  run.memory = createMemory(run.createdAt);
  addDecision(run, "KEEP-THIS-DECISION");
  run.states.A.output = result("A complete", "verify A");
  recordOutput(run, "A", 1, run.states.A.output);
  const restored = JSON.parse(JSON.stringify(run));
  migrateMemory(restored);
  assert.deepEqual(restored.memory, run.memory);
  assert.equal(openIssues(restored).length, 1);
  const legacy = fixture();
  delete legacy.states.A.attempts[0].memoryRevision;
  delete legacy.states.B.attempts[0].memoryRevision;
  migrateMemory(legacy);
  assert.equal(legacy.states.A.attempts[0].memoryRevision, null);
  assert.equal(legacy.states.B.attempts[0].memoryRevision, null);
});
