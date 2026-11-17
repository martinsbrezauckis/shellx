export interface DebugUiCommandCursor { epoch: string; sequence: number }
type Fields = Record<string, unknown>;
const fields = (value: unknown): value is Fields => !!value && typeof value === "object" && !Array.isArray(value);
const sequence = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export function parseDebugUiCommandCursor(value: unknown): DebugUiCommandCursor | null {
  return fields(value) && typeof value.epoch === "string" && value.epoch.length > 0 && sequence(value.sequence)
    ? { epoch: value.epoch, sequence: value.sequence } : null;
}

function debugUiCommandTarget(patch: Fields): "app" | "browser" | null {
  const source = typeof patch.source === "string" ? patch.source.trim().toLowerCase() : "";
  if (source === "renderer" || source.startsWith("renderer-") || source === "shellx-browser-ui") return null;
  const surface = typeof patch.debugSurface === "string" ? patch.debugSurface.trim().toLowerCase() : "";
  if (surface === "app" || surface === "browser") return surface;
  return source.includes("browser") ? "browser" : "app";
}

/** Consume exact operator patches once. UI snapshots are observations, never commands. */
export function createDebugUiCommandConsumer(initial: unknown = null, surface: "app" | "browser" = "app") {
  let cursor = parseDebugUiCommandCursor(initial);
  const retiredEpochs = new Set<string>();
  return {
    consume(
      state: Fields,
      apply: (patch: Fields) => void,
      save: (cursor: DebugUiCommandCursor) => void,
      gap: (missing: { from: number; to: number }) => void,
    ): void {
      const stream = state.commandStream;
      const head = parseDebugUiCommandCursor(stream);
      if (!head || retiredEpochs.has(head.epoch) || !fields(stream) || !Array.isArray(stream.commands)) return;
      // Validate the complete bounded stream before performing any action.
      const commands: { sequence: number; patch: Fields }[] = [];
      for (const command of stream.commands) {
        if (!fields(command) || !sequence(command.sequence) || command.sequence === 0 || !fields(command.patch)) return;
        const previous = commands.at(-1);
        if (previous && command.sequence !== previous.sequence + 1) return;
        commands.push({ sequence: command.sequence, patch: command.patch });
      }
      if ((commands.at(-1)?.sequence ?? 0) !== head.sequence) return;
      if (cursor?.epoch === head.epoch && cursor.sequence >= head.sequence) return;
      // A persisted cursor is scoped to the backend lifetime, not global uiRevision.
      if (cursor?.epoch !== head.epoch) {
        if (cursor) retiredEpochs.add(cursor.epoch);
        cursor = { epoch: head.epoch, sequence: 0 };
      }
      if (!cursor) return;
      const first = commands[0]?.sequence ?? 1;
      if (first > cursor.sequence + 1) {
        // Lost commands might be prerequisites for the remainder. Refuse the
        // entire batch and report the gap; the operator must reissue intent.
        const missing = { from: cursor.sequence + 1, to: first - 1 };
        cursor = head;
        save({ ...cursor });
        gap(missing);
        return;
      }
      for (const command of commands) {
        if (command.sequence <= cursor.sequence) continue;
        // Consume before dispatch: repeated transports/reloads must not repeat
        // a click if its handler causes synchronous re-entry or a reload.
        cursor = { epoch: head.epoch, sequence: command.sequence };
        save({ ...cursor });
        if (debugUiCommandTarget(command.patch) === surface) apply(command.patch);
      }
    },
  };
}
