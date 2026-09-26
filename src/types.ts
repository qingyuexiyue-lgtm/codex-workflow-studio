import type { Edge, Node } from "@xyflow/react";
export interface Role {
  id: string;
  name: string;
  prompt: string;
  model: string;
  effort: string;
  projectId: string;
  cwd: string;
  sessionMode: "new" | "existing";
  threadId: string;
}
export type StepData = {
  label: string;
  roleId: string;
  task: string;
  outputPrompt: string;
  allowQuestions: boolean;
  defaultRule: string;
  inputIds: string[];
  terminalRoutes: string[];
  color: string;
  roleName?: string;
  model?: string;
  status?: string;
  shared?: boolean;
  order?: number;
};
export type Step = Node<StepData>;
export type Route = Edge<{ kind: "next" | "rework"; route: string }>;
export interface Workflow {
  id: string;
  name: string;
  description: string;
  globalPrompt: string;
  maxReworks: number;
  sandbox: "read-only" | "workspace-write";
  roles: Role[];
  nodes: Step[];
  edges: Route[];
  updatedAt: string;
}
export interface Catalog {
  projects: { id: string; name: string; roots: { path: string }[] }[];
  threads: {
    id: string;
    name: string | null;
    preview: string;
    cwd: string;
    projectId: string | null;
    model: string;
    status: { type: string };
    membershipSource: string;
  }[];
  models: {
    id: string;
    model: string;
    displayName: string;
    supportedReasoningEfforts: { reasoningEffort: string }[];
  }[];
}
export interface Output {
  status: string;
  route: string;
  content: string;
  summary: string;
  evidence: string;
  unverified: string;
  question: string;
  artifacts: string[];
}
export interface MemoryDecision {
  id: string;
  revision: number;
  at: string;
  text: string;
  resolves: string[];
}
export interface MemoryUpdate {
  id: string;
  nodeId: string;
  attempt: number;
  memoryRevision: number | null;
  at: string;
  status: string;
  summary: string;
  evidence: string;
  unverified: string;
  question: string;
}
export interface TaskMemory {
  revision: number;
  revisions: {
    revision: number;
    kind: "original" | "user-decision";
    at: string;
    decisionId?: string;
  }[];
  decisions: MemoryDecision[];
  updates: MemoryUpdate[];
  compactions: {
    id: string;
    nodeId: string;
    attempt: number;
    threadId: string;
    turnId: string;
    memoryRevision: number | null;
    at: string;
  }[];
}
export interface MemoryIssue {
  id: string;
  kind: "question" | "unverified";
  text: string;
  nodeId: string;
  attempt: number;
  memoryRevision: number | null;
}
export interface Recovery {
  required: boolean;
  reason: "disconnect" | "restart" | "sleep" | "uncertain_start" | "execution_failure" | "interruption";
  phase: "inspect" | "in_progress" | "terminal" | "unresolved" | "confirmed";
  inspectedAt?: string;
  turnStatus?: "completed" | "failed" | "interrupted" | "inProgress" | "notStarted";
  finalAnswerText?: string | null;
  completedAt?: string | null;
  confirmedAt?: string;
  adoptedAt?: string;
  note?: string;
  detail?: string;
}
export interface ConnectionState {
  status: "connected" | "disconnected" | "connecting";
  error?: string;
}
export interface StepState {
  status: string;
  attempt: number;
  attempts: {
    attempt: number;
    snapshotIndex: number | null;
    memoryRevision: number | null;
    startedAt: string;
    finishedAt: string | null;
    status: string;
    artifactDirectory: string;
    threadId: string;
    turnId: string;
    output: Output | null;
    rawText: string;
    error: string;
    usage: unknown;
    recovery?: Recovery;
    marker?: string;
    operation?: string;
    safeRetries?: number;
  }[];
  output: Output | null;
  rawText: string;
  error: string;
  feedback: string;
  threadId: string;
  turnId: string;
  logs: {
    time: string;
    event: string;
    type: string;
    attempt?: number;
    turnId?: string;
  }[];
  artifactDirectory?: string;
  usage: unknown;
  recovery?: Recovery;
}
export interface Run {
  id: string;
  workflow: Workflow;
  snapshots: Workflow[];
  task: string;
  materials: string;
  materialsVersionPath?: string;
  abandonedAt?: string;
  createdAt: string;
  status: string;
  error: string;
  memory: TaskMemory;
  states: Record<string, StepState>;
  feedback: string;
  reworks: number;
  reworkRequests: {
    source: string;
    sourceAttempt: number;
    target: string;
    feedback: string;
  }[];
}
export interface Studio {
  boot(): Promise<{
    workflows: Workflow[];
    runs: Run[];
    directory: string;
    server: unknown;
    connection: ConnectionState;
  }>;
  catalog(): Promise<Catalog>;
  save(workflow: Workflow): Promise<Workflow>;
  remove(id: string): Promise<void>;
  pickDirectory(): Promise<string | null>;
  history(id: string): Promise<unknown>;
  start(workflow: Workflow, task: string, materials: string): Promise<Run>;
  pause(id: string): Promise<void>;
  interrupt(id: string): Promise<void>;
  abandon(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  reconnect(): Promise<void>;
  inspectRecovery(runId: string, nodeId: string): Promise<Recovery>;
  confirmRecovery(runId: string, nodeId: string, note: string): Promise<void>;
  acceptRecoveryResult(
    runId: string,
    nodeId: string,
    note: string,
  ): Promise<void>;
  addDecision(runId: string, text: string, resolves: string[]): Promise<void>;
  rerun(
    id: string,
    nodeId: string,
    workflow: Workflow,
    feedback: string,
  ): Promise<void>;
  preview(
    workflow: Workflow,
    nodeId: string,
    task: string,
    materials: string,
  ): Promise<string>;
  openArtifacts(runId: string, nodeId: string, attempt: number): Promise<void>;
  window(action: string): void;
  subscribe(callback: (run: Run) => void): () => void;
  subscribeConnection(callback: (connection: ConnectionState) => void): () => void;
}
declare global {
  interface Window {
    studio: Studio;
  }
}
