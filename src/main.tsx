import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  MarkerType,
  useReactFlow,
  useStore,
  type NodeProps,
  type NodeChange,
  type EdgeChange,
  type Connection,
} from "@xyflow/react";
import {
  Workflow as WorkflowIcon,
  Plus,
  Play,
  Pause,
  Save,
  Copy,
  Trash2,
  Settings2,
  ChevronRight,
  ChevronDown,
  Check,
  FolderOpen,
  MessageSquare,
  Search,
  RefreshCw,
  X,
  Minus,
  Square,
  History,
  FileText,
  ArrowUpRight,
  RotateCcw,
  Eye,
  PanelRightClose,
  PanelRightOpen,
  CircleHelp,
  GitBranch,
  CheckCheck,
  SlidersHorizontal,
  Circle,
  Layers,
  Terminal,
  Cable,
  BookOpen,
  SearchCheck,
  ShieldCheck,
} from "lucide-react";
import {
  workflow as createWorkflow,
  role as createRole,
  step as createStep,
  id,
  statusLabel,
} from "./defaults";
import type {
  Workflow,
  Role,
  Step,
  Route,
  Run,
  Catalog,
  StepData,
  ConnectionState,
  MemoryIssue,
} from "./types";
import "@xyflow/react/dist/style.css";
import "./style.css";

function IconButton({
  title,
  children,
  onClick,
  disabled = false,
}: {
  title: string;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="icon-button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const fieldId = React.useId();
  return (
    <div className="field">
      <label htmlFor={fieldId}>{label}</label>
      {React.cloneElement(children as React.ReactElement<{ id: string }>, {
        id: fieldId,
      })}
    </div>
  );
}
function StepNode({ data, selected }: NodeProps<Step>) {
  return (
    <div className={`step-node ${data.color} ${selected ? "selected" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <Handle
        id="feedback"
        type="target"
        position={Position.Bottom}
        style={{ left: "35%" }}
      />
      <div className="node-top">
        <span className="node-glyph">
          <Layers size={17} />
        </span>
        <span className="node-order">
          {String(data.order).padStart(2, "0")}
        </span>
        <span className={`node-status ${data.status}`}>
          <i />
          {statusLabel[data.status || "draft"]}
        </span>
      </div>
      <h3>{data.label}</h3>
      <div className="node-role">{data.roleName}</div>
      <div className="node-bottom">
        <span>{data.model || "未选择模型"}</span>
        {data.shared ? (
          <span title="共享上下文">
            <MessageSquare size={13} />
          </span>
        ) : (
          <span className="node-dot" />
        )}
      </div>
      <Handle type="source" position={Position.Right} />
      <Handle
        id="rework"
        type="source"
        position={Position.Bottom}
        style={{ left: "65%" }}
      />
    </div>
  );
}
const nodeTypes = { step: StepNode };
function FitCanvas() {
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const { fitView } = useReactFlow();
  useEffect(() => {
    void fitView({ padding: 0.14 });
  }, [width, height, fitView]);
  return null;
}
const emptyCatalog: Catalog = { projects: [], threads: [], models: [] };

function currentMemoryIssues(run: Run): MemoryIssue[] {
  const resolved = new Set(
    run.memory.decisions.flatMap((decision) => decision.resolves),
  );
  return run.memory.updates.flatMap((update) => {
    const state = run.states[update.nodeId];
    if (state.attempt !== update.attempt || !state.output) return [];
    return [
      { id: `${update.id}:question`, kind: "question" as const, text: update.question },
      {
        id: `${update.id}:unverified`,
        kind: "unverified" as const,
        text: update.unverified,
      },
    ]
      .filter((issue) => issue.text.trim() && !resolved.has(issue.id))
      .map((issue) => ({
        ...issue,
        nodeId: update.nodeId,
        attempt: update.attempt,
        memoryRevision: update.memoryRevision,
      }));
  });
}

function App() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [current, setCurrent] = useState<Workflow>(createWorkflow);
  const [catalog, setCatalog] = useState<Catalog>(emptyCatalog);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState("");
  const [selectedEdge, setSelectedEdge] = useState("");
  const [tab, setTab] = useState<"step" | "role" | "inputs">("step");
  const [view, setView] = useState<"canvas" | "runs">("canvas");
  const [runId, setRunId] = useState("");
  const [panel, setPanel] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [connection, setConnection] = useState<ConnectionState>({
    status: "connecting",
  });
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<
    "run" | "settings" | "preview" | "threads" | "delete" | null
  >(null);
  const [preview, setPreview] = useState("");
  const [search, setSearch] = useState("");
  const [task, setTask] = useState("");
  const [materials, setMaterials] = useState("");
  const [feedback, setFeedback] = useState("");
  const [decisionDraft, setDecisionDraft] = useState("");
  const [decisionIssueId, setDecisionIssueId] = useState("");
  const [recoveryNote, setRecoveryNote] = useState("");
  const [terminalRouteDraft, setTerminalRouteDraft] = useState<{
    nodeId: string;
    value: string;
  } | null>(null);
  const [attemptSelection, setAttemptSelection] = useState<{
    runId: string;
    nodeId: string;
    attempt: number;
  } | null>(null);
  const [outputTab, setOutputTab] = useState<
    "result" | "memory" | "events" | "usage"
  >("result");
  const [dataDirectory, setDataDirectory] = useState("");
  const act = async (action: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await action();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void act(async () => {
      const boot = await window.studio.boot();
      setDataDirectory(boot.directory);
      setRuns(boot.runs);
      setConnection(boot.connection);
      let list = boot.workflows;
      if (!list.length) {
        const first = createWorkflow();
        list = [first];
        await window.studio.save(first);
      }
      setWorkflows(list);
      setCurrent(list[0]);
      setSelected(list[0].nodes[0]?.id || "");
      if (boot.connection.status === "connected")
        setCatalog(await window.studio.catalog());
    });
    const unsubscribeRuns = window.studio.subscribe((run) =>
      setRuns((previous) => [
        run,
        ...previous.filter((item) => item.id !== run.id),
      ]),
    );
    const unsubscribeConnection = window.studio.subscribeConnection(setConnection);
    return () => {
      unsubscribeRuns();
      unsubscribeConnection();
    };
  }, []);
  useEffect(() => setRecoveryNote(""), [runId, selected]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 2400);
    return () => clearTimeout(timer);
  }, [notice]);
  const node = current.nodes.find((node) => node.id === selected);
  const role =
    node && current.roles.find((role) => role.id === node.data.roleId)!;
  const edge = current.edges.find((edge) => edge.id === selectedEdge);
  const run = runs.find((run) => run.id === runId);
  const state = run && run.states[selected];
  const memoryIssues = run?.memory ? currentMemoryIssues(run) : [];
  const connected = connection.status === "connected";
  const viewedAttempt =
    state?.attempts?.find(
      (attempt) =>
        attemptSelection?.runId === run?.id &&
        attemptSelection?.nodeId === selected &&
        attemptSelection?.attempt === attempt.attempt,
    ) || state?.attempts?.at(-1);
  const displayedAttempt =
    viewedAttempt?.attempt === state?.attempt ? state : viewedAttempt || state;
  const activeTurns = run?.workflow.nodes.some(
    (item) => ["running", "awaiting_response"].includes(run.states[item.id].status),
  );
  const attentionNodes = run?.workflow.nodes.filter((item) =>
    ["question", "blocked", "failed", "interrupted"].includes(
      run.states[item.id].status,
    ),
  );
  const affectedStates =
    run &&
    (() => {
      const affected = new Set([selected]);
      const queue = [selected];
      while (queue.length) {
        const source = queue.shift();
        for (const edge of run.workflow.edges.filter(
          (edge) => edge.source === source && edge.data?.kind === "next",
        ))
          if (!affected.has(edge.target)) {
            affected.add(edge.target);
            queue.push(edge.target);
          }
      }
      return [...affected].map((id) => run.states[id]);
    })();
  const affectedBusy = affectedStates?.some((item) =>
    ["queued", "running", "awaiting_response"].includes(item.status),
  );
  const affectedRecovery = affectedStates?.some((item) => item.recovery?.required);
  const update = (change: Partial<Workflow>) => {
    setCurrent((previous) => ({ ...previous, ...change }));
    setDirty(true);
  };
  const updateNode = (change: Partial<StepData>) =>
    update({
      nodes: current.nodes.map((item) =>
        item.id === selected
          ? { ...item, data: { ...item.data, ...change } }
          : item,
      ),
    });
  const updateRole = (change: Partial<Role>) =>
    update({
      roles: current.roles.map((item) =>
        item.id === role!.id ? { ...item, ...change } : item,
      ),
    });
  const save = async () => {
    const saved = { ...current, updatedAt: new Date().toISOString() };
    await window.studio.save(saved);
    setWorkflows((previous) => [
      saved,
      ...previous.filter((item) => item.id !== saved.id),
    ]);
    setCurrent(saved);
    setDirty(false);
    setNotice("流程已保存");
  };
  const selectWorkflow = async (workflow: Workflow) => {
    const next = dirty && workflow.id === current.id ? current : workflow;
    if (dirty) await save();
    setCurrent(next);
    setSelected(workflow.nodes[0]?.id || "");
    setSelectedEdge("");
    setRunId("");
    setDirty(false);
    setView("canvas");
  };
  const addNode = () => {
    const newRole = createRole();
    const newNode = createStep(
      newRole.id,
      `步骤 ${current.nodes.length + 1}`,
      100 + (current.nodes.length % 3) * 300,
      420 + Math.floor(current.nodes.length / 3) * 210,
    );
    update({
      roles: [...current.roles, newRole],
      nodes: [...current.nodes, newNode],
    });
    setSelected(newNode.id);
    setSelectedEdge("");
    setPanel(true);
  };
  const removeNode = () => {
    update({
      nodes: current.nodes
        .filter((n) => n.id !== selected)
        .map((n) => ({
          ...n,
          data: {
            ...n.data,
            inputIds: n.data.inputIds.filter((value) => value !== selected),
          },
        })),
      edges: current.edges.filter(
        (edge) => edge.source !== selected && edge.target !== selected,
      ),
    });
    setSelected("");
  };
  const nodesChanged = useCallback((changes: NodeChange<Step>[]) => {
    setCurrent((previous) => ({
      ...previous,
      nodes: applyNodeChanges(changes, previous.nodes),
    }));
    if (
      changes.some(
        (change) => change.type !== "select" && change.type !== "dimensions",
      )
    )
      setDirty(true);
  }, []);
  const edgesChanged = useCallback((changes: EdgeChange<Route>[]) => {
    setCurrent((previous) => ({
      ...previous,
      edges: applyEdgeChanges(changes, previous.edges),
    }));
    if (changes.some((change) => change.type !== "select")) setDirty(true);
  }, []);
  const onConnect = (connection: Connection) =>
    update({
      edges: addEdge(
        {
          ...connection,
          id: id(),
          data: {
            kind: connection.sourceHandle === "rework" ? "rework" : "next",
            route: connection.sourceHandle === "rework" ? "revise" : "*",
          },
        },
        current.edges,
      ),
    });
  const displayNodes = current.nodes.map((item, index) => {
    const itemRole = current.roles.find(
      (role) => role.id === item.data.roleId,
    )!;
    const shared =
      (itemRole.sessionMode === "existing" &&
        itemRole.threadId !== "" &&
        current.roles.filter((role) => role.threadId === itemRole.threadId)
          .length > 1) ||
      current.nodes.filter((n) => n.data.roleId === itemRole.id).length > 1;
    return {
      ...item,
      selected: selected === item.id,
      data: {
        ...item.data,
        roleName: itemRole.name,
        model: itemRole.model,
        order: index + 1,
        shared,
        status: run?.states[item.id]?.status || "draft",
      },
    };
  });
  const displayEdges = current.edges.map((edge) => ({
    ...edge,
    selected: selectedEdge === edge.id,
    type: "smoothstep",
    label:
      edge.data!.kind === "rework"
        ? `返工 · ${edge.data!.route}`
        : edge.data!.route === "*"
          ? ""
          : edge.data!.route,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: edge.data!.kind === "rework" ? "#bd8395" : "#93a6ad",
    },
    style: {
      stroke: edge.data!.kind === "rework" ? "#bd8395" : "#93a6ad",
      strokeWidth: 1.6,
      strokeDasharray: edge.data!.kind === "rework" ? "5 5" : undefined,
    },
    labelStyle: { fill: "#8c6674", fontSize: 11 },
    labelBgStyle: { fill: "#f6f8f9" },
  }));
  const matchingThreads = catalog.threads.filter(
    (thread) =>
      (!role?.projectId || thread.projectId === role.projectId) &&
      `${thread.name} ${thread.id}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );

  return (
    <div className="application">
      <header className="titlebar">
        <div className="brand">
          <span className="brand-icon">
            <WorkflowIcon size={19} />
          </span>
          <strong>Workflow Studio</strong>
          <span className="version">0.1</span>
        </div>
        <div className="title-center">本地工作台</div>
        <div className="window-buttons">
          <IconButton
            title="最小化"
            onClick={() => window.studio.window("minimize")}
          >
            <Minus size={15} />
          </IconButton>
          <IconButton
            title="最大化"
            onClick={() => window.studio.window("maximize")}
          >
            <Square size={12} />
          </IconButton>
          <IconButton
            title="收起到托盘"
            onClick={() => window.studio.window("close")}
          >
            <X size={16} />
          </IconButton>
        </div>
      </header>
      <div className="shell">
        <aside className="sidebar">
          <div className="workspace">
            <span className="workspace-avatar">W</span>
            <div>
              <strong>我的工作空间</strong>
              <small>LOCAL WORKSPACE</small>
            </div>
          </div>
          <nav className="main-nav">
            <button
              className={view === "canvas" ? "active" : ""}
              onClick={() => setView("canvas")}
            >
              <WorkflowIcon size={17} />
              流程工作台<span>{workflows.length}</span>
            </button>
            <button
              className={view === "runs" ? "active" : ""}
              onClick={() => setView("runs")}
            >
              <History size={17} />
              运行记录<span>{runs.length}</span>
            </button>
          </nav>
          <div className="sidebar-heading">
            <span>我的流程</span>
            <IconButton
              title="创建流程"
              onClick={() =>
                void act(async () => {
                  const next = createWorkflow();
                  next.name = "未命名流程";
                  await window.studio.save(next);
                  setWorkflows((previous) => [...previous, next]);
                  await selectWorkflow(next);
                })
              }
            >
              <Plus size={16} />
            </IconButton>
          </div>
          <div className="workflow-list">
            {workflows.map((item) => (
              <button
                key={item.id}
                className={item.id === current.id ? "chosen" : ""}
                onClick={() => void act(() => selectWorkflow(item))}
              >
                <GitBranch size={16} />
                <span>{item.id === current.id ? current.name : item.name}</span>
                <i />
              </button>
            ))}
          </div>
          <div className="sidebar-bottom">
            <div className="connection">
              <i className={connected ? "online" : ""} />
              <span>
                Codex {connected ? "已连接" : connection.status === "connecting" ? "连接中" : "已断开"}
              </span>
              <IconButton
                title={connected ? "刷新项目与对话" : "重新连接 Codex"}
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    if (!connected) await window.studio.reconnect();
                    setCatalog(await window.studio.catalog());
                    setNotice(connected ? "列表已刷新" : "Codex 已重新连接");
                  })
                }
              >
                <RefreshCw size={14} />
              </IconButton>
            </div>
            <button
              className="settings-link"
              onClick={() => setModal("settings")}
            >
              <Settings2 size={16} />
              流程设置
              <ChevronRight size={14} />
            </button>
          </div>
        </aside>
        <main className={`main-area ${run ? "has-run" : ""}`}>
          <header className="workspace-header">
            <div className="breadcrumb">
              工作空间
              <ChevronRight size={13} />
              <strong>{current.name}</strong>
              {dirty && <span className="unsaved">未保存</span>}
            </div>
            <div className="header-actions">
              <IconButton
                title="复制流程"
                onClick={() =>
                  void act(async () => {
                    const copied = {
                      ...structuredClone(current),
                      id: id(),
                      name: `${current.name} 副本`,
                    };
                    await window.studio.save(copied);
                    setWorkflows((previous) => [...previous, copied]);
                    await selectWorkflow(copied);
                  })
                }
              >
                <Copy size={16} />
              </IconButton>
              <IconButton
                title="保存流程"
                onClick={() => void act(save)}
                disabled={busy}
              >
                <Save size={17} />
              </IconButton>
              <div className="divider" />
              <button
                className="primary"
                disabled={busy || !connected}
                onClick={() => setModal("run")}
              >
                <Play size={14} fill="currentColor" />
                运行流程
              </button>
            </div>
          </header>
          {error && (
            <div className="error-banner" role="alert">
              <CircleHelp size={17} />
              <span>{error}</span>
              <IconButton title="关闭错误" onClick={() => setError("")}>
                <X size={15} />
              </IconButton>
            </div>
          )}
          {connection.status === "disconnected" && (
            <div className="error-banner connection-banner" role="alert">
              <Cable size={16} />
              <span>{connection.error || "Codex 连接已断开。"}</span>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await window.studio.reconnect();
                    setCatalog(await window.studio.catalog());
                  })
                }
              >
                <RefreshCw size={14} />
                重新连接
              </button>
            </div>
          )}
          {view === "canvas" ? (
            <>
              <div className="canvas-toolbar">
                <div className="view-tabs">
                  <span className="active">
                    <WorkflowIcon size={15} />
                    画布
                  </span>
                  <span className="meta-count">
                    {current.nodes.length} 个步骤<span>·</span>
                    {
                      current.roles.filter((role) =>
                        current.nodes.some(
                          (node) => node.data.roleId === role.id,
                        ),
                      ).length
                    }{" "}
                    个角色
                  </span>
                </div>
                <div className="toolbar-actions">
                  <button onClick={addNode}>
                    <Plus size={15} />
                    添加节点
                  </button>
                  <IconButton
                    title="全局配置"
                    onClick={() => setModal("settings")}
                  >
                    <SlidersHorizontal size={16} />
                  </IconButton>
                  <IconButton
                    title={panel ? "收起属性" : "展开属性"}
                    onClick={() => setPanel(!panel)}
                  >
                    {panel ? (
                      <PanelRightClose size={17} />
                    ) : (
                      <PanelRightOpen size={17} />
                    )}
                  </IconButton>
                </div>
              </div>
              <div className="editor-body">
                <section className="canvas-area">
                  <div className="canvas-heading">
                    <span className="eyebrow">WORKFLOW</span>
                    <h1>{current.name}</h1>
                    <p>{current.description}</p>
                  </div>
                  <ReactFlow
                    key={current.id}
                    nodes={displayNodes}
                    edges={displayEdges}
                    nodeTypes={nodeTypes}
                    onNodesChange={nodesChanged}
                    onEdgesChange={edgesChanged}
                    onConnect={onConnect}
                    onNodeClick={(_, node) => {
                      setSelected(node.id);
                      setSelectedEdge("");
                      setPanel(true);
                    }}
                    onEdgeClick={(_, edge) => {
                      setSelectedEdge(edge.id);
                      setSelected("");
                      setPanel(true);
                    }}
                    fitView
                    fitViewOptions={{ padding: 0.14 }}
                    minZoom={0.35}
                    maxZoom={1.5}
                    deleteKeyCode={null}
                    proOptions={{ hideAttribution: true }}
                  >
                    <FitCanvas />
                    <Background color="#d7dfe2" gap={22} size={1} />
                    <Controls showInteractive={false} />
                    <MiniMap
                      nodeColor={(node) =>
                        ({ mint: "#b4d7cf", blue: "#b9cde7", rose: "#e3c1cf" })[
                          node.data.color as string
                        ] || "#b4d7cf"
                      }
                      maskColor="rgba(244,247,248,.75)"
                      pannable
                      zoomable
                    />
                  </ReactFlow>
                  <div className="canvas-footer">
                    <span>
                      <Circle size={9} />{" "}
                      {run ? statusLabel[run.status] : "草稿"}
                    </span>
                    <span>
                      本地存储
                      <CheckCheck size={13} />
                    </span>
                  </div>
                </section>
                {panel && (
                  <aside className="inspector">
                    <div className="inspector-heading">
                      <strong>
                        {edge ? "路线配置" : node ? "节点配置" : "流程概览"}
                      </strong>
                      {node && (
                        <div>
                          <IconButton
                            title="复制节点"
                            onClick={() => {
                              const copied = {
                                ...structuredClone(node),
                                id: id(),
                                position: {
                                  x: node.position.x + 30,
                                  y: node.position.y + 230,
                                },
                                data: {
                                  ...node.data,
                                  label: `${node.data.label} 副本`,
                                },
                              };
                              update({ nodes: [...current.nodes, copied] });
                              setSelected(copied.id);
                            }}
                          >
                            <Copy size={14} />
                          </IconButton>
                          <IconButton title="删除节点" onClick={removeNode}>
                            <Trash2 size={14} />
                          </IconButton>
                        </div>
                      )}
                    </div>
                    {node && role ? (
                      <>
                        <div className="inspector-tabs">
                          {(["step", "role", "inputs"] as const).map(
                            (value) => (
                              <button
                                key={value}
                                className={tab === value ? "active" : ""}
                                onClick={() => setTab(value)}
                              >
                                {
                                  {
                                    step: "本步任务",
                                    role: "角色与会话",
                                    inputs: "输入与输出",
                                  }[value]
                                }
                              </button>
                            ),
                          )}
                        </div>
                        <div className="inspector-scroll">
                          {tab === "step" && (
                            <>
                              <Field label="节点名称">
                                <input
                                  value={node.data.label}
                                  onChange={(event) =>
                                    updateNode({ label: event.target.value })
                                  }
                                />
                              </Field>
                              <Field label="执行角色">
                                <select
                                  value={role.id}
                                  onChange={(event) => {
                                    if (event.target.value === "new") {
                                      const next = createRole();
                                      update({
                                        roles: [...current.roles, next],
                                        nodes: current.nodes.map((n) =>
                                          n.id === selected
                                            ? {
                                                ...n,
                                                data: {
                                                  ...n.data,
                                                  roleId: next.id,
                                                },
                                              }
                                            : n,
                                        ),
                                      });
                                    } else
                                      updateNode({
                                        roleId: event.target.value,
                                      });
                                  }}
                                >
                                  {current.roles.map((role) => (
                                    <option key={role.id} value={role.id}>
                                      {role.name}
                                    </option>
                                  ))}
                                  <option value="new">+ 新建角色</option>
                                </select>
                              </Field>
                              <Field label="本步任务">
                                <textarea
                                  className="task-textarea"
                                  value={node.data.task}
                                  onChange={(event) =>
                                    updateNode({ task: event.target.value })
                                  }
                                />
                              </Field>
                              <div className="section-divider" />
                              <div className="toggle-row">
                                <span>
                                  <MessageSquare size={16} />
                                  允许向我提问
                                </span>
                                <input
                                  type="checkbox"
                                  className="switch"
                                  checked={node.data.allowQuestions}
                                  onChange={(event) =>
                                    updateNode({
                                      allowQuestions: event.target.checked,
                                    })
                                  }
                                />
                              </div>
                              {!node.data.allowQuestions && (
                                <Field label="默认处理规则">
                                  <textarea
                                    value={node.data.defaultRule}
                                    onChange={(event) =>
                                      updateNode({
                                        defaultRule: event.target.value,
                                      })
                                    }
                                  />
                                </Field>
                              )}
                              <Field label="节点颜色">
                                <div className="swatches">
                                  {["mint", "blue", "rose"].map((color) => (
                                    <button
                                      key={color}
                                      aria-label={color}
                                      className={`swatch ${color}`}
                                      onClick={() => updateNode({ color })}
                                    >
                                      {node.data.color === color && (
                                        <Check size={14} />
                                      )}
                                    </button>
                                  ))}
                                </div>
                              </Field>
                              <button
                                className="full-width secondary"
                                onClick={() =>
                                  void act(async () => {
                                    setPreview(
                                      await window.studio.preview(
                                        current,
                                        selected,
                                        task,
                                        materials,
                                      ),
                                    );
                                    setModal("preview");
                                  })
                                }
                              >
                                <Eye size={15} />
                                预览任务包
                              </button>
                            </>
                          )}
                          {tab === "role" && (
                            <>
                              <Field label="角色名称">
                                <input
                                  value={role.name}
                                  onChange={(event) =>
                                    updateRole({ name: event.target.value })
                                  }
                                />
                              </Field>
                              <Field label="模型">
                                <select
                                  value={role.model}
                                  onChange={(event) =>
                                    updateRole({
                                      model: event.target.value,
                                      effort: "medium",
                                    })
                                  }
                                >
                                  <option value="">选择模型</option>
                                  {catalog.models.map((model) => (
                                    <option key={model.id} value={model.model}>
                                      {model.displayName}
                                    </option>
                                  ))}
                                </select>
                              </Field>
                              <Field label="思考深度">
                                <select
                                  value={role.effort}
                                  onChange={(event) =>
                                    updateRole({ effort: event.target.value })
                                  }
                                >
                                  {(
                                    catalog.models.find(
                                      (model) => model.model === role.model,
                                    )?.supportedReasoningEfforts || [
                                      { reasoningEffort: "medium" },
                                    ]
                                  ).map((effort) => (
                                    <option
                                      key={effort.reasoningEffort}
                                      value={effort.reasoningEffort}
                                    >
                                      {effort.reasoningEffort}
                                    </option>
                                  ))}
                                </select>
                              </Field>
                              <Field label="角色提示词">
                                <textarea
                                  value={role.prompt}
                                  onChange={(event) =>
                                    updateRole({ prompt: event.target.value })
                                  }
                                />
                              </Field>
                              <div className="section-divider" />
                              <Field label="Codex 项目">
                                <select
                                  value={role.projectId}
                                  onChange={(event) => {
                                    const project = catalog.projects.find(
                                      (project) =>
                                        project.id === event.target.value,
                                    );
                                    updateRole({
                                      projectId: event.target.value,
                                      threadId: "",
                                      cwd: project ? project.roots[0].path : "",
                                    });
                                  }}
                                >
                                  <option value="">
                                    所有项目 / 自定义位置
                                  </option>
                                  {catalog.projects.map((project) => (
                                    <option key={project.id} value={project.id}>
                                      {project.name}
                                    </option>
                                  ))}
                                </select>
                              </Field>
                              <Field label="工作目录">
                                <div className="input-action">
                                  <input
                                    value={role.cwd}
                                    onChange={(event) =>
                                      updateRole({ cwd: event.target.value })
                                    }
                                  />
                                  <IconButton
                                    title="选择工作目录"
                                    onClick={() =>
                                      void act(async () => {
                                        const path =
                                          await window.studio.pickDirectory();
                                        if (path) updateRole({ cwd: path });
                                      })
                                    }
                                  >
                                    <FolderOpen size={16} />
                                  </IconButton>
                                </div>
                              </Field>
                              <div className="segmented">
                                <button
                                  className={
                                    role.sessionMode === "new" ? "active" : ""
                                  }
                                  onClick={() =>
                                    updateRole({
                                      sessionMode: "new",
                                      threadId: "",
                                    })
                                  }
                                >
                                  运行时新建
                                </button>
                                <button
                                  className={
                                    role.sessionMode === "existing"
                                      ? "active"
                                      : ""
                                  }
                                  onClick={() =>
                                    updateRole({ sessionMode: "existing" })
                                  }
                                >
                                  已有对话
                                </button>
                              </div>
                              {role.sessionMode === "existing" && (
                                <>
                                  <button
                                    className="thread-choice"
                                    onClick={() => {
                                      setSearch("");
                                      setModal("threads");
                                    }}
                                  >
                                    <MessageSquare size={17} />
                                    <span>
                                      {catalog.threads.find(
                                        (thread) => thread.id === role.threadId,
                                      )?.name || "选择已有对话"}
                                    </span>
                                    <ChevronDown size={14} />
                                  </button>
                                  {role.threadId && (
                                    <>
                                      <code className="thread-id">
                                        {role.threadId}
                                      </code>
                                      <button
                                        className="text-button"
                                        onClick={() =>
                                          void act(async () => {
                                            setPreview(
                                              JSON.stringify(
                                                await window.studio.history(
                                                  role.threadId,
                                                ),
                                                null,
                                                2,
                                              ),
                                            );
                                            setModal("preview");
                                          })
                                        }
                                      >
                                        <History size={14} />
                                        查看历史
                                      </button>
                                    </>
                                  )}
                                </>
                              )}
                              {displayNodes.find((n) => n.id === selected)?.data
                                .shared && (
                                <div className="shared-label">
                                  <MessageSquare size={14} />
                                  共享上下文
                                </div>
                              )}
                            </>
                          )}
                          {tab === "inputs" && (
                            <>
                              <Field label="引用上游成果">
                                <div className="checklist">
                                  {current.nodes
                                    .filter((n) => n.id !== selected)
                                    .map((n) => (
                                      <label key={n.id}>
                                        <input
                                          type="checkbox"
                                          checked={node.data.inputIds.includes(
                                            n.id,
                                          )}
                                          onChange={(event) =>
                                            updateNode({
                                              inputIds: event.target.checked
                                                ? [...node.data.inputIds, n.id]
                                                : node.data.inputIds.filter(
                                                    (value) => value !== n.id,
                                                  ),
                                            })
                                          }
                                        />
                                        {n.data.label}
                                      </label>
                                    ))}
                                </div>
                              </Field>
                              <div className="field-note">
                                {node.data.inputIds.length
                                  ? `${node.data.inputIds.length} 份指定成果`
                                  : "最初任务 + 直接上游结果"}
                              </div>
                              <Field label="输出要求">
                                <textarea
                                  className="task-textarea"
                                  value={node.data.outputPrompt}
                                  onChange={(event) =>
                                    updateNode({
                                      outputPrompt: event.target.value,
                                    })
                                  }
                                />
                              </Field>
                              <Field label="结束路线（逗号分隔）">
                                <input
                                  value={
                                    terminalRouteDraft?.nodeId === node.id
                                      ? terminalRouteDraft.value
                                      : node.data.terminalRoutes.join(", ")
                                  }
                                  onChange={(event) =>
                                    setTerminalRouteDraft({
                                      nodeId: node.id,
                                      value: event.target.value,
                                    })
                                  }
                                  onBlur={(event) => {
                                    const routes = event.target.value
                                      .split(",")
                                      .map((value) => value.trim())
                                      .filter(Boolean);
                                    setCurrent((previous) => ({
                                      ...previous,
                                      nodes: previous.nodes.map((item) =>
                                        item.id === node.id
                                          ? {
                                              ...item,
                                              data: {
                                                ...item.data,
                                                terminalRoutes: routes,
                                              },
                                            }
                                          : item,
                                      ),
                                    }));
                                    setDirty(true);
                                    setTerminalRouteDraft(null);
                                  }}
                                />
                              </Field>
                              <h4>出口路线</h4>
                              {current.edges
                                .filter((edge) => edge.source === selected)
                                .map((edge) => (
                                  <button
                                    className="route-row"
                                    key={edge.id}
                                    onClick={() => {
                                      setSelectedEdge(edge.id);
                                      setSelected("");
                                    }}
                                  >
                                    <GitBranch size={14} />
                                    {edge.data!.route === "*"
                                      ? "完成后"
                                      : edge.data!.route}
                                    <ChevronRight size={14} />
                                    <span>
                                      {
                                        current.nodes.find(
                                          (n) => n.id === edge.target,
                                        )!.data.label
                                      }
                                    </span>
                                  </button>
                                ))}
                            </>
                          )}
                        </div>
                        <div className="inspector-bottom">
                          <span>
                            <Cable size={14} />
                            Codex 执行器
                          </span>
                          <span>
                            {role.sessionMode === "existing"
                              ? "续用会话"
                              : "新建会话"}
                          </span>
                        </div>
                      </>
                    ) : edge ? (
                      <div className="inspector-scroll">
                        <Field label="路线类型">
                          <select
                            value={edge.data!.kind}
                            onChange={(event) =>
                              update({
                                edges: current.edges.map((item) =>
                                  item.id === edge.id
                                    ? {
                                        ...item,
                                        data: {
                                          ...item.data!,
                                          kind: event.target.value as
                                            "next" | "rework",
                                        },
                                      }
                                    : item,
                                ),
                              })
                            }
                          >
                            <option value="next">正常交接</option>
                            <option value="rework">返工</option>
                          </select>
                        </Field>
                        <Field label="匹配 route 字段（* 表示全部）">
                          <input
                            value={edge.data!.route}
                            onChange={(event) =>
                              update({
                                edges: current.edges.map((item) =>
                                  item.id === edge.id
                                    ? {
                                        ...item,
                                        data: {
                                          ...item.data!,
                                          route: event.target.value,
                                        },
                                      }
                                    : item,
                                ),
                              })
                            }
                          />
                        </Field>
                        <button
                          className="danger secondary"
                          onClick={() => {
                            update({
                              edges: current.edges.filter(
                                (item) => item.id !== edge.id,
                              ),
                            });
                            setSelectedEdge("");
                          }}
                        >
                          <Trash2 size={15} />
                          删除路线
                        </button>
                      </div>
                    ) : (
                      <div className="inspector-scroll">
                        <div className="overview-icon">
                          <WorkflowIcon size={30} />
                        </div>
                        <h3>{current.name}</h3>
                        <p className="muted">{current.description}</p>
                        <button
                          className="secondary"
                          onClick={() => setModal("settings")}
                        >
                          <Settings2 size={15} />
                          全局配置
                        </button>
                      </div>
                    )}
                  </aside>
                )}
              </div>
              {run && (
                <section
                  className={`run-dock ${outputTab === "memory" ? "memory-active" : state?.recovery?.required ? "recovery-active" : ""}`}
                >
                  <div className="dock-header">
                    <div>
                      <span className={`status-badge ${run.status}`}>
                        {statusLabel[run.status]}
                      </span>
                      <strong>{run.task}</strong>
                      {!!(
                        attentionNodes?.length || run.reworkRequests?.length
                      ) && (
                        <button
                          className="attention-link"
                          onClick={() => {
                            setSelected(
                              attentionNodes?.[0]?.id ||
                                run.reworkRequests[0].target,
                            );
                            setOutputTab("result");
                          }}
                        >
                          <CircleHelp size={13} />
                          {attentionNodes?.length || 0} 个问题
                          {!!run.reworkRequests?.length &&
                            ` · ${run.reworkRequests.length} 个返工请求`}
                        </button>
                      )}
                    </div>
                    <div className="toolbar-actions">
                      {run.status === "running" ? (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act(() => window.studio.pause(run.id))
                          }
                        >
                          <Pause size={14} />
                          暂停调度
                        </button>
                      ) : (
                        run.status === "paused" && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              void act(() => window.studio.resume(run.id))
                            }
                          >
                            <Play size={14} />
                            继续调度
                          </button>
                        )
                      )}
                      {(["running", "pausing", "interrupting"].includes(
                        run.status,
                      ) ||
                        activeTurns) && (
                        <button
                          className="interrupt-button"
                          disabled={busy || run.status === "interrupting"}
                          onClick={() =>
                            void act(() => window.studio.interrupt(run.id))
                          }
                        >
                          <Square size={13} fill="currentColor" />
                          立即中断
                        </button>
                      )}
                      <IconButton
                        title="关闭运行面板"
                        onClick={() => setRunId("")}
                      >
                        <X size={15} />
                      </IconButton>
                    </div>
                  </div>
                  {run.error && (
                    <div className="run-warning" role="alert">
                      <CircleHelp size={14} />
                      {run.error}
                    </div>
                  )}
                  {state?.status === "awaiting_response" && (
                    <div className="run-warning awaiting-notice" role="status">
                      <SearchCheck size={14} />
                      Codex 启动请求仍未返回；此步骤可能已在执行。请等待响应，断连后再核对现场。
                    </div>
                  )}
                  <div className="dock-content">
                    <div className="run-steps">
                      {run.workflow.nodes.map((n) => (
                        <button
                          key={n.id}
                          className={selected === n.id ? "active" : ""}
                          onClick={() => setSelected(n.id)}
                        >
                          <span
                            className={`state-dot ${run.states[n.id].status}`}
                          />
                          <span>{n.data.label}</span>
                          <small>{statusLabel[run.states[n.id].status]}</small>
                        </button>
                      ))}
                    </div>
                    <div className="output">
                      <div className="output-tabs">
                        {(["result", "memory", "events", "usage"] as const).map(
                          (value) => (
                            <button
                              key={value}
                              className={outputTab === value ? "active" : ""}
                              onClick={() => setOutputTab(value)}
                            >
                              {
                                {
                                  result: "成果",
                                  memory: "任务记忆",
                                  events: "事件",
                                  usage: "用量",
                                }[value]
                              }
                            </button>
                          ),
                        )}
                        {outputTab !== "memory" && !!state?.attempts?.length && (
                          <select
                            className="attempt-select"
                            aria-label="选择尝试"
                            value={viewedAttempt?.attempt}
                            onChange={(event) =>
                              setAttemptSelection({
                                runId: run.id,
                                nodeId: selected,
                                attempt: Number(event.target.value),
                              })
                            }
                          >
                            {state.attempts.map((attempt) => (
                              <option
                                key={attempt.attempt}
                                value={attempt.attempt}
                              >
                                第 {attempt.attempt} 次 ·{" "}
                                {attempt.snapshotIndex === null
                                  ? "旧配置"
                                  : `配置 ${attempt.snapshotIndex + 1}`}
                                {" · "}
                                {attempt.memoryRevision === null || attempt.memoryRevision === undefined
                                  ? "记忆未知"
                                  : `记忆 ${attempt.memoryRevision}`}
                              </option>
                            ))}
                          </select>
                        )}
                        {outputTab !== "memory" && displayedAttempt?.artifactDirectory && (
                          <IconButton
                            title="打开成果目录"
                            onClick={() =>
                              void act(() =>
                                window.studio.openArtifacts(
                                  run.id,
                                  selected,
                                  viewedAttempt?.attempt || state!.attempt,
                                ),
                              )
                            }
                          >
                            <FolderOpen size={15} />
                          </IconButton>
                        )}
                      </div>
                      {state && (
                        <div className="output-scroll">
                          {outputTab === "result" ? (
                            <>
                              {state.recovery?.required && (
                                <section className="recovery-panel" aria-label="故障恢复">
                                  <div className="recovery-heading">
                                    <strong>原 turn 待核对</strong>
                                    <span>
                                      {state.recovery.phase === "terminal"
                                        ? "已找到终态"
                                        : state.recovery.phase === "in_progress"
                                          ? "仍在执行"
                                          : state.recovery.phase === "unresolved"
                                            ? "尚未定位"
                                            : "等待核对"}
                                    </span>
                                  </div>
                                  <p>{state.recovery.detail}</p>
                                  <div className="recovery-identity">
                                    <code>{state.threadId || "会话 ID 尚未返回"}</code>
                                    <code>{state.turnId || "turn ID 尚未返回"}</code>
                                  </div>
                                  <div className="recovery-actions">
                                    {["interrupted", "needs_attention", "paused"].includes(run.status) && !activeTurns && (
                                      <button
                                        className="secondary"
                                        disabled={busy}
                                        onClick={() => void act(() => window.studio.abandon(run.id))}
                                      >
                                        <Square size={14} />
                                        结束异常运行
                                      </button>
                                    )}
                                    <button
                                      className="secondary"
                                      disabled={busy || !connected}
                                      onClick={() =>
                                        void act(async () => {
                                          await window.studio.inspectRecovery(run.id, selected);
                                          setNotice("原 turn 状态已核对");
                                        })
                                      }
                                    >
                                      <SearchCheck size={14} />
                                      核对现场
                                    </button>
                                  </div>
                                  {state.recovery.phase === "terminal" && (
                                    <>
                                      <textarea
                                        className="recovery-note"
                                        aria-label="副作用核对结论"
                                        value={recoveryNote}
                                        onChange={(event) => setRecoveryNote(event.target.value)}
                                        placeholder="记录已完成成果、文件修改或外部操作的核对结论"
                                      />
                                      <div className="recovery-actions">
                                        {run.status !== "abandoned" && state.recovery.turnStatus === "completed" &&
                                          !!state.recovery.finalAnswerText && (
                                            <button
                                              className="secondary"
                                              disabled={busy || !recoveryNote.trim()}
                                              onClick={() =>
                                                void act(async () => {
                                                  await window.studio.acceptRecoveryResult(
                                                    run.id,
                                                    selected,
                                                    recoveryNote,
                                                  );
                                                  setRecoveryNote("");
                                                  setNotice("已采用原 turn 成果；继续调度由你决定");
                                                })
                                              }
                                            >
                                              <CheckCheck size={14} />
                                              采用已完成结果
                                            </button>
                                          )}
                                        <button
                                          className="secondary"
                                          disabled={busy || !recoveryNote.trim()}
                                          onClick={() =>
                                            void act(async () => {
                                              await window.studio.confirmRecovery(
                                                run.id,
                                                selected,
                                                recoveryNote,
                                              );
                                              setRecoveryNote("");
                                              setNotice(run.status === "abandoned" ? "核对结论已记录；原会话可用于新运行" : "核对结论已记录；可从此重跑");
                                            })
                                          }
                                        >
                                          <ShieldCheck size={14} />
                                          {run.status === "abandoned" ? "确认副作用" : "确认副作用后重跑"}
                                        </button>
                                      </div>
                                    </>
                                  )}
                                </section>
                              )}
                              {!!displayedAttempt?.error && (
                                <pre className="error-text">
                                  {displayedAttempt.error}
                                </pre>
                              )}
                              <pre>
                                {displayedAttempt?.output?.content ||
                                  displayedAttempt?.rawText ||
                                  statusLabel[
                                    displayedAttempt?.status || state.status
                                  ]}
                              </pre>
                              {!!displayedAttempt?.output?.question && (
                                <p>{displayedAttempt.output.question}</p>
                              )}
                              {run.reworkRequests
                                ?.filter(
                                  (request) => request.target === selected,
                                )
                                .map((request) => (
                                  <p
                                    className="rework-request"
                                    key={`${request.source}-${request.sourceAttempt}`}
                                  >
                                    {
                                      run.workflow.nodes.find(
                                        (item) => item.id === request.source,
                                      )?.data.label
                                    }{" "}
                                    第 {request.sourceAttempt} 次请求返工：
                                    {request.feedback}
                                  </p>
                                ))}
                              {!["pending", "queued", "running"].includes(
                                state.status,
                              ) &&
                                !["pausing", "interrupting", "abandoned"].includes(
                                  run.status,
                                ) && (
                                  <div className="answer-row">
                                    <input
                                      aria-label="重跑补充说明"
                                      value={feedback}
                                      onChange={(event) =>
                                        setFeedback(event.target.value)
                                      }
                                      placeholder="回答或重跑补充说明"
                                    />
                                    <button
                                      className="secondary"
                                      disabled={busy || affectedBusy || affectedRecovery || !connected}
                                      title={
                                        affectedBusy
                                          ? "受影响的下游步骤仍在执行"
                                          : affectedRecovery
                                            ? "受影响的步骤需先核对原 turn 与副作用"
                                          : "从选中节点使用当前配置重新执行"
                                      }
                                      onClick={() =>
                                        void act(async () => {
                                          await window.studio.rerun(
                                            run.id,
                                            selected,
                                            current,
                                            feedback,
                                          );
                                          setFeedback("");
                                          setAttemptSelection(null);
                                        })
                                      }
                                    >
                                      <RotateCcw size={14} />
                                      从此重跑
                                    </button>
                                  </div>
                                )}
                            </>
                          ) : outputTab === "memory" ? (
                            <div className="memory-view">
                              <section>
                                <h3>原始需求</h3>
                                <pre>{run.task}</pre>
                                {!!run.materials && (
                                  <>
                                    <h3>指定材料</h3>
                                    <pre>{run.materials}</pre>
                                  </>
                                )}
                              </section>
                              <section>
                                <h3>用户已确认的决定 · 修订 {run.memory.revision}</h3>
                                {run.memory.decisions.length ? (
                                  run.memory.decisions.map((decision) => (
                                    <div className="memory-entry" key={decision.id}>
                                      <small>修订 {decision.revision} · {new Date(decision.at).toLocaleString()}</small>
                                      <p>{decision.text}</p>
                                    </div>
                                  ))
                                ) : (
                                  <p className="muted">暂无已确认的新决定</p>
                                )}
                                <div className="memory-decision-form">
                                  <textarea
                                    aria-label="新增用户决定"
                                    value={decisionDraft}
                                    onChange={(event) => setDecisionDraft(event.target.value)}
                                    placeholder="记录用户明确确认的决定"
                                  />
                                  <div>
                                    <select
                                      aria-label="关联待处理问题"
                                      value={decisionIssueId}
                                      onChange={(event) => setDecisionIssueId(event.target.value)}
                                    >
                                      <option value="">不关联待处理问题</option>
                                      {memoryIssues.map((issue) => (
                                        <option key={issue.id} value={issue.id}>
                                          {run.workflow.nodes.find((item) => item.id === issue.nodeId)?.data.label} · {issue.text}
                                        </option>
                                      ))}
                                    </select>
                                    <button
                                      className="secondary"
                                      disabled={busy || !decisionDraft.trim()}
                                      onClick={() =>
                                        void act(async () => {
                                          await window.studio.addDecision(
                                            run.id,
                                            decisionDraft,
                                            decisionIssueId ? [decisionIssueId] : [],
                                          );
                                          setDecisionDraft("");
                                          setDecisionIssueId("");
                                          setNotice("用户决定已保存");
                                        })
                                      }
                                    >
                                      <Plus size={14} />
                                      保存决定
                                    </button>
                                  </div>
                                </div>
                              </section>
                              <section>
                                <h3>待处理事项</h3>
                                {memoryIssues.length ? memoryIssues.map((issue) => (
                                  <div className="memory-entry" key={issue.id}>
                                    <small>{run.workflow.nodes.find((item) => item.id === issue.nodeId)?.data.label} · 第 {issue.attempt} 次 · {issue.kind === "question" ? "提问" : "未验证"}</small>
                                    <p>{issue.text}</p>
                                  </div>
                                )) : <p className="muted">暂无待处理事项</p>}
                              </section>
                              <section>
                                <h3>角色进度</h3>
                                {run.memory.updates.length ? run.memory.updates.map((update) => (
                                  <div className="memory-entry" key={update.id}>
                                    <small>
                                      {run.workflow.nodes.find((item) => item.id === update.nodeId)?.data.label}
                                      {` · 第 ${update.attempt} 次 · 记忆修订 ${update.memoryRevision ?? "旧记录未知"}`}
                                    </small>
                                    <p>{update.summary}</p>
                                    {!!update.unverified && <small>未验证：{update.unverified}</small>}
                                    {!!update.question && <small>待回答：{update.question}</small>}
                                  </div>
                                )) : <p className="muted">暂无角色进度</p>}
                              </section>
                              {!!run.memory.compactions.length && (
                                <section>
                                  <h3>上下文压缩</h3>
                                  {run.memory.compactions.map((event) => (
                                    <div className="memory-entry" key={`${event.threadId}:${event.turnId}:${event.id}`}>
                                      <small>{run.workflow.nodes.find((item) => item.id === event.nodeId)?.data.label} · 第 {event.attempt} 次 · {new Date(event.at).toLocaleString()}</small>
                                    </div>
                                  ))}
                                </section>
                              )}
                            </div>
                          ) : outputTab === "events" ? (
                            state.logs
                              .filter(
                                (log) =>
                                  !viewedAttempt ||
                                  log.attempt === viewedAttempt.attempt,
                              )
                              .map((log, index) => (
                                <div className="log-row" key={index}>
                                  <time>
                                    {new Date(log.time).toLocaleTimeString()}
                                  </time>
                                  <span>{log.event}</span>
                                  <small>
                                    {log.attempt ? `#${log.attempt} ` : ""}
                                    {log.type}
                                  </small>
                                </div>
                              ))
                          ) : (
                            <pre>
                              {displayedAttempt?.usage
                                ? JSON.stringify(
                                    displayedAttempt.usage,
                                    null,
                                    2,
                                  )
                                : "尚无用量数据"}
                            </pre>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </section>
              )}
            </>
          ) : (
            <section className="history-view">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">EXECUTIONS</span>
                  <h1>运行记录</h1>
                </div>
                <span>{runs.length} 次运行</span>
              </div>
              <div className="history-table">
                <div className="table-head">
                  <span>任务</span>
                  <span>流程</span>
                  <span>状态</span>
                  <span>开始时间</span>
                  <span />
                </div>
                {runs.length === 0 ? (
                  <div className="empty-history">
                    <History size={32} />
                    <h3>尚无运行记录</h3>
                  </div>
                ) : (
                  runs.map((run) => (
                    <button
                      className="table-row"
                      key={run.id}
                      onClick={() => {
                        setCurrent(structuredClone(run.workflow));
                        setSelected(run.workflow.nodes[0].id);
                        setRunId(run.id);
                        setView("canvas");
                        setDirty(false);
                      }}
                    >
                      <strong>{run.task}</strong>
                      <span>{run.workflow.name}</span>
                      <span className={`status-badge ${run.status}`}>
                        {statusLabel[run.status]}
                      </span>
                      <time>{new Date(run.createdAt).toLocaleString()}</time>
                      <ArrowUpRight size={15} />
                    </button>
                  ))
                )}
              </div>
            </section>
          )}
        </main>
      </div>
      {notice && (
        <div className="toast">
          <Check size={16} />
          {notice}
        </div>
      )}
      {modal && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setModal(null);
          }}
        >
          <section
            className={`modal ${modal === "preview" ? "wide" : ""}`}
            role="dialog"
            aria-modal="true"
          >
            <header>
              <div>
                <span className="eyebrow">WORKFLOW STUDIO</span>
                <h2>
                  {
                    {
                      run: "启动流程",
                      settings: "流程设置",
                      preview: "任务与记录",
                      threads: "选择 Codex 对话",
                      delete: "删除流程",
                    }[modal]
                  }
                </h2>
              </div>
              <IconButton title="关闭" onClick={() => setModal(null)}>
                <X size={18} />
              </IconButton>
            </header>
            <div className="modal-content">
              {error && (
                <div className="modal-error" role="alert">
                  {error}
                </div>
              )}
              {modal === "run" && (
                <>
                  <Field label="本次任务">
                    <textarea
                      className="large-textarea"
                      autoFocus
                      value={task}
                      onChange={(event) => setTask(event.target.value)}
                      placeholder="这次需要完成什么？"
                    />
                  </Field>
                  <Field label="材料与附件路径">
                    <textarea
                      value={materials}
                      onChange={(event) => setMaterials(event.target.value)}
                      placeholder="材料正文、文件绝对路径或链接"
                    />
                  </Field>
                  <div className="run-summary">
                    <span>
                      <Layers size={15} />
                      {current.nodes.length} 个步骤
                    </span>
                    <span>
                      <RotateCcw size={15} />
                      最多返工 {current.maxReworks} 次
                    </span>
                    <span>
                      {current.sandbox === "read-only"
                        ? "只读权限"
                        : "工作区写入"}
                    </span>
                  </div>
                </>
              )}
              {modal === "settings" && (
                <>
                  <Field label="流程名称">
                    <input
                      value={current.name}
                      onChange={(event) => update({ name: event.target.value })}
                    />
                  </Field>
                  <Field label="备注">
                    <input
                      value={current.description}
                      onChange={(event) =>
                        update({ description: event.target.value })
                      }
                    />
                  </Field>
                  <Field label="全局要求">
                    <textarea
                      className="large-textarea"
                      value={current.globalPrompt}
                      onChange={(event) =>
                        update({ globalPrompt: event.target.value })
                      }
                    />
                  </Field>
                  <div className="two-fields">
                    <Field label="最大返工次数">
                      <input
                        type="number"
                        min="0"
                        max="20"
                        value={current.maxReworks}
                        onChange={(event) =>
                          update({ maxReworks: Number(event.target.value) })
                        }
                      />
                    </Field>
                    <Field label="Codex 权限">
                      <select
                        value={current.sandbox}
                        onChange={(event) =>
                          update({
                            sandbox: event.target.value as Workflow["sandbox"],
                          })
                        }
                      >
                        <option value="read-only">只读</option>
                        <option value="workspace-write">工作区写入</option>
                      </select>
                    </Field>
                  </div>
                  <div className="data-location">
                    <span>本地数据</span>
                    <code>{dataDirectory}</code>
                  </div>
                  <button
                    className="danger text-button"
                    onClick={() => setModal("delete")}
                  >
                    <Trash2 size={14} />
                    删除此流程
                  </button>
                </>
              )}
              {modal === "preview" && (
                <pre className="preview-text">{preview}</pre>
              )}
              {modal === "threads" && (
                <>
                  <div className="search-input">
                    <Search size={16} />
                    <input
                      autoFocus
                      aria-label="搜索对话"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="搜索标题或会话 ID"
                    />
                  </div>
                  <div className="thread-list">
                    {matchingThreads.map((thread) => (
                      <button
                        key={thread.id}
                        onClick={() => {
                          updateRole({
                            threadId: thread.id,
                            cwd: thread.cwd,
                            projectId: thread.projectId || "",
                          });
                          setModal(null);
                        }}
                      >
                        <span className="thread-icon">
                          <MessageSquare size={17} />
                        </span>
                        <span>
                          <strong>
                            {thread.name ||
                              thread.preview.slice(0, 70) ||
                              thread.id}
                          </strong>
                          <small>
                            {catalog.projects.find(
                              (project) => project.id === thread.projectId,
                            )?.name || "未归属项目"}{" "}
                            · {thread.model}
                          </small>
                          <code>{thread.id}</code>
                        </span>
                        {role?.threadId === thread.id && <Check size={16} />}
                      </button>
                    ))}
                    {!matchingThreads.length && (
                      <div className="empty-list">没有匹配的对话</div>
                    )}
                  </div>
                </>
              )}
              {modal === "delete" && (
                <p>删除“{current.name}”？历史运行和成果将保留。</p>
              )}
            </div>
            {["run", "settings", "delete"].includes(modal) && (
              <footer>
                <button className="secondary" onClick={() => setModal(null)}>
                  取消
                </button>
                {modal === "run" ? (
                  <button
                    className="primary"
                    disabled={busy || !task.trim()}
                    onClick={() =>
                      void act(async () => {
                        await save();
                        const started = await window.studio.start(
                          current,
                          task,
                          materials,
                        );
                        setRuns((previous) => [
                          started,
                          ...previous.filter((run) => run.id !== started.id),
                        ]);
                        setRunId(started.id);
                        setSelected(current.nodes[0].id);
                        setView("canvas");
                        setModal(null);
                      })
                    }
                  >
                    <Play size={14} />
                    开始执行
                  </button>
                ) : modal === "settings" ? (
                  <button
                    className="primary"
                    onClick={() =>
                      void act(async () => {
                        await save();
                        setModal(null);
                      })
                    }
                  >
                    <Check size={15} />
                    保存配置
                  </button>
                ) : (
                  <button
                    className="primary danger-fill"
                    onClick={() =>
                      void act(async () => {
                        await window.studio.remove(current.id);
                        const remaining = workflows.filter(
                          (item) => item.id !== current.id,
                        );
                        const next = remaining[0] || createWorkflow();
                        if (!remaining.length) {
                          await window.studio.save(next);
                          remaining.push(next);
                        }
                        setWorkflows(remaining);
                        setCurrent(next);
                        setSelected(next.nodes[0].id);
                        setRunId("");
                        setDirty(false);
                        setModal(null);
                      })
                    }
                  >
                    确认删除
                  </button>
                )}
              </footer>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
