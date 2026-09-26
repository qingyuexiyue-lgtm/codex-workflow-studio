const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("studio", {
  boot: () => ipcRenderer.invoke("studio:boot"),
  catalog: () => ipcRenderer.invoke("studio:catalog"),
  save: (workflow) => ipcRenderer.invoke("studio:save", workflow),
  remove: (id) => ipcRenderer.invoke("studio:remove", id),
  pickDirectory: () => ipcRenderer.invoke("studio:directory"),
  history: (threadId) => ipcRenderer.invoke("studio:history", threadId),
  start: (workflow, task, materials) =>
    ipcRenderer.invoke("studio:start", workflow, task, materials),
  pause: (id) => ipcRenderer.invoke("studio:pause", id),
  interrupt: (id) => ipcRenderer.invoke("studio:interrupt", id),
  abandon: (id) => ipcRenderer.invoke("studio:abandon", id),
  resume: (id) => ipcRenderer.invoke("studio:resume", id),
  reconnect: () => ipcRenderer.invoke("studio:reconnect"),
  inspectRecovery: (runId, nodeId) =>
    ipcRenderer.invoke("studio:inspectRecovery", runId, nodeId),
  confirmRecovery: (runId, nodeId, note) =>
    ipcRenderer.invoke("studio:confirmRecovery", runId, nodeId, note),
  acceptRecoveryResult: (runId, nodeId, note) =>
    ipcRenderer.invoke("studio:acceptRecoveryResult", runId, nodeId, note),
  addDecision: (runId, text, resolves) =>
    ipcRenderer.invoke("studio:addDecision", runId, text, resolves),
  rerun: (id, nodeId, workflow, feedback) =>
    ipcRenderer.invoke("studio:rerun", id, nodeId, workflow, feedback),
  preview: (workflow, nodeId, task, materials) =>
    ipcRenderer.invoke("studio:preview", workflow, nodeId, task, materials),
  openArtifacts: (runId, nodeId, attempt) =>
    ipcRenderer.invoke("studio:artifacts", runId, nodeId, attempt),
  window: (action) => ipcRenderer.send("studio:window", action),
  subscribe: (callback) => {
    const handler = (_, run) => callback(run);
    ipcRenderer.on("studio:run", handler);
    return () => ipcRenderer.removeListener("studio:run", handler);
  },
  subscribeConnection: (callback) => {
    const handler = (_, connection) => callback(connection);
    ipcRenderer.on("studio:connection", handler);
    return () => ipcRenderer.removeListener("studio:connection", handler);
  },
});
