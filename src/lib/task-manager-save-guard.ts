export type TaskManagerSaveGuardResult<T> =
  | { kind: "busy" }
  | { kind: "preflightRejected" }
  | { kind: "saved"; value: T };

/**
 * Keeps Save single-flight across an asynchronous provider preflight. The UI
 * busy indicator is presentation state; this guard is the action boundary.
 */
export function createTaskManagerSaveGuard(): {
  isActive(): boolean;
  run<T>(preflight: () => Promise<boolean>, save: () => Promise<T>): Promise<TaskManagerSaveGuardResult<T>>;
} {
  let active = false;
  return {
    isActive: () => active,
    async run<T>(preflight: () => Promise<boolean>, save: () => Promise<T>): Promise<TaskManagerSaveGuardResult<T>> {
      if (active) return { kind: "busy" };
      active = true;
      try {
        if (!await preflight()) return { kind: "preflightRejected" };
        return { kind: "saved", value: await save() };
      } finally {
        active = false;
      }
    },
  };
}
