const { EventEmitter } = require("node:events");
const { randomUUID, createHash } = require("node:crypto");
const {
  mkdirSync,
  writeFileSync,
  statSync,
  copyFileSync,
  readFileSync,
  existsSync,
} = require("node:fs");
const { join, isAbsolute, basename } = require("node:path");
const {
  descendants,
  validate,
  readiness,
  packet,
  outputSchema,
} = require("./workflow.cjs");
const {
  createMemory,
  migrateMemory,
  addDecision,
  recordOutput,
  recordCompaction,
} = require("./memory.cjs");

const busyStatuses = new Set(["queued", "running", "awaiting_response"]);
const attentionStatuses = new Set([
  "question",
  "blocked",
  "failed",
  "interrupted",
]);
const terminalTurnStatuses = new Set(["completed", "failed", "interrupted"]);
const preTurnOperations = new Set(["preparing", "thread/resume", "thread/start"]);
const safeResumeFailures = new Set([
  "rateLimitExceeded",
  "serverOverloaded",
  "internalServerError",
]);

function safeToRetryResume(error) {
  return (
    Number.isInteger(error.code) &&
    safeResumeFailures.has(error.data?.codexErrorInfo)
  );
}

function finalAnswer(turn) {
  return turn.items.findLast(
    (item) => item.type === "agentMessage" && item.phase === "final_answer",
  )?.text;
}

function hasAttemptMarker(turn, marker) {
  return turn.items.some(
    (item) =>
      item.type === "userMessage" &&
      item.content.some((input) => input.type === "text" && input.text.includes(marker)),
  );
}

class SessionQueue {
  constructor() {
    this.jobs = new Map();
  }
  run(key, work) {
    const previous = this.jobs.get(key) || Promise.resolve();
    const next = previous.then(work, work);
    this.jobs.set(key, next);
    return next;
  }
}

class Engine extends EventEmitter {
  constructor(client, store) {
    super();
    this.store = store;
    this.queue = new SessionQueue();
    this.runs = new Map(store.runs().map((run) => [run.id, run]));
    this.active = new Map();
    this.pendingOperations = new Map();
    this.interruptions = new Map();
    this.suspended = false;
    this.closed = false;
    for (const run of this.runs.values()) {
      const legacy = !Object.hasOwn(run, "reworkRequests");
      if (legacy) {
        run.reworkRequests = run.reworkTarget
          ? [
              {
                source: "legacy",
                sourceAttempt: 0,
                target: run.reworkTarget,
                feedback: run.feedback,
              },
            ]
          : [];
        run.error = "";
        for (const [nodeId, state] of Object.entries(run.states)) {
          // Initial 0.1 records stored attempt files but no per-attempt index.
          state.attempts = Array.from({ length: state.attempt }, (_, index) => {
            const number = index + 1;
            const directory = join(
              this.store.directory,
              "artifacts",
              run.id,
              nodeId,
              String(number),
            );
            const handoff = join(directory, "handoff.json");
            const response = join(directory, "response.txt");
            const output = existsSync(handoff)
              ? JSON.parse(readFileSync(handoff, "utf8"))
              : number === state.attempt
                ? state.output
                : null;
            return {
              attempt: number,
              snapshotIndex: null,
              startedAt: "",
              finishedAt: null,
              status:
                output?.status ||
                (number === state.attempt ? state.status : "unknown"),
              artifactDirectory: existsSync(directory) ? directory : "",
              threadId: number === state.attempt ? state.threadId : "",
              turnId: number === state.attempt ? state.turnId : "",
              output,
              rawText: existsSync(response)
                ? readFileSync(response, "utf8")
                : "",
              error: number === state.attempt ? state.error : "",
              usage: number === state.attempt ? state.usage : null,
            };
          });
          state.feedback = "";
          state.rawText = state.attempt ? state.attempts.at(-1).rawText : "";
        }
      }
      const migratedMemory = migrateMemory(run);
      let interrupted = false;
      if (
        ["running", "pausing", "interrupting"].includes(run.status) ||
        Object.values(run.states).some((state) =>
          busyStatuses.has(state.status),
        )
      ) {
        run.status = "interrupted";
        for (const state of Object.values(run.states))
          if (busyStatuses.has(state.status)) {
            const queued = state.status === "queued";
            state.status = "interrupted";
            const attempt = state.attempts?.at(-1);
            if (!queued && attempt) {
              this.requireRecovery(state, attempt, "restart", "进程重启前的执行结果未知。请核对原 turn 与副作用。");
              state.error = state.recovery.detail;
              attempt.status = "unknown";
              attempt.finishedAt = null;
            } else if (queued) {
              state.error = "进程退出前仍在排队，本次未派发。";
            }
          }
        interrupted = true;
      }
      if (legacy || migratedMemory || interrupted) store.saveRun(run);
    }
    this.attachClient(client);
  }

  attachClient(client) {
    if (this.client) {
      this.client.off("notification", this.onNotification);
      this.client.off("disconnected", this.onDisconnected);
    }
    this.client = client;
    this.connected = !client.disconnected;
    this.onNotification = (message) => this.receive(message);
    this.onDisconnected = (message) => this.disconnect(message);
    client.on("notification", this.onNotification);
    client.on("disconnected", this.onDisconnected);
  }

  requireRecovery(state, attempt, reason, detail) {
    const recovery = {
      required: true,
      reason,
      phase: "inspect",
      detail,
    };
    state.recovery = recovery;
    attempt.recovery = recovery;
  }

  disconnect(message) {
    this.connected = false;
    for (const run of this.runs.values()) {
      let changed = false;
      for (const state of Object.values(run.states)) {
        if (!busyStatuses.has(state.status)) continue;
        const queued = state.status === "queued";
        state.status = "interrupted";
        if (!queued) {
          const attempt = state.attempts.at(-1);
          if (!state.recovery?.required)
            this.requireRecovery(state, attempt, "disconnect", `Codex 进程断连，结果未知：${message}`);
          state.error = state.recovery.detail;
          attempt.status = "unknown";
          attempt.finishedAt = null;
        } else {
          state.error = "Codex 进程断连前仍在排队，本次未派发。";
        }
        changed = true;
      }
      if (changed) {
        run.status = "interrupted";
        run.error = `Codex 进程断连：${message}`;
        this.publish(run);
      }
    }
    for (const cancel of this.pendingOperations.values())
      cancel(new Error(`Codex 进程断连：${message}`));
    for (const execution of this.active.values()) {
      if (execution.finished) continue;
      execution.finished = true;
      execution.finish({ status: "disconnected", error: message });
      if (!execution.turnId) execution.resolveTurnReady(null);
    }
  }

  markSleep() {
    for (const run of this.runs.values()) {
      let changed = false;
      for (const state of Object.values(run.states)) {
        if (!busyStatuses.has(state.status)) continue;
        const queued = state.status === "queued";
        state.status = "interrupted";
        if (queued) {
          state.error = "休眠前仍在排队，本次未派发。";
        } else {
          const attempt = state.attempts.at(-1);
          this.requireRecovery(state, attempt, "sleep", "系统休眠期间的原 turn 状态未知。请核对会话历史与副作用。");
          state.error = state.recovery.detail;
          attempt.status = "unknown";
          attempt.finishedAt = null;
        }
        changed = true;
      }
      if (changed) {
        run.status = "interrupted";
        run.error = "系统已从休眠恢复；未自动重放任何步骤。";
        this.publish(run);
      }
    }
    for (const cancel of this.pendingOperations.values())
      cancel(new Error("系统休眠后需核对原操作。"));
    for (const execution of this.active.values()) {
      if (execution.finished) continue;
      execution.finished = true;
      execution.finish({ status: "recovered" });
      if (!execution.turnId) execution.resolveTurnReady(null);
    }
  }

  publish(run) {
    if (this.closed) return;
    this.store.saveRun(run);
    this.emit("change", run);
  }

  start(workflow, task, materials) {
    if (!this.connected) throw new Error("Codex 进程已断连；请先手动重连并核对未完成运行。");
    if (
      [...this.runs.values()].some((run) => run.status !== "abandoned" &&
        Object.values(run.states).some(
          (state) => busyStatuses.has(state.status) || state.recovery?.required,
        ),
      )
    )
      throw new Error("已有执行或待核对的结果；请先完成当前运行的核对。");
    const issues = validate(workflow, task);
    if (issues.length) throw new Error(issues.join("\n"));
    for (const role of workflow.roles)
      if (role.sessionMode === "existing") this.checkEndedRunThread(role.threadId);
    const snapshot = structuredClone(workflow);
    const run = {
      id: randomUUID(),
      workflow: snapshot,
      snapshots: [snapshot],
      task,
      materials,
      createdAt: new Date().toISOString(),
      status: "running",
      error: "",
      feedback: "",
      reworks: 0,
      reworkRequests: [],
      memory: createMemory(),
      sessions: {},
      states: Object.fromEntries(
        workflow.nodes.map((node) => [
          node.id,
          {
            status: "pending",
            attempt: 0,
            attempts: [],
            output: null,
            rawText: "",
            error: "",
            feedback: "",
            threadId: "",
            turnId: "",
            logs: [],
            usage: null,
          },
        ]),
      ),
    };
    if (materials.length > 5000) {
      const inputs = join(this.store.directory, "artifacts", run.id, "inputs");
      mkdirSync(inputs, { recursive: true });
      run.materialsVersionPath = join(inputs, "materials.md");
      writeFileSync(run.materialsVersionPath, materials);
    }
    this.runs.set(run.id, run);
    this.publish(run);
    this.tick(run);
    return run;
  }

  affectedByRework(run) {
    const affected = new Set();
    for (const request of run.reworkRequests)
      for (const id of descendants(run.workflow, request.target))
        affected.add(id);
    return affected;
  }

  applyReworks(run) {
    if (!run.reworkRequests.length) return new Set();
    const affected = this.affectedByRework(run);
    if ([...affected].some((id) => busyStatuses.has(run.states[id].status)))
      return affected;
    if ([...affected].some((id) => run.states[id].recovery?.required)) {
      run.error = "返工路径中有尚未核对的原 turn；请先完成现场核对。";
      this.publish(run);
      return affected;
    }
    if (run.reworks + run.reworkRequests.length > run.workflow.maxReworks) {
      const error = `已达到返工上限；${run.reworkRequests.length} 个返工请求等待人工处理。`;
      if (run.error !== error) {
        run.error = error;
        this.publish(run);
      }
      return affected;
    }
    const requests = run.reworkRequests;
    run.reworks += requests.length;
    run.reworkRequests = [];
    run.error = "";
    for (const id of affected) this.resetState(run.states[id]);
    for (const request of requests) {
      const state = run.states[request.target];
      state.feedback = [state.feedback, request.feedback]
        .filter(Boolean)
        .join("\n\n");
    }
    run.feedback = requests.map((request) => request.feedback).join("\n\n");
    this.publish(run);
    return new Set();
  }

  tick(run) {
    const states = Object.values(run.states);
    const busy = states.some((state) => busyStatuses.has(state.status));
    if (this.suspended) return;
    if (run.status === "pausing" || run.status === "interrupting") {
      if (!busy) {
        run.status = run.status === "pausing" ? "paused" : "interrupted";
        this.publish(run);
      }
      return;
    }
    if (run.status !== "running") return;
    if (!this.connected) return;

    const affected = this.applyReworks(run);
    let skipped = false;
    const workflow = run.workflow;
    const snapshotIndex = run.snapshots.length - 1;
    for (const node of workflow.nodes) {
      const state = run.states[node.id];
      if (state.status !== "pending" || affected.has(node.id)) continue;
      const next = readiness(workflow, run.states, node.id);
      if (next === "skip") {
        state.status = "skipped";
        skipped = true;
        this.publish(run);
      } else if (next === "ready") {
        state.status = "queued";
        this.publish(run);
        const role = workflow.roles.find(
          (role) => role.id === node.data.roleId,
        );
        const knownThreadId =
          role.sessionMode === "existing"
            ? role.threadId
            : run.sessions[role.id];
        const key = knownThreadId
          ? `thread:${knownThreadId}`
          : `new:${run.id}:${role.id}`;
        this.queue
          .run(key, () => this.execute(run, workflow, node, snapshotIndex))
          .then(
            () => this.tick(run),
            (error) => {
              state.status = "failed";
              state.error = error.message;
              this.publish(run);
              this.tick(run);
            },
          );
      }
    }
    if (skipped) {
      this.tick(run);
      return;
    }
    const current = Object.values(run.states);
    if (
      !run.reworkRequests.length &&
      current.every((state) => ["completed", "skipped"].includes(state.status))
    ) {
      run.status = "completed";
      this.publish(run);
    } else if (
      !current.some((state) => busyStatuses.has(state.status)) &&
      (run.reworkRequests.length ||
        current.some((state) => attentionStatuses.has(state.status)))
    ) {
      run.status = "needs_attention";
      this.publish(run);
    }
  }

  async ownedRequest(run, state, attempt, method, params) {
    attempt.operation = method;
    this.publish(run);
    let cancel;
    const stopped = new Promise((_, reject) => (cancel = reject));
    this.pendingOperations.set(attempt, cancel);
    try {
      for (let retries = 0; ; retries++) {
        try {
          const result = await Promise.race([
            this.client.request(method, params, {
              onWaiting: () => {
                if (state.recovery?.required) return;
                state.status = "awaiting_response";
                state.recovery = {
                  required: false,
                  reason: "uncertain_start",
                  phase: "inspect",
                  detail: `${method} 已超过等待时间；请求可能仍在执行，不能重新发送。`,
                };
                attempt.recovery = state.recovery;
                this.publish(run);
              },
            }),
            stopped,
          ]);
          if (state.status === "awaiting_response" && !state.recovery?.required) {
            state.status = "running";
            delete state.recovery;
            delete attempt.recovery;
            this.publish(run);
          }
          return result;
        } catch (error) {
          if (
            Number.isInteger(error.code) &&
            state.status === "awaiting_response" &&
            !state.recovery?.required
          ) {
            state.status = "running";
            delete state.recovery;
            delete attempt.recovery;
            this.publish(run);
          }
          if (
            method !== "thread/resume" ||
            retries >= 2 ||
            state.recovery?.required ||
            !this.connected ||
            !safeToRetryResume(error)
          )
            throw error;
          attempt.safeRetries = retries + 1;
          state.logs.push({
            time: new Date().toISOString(),
            event: "execution/safe-retry",
            type: `${method} ${error.data.codexErrorInfo}`,
            attempt: attempt.attempt,
          });
          this.publish(run);
        }
      }
    } finally {
      this.pendingOperations.delete(attempt);
    }
  }

  completeOutput(run, workflow, node, state, attempt, rawText) {
    const directory = attempt.artifactDirectory;
    const output = JSON.parse(rawText);
    for (const key of outputSchema.required) {
      if (!(key in output)) throw new Error(`交接缺少字段：${key}`);
      if (key !== "artifacts" && typeof output[key] !== "string")
        throw new Error(`交接字段必须为文本：${key}`);
    }
    if (
      !Array.isArray(output.artifacts) ||
      output.artifacts.some((path) => typeof path !== "string")
    )
      throw new Error("artifacts 必须为路径数组。");
    if (!outputSchema.properties.status.enum.includes(output.status))
      throw new Error("交接状态不符合约定。");
    const routes = workflow.edges.filter((edge) => edge.source === node.id);
    if (
      output.status === "completed" &&
      !node.data.terminalRoutes.includes(output.route) &&
      !routes.some(
        (edge) => edge.data.route === "*" || edge.data.route === output.route,
      )
    )
      throw new Error(`未配置的路线：${output.route}`);
    if (output.status === "question" && !node.data.allowQuestions)
      throw new Error("当前节点禁止提问，但执行器请求了用户回答。");
    const manifest = [];
    for (const [index, path] of output.artifacts.entries()) {
      if (!isAbsolute(path) || !statSync(path).isFile())
        throw new Error(`成果不是有效的绝对文件路径：${path}`);
      const destination = join(directory, "files", `${index}-${basename(path)}`);
      mkdirSync(join(directory, "files"), { recursive: true });
      copyFileSync(path, destination);
      manifest.push({
        source: path,
        versionPath: destination,
        sha256: createHash("sha256")
          .update(readFileSync(destination))
          .digest("hex"),
      });
    }
    writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2));
    output.artifacts = manifest.map((file) => file.versionPath);
    writeFileSync(join(directory, "handoff.json"), JSON.stringify(output, null, 2));
    writeFileSync(join(directory, "result.md"), output.content);
    state.output = output;
    state.status = output.status;
    recordOutput(run, node.id, attempt.attempt, output);
    const reworks = routes.filter(
      (edge) => edge.data.kind === "rework" && edge.data.route === output.route,
    );
    if (output.status === "completed")
      for (const rework of reworks)
        run.reworkRequests.push({
          source: node.id,
          sourceAttempt: attempt.attempt,
          target: rework.target,
          feedback:
            output.content.length > 5000
              ? `${output.summary}\n完整返工意见版本文件：${join(directory, "result.md")}`
              : `${output.content}\n${output.summary}`,
        });
    return output;
  }

  async execute(run, workflow, node, snapshotIndex) {
    const state = run.states[node.id];
    if (state.status !== "queued") return;
    if (run.status !== "running" || this.suspended || !this.connected) {
      state.status = run.status === "interrupting" ? "interrupted" : "pending";
      this.publish(run);
      return;
    }
    if (this.affectedByRework(run).has(node.id)) {
      state.status = "pending";
      this.publish(run);
      return;
    }

    const role = workflow.roles.find((role) => role.id === node.data.roleId);
    state.status = "running";
    state.attempt++;
    state.error = "";
    state.output = null;
    state.rawText = "";
    state.turnId = "";
    state.usage = null;
    delete state.recovery;
    const directory = join(
      this.store.directory,
      "artifacts",
      run.id,
      node.id,
      String(state.attempt),
    );
    state.artifactDirectory = directory;
    const attempt = {
      attempt: state.attempt,
      snapshotIndex,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: "running",
      artifactDirectory: directory,
      threadId: "",
      turnId: "",
      output: null,
      rawText: "",
      error: "",
      usage: null,
      memoryRevision: run.memory.revision,
      marker: `WORKFLOW-STUDIO-${randomUUID()}`,
      operation: "preparing",
    };
    state.attempts.push(attempt);
    let threadId;
    let execution;
    try {
      mkdirSync(directory, { recursive: true });
      const prompt =
        packet(workflow, node, run) +
        `\n\n# 本步成果目录\n${directory}` +
        `\n\n<!-- ${attempt.marker} -->`;
      writeFileSync(join(directory, "task.md"), prompt);
      this.publish(run);
      const parameters = {
        model: role.model,
        cwd: role.cwd,
        sandbox: workflow.sandbox,
        approvalPolicy: "never",
      };
      if (role.sessionMode === "existing") {
        threadId = role.threadId;
        this.checkEndedRunThread(threadId);
        state.threadId = threadId;
        attempt.threadId = threadId;
        this.publish(run);
        await this.ownedRequest(run, state, attempt, "thread/resume", {
          threadId,
          ...parameters,
          excludeTurns: true,
        });
      } else if (Object.hasOwn(run.sessions, role.id)) {
        threadId = run.sessions[role.id];
        this.checkEndedRunThread(threadId);
        state.threadId = threadId;
        attempt.threadId = threadId;
        this.publish(run);
        await this.ownedRequest(run, state, attempt, "thread/resume", {
          threadId,
          ...parameters,
          excludeTurns: true,
        });
      } else {
        const created = await this.ownedRequest(run, state, attempt, "thread/start", {
          ...parameters,
          projectId: role.projectId || null,
        });
        threadId = created.thread.id;
        run.sessions[role.id] = threadId;
        this.publish(run);
      }
      state.threadId = threadId;
      attempt.threadId = threadId;
      this.publish(run);
      if (run.status === "interrupting") {
        state.status = "interrupted";
        state.error = "在启动 turn 前已中断。";
        return;
      }
      if (run.status === "interrupted" || run.status === "needs_attention") {
        state.status = "interrupted";
        return;
      }

      let finish;
      let resolveTurnReady;
      const completion = new Promise((resolve) => (finish = resolve));
      const turnReady = new Promise((resolve) => (resolveTurnReady = resolve));
      execution = {
        run,
        node,
        state,
        threadId,
        turnId: "",
        text: "",
        partialText: "",
        earlyMessages: [],
        finished: false,
        interruptRequested: false,
        protocolError: "",
        slowOperation: false,
        finish,
        turnReady,
        resolveTurnReady,
      };
      this.active.set(threadId, execution);
      const recoveredStart = new Promise(
        (resolve) => (execution.resolveRecoveryStart = resolve),
      );
      const started = await Promise.race([
        this.ownedRequest(run, state, attempt, "turn/start", {
          threadId,
          model: role.model,
          effort: role.effort,
          input: [{ type: "text", text: prompt, text_elements: [] }],
          outputSchema,
        }),
        recoveredStart,
      ]);
      if (!started) return;
      execution.turnId = started.turn.id;
      state.turnId = started.turn.id;
      attempt.turnId = started.turn.id;
      attempt.operation = "turn/active";
      execution.resolveTurnReady(started.turn.id);
      this.publish(run);
      for (const message of execution.earlyMessages) this.receive(message);
      execution.earlyMessages = [];
      delete attempt.earlyMessages;
      if (execution.reconciledTurn && !execution.finished) {
        execution.finished = true;
        execution.finish({ status: "recovered" });
      }

      const result = await completion;
      if (execution.text && !state.recovery?.finalAnswerText)
        state.rawText = execution.text;
      if (execution.text && !state.recovery?.finalAnswerText)
        writeFileSync(join(directory, "response.txt"), execution.text);
      if (
        state.recovery?.required ||
        result.status === "recovered" ||
        result.status === "disconnected"
      ) {
        state.status = "interrupted";
        if (!state.recovery?.required)
          this.requireRecovery(
            state,
            attempt,
            result.status === "recovered" ? "uncertain_start" : "disconnect",
            "原执行结果需核对会话历史与副作用。",
          );
        return;
      }
      attempt.operation = "turn/completed";
      if (result.status === "interrupted") {
        state.status = "interrupted";
        this.requireRecovery(
          state,
          attempt,
          "interruption",
          "Codex turn 已中断；请核对原 turn 与已发生的副作用后再重跑。",
        );
        state.recovery.turnStatus = "interrupted";
        state.error = state.recovery.detail;
        return;
      }
      if (result.status === "failed") throw new Error(result.error);
      this.completeOutput(run, workflow, node, state, attempt, execution.text);
    } catch (error) {
      if (
        !state.recovery?.required &&
        attempt.operation === "turn/start" &&
        !Number.isInteger(error.code)
      )
        this.requireRecovery(
          state,
          attempt,
          "uncertain_start",
          `turn/start 未得到明确响应；原 turn 和副作用需核对：${error.message}`,
        );
      if (!state.recovery?.required && attempt.operation === "turn/completed") {
        this.requireRecovery(
          state,
          attempt,
          "execution_failure",
          `原 turn ${execution.terminalStatus === "failed" ? "执行失败" : "已结束但成果未通过校验"}；重跑前须核对副作用：${error.message}`,
        );
        state.recovery.turnStatus = execution.terminalStatus;
      }
      if (state.recovery?.required) {
        state.status = attempt.operation === "turn/completed" ? "failed" : "interrupted";
        state.error = state.recovery.detail;
      } else {
        state.status = "failed";
        state.error = error.message;
        state.logs.push({
          time: new Date().toISOString(),
          event: "execution/failed",
          type: error.message,
          attempt: state.attempt,
        });
      }
    } finally {
      if (execution) {
        if (!execution.turnId) execution.resolveTurnReady(null);
        this.active.delete(threadId);
        if (execution.text && !state.recovery?.finalAnswerText)
          attempt.rawText = execution.text;
      }
      attempt.status =
        state.recovery?.required && !state.recovery.turnStatus
          ? "unknown"
          : state.status;
      attempt.output = state.output;
      attempt.error = state.error;
      attempt.usage = state.usage;
      attempt.finishedAt = state.recovery?.required && !state.recovery.turnStatus
        ? null
        : new Date().toISOString();
      this.publish(run);
    }
  }

  receive(message) {
    if (!message.params?.threadId) return;
    const execution = this.active.get(message.params.threadId);
    const turnId = message.params.turn?.id || message.params.turnId;
    if (!turnId) return;
    if (!execution) {
      if (
        message.method !== "item/completed" ||
        message.params.item?.type !== "contextCompaction"
      ) return;
      const owners = [...this.runs.values()].filter((run) =>
        ["running", "pausing", "paused", "needs_attention"].includes(run.status) &&
        Object.values(run.states).some((state) =>
          state.attempts.some((attempt) =>
            attempt.threadId === message.params.threadId && attempt.finishedAt,
          ),
        ),
      );
      if (owners.length !== 1) return;
      const run = owners[0];
      const latest = Object.entries(run.states)
        .flatMap(([nodeId, state]) => state.attempts.map((attempt) => ({ nodeId, attempt })))
        .filter(({ attempt }) =>
          attempt.threadId === message.params.threadId && attempt.finishedAt,
        )
        .sort((a, b) => b.attempt.startedAt.localeCompare(a.attempt.startedAt))[0];
      recordCompaction(
        run,
        latest.nodeId,
        latest.attempt.attempt,
        message.params.threadId,
        turnId,
        message.params.item.id,
        true,
      );
      this.publish(run);
      return;
    }
    if (!execution.turnId) {
      execution.earlyMessages.push(message);
      return;
    }
    if (turnId !== execution.turnId) return;
    const { run, state } = execution;
    if ("id" in message) {
      this.client.respondError(
        message.id,
        -32601,
        "This approval or elicitation is not supported by Workflow Studio 0.1.",
      );
      execution.protocolError = `当前版本未接入交互请求：${message.method}`;
      state.error = execution.protocolError;
    } else if (
      message.method === "item/completed" &&
      message.params.item.type === "agentMessage"
    ) {
      if (message.params.item.phase === "final_answer") {
        execution.finalText = message.params.item.text;
        execution.text = execution.finalText;
      } else if (!execution.finalText) {
        execution.text = message.params.item.text;
      }
    } else if (
      message.method === "item/completed" &&
      message.params.item.type === "contextCompaction"
    ) {
      recordCompaction(
        run,
        execution.node.id,
        state.attempt,
        execution.threadId,
        turnId,
        message.params.item.id,
      );
    } else if (message.method === "thread/tokenUsage/updated") {
      state.usage = message.params.tokenUsage;
    } else if (message.method === "turn/completed" && !execution.finished) {
      execution.finished = true;
      const turn = message.params.turn;
      execution.terminalStatus = turn.status;
      if (turn.status === "completed" && !execution.protocolError)
        execution.finish({ status: "completed" });
      else if (turn.status === "interrupted")
        execution.finish({ status: "interrupted" });
      else
        execution.finish({
          status: "failed",
          error:
            execution.protocolError ||
            turn.error?.message ||
            JSON.stringify(turn.error || { status: turn.status }),
        });
    }
    if (
      [
        "item/started",
        "item/completed",
        "turn/started",
        "turn/completed",
        "thread/compacted",
      ].includes(message.method) ||
      "id" in message
    )
      state.logs.push({
        time: new Date().toISOString(),
        event: message.method,
        type: message.params.item?.type || "",
        attempt: state.attempt,
        turnId,
      });
    this.publish(run);
  }

  recoveryAttempt(id, nodeId) {
    const run = this.runs.get(id);
    if (!run) throw new Error("找不到该运行记录。");
    const state = run.states[nodeId];
    if (!state) throw new Error("找不到该步骤。");
    const attempt = state.attempts.at(-1);
    if (!attempt || !state.recovery?.required)
      throw new Error("此步骤没有需要核对的执行尝试。");
    return { run, state, attempt };
  }

  async inspectRecovery(id, nodeId) {
    const { run, state, attempt } = this.recoveryAttempt(id, nodeId);
    if (!this.connected)
      throw new Error("Codex 已断连；请先重新连接，再核对原 turn。");
    const inspectedAt = new Date().toISOString();
    if (preTurnOperations.has(attempt.operation)) {
      state.recovery = {
        ...state.recovery,
        phase: "terminal",
        turnStatus: "notStarted",
        inspectedAt,
        detail: `${attempt.operation} 阶段尚未发送 turn/start；本步骤没有已派发的 turn。请核对本地副作用后确认。`,
      };
      attempt.recovery = state.recovery;
      this.publish(run);
      return state.recovery;
    }

    const threadId = attempt.threadId || state.threadId;
    const knownTurnId = attempt.turnId || state.turnId;
    if (!threadId || (!knownTurnId && !attempt.marker)) {
      state.recovery = {
        ...state.recovery,
        phase: "unresolved",
        inspectedAt,
        detail: "缺少原会话或本次尝试标识；不能确认是否已有 turn。",
      };
      attempt.recovery = state.recovery;
      this.publish(run);
      return state.recovery;
    }

    let cursor;
    const matches = [];
    let incompleteHistory = false;
    do {
      const page = await this.client.request("thread/turns/list", {
        threadId,
        itemsView: "full",
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      for (const turn of page.data) {
        if (knownTurnId ? turn.id === knownTurnId : hasAttemptMarker(turn, attempt.marker))
          matches.push(turn);
        if (!knownTurnId && turn.itemsView && turn.itemsView !== "full")
          incompleteHistory = true;
      }
      if (knownTurnId && matches.length) break;
      cursor = page.nextCursor;
    } while (cursor);

    if (matches.length !== 1 || incompleteHistory) {
      state.recovery = {
        ...state.recovery,
        phase: "unresolved",
        inspectedAt,
        detail: incompleteHistory
          ? "会话历史未返回完整条目，不能核对本次尝试。"
          : matches.length > 1
            ? "有多个 turn 包含本次尝试标识，不能擅自选择。"
            : "会话历史中尚未找到原 turn；不能确认它没有执行。",
      };
      attempt.recovery = state.recovery;
      this.publish(run);
      return state.recovery;
    }

    const turn = matches[0];
    if (!knownTurnId) {
      state.turnId = turn.id;
      attempt.turnId = turn.id;
    }
    for (const item of turn.items)
      if (item.type === "contextCompaction")
        recordCompaction(run, nodeId, attempt.attempt, threadId, turn.id, item.id);
    const text = finalAnswer(turn);
    if (text !== undefined) {
      state.rawText = text;
      attempt.rawText = text;
      if (attempt.artifactDirectory) {
        mkdirSync(attempt.artifactDirectory, { recursive: true });
        writeFileSync(join(attempt.artifactDirectory, "response.txt"), text);
      }
    }
    const terminal = terminalTurnStatuses.has(turn.status);
    state.recovery = {
      ...state.recovery,
      phase: terminal ? "terminal" : "in_progress",
      turnStatus: turn.status,
      inspectedAt,
      finalAnswerText: text ?? null,
      completedAt:
        terminal && Number.isFinite(turn.completedAt)
          ? new Date(turn.completedAt * 1000).toISOString()
          : null,
      detail: terminal
        ? `原 turn ${turn.id} 已${turn.status === "completed" ? "完成" : turn.status === "failed" ? "失败" : "中断"}；采用成果或重跑前须确认副作用。`
        : `原 turn ${turn.id} 仍在执行；不能重跑。`,
    };
    attempt.recovery = state.recovery;
    this.publish(run);
    if (terminal) {
      const cancel = this.pendingOperations.get(attempt);
      if (cancel) cancel(new Error("原 turn 已经由会话历史核对。"));
      const execution = this.active.get(threadId);
      if (execution?.state === state && !execution.finished) {
        execution.finished = true;
        execution.finish({ status: "recovered" });
        if (!execution.turnId) execution.resolveTurnReady(null);
      }
      if (execution?.state === state)
        await new Promise((resolve) => setImmediate(resolve));
    }
    return state.recovery;
  }

  confirmRecovery(id, nodeId, note) {
    const { run, state, attempt } = this.recoveryAttempt(id, nodeId);
    const value = note.trim();
    if (!value) throw new Error("请填写副作用核对结论。");
    if (state.recovery.phase !== "terminal")
      throw new Error("原 turn 尚未确认结束，不能重跑。");
    state.recovery = {
      ...state.recovery,
      required: false,
      phase: "confirmed",
      note: value,
      confirmedAt: new Date().toISOString(),
    };
    attempt.recovery = state.recovery;
    state.error = "";
    run.error = "";
    this.publish(run);
  }

  acceptRecoveryResult(id, nodeId, note) {
    const { run, state, attempt } = this.recoveryAttempt(id, nodeId);
    if (run.status === "abandoned")
      throw new Error("此运行已结束，不能重新采用成果或恢复调度。");
    const value = note.trim();
    if (!value) throw new Error("请填写成果与副作用核对结论。");
    if (
      state.recovery.phase !== "terminal" ||
      state.recovery.turnStatus !== "completed" ||
      !state.recovery.finalAnswerText
    )
      throw new Error("原 turn 没有可采用的已完成最终答复。");
    const workflow = run.snapshots[attempt.snapshotIndex];
    const node = workflow?.nodes.find((item) => item.id === nodeId);
    if (!node)
      throw new Error("无法确定本次尝试使用的配置快照，不能采用成果。");
    const output = JSON.parse(state.recovery.finalAnswerText);
    if (output.status !== "completed")
      throw new Error("最终答复没有完成状态，不能采用为已完成成果。");
    this.completeOutput(
      run,
      workflow,
      node,
      state,
      attempt,
      state.recovery.finalAnswerText,
    );
    state.recovery = {
      ...state.recovery,
      required: false,
      phase: "confirmed",
      note: value,
      adoptedAt: new Date().toISOString(),
    };
    attempt.recovery = state.recovery;
    attempt.status = state.status;
    attempt.output = state.output;
    attempt.rawText = state.rawText;
    attempt.finishedAt = state.recovery.completedAt;
    state.error = "";
    run.error = "";
    run.status = "paused";
    this.publish(run);
  }

  addDecision(id, text, resolves = []) {
    const run = this.runs.get(id);
    if (!run) throw new Error("找不到该运行记录。");
    const decision = addDecision(run, text, resolves);
    this.publish(run);
    return decision;
  }

  pause(id) {
    const run = this.runs.get(id);
    if (run.status !== "running") throw new Error("当前运行不在调度中。");
    run.status = "pausing";
    this.publish(run);
    this.tick(run);
  }

  async interrupt(id) {
    const run = this.runs.get(id);
    if (this.interruptions.has(id)) return this.interruptions.get(id);
    if (
      !["running", "pausing", "paused", "needs_attention"].includes(run.status)
    )
      throw new Error("当前运行不能中断。");
    run.status = "interrupting";
    run.error = "";
    for (const state of Object.values(run.states))
      if (state.status === "queued") state.status = "interrupted";
    this.publish(run);
    const owned = [...this.active.values()].filter(
      (execution) => execution.run === run,
    );
    const pending = Promise.all(
      owned.map(async (execution) => {
        const turnId = await execution.turnReady;
        if (!turnId || execution.finished) return;
        execution.interruptRequested = true;
        await this.client.request("turn/interrupt", {
          threadId: execution.threadId,
          turnId,
        });
      }),
    )
      .then(() => this.tick(run))
      .catch((error) => {
        run.status = "needs_attention";
        run.error = `立即中断失败：${error.message}`;
        this.publish(run);
        throw error;
      })
      .finally(() => this.interruptions.delete(id));
    this.interruptions.set(id, pending);
    this.tick(run);
    return pending;
  }

  checkEndedRunThread(threadId) {
    for (const run of this.runs.values())
      if (run.status === "abandoned" && Object.values(run.states).some(
        (state) => state.recovery?.required && state.threadId === threadId,
      ))
        throw new Error("此会话仍有已结束运行的未知结果；请在原运行中核对并确认副作用后再使用。");
  }

  abandon(id) {
    const run = this.runs.get(id);
    if (!["interrupted", "needs_attention", "paused"].includes(run.status) ||
        !Object.values(run.states).some((state) => state.recovery?.required))
      throw new Error("只有待核对的异常运行可以结束。");
    if (Object.values(run.states).some((state) =>
      busyStatuses.has(state.status) || state.attempts.some((attempt) => this.pendingOperations.has(attempt)),
    ) || [...this.active.values()].some((execution) => execution.run === run))
      throw new Error("本运行仍有请求在执行；请先中断或等待断连处理结束。");
    run.status = "abandoned";
    run.abandonedAt = new Date().toISOString();
    run.error = "已结束本地调度；原执行结果仍待核对，不代表服务端任务已停止，也不会撤销副作用。";
    this.publish(run);
  }

  resume(id) {
    const run = this.runs.get(id);
    if (run.status !== "paused")
      throw new Error("只有已暂停的运行可以继续调度。");
    if (Object.values(run.states).some((state) => state.recovery?.required))
      throw new Error("仍有尚未核对的原 turn；不能继续调度。");
    run.status = "running";
    this.publish(run);
    this.tick(run);
  }

  resetState(state) {
    if (state.recovery?.required)
      throw new Error("该步骤仍需核对原 turn 和副作用，不能重置。");
    state.status = "pending";
    state.output = null;
    state.rawText = "";
    state.error = "";
    state.feedback = "";
    state.threadId = "";
    state.turnId = "";
    state.usage = null;
    state.artifactDirectory = undefined;
    delete state.recovery;
  }

  rerun(id, nodeId, workflow, feedback) {
    const run = this.runs.get(id);
    if (run.status === "abandoned")
      throw new Error("此运行已结束，不能从旧记录重跑；请新建运行。");
    if (!this.connected)
      throw new Error("Codex 进程已断连；请重新连接并核对现场。");
    if (["pausing", "interrupting"].includes(run.status))
      throw new Error("请等待当前控制操作结束后重跑。");
    const affected = descendants(run.workflow, nodeId);
    if ([...affected].some((id) => busyStatuses.has(run.states[id].status)))
      throw new Error("受影响的步骤仍在执行；请等待结束或立即中断后重跑。");
    if ([...affected].some((id) => run.states[id].recovery?.required))
      throw new Error("受影响的步骤仍需核对原 turn 和副作用，不能重跑。");
    if (
      JSON.stringify(workflow.edges) !== JSON.stringify(run.workflow.edges) ||
      JSON.stringify(workflow.nodes.map((node) => node.id)) !==
        JSON.stringify(run.workflow.nodes.map((node) => node.id))
    )
      throw new Error("重跑仅接受提示词及角色配置修改；路线变更请新建运行。");
    const issues = validate(workflow, run.task);
    if (issues.length) throw new Error(issues.join("\n"));
    for (const role of workflow.roles) {
      if (role.sessionMode !== "existing") continue;
      const owner = Object.entries(run.sessions).find(
        ([ownerId, threadId]) =>
          ownerId !== role.id && threadId === role.threadId,
      );
      if (
        owner &&
        run.workflow.nodes.some(
          (node) =>
            node.data.roleId === owner[0] &&
            busyStatuses.has(run.states[node.id].status),
        )
      )
        throw new Error(
          "此会话正由当前运行的其他节点使用；请等待该 turn 结束后再改绑重跑。",
        );
    }
    const consumed = run.reworkRequests.filter((request) =>
      affected.has(request.target),
    );
    run.reworkRequests = run.reworkRequests.filter(
      (request) => !affected.has(request.target),
    );
    run.workflow = structuredClone(workflow);
    run.snapshots.push(run.workflow);
    for (const target of affected) this.resetState(run.states[target]);
    run.states[nodeId].feedback = [
      ...consumed.map((request) => request.feedback),
      feedback,
    ]
      .filter(Boolean)
      .join("\n\n");
    run.feedback = feedback;
    run.error = "";
    run.status = "running";
    this.publish(run);
    this.tick(run);
  }
}

module.exports = { Engine, SessionQueue };
