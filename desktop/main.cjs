const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Tray,
  Menu,
  nativeImage,
  shell,
  powerMonitor,
} = require("electron");
const { join } = require("node:path");
const { homedir } = require("node:os");
const { CodexClient } = require("./codex-client.cjs");
const { Store } = require("./store.cjs");
const { Engine } = require("./engine.cjs");
const { catalog } = require("./catalog.cjs");
const { packet } = require("./workflow.cjs");

let window, tray, client, store, engine, initialization;
let quitting = false;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    window.show();
    window.focus();
  });
  app.whenReady().then(async () => {
    const directory = process.env.STUDIO_DATA_DIR || app.getPath("userData");
    store = new Store(directory);
    const executable =
      process.env.STUDIO_CODEX_PATH ||
      join(
        process.env.LOCALAPPDATA,
        "Programs",
        "OpenAI",
        "Codex",
        "bin",
        "codex.exe",
      );
    let connection = { status: "connecting" };
    const setConnection = (status, error) => {
      connection = error ? { status, error } : { status };
      if (window && !window.isDestroyed())
        window.webContents.send("studio:connection", connection);
    };
    const connect = () => {
      const next = new CodexClient(executable);
      client = next;
      if (engine) engine.attachClient(next);
      else {
        engine = new Engine(next, store);
        engine.on("change", (run) => {
          if (window && !window.isDestroyed())
            window.webContents.send("studio:run", run);
        });
      }
      engine.connected = false;
      setConnection("connecting");
      next.on("disconnected", (message) => {
        if (client !== next) return;
        engine.connected = false;
        setConnection("disconnected", message);
      });
      initialization = next.initialize().then(
        (server) => {
          if (client !== next || next.disconnected) return null;
          engine.connected = true;
          setConnection("connected");
          return server;
        },
        (error) => {
          if (client === next) setConnection("disconnected", error.message);
          return null;
        },
      );
      return initialization;
    };
    connect();
    powerMonitor.on("resume", () => engine.markSleep());
    const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
    ipcMain.handle("studio:boot", async () => ({
      workflows: store.workflows(),
      runs: [...engine.runs.values()],
      directory,
      server: await initialization,
      connection,
    }));
    ipcMain.handle("studio:catalog", async () => {
      await initialization;
      if (!engine.connected)
        throw new Error(connection.error || "Codex 未连接。");
      return catalog(client, codexHome);
    });
    ipcMain.handle("studio:reconnect", async () => {
      if (connection.status === "connected") return connection;
      if (connection.status === "connecting")
        throw new Error("Codex 正在连接，请等待当前请求完成。");
      client.close();
      const server = await connect();
      if (!server) throw new Error(connection.error || "Codex 重连失败。");
      return connection;
    });
    ipcMain.handle("studio:save", (_, workflow) =>
      store.saveWorkflow(workflow),
    );
    ipcMain.handle("studio:remove", (_, id) => store.deleteWorkflow(id));
    ipcMain.handle("studio:directory", async () => {
      const result = await dialog.showOpenDialog(window, {
        properties: ["openDirectory"],
      });
      return result.canceled ? null : result.filePaths[0];
    });
    ipcMain.handle("studio:history", (_, threadId) =>
      client.request("thread/turns/list", {
        threadId,
        itemsView: "full",
        limit: 10,
      }),
    );
    ipcMain.handle("studio:start", (_, workflow, task, materials) =>
      engine.start(workflow, task, materials),
    );
    ipcMain.handle("studio:pause", (_, id) => engine.pause(id));
    ipcMain.handle("studio:interrupt", (_, id) => engine.interrupt(id));
    ipcMain.handle("studio:abandon", async (_, id) => {
      const decision = await dialog.showMessageBox(window, {
        type: "warning",
        message: "结束此异常运行？",
        detail: "仅结束本地调度，保留所有记录。不会重跑任务、撤销副作用或保证服务端已停止。原会话核对前不可复用；其他会话可启动新流程。",
        buttons: ["取消", "结束异常运行"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (decision.response === 1) engine.abandon(id);
    });
    ipcMain.handle("studio:resume", (_, id) => engine.resume(id));
    ipcMain.handle("studio:inspectRecovery", (_, id, nodeId) =>
      engine.inspectRecovery(id, nodeId),
    );
    ipcMain.handle("studio:confirmRecovery", (_, id, nodeId, note) =>
      engine.confirmRecovery(id, nodeId, note),
    );
    ipcMain.handle("studio:acceptRecoveryResult", (_, id, nodeId, note) =>
      engine.acceptRecoveryResult(id, nodeId, note),
    );
    ipcMain.handle("studio:addDecision", (_, id, text, resolves) =>
      engine.addDecision(id, text, resolves),
    );
    ipcMain.handle("studio:rerun", (_, id, nodeId, workflow, feedback) =>
      engine.rerun(id, nodeId, workflow, feedback),
    );
    ipcMain.handle("studio:preview", (_, workflow, nodeId, task, materials) =>
      packet(
        workflow,
        workflow.nodes.find((node) => node.id === nodeId),
        {
          task,
          materials,
          states: Object.fromEntries(
            workflow.nodes.map((node) => [node.id, { output: null }]),
          ),
          feedback: "",
        },
      ),
    );
    ipcMain.handle("studio:artifacts", (_, runId, nodeId, attemptNumber) =>
      shell.openPath(
        engine.runs
          .get(runId)
          .states[nodeId].attempts.find(
            (attempt) => attempt.attempt === attemptNumber,
          ).artifactDirectory,
      ),
    );
    ipcMain.on("studio:window", (_, action) => {
      if (action === "minimize") window.minimize();
      if (action === "maximize")
        window.isMaximized() ? window.unmaximize() : window.maximize();
      if (action === "close") window.close();
    });
    window = new BrowserWindow({
      width: 1500,
      height: 980,
      minWidth: 1050,
      minHeight: 720,
      frame: false,
      title: "Workflow Studio",
      icon: join(__dirname, "icon.png"),
      backgroundColor: "#f5f6f8",
      webPreferences: {
        preload: join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.on("close", (event) => {
      if (!quitting) {
        event.preventDefault();
        window.hide();
      }
    });
    tray = new Tray(nativeImage.createFromPath(join(__dirname, "icon.png")));
    tray.setToolTip("Workflow Studio");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "打开 Workflow Studio", click: () => window.show() },
        {
          label: "退出",
          click: async () => {
            const busy = [...engine.runs.values()].some((run) =>
              ["running", "pausing", "interrupting"].includes(run.status),
            );
            if (busy) {
              const decision = await dialog.showMessageBox(window, {
                type: "warning",
                message: "仍有流程在执行。退出将中断当前任务。",
                buttons: ["继续执行", "退出"],
                defaultId: 0,
                cancelId: 0,
              });
              if (decision.response === 0) return;
            }
            quitting = true;
            app.quit();
          },
        },
      ]),
    );
    tray.on("double-click", () => window.show());
    await window.loadFile(join(__dirname, "../dist/index.html"));
  });
  app.on("before-quit", () => {
    quitting = true;
    if (engine) engine.closed = true;
    client?.close();
    store?.close();
  });
  app.on("window-all-closed", (event) => event.preventDefault());
}
