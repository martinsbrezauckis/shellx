import { extractGeneratedMediaPath, shouldScanGeneratedMediaOutput } from "./media-paths";

export type ActivityKind =
  | "searched"
  | "listed"
  | "opened"
  | "read"
  | "written"
  | "created"
  | "deleted"
  | "executed";

export type ActivityConfidence = "verified" | "observed" | "inferred";
export type ActivityActor = "agent" | "human" | "external" | "unknown";
export type ActivitySourceKind = "hunk_record" | "host_mcp" | "grok_event" | "grok_update" | "shell_command" | "fs_watch";

export interface ActivityActionCounts {
  searched: number;
  listed: number;
  opened: number;
  read: number;
  written: number;
  created: number;
  deleted: number;
  executed: number;
}

export interface ActivityAction {
  id: string;
  kind: ActivityKind;
  path: string;
  relativePath: string;
  name: string;
  actor: ActivityActor;
  confidence: ActivityConfidence;
  source: ActivitySourceKind;
  sourceType?: string;
  eventType?: string;
  timestamp?: string;
  timestampMs?: number;
  promptIndex?: number;
  hunkStart?: number;
  hunkEnd?: number;
  linesAdded?: number;
  linesRemoved?: number;
  sourcePath?: string;
  toolCallId?: string;
  toolName?: string;
  command?: string;
  query?: string;
  description?: string;
}

export interface ActivitySourceStatus {
  readable: boolean;
  sourcePath?: string;
  recordsRead: number;
  recordsSkipped: number;
  note?: string;
}

export interface ActivityTrace {
  actions: ActivityAction[];
  source: ActivitySourceStatus;
}

export interface ActivityTreeNode {
  id: string;
  name: string;
  path: string;
  relativePath: string;
  kind: "root" | "dir" | "file";
  counts: ActivityActionCounts;
  actions: ActivityAction[];
  children: ActivityTreeNode[];
}

export interface ActivitySummary {
  total: number;
  verified: number;
  observed: number;
  inferred: number;
  agentWritten: number;
  agentDeleted: number;
  humanWritten: number;
  humanDeleted: number;
  searched: number;
  listed: number;
  read: number;
  executed: number;
}

export type ActivityGraphNodeKind = "session" | "action" | "folder" | "file";

export interface ActivityGraphNode {
  id: string;
  kind: ActivityGraphNodeKind;
  label: string;
  path?: string;
  relativePath?: string;
  actionKind?: ActivityKind;
  count: number;
  counts: ActivityActionCounts;
  confidence: ActivityConfidence;
  actions: ActivityAction[];
}

export interface ActivityGraphEdge {
  id: string;
  from: string;
  to: string;
  count: number;
  confidence: ActivityConfidence;
  actionKinds: ActivityActionCounts;
}

export interface ActivityGraph {
  nodes: ActivityGraphNode[];
  edges: ActivityGraphEdge[];
  targetCount: number;
  hiddenTargetCount: number;
}

interface ActivityGraphOptions {
  maxTargetNodes?: number;
}

interface ParseOptions {
  rootPath?: string;
  sourcePath?: string;
}

interface HunkRecordLike {
  hunkId?: unknown;
  filePath?: unknown;
  hunkStart?: unknown;
  hunkEnd?: unknown;
  linesAdded?: unknown;
  linesRemoved?: unknown;
  authorType?: unknown;
  sessionId?: unknown;
  timestamp?: unknown;
  promptIndex?: unknown;
  sourceType?: unknown;
  eventType?: unknown;
}

interface GrokUpdateLike {
  timestamp?: unknown;
  params?: {
    update?: {
      sessionUpdate?: unknown;
      toolCallId?: unknown;
      title?: unknown;
      status?: unknown;
      rawInput?: unknown;
      rawOutput?: unknown;
      content?: unknown;
    };
  };
}

const ACTIVITY_KINDS: ActivityKind[] = [
  "searched",
  "listed",
  "opened",
  "read",
  "written",
  "created",
  "deleted",
  "executed",
];

function emptyCounts(): ActivityActionCounts {
  return {
    searched: 0,
    listed: 0,
    opened: 0,
    read: 0,
    written: 0,
    created: 0,
    deleted: 0,
    executed: 0,
  };
}

function addCount(target: ActivityActionCounts, kind: ActivityKind, amount = 1): void {
  target[kind] += amount;
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function relativePathFor(path: string, rootPath?: string): string {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = rootPath ? normalizePath(rootPath) : "";
  if (normalizedRoot && normalizedPath === normalizedRoot) return "";
  if (normalizedRoot && normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  return normalizedPath.replace(/^\/+/, "");
}

function isAbsolutePath(path: string): boolean {
  return /^([A-Za-z]:[\\/]|\/|\\\\)/.test(path);
}

function resolvePath(path: string, rootPath?: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === ".") return rootPath || trimmed;
  if (isAbsolutePath(trimmed) || !rootPath) return trimmed;
  const root = rootPath.replace(/[\\/]$/, "");
  return `${root}/${trimmed.replace(/^\.\//, "")}`;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function actorFor(value: unknown): ActivityActor {
  const raw = typeof value === "string" ? value.toLowerCase() : "";
  if (raw === "agent") return "agent";
  if (raw === "human" || raw === "user") return "human";
  if (raw === "external") return "external";
  return "unknown";
}

function kindForHunk(record: HunkRecordLike): ActivityKind {
  const eventType = asString(record.eventType)?.toLowerCase();
  const linesAdded = asNumber(record.linesAdded) ?? 0;
  const linesRemoved = asNumber(record.linesRemoved) ?? 0;
  if (eventType === "deleted" || (linesRemoved > 0 && linesAdded === 0)) return "deleted";
  if (eventType === "created") return "created";
  return "written";
}

function timestampMs(timestamp: string | undefined): number | undefined {
  if (!timestamp) return undefined;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : undefined;
}

function timestampValueMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  return timestampMs(asString(value));
}

function confidenceForHunk(actor: ActivityActor, sourceType: string | undefined): ActivityConfidence {
  return actor === "agent" && sourceType === "agentEdit" ? "verified" : "observed";
}

export function parseHunkRecordsJsonl(jsonl: string, options: ParseOptions = {}): ActivityTrace {
  const actions: ActivityAction[] = [];
  let recordsRead = 0;
  let recordsSkipped = 0;

  for (const line of jsonl.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: HunkRecordLike;
    try {
      parsed = JSON.parse(trimmed) as HunkRecordLike;
    } catch {
      recordsSkipped += 1;
      continue;
    }

    const path = asString(parsed.filePath);
    if (!path) {
      recordsSkipped += 1;
      continue;
    }

    recordsRead += 1;
    const actor = actorFor(parsed.authorType);
    const sourceType = asString(parsed.sourceType);
    const timestamp = asString(parsed.timestamp);
    const resolvedPath = resolvePath(path, options.rootPath);
    const relativePath = relativePathFor(resolvedPath, options.rootPath);
    const kind = kindForHunk(parsed);
    actions.push({
      id: asString(parsed.hunkId) ?? `${path}:${recordsRead}`,
      kind,
      path: resolvedPath,
      relativePath,
      name: basename(path),
      actor,
      confidence: confidenceForHunk(actor, sourceType),
      source: "hunk_record",
      sourceType,
      eventType: asString(parsed.eventType),
      timestamp,
      timestampMs: timestampMs(timestamp),
      promptIndex: asNumber(parsed.promptIndex),
      hunkStart: asNumber(parsed.hunkStart),
      hunkEnd: asNumber(parsed.hunkEnd),
      linesAdded: asNumber(parsed.linesAdded),
      linesRemoved: asNumber(parsed.linesRemoved),
      sourcePath: options.sourcePath,
    });
  }

  actions.sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0));
  return {
    actions,
    source: {
      readable: true,
      sourcePath: options.sourcePath,
      recordsRead,
      recordsSkipped,
    },
  };
}

export function parseGrokUpdatesJsonl(jsonl: string, options: ParseOptions = {}): ActivityTrace {
  const actions: ActivityAction[] = [];
  const seen = new Set<string>();
  let recordsRead = 0;
  let recordsSkipped = 0;

  for (const line of jsonl.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: GrokUpdateLike;
    try {
      parsed = JSON.parse(trimmed) as GrokUpdateLike;
    } catch {
      recordsSkipped += 1;
      continue;
    }

    const update = parsed.params?.update;
    const updateKind = asString(update?.sessionUpdate);
    if (updateKind !== "tool_call" && updateKind !== "tool_call_update") continue;
    recordsRead += 1;
    const rawInput = isRecord(update?.rawInput) ? update.rawInput : {};
    const toolCallId = asString(update?.toolCallId) ?? `tool-${recordsRead}`;
    const title = asString(update?.title) ?? "";
    const timestampMs = timestampValueMs(parsed.timestamp);
    const timestamp = timestampMs ? new Date(timestampMs).toISOString() : undefined;

    const inputActions = actionsFromToolInput({
      rawInput,
      title,
      toolCallId,
      timestamp,
      timestampMs,
      sourcePath: options.sourcePath,
      rootPath: options.rootPath,
    });
    const outputActions = actionsFromToolOutput({
      texts: textFragmentsFromToolUpdate(update),
      title,
      toolCallId,
      timestamp,
      timestampMs,
      sourcePath: options.sourcePath,
      rootPath: options.rootPath,
    });
    const nextActions = [...inputActions, ...outputActions];

    for (const action of nextActions) {
      const key = `${action.toolCallId}:${action.kind}:${normalizePath(action.path)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      actions.push(action);
    }
  }

  actions.sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0));
  return {
    actions,
    source: {
      readable: true,
      sourcePath: options.sourcePath,
      recordsRead,
      recordsSkipped,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function actionsFromToolInput({
  rawInput,
  title,
  toolCallId,
  timestamp,
  timestampMs,
  sourcePath,
  rootPath,
}: {
  rawInput: Record<string, unknown>;
  title: string;
  toolCallId: string;
  timestamp?: string;
  timestampMs?: number;
  sourcePath?: string;
  rootPath?: string;
}): ActivityAction[] {
  const variant = asString(rawInput.variant)?.toLowerCase();
  const toolName = (variant || title || "tool").toString();
  const base = {
    actor: "agent" as ActivityActor,
    source: "grok_update" as ActivitySourceKind,
    timestamp,
    timestampMs,
    sourcePath,
    toolCallId,
    toolName,
    description: asString(rawInput.description),
  };

  const filePath = asString(rawInput.filePath);
  if (filePath && (variant === "write" || /(^|\s)write/i.test(title))) {
    return [makePathAction({ ...base, id: `${toolCallId}:write:${filePath}`, kind: "written", path: filePath, confidence: "observed", rootPath })];
  }
  if (filePath && (variant === "searchreplace" || /search_replace/i.test(title))) {
    return [makePathAction({ ...base, id: `${toolCallId}:searchreplace:${filePath}`, kind: "written", path: filePath, confidence: "observed", rootPath })];
  }

  const targetFile = asString(rawInput.target_file);
  if (targetFile && (variant === "readfile" || /read_file/i.test(title) || /^read `/i.test(title))) {
    return [makePathAction({ ...base, id: `${toolCallId}:read:${targetFile}`, kind: "read", path: targetFile, confidence: "observed", rootPath })];
  }

  const targetDirectory = asString(rawInput.target_directory);
  if (targetDirectory && (variant === "listdir" || /list_dir/i.test(title) || /^list `/i.test(title))) {
    return [makePathAction({ ...base, id: `${toolCallId}:list:${targetDirectory}`, kind: "listed", path: targetDirectory, confidence: "observed", rootPath })];
  }

  const grepPath = asString(rawInput.path) ?? asString(rawInput.target_directory);
  if (grepPath && (variant === "grep" || /grep/i.test(title))) {
    return [makePathAction({
      ...base,
      id: `${toolCallId}:grep:${grepPath}`,
      kind: "searched",
      path: grepPath,
      confidence: "observed",
      rootPath,
      query: asString(rawInput.pattern) ?? asString(rawInput.query),
    })];
  }

  const query = asString(rawInput.query);
  if (query && (variant === "searchtool" || /search_tool/i.test(title))) {
    return [];
  }

  const command = asString(rawInput.command);
  if (command && (variant === "bash" || /execute `/i.test(title) || /run_terminal_command/i.test(title))) {
    return actionsFromCommand(command, {
      ...base,
      command,
      rootPath,
    });
  }

  return [];
}

function actionsFromToolOutput({
  texts,
  title,
  toolCallId,
  timestamp,
  timestampMs,
  sourcePath,
  rootPath,
}: {
  texts: string[];
  title: string;
  toolCallId: string;
  timestamp?: string;
  timestampMs?: number;
  sourcePath?: string;
  rootPath?: string;
}): ActivityAction[] {
  if (texts.length === 0) return [];
  const base = {
    actor: "agent" as ActivityActor,
    source: "grok_update" as ActivitySourceKind,
    sourceType: "media_output",
    timestamp,
    timestampMs,
    sourcePath,
    toolCallId,
    toolName: title || "tool",
    description: title || undefined,
  };
  const out: ActivityAction[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const kind of ["image", "video"] as const) {
      if (!shouldScanGeneratedMediaOutput(title, kind)) continue;
      const path = extractGeneratedMediaPath(text, kind);
      if (!path) continue;
      const key = `${kind}:${normalizePath(path)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(makePathAction({
        ...base,
        id: `${toolCallId}:${kind}:${path}`,
        kind: "created",
        path,
        confidence: "observed",
        rootPath,
      }));
    }
  }
  return out;
}

function textFragmentsFromToolUpdate(update: { rawOutput?: unknown; content?: unknown } | undefined): string[] {
  const texts: string[] = [];
  const rawOutput = isRecord(update?.rawOutput) ? update.rawOutput : null;
  const rawText = asString(rawOutput?.text);
  if (rawText) texts.push(rawText);
  const content = Array.isArray(update?.content) ? update.content : [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    const nested = isRecord(item.content) ? item.content : item;
    const text = asString(nested.text);
    if (text) texts.push(text);
  }
  return texts;
}

function makePathAction(input: Omit<ActivityAction, "relativePath" | "name" | "path"> & {
  path: string;
  rootPath?: string;
}): ActivityAction {
  const resolved = resolvePath(input.path, input.rootPath);
  return {
    ...input,
    path: resolved,
    relativePath: relativePathFor(resolved, input.rootPath),
    name: basename(resolved),
  };
}

function actionsFromCommand(
  command: string,
  base: Omit<ActivityAction, "id" | "kind" | "path" | "relativePath" | "name" | "confidence"> & {
    rootPath?: string;
  },
): ActivityAction[] {
  const trimmed = command.trim();
  const first = trimmed.split(/\s+/, 1)[0] ?? "";
  const candidates = extractCommandPaths(trimmed);
  const path = candidates[0] ?? base.rootPath;
  if (!path) return [];

  let kind: ActivityKind = "executed";
  if (/^(rg|grep|find)\b/.test(first)) kind = "searched";
  else if (/^(ls|tree)\b/.test(first)) kind = "listed";
  else if (/^(cat|sed|nl|head|tail|less|more)\b/.test(first)) kind = "read";

  return [makePathAction({
    ...base,
    id: `${base.toolCallId ?? "cmd"}:${kind}:${path}`,
    kind,
    path,
    confidence: "inferred",
    rootPath: base.rootPath,
  })];
}

function extractCommandPaths(command: string): string[] {
  const noPipes = command.split(/[|;&]/, 1)[0] ?? command;
  const tokens = noPipes.match(/"[^"]+"|'[^']+'|\S+/g) ?? [];
  return tokens
    .map((token) => token.replace(/^['"]|['"]$/g, ""))
    .filter((token, idx) => idx > 0 && !token.startsWith("-") && !/^\d/.test(token))
    .filter((token) =>
      /^(\.{1,2}[\\/]|\/|\\\\|[A-Za-z]:[\\/])/.test(token) ||
      token.includes("/") ||
      token.includes("\\") ||
      /[\w.-]+\.[A-Za-z0-9]{1,8}$/.test(token)
    );
}

export function combineActivityTraces(traces: ActivityTrace[]): ActivityTrace {
  const all = traces.flatMap((trace) => trace.actions);
  const verifiedWrites = all.filter((a) => a.source === "hunk_record" && a.confidence === "verified" && (a.kind === "written" || a.kind === "created" || a.kind === "deleted"));
  const out: ActivityAction[] = [];
  const seen = new Set<string>();

  for (const action of all) {
    if (action.source === "grok_update" && (action.kind === "written" || action.kind === "created" || action.kind === "deleted")) {
      const duplicateVerified = verifiedWrites.some((hunk) =>
        hunk.kind === action.kind &&
        normalizePath(hunk.path) === normalizePath(action.path) &&
        Math.abs((hunk.timestampMs ?? 0) - (action.timestampMs ?? 0)) <= 5000
      );
      if (duplicateVerified) continue;
    }
    const key = `${action.source}:${action.kind}:${normalizePath(action.path)}:${action.timestampMs ?? ""}:${action.toolCallId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(action);
  }

  out.sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0));
  return {
    actions: out,
    source: {
      readable: traces.some((trace) => trace.source.readable),
      sourcePath: traces.map((trace) => trace.source.sourcePath).filter(Boolean).join(", ") || undefined,
      recordsRead: traces.reduce((sum, trace) => sum + trace.source.recordsRead, 0),
      recordsSkipped: traces.reduce((sum, trace) => sum + trace.source.recordsSkipped, 0),
    },
  };
}

function createNode(kind: ActivityTreeNode["kind"], name: string, path: string, relativePath: string): ActivityTreeNode {
  return {
    id: `${kind}:${relativePath || path || name}`,
    name,
    path,
    relativePath,
    kind,
    counts: emptyCounts(),
    actions: [],
    children: [],
  };
}

export function buildActivityTree(actions: ActivityAction[], rootPath = ""): ActivityTreeNode {
  const rootName = rootPath ? basename(rootPath) : "session";
  const root = createNode("root", rootName, rootPath, "");

  for (const action of actions) {
    addCount(root.counts, action.kind);
    const segments = action.relativePath.split("/").filter(Boolean);
    let node = root;
    let pathAcc = normalizePath(rootPath);
    let relAcc = "";

    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      if (!segment) continue;
      const isFile = i === segments.length - 1;
      relAcc = relAcc ? `${relAcc}/${segment}` : segment;
      pathAcc = pathAcc ? `${pathAcc}/${segment}` : segment;
      let child = node.children.find((n) => n.name === segment && n.kind === (isFile ? "file" : "dir"));
      if (!child) {
        child = createNode(isFile ? "file" : "dir", segment, pathAcc, relAcc);
        node.children.push(child);
      }
      addCount(child.counts, action.kind);
      node = child;
    }

    node.actions.push(action);
  }

  sortTree(root);
  return root;
}

function sortTree(node: ActivityTreeNode): void {
  node.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  node.children.forEach(sortTree);
}

export function summarizeActivity(actions: ActivityAction[]): ActivitySummary {
  const out: ActivitySummary = {
    total: actions.length,
    verified: 0,
    observed: 0,
    inferred: 0,
    agentWritten: 0,
    agentDeleted: 0,
    humanWritten: 0,
    humanDeleted: 0,
    searched: 0,
    listed: 0,
    read: 0,
    executed: 0,
  };

  for (const action of actions) {
    out[action.confidence] += 1;
    if (action.kind === "searched") out.searched += 1;
    if (action.kind === "listed") out.listed += 1;
    if (action.kind === "read" || action.kind === "opened") out.read += 1;
    if (action.kind === "executed") out.executed += 1;
    if (action.actor === "agent" && action.kind === "written") out.agentWritten += 1;
    if (action.actor === "agent" && action.kind === "deleted") out.agentDeleted += 1;
    if (action.actor === "human" && action.kind === "written") out.humanWritten += 1;
    if (action.actor === "human" && action.kind === "deleted") out.humanDeleted += 1;
  }

  return out;
}

export function buildActivityGraph(
  actions: ActivityAction[],
  rootPath = "",
  options: ActivityGraphOptions = {},
): ActivityGraph {
  const maxTargetNodes = Math.max(1, options.maxTargetNodes ?? 72);
  const nodes = new Map<string, ActivityGraphNode>();
  const edges = new Map<string, ActivityGraphEdge>();
  const targets = rankActivityTargets(actions);
  const visibleTargets = targets.slice(0, maxTargetNodes);
  const visibleTargetKeys = new Set(visibleTargets.map((target) => target.relativePath));
  const sessionLabel = rootPath ? basename(rootPath) : "session";

  upsertGraphNode(nodes, {
    id: "session:root",
    kind: "session",
    label: sessionLabel,
    path: rootPath,
    relativePath: "",
    count: actions.length,
    counts: countsForActions(actions),
    confidence: strongestConfidence(actions),
    actions,
  });

  for (const kind of ACTIVITY_KINDS) {
    const kindActions = actions.filter((action) => action.kind === kind);
    if (kindActions.length === 0) continue;
    const actionId = `action:${kind}`;
    upsertGraphNode(nodes, {
      id: actionId,
      kind: "action",
      label: graphActionLabel(kind),
      actionKind: kind,
      count: kindActions.length,
      counts: countsForActions(kindActions),
      confidence: strongestConfidence(kindActions),
      actions: kindActions,
    });
    addGraphEdge(edges, "session:root", actionId, kindActions);
  }

  for (const action of actions) {
    const relativePath = action.relativePath || ".";
    if (!visibleTargetKeys.has(relativePath)) continue;
    connectActionTarget(nodes, edges, action, rootPath);
  }

  return {
    nodes: Array.from(nodes.values()).sort(sortGraphNodes),
    edges: Array.from(edges.values()).sort((a, b) => a.id.localeCompare(b.id)),
    targetCount: targets.length,
    hiddenTargetCount: Math.max(0, targets.length - visibleTargets.length),
  };
}

export function totalCount(counts: ActivityActionCounts): number {
  return ACTIVITY_KINDS.reduce((sum, kind) => sum + counts[kind], 0);
}

function rankActivityTargets(actions: ActivityAction[]): Array<{ relativePath: string; count: number; newest: number }> {
  const targets = new Map<string, { relativePath: string; count: number; newest: number }>();
  for (const action of actions) {
    const relativePath = action.relativePath || ".";
    const current = targets.get(relativePath) ?? { relativePath, count: 0, newest: 0 };
    current.count += 1;
    current.newest = Math.max(current.newest, action.timestampMs ?? 0);
    targets.set(relativePath, current);
  }
  return Array.from(targets.values()).sort((a, b) =>
    b.count - a.count ||
    b.newest - a.newest ||
    a.relativePath.localeCompare(b.relativePath)
  );
}

function connectActionTarget(
  nodes: Map<string, ActivityGraphNode>,
  edges: Map<string, ActivityGraphEdge>,
  action: ActivityAction,
  rootPath: string,
): void {
  const actionId = `action:${action.kind}`;
  const relativePath = action.relativePath || ".";
  const segments = relativePath === "." ? [rootPath ? basename(rootPath) : "workspace"] : relativePath.split("/").filter(Boolean);
  if (segments.length === 0) return;

  let parentId = actionId;
  let pathAcc = normalizePath(rootPath);
  let relAcc = "";
  const finalIsFile = isGraphFileTarget(action);

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (!segment) continue;
    const isFinal = i === segments.length - 1;
    const kind: ActivityGraphNodeKind = isFinal && finalIsFile ? "file" : "folder";
    relAcc = relativePath === "." ? "" : (relAcc ? `${relAcc}/${segment}` : segment);
    pathAcc = pathAcc ? `${pathAcc}/${segment}` : segment;
    const id = `${kind}:${relAcc || "."}`;

    upsertGraphNode(nodes, {
      id,
      kind,
      label: segment,
      path: pathAcc,
      relativePath: relAcc || ".",
      count: 1,
      counts: countsForActions([action]),
      confidence: action.confidence,
      actions: [action],
    });
    addGraphEdge(edges, parentId, id, [action]);
    parentId = id;
  }
}

function isGraphFileTarget(action: ActivityAction): boolean {
  if (action.kind === "read" || action.kind === "opened" || action.kind === "written" || action.kind === "created" || action.kind === "deleted") {
    return true;
  }
  return /\.[A-Za-z0-9]{1,8}$/.test(action.name);
}

function upsertGraphNode(nodes: Map<string, ActivityGraphNode>, next: ActivityGraphNode): void {
  const current = nodes.get(next.id);
  if (!current) {
    nodes.set(next.id, {
      ...next,
      counts: { ...next.counts },
      actions: [...next.actions],
    });
    return;
  }

  current.count += next.count;
  for (const kind of ACTIVITY_KINDS) current.counts[kind] += next.counts[kind];
  current.confidence = mergeConfidence(current.confidence, next.confidence);
  current.actions.push(...next.actions);
}

function addGraphEdge(edges: Map<string, ActivityGraphEdge>, from: string, to: string, actions: ActivityAction[]): void {
  if (actions.length === 0) return;
  const id = `${from}->${to}`;
  const nextCounts = countsForActions(actions);
  const current = edges.get(id);
  if (!current) {
    edges.set(id, {
      id,
      from,
      to,
      count: actions.length,
      confidence: strongestConfidence(actions),
      actionKinds: nextCounts,
    });
    return;
  }
  current.count += actions.length;
  current.confidence = mergeConfidence(current.confidence, strongestConfidence(actions));
  for (const kind of ACTIVITY_KINDS) current.actionKinds[kind] += nextCounts[kind];
}

function countsForActions(actions: ActivityAction[]): ActivityActionCounts {
  const counts = emptyCounts();
  for (const action of actions) addCount(counts, action.kind);
  return counts;
}

function strongestConfidence(actions: ActivityAction[]): ActivityConfidence {
  return actions.reduce<ActivityConfidence>((best, action) => mergeConfidence(best, action.confidence), "inferred");
}

function mergeConfidence(a: ActivityConfidence, b: ActivityConfidence): ActivityConfidence {
  if (a === "verified" || b === "verified") return "verified";
  if (a === "observed" || b === "observed") return "observed";
  return "inferred";
}

function graphActionLabel(kind: ActivityKind): string {
  if (kind === "searched") return "search";
  if (kind === "listed") return "list";
  if (kind === "opened") return "open";
  if (kind === "read") return "read";
  if (kind === "written") return "write";
  if (kind === "created") return "create";
  if (kind === "deleted") return "delete";
  if (kind === "executed") return "execute";
  return kind;
}

function sortGraphNodes(a: ActivityGraphNode, b: ActivityGraphNode): number {
  const order: Record<ActivityGraphNodeKind, number> = {
    session: 0,
    action: 1,
    folder: 2,
    file: 3,
  };
  return order[a.kind] - order[b.kind] ||
    b.count - a.count ||
    a.label.localeCompare(b.label);
}
