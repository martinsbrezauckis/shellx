export interface UiStateSpaceAction<State> {
  id: string;
  /** Return null when the action is not available in this state. */
  apply: (state: Readonly<State>) => State | null;
}

export interface UiStateSpaceSpec<State> {
  name: string;
  initial: State;
  actions: readonly UiStateSpaceAction<State>[];
  key: (state: Readonly<State>) => string;
  validate: (state: Readonly<State>) => void;
  expectedStateCount: number;
  maxStateCount?: number;
}

export interface UiStateSpaceResult {
  name: string;
  stateCount: number;
  transitionCount: number;
  changedActionCount: number;
  maxDepth: number;
}

interface SeenState<State> {
  state: State;
  path: string[];
}

/**
 * Exhaustively explores a bounded deterministic UI model with breadth-first
 * search. The gate rejects unreachable expected states, nondeterministic or
 * mutating transitions, dead actions, and states that cannot navigate back to
 * the initial state.
 */
export function exploreUiStateSpace<State>(spec: UiStateSpaceSpec<State>): UiStateSpaceResult {
  assertUniqueActionIds(spec);
  spec.validate(spec.initial);
  const initialKey = spec.key(spec.initial);
  const seen = new Map<string, SeenState<State>>([
    [initialKey, { state: spec.initial, path: [] }],
  ]);
  const queue = [initialKey];
  const edges = new Map<string, Set<string>>();
  const changedActions = new Set<string>();
  let transitionCount = 0;
  let maxDepth = 0;
  const maxStates = spec.maxStateCount ?? Math.max(spec.expectedStateCount, 1_000);

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const currentKey = queue[cursor]!;
    const current = seen.get(currentKey)!;
    maxDepth = Math.max(maxDepth, current.path.length);
    for (const action of spec.actions) {
      const beforeKey = spec.key(current.state);
      const next = action.apply(current.state);
      const repeated = action.apply(current.state);
      const afterKey = spec.key(current.state);
      if (beforeKey !== afterKey) {
        fail(spec, current, action.id, "transition mutated its input state");
      }
      if ((next === null) !== (repeated === null)) {
        fail(spec, current, action.id, "transition availability is nondeterministic");
      }
      if (next === null || repeated === null) continue;
      const nextKey = spec.key(next);
      const repeatedKey = spec.key(repeated);
      if (nextKey !== repeatedKey) {
        fail(spec, current, action.id, `transition is nondeterministic (${nextKey} != ${repeatedKey})`);
      }
      try {
        spec.validate(next);
      } catch (error) {
        fail(
          spec,
          current,
          action.id,
          `state invariant failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      transitionCount += 1;
      addEdge(edges, currentKey, nextKey);
      if (nextKey !== currentKey) changedActions.add(action.id);
      if (seen.has(nextKey)) continue;
      if (seen.size >= maxStates) {
        fail(spec, current, action.id, `exceeded bounded state budget ${maxStates}`);
      }
      seen.set(nextKey, { state: next, path: [...current.path, action.id] });
      queue.push(nextKey);
    }
  }

  if (seen.size !== spec.expectedStateCount) {
    throw new Error(
      `${spec.name}: reached ${seen.size} states, expected ${spec.expectedStateCount}; `
      + `registries or transition constraints drifted`,
    );
  }
  const deadActions = spec.actions
    .map((action) => action.id)
    .filter((id) => !changedActions.has(id));
  if (deadActions.length > 0) {
    throw new Error(`${spec.name}: actions never change a reachable state: ${deadActions.join(", ")}`);
  }
  assertAllStatesCanReturn(spec.name, initialKey, seen, edges);

  return {
    name: spec.name,
    stateCount: seen.size,
    transitionCount,
    changedActionCount: changedActions.size,
    maxDepth,
  };
}

function assertUniqueActionIds<State>(spec: UiStateSpaceSpec<State>): void {
  const ids = new Set<string>();
  for (const action of spec.actions) {
    if (!action.id.trim()) throw new Error(`${spec.name}: action id cannot be blank`);
    if (!ids.add(action.id)) throw new Error(`${spec.name}: duplicate action id ${action.id}`);
  }
}

function assertAllStatesCanReturn<State>(
  name: string,
  initialKey: string,
  seen: Map<string, SeenState<State>>,
  edges: Map<string, Set<string>>,
): void {
  const reverse = new Map<string, Set<string>>();
  for (const [from, destinations] of edges) {
    for (const to of destinations) addEdge(reverse, to, from);
  }
  const canReturn = new Set([initialKey]);
  const queue = [initialKey];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    for (const predecessor of reverse.get(queue[cursor]!) ?? []) {
      if (canReturn.has(predecessor)) continue;
      canReturn.add(predecessor);
      queue.push(predecessor);
    }
  }
  const trapped = [...seen.entries()].filter(([key]) => !canReturn.has(key));
  if (trapped.length === 0) return;
  const sample = trapped.slice(0, 3).map(([key, value]) => `${key} via ${value.path.join(" -> ")}`).join("; ");
  throw new Error(`${name}: ${trapped.length} state(s) cannot return to the initial state; ${sample}`);
}

function addEdge(edges: Map<string, Set<string>>, from: string, to: string): void {
  const destinations = edges.get(from) ?? new Set<string>();
  destinations.add(to);
  edges.set(from, destinations);
}

function fail<State>(
  spec: UiStateSpaceSpec<State>,
  current: SeenState<State>,
  actionId: string,
  message: string,
): never {
  const path = current.path.length > 0 ? current.path.join(" -> ") : "<initial>";
  throw new Error(`${spec.name}: ${message}; path=${path}; action=${actionId}; state=${spec.key(current.state)}`);
}
