const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const { EventEmitter } = require("node:events");

const ownershipMethods = new Set([
  "thread/start",
  "thread/resume",
  "turn/start",
  "turn/interrupt",
]);

class CodexClient extends EventEmitter {
  constructor(executable, args = ["app-server", "--stdio"]) {
    super();
    this.sequence = 0;
    this.pending = new Map();
    this.disconnected = false;
    this.closing = false;
    this.process = spawn(executable, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stdin.on("error", (error) => this.fail(error));
    this.process.stderr.on("data", (data) =>
      this.emit("diagnostic", data.toString()),
    );
    this.process.on("error", (error) => this.fail(error));
    this.process.on("exit", (code) => {
      this.fail(new Error(`Codex process exited (${code})`));
      this.process.stdout.destroy();
      this.process.stderr.destroy();
    });
    createInterface({ input: this.process.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      if ("method" in message) {
        this.emit("notification", message);
      } else {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) {
          const error = new Error(`${request.method}: ${message.error.message}`);
          error.code = message.error.code;
          error.data = message.error.data;
          request.reject(error);
        } else request.resolve(message.result);
      }
    });
  }

  fail(error) {
    if (this.disconnected) return;
    this.disconnected = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.emit("disconnected", error.message);
  }

  request(method, params = {}, options = {}) {
    if (this.disconnected || this.closing)
      return Promise.reject(new Error("Codex process is disconnected"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (ownershipMethods.has(method)) {
          const request = this.pending.get(id);
          request.waiting = true;
          options.onWaiting?.({ id, method });
          this.emit("waiting", { id, method });
          return;
        }
        this.pending.delete(id);
        reject(new Error(`${method}: request timed out`));
      }, 30000);
      this.pending.set(id, { method, resolve, reject, timer, waiting: false });
      this.process.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  respond(id, result) {
    this.process.stdin.write(JSON.stringify({ id, result }) + "\n");
  }

  respondError(id, code, message) {
    this.process.stdin.write(
      JSON.stringify({ id, error: { code, message } }) + "\n",
    );
  }

  async initialize() {
    const result = await this.request("initialize", {
      clientInfo: {
        name: "workflow_studio",
        title: "Workflow Studio",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.process.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    return result;
  }

  close() {
    this.closing = true;
    this.process.stdin.end();
  }
}

module.exports = { CodexClient };
