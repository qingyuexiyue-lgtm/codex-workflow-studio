// Real Electron main process and IPC, synthetic powerMonitor.emit('resume').
// No OS sleep, power-setting changes, real Codex process, or model work occurs.
import assert from "node:assert/strict";
import { _electron as electron } from "playwright";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { Store } = require("../desktop/store.cjs");
const root = path.resolve(".");
await mkdir(path.join(root, ".integration"), { recursive: true });
const directory = await mkdtemp(
  path.join(root, ".integration", "power-monitor-"),
);
const report = {
  directory,
  kind: "synthetic resume emitted on real Electron powerMonitor, not a physical OS sleep",
  scenarios: [],
};

async function until(label, check, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

const node = (id) => ({
  id,
  type: "step",
  position: { x: 0, y: 0 },
  data: {
    label: id,
    roleId: "shared",
    task: "Return a controlled fixture result.",
    outputPrompt: "Return the required JSON schema only.",
    allowQuestions: false,
    defaultRule: "Return blocked if impossible.",
    inputIds: [],
    terminalRoutes: ["done"],
    color: "mint",
  },
});

function workflow(scenario, cwd) {
  return {
    id: `power-${scenario}`,
    name: `Power ${scenario}`,
    description: "Controlled test",
    globalPrompt: "Fixture only. No tools, files, or user conversations.",
    maxReworks: 0,
    sandbox: "read-only",
    updatedAt: new Date().toISOString(),
    roles: [
      {
        id: "shared",
        name: "Fixture",
        model: "fixture-model",
        effort: "low",
        prompt: "Use the controlled result.",
        cwd,
        projectId: "fixture-project",
        sessionMode: "new",
        threadId: "",
      },
    ],
    nodes: scenario === "queued" ? [node("A"), node("B")] : [node("A")],
    edges: [],
  };
}

async function scenarioAcceptance(scenario) {
  const scenarioDirectory = path.join(directory, scenario);
  const serverDirectory = path.join(scenarioDirectory, "server");
  const dataDirectory = path.join(scenarioDirectory, "data");
  await mkdir(serverDirectory, { recursive: true });
  await mkdir(dataDirectory);
  await copyFile(
    path.join(root, "scripts/fixtures/power-app-server.mjs"),
    path.join(serverDirectory, "app-server"),
  );
  const env = {
    ...process.env,
    STUDIO_CODEX_PATH: process.execPath,
    STUDIO_DATA_DIR: dataDirectory,
    STUDIO_POWER_SCENARIO: scenario,
    CODEX_HOME: path.join(scenarioDirectory, "codex-home"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = { scenario, checks: [] };
  let application;
  try {
    application = await electron.launch(
      process.env.STUDIO_TEST_EXE
        ? {
            executablePath: path.resolve(process.env.STUDIO_TEST_EXE),
            args: [],
            cwd: serverDirectory,
            env,
          }
        : { args: [root], cwd: serverDirectory, env },
    );
    const page = await application.firstWindow();
    await until(
      "Electron App Server connection",
      async () =>
        (await page.evaluate(() => window.studio.boot())).connection.status ===
        "connected",
    );
    const created = await page.evaluate(
      (graph) =>
        window.studio.start(graph, "Controlled power-resume acceptance.", ""),
      workflow(scenario, scenarioDirectory),
    );
    const readRun = () =>
      page.evaluate(
        (id) =>
          window.studio
            .boot()
            .then((boot) => boot.runs.find((run) => run.id === id)),
        created.id,
      );
    const before = await until(`${scenario} target state`, async () => {
      const run = await readRun();
      const first = run.states.A;
      if (scenario === "thread-pending")
        return first.attempts[0]?.operation === "thread/start" ? run : null;
      if (scenario === "turn-pending")
        return first.attempts[0]?.operation === "turn/start" && !first.turnId
          ? run
          : null;
      if (scenario === "queued")
        return first.turnId &&
          run.states.B.status === "queued" &&
          run.states.B.attempt === 0
          ? run
          : null;
      if (scenario === "terminal")
        return run.status === "completed" ? run : null;
      return first.turnId && first.attempts[0]?.operation === "turn/active"
        ? run
        : null;
    });
    const delivered = await application.evaluate(({ powerMonitor }) => ({
      listeners: powerMonitor.listenerCount("resume"),
      emitted: powerMonitor.emit("resume"),
    }));
    assert.ok(
      delivered.listeners >= 1 && delivered.emitted,
      "real Electron main process did not receive powerMonitor resume",
    );
    result.before = before;
    const after = await readRun();
    result.afterResume = after;

    if (scenario === "terminal") {
      assert.deepEqual(
        after,
        before,
        "a completed run was changed by the later resume event",
      );
      result.checks.push("terminal run unchanged after resume");
    } else {
      assert.equal(after.status, "interrupted");
      assert.equal(after.states.A.status, "interrupted");
      assert.equal(after.states.A.recovery.reason, "sleep");
      assert.equal(after.states.A.recovery.required, true);
      assert.equal(after.states.A.attempts[0].status, "unknown");
      assert.equal(after.states.A.attempts[0].finishedAt, null);
      if (scenario === "queued") {
        assert.equal(after.states.B.status, "interrupted");
        assert.equal(after.states.B.attempt, 0);
        assert.equal(after.states.B.recovery, undefined);
        result.checks.push(
          "running attempt requires inspection; queued step was never sent",
        );
      } else
        result.checks.push(
          `${scenario} attempt retained as unknown without automatic replay`,
        );

      if (scenario === "thread-pending") {
        assert.equal(after.states.A.threadId, "");
        await writeFile(
          path.join(serverDirectory, ".release-thread"),
          "release",
        );
        await until("late thread/start response", async () => {
          try {
            await readFile(path.join(serverDirectory, ".thread-released"));
            return true;
          } catch (error) {
            if (error.code === "ENOENT") return false;
            throw error;
          }
        });
        const inspected = await page.evaluate(
          (id) => window.studio.inspectRecovery(id, "A"),
          created.id,
        );
        assert.equal(inspected.turnStatus, "notStarted");
        await page.evaluate(
          (id) =>
            window.studio.confirmRecovery(
              id,
              "A",
              "No turn/start was sent; controlled local side effects checked.",
            ),
          created.id,
        );
        result.checks.push(
          "late thread creation did not dispatch a turn; pre-turn recovery confirmed",
        );
      } else {
        await writeFile(path.join(serverDirectory, ".release-turn"), "release");
        await until(
          "late turn response and terminal notification",
          async () => {
            try {
              await readFile(path.join(serverDirectory, ".turn-released"));
              return true;
            } catch (error) {
              if (error.code === "ENOENT") return false;
              throw error;
            }
          },
        );
        const inspected = await until(
          "exact persisted turn history",
          async () => {
            const recovery = await page.evaluate(
              (id) => window.studio.inspectRecovery(id, "A"),
              created.id,
            );
            return recovery.phase === "terminal" ? recovery : null;
          },
        );
        assert.equal(inspected.turnStatus, "completed");
        await page.evaluate(
          (id) =>
            window.studio.acceptRecoveryResult(
              id,
              "A",
              "Controlled exact turn and side effects checked.",
            ),
          created.id,
        );
        const adopted = await readRun();
        assert.equal(adopted.status, "paused");
        assert.equal(adopted.states.A.output.content, `POWER-${scenario}-DONE`);
        assert.equal(adopted.states.A.attempt, 1);
        if (scenario === "queued") assert.equal(adopted.states.B.attempt, 0);
        result.checks.push(
          "late result adopted from exact history; no dispatch repeated",
        );
      }
    }
    const requests = (
      await readFile(path.join(serverDirectory, "requests.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    result.calls = requests;
    assert.equal(
      requests.filter((call) => call.method === "thread/start").length,
      1,
    );
    assert.equal(
      requests.filter((call) => call.method === "turn/start").length,
      scenario === "thread-pending" ? 0 : 1,
    );
    assert.equal(
      requests.filter((call) => call.method === "turn/interrupt").length,
      0,
    );
    result.checks.push("no duplicate start or implicit interrupt");
    result.final = await readRun();
    console.log(`POWER ${scenario}: ${result.checks.join("; ")}`);
  } catch (error) {
    result.error = { message: error.message, stack: error.stack };
    throw error;
  } finally {
    await application?.close();
    if (result.final) {
      const persisted = new Store(dataDirectory);
      try {
        assert.deepEqual(
          persisted.runs().find((run) => run.id === result.final.id),
          result.final,
        );
        result.checks.push("SQLite state persisted after Electron exit");
      } finally {
        persisted.close();
      }
    }
    report.scenarios.push(result);
  }
}

try {
  for (const scenario of [
    "running",
    "turn-pending",
    "thread-pending",
    "queued",
    "terminal",
  ])
    await scenarioAcceptance(scenario);
  console.log(
    "POWER MONITOR PASS: five isolated real-Electron synthetic resume scenarios.",
  );
} finally {
  await writeFile(
    path.join(directory, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log("Power-monitor report:", path.join(directory, "report.json"));
}
