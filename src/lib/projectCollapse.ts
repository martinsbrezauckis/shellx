export interface ProjectCollapseEntry {
  id: string;
}

export function projectCollapseDefaults(
  projects: ProjectCollapseEntry[],
  persisted: Record<string, unknown>,
): Record<string, boolean> {
  const next: Record<string, boolean> = {};
  projects.forEach((project, index) => {
    const stored = persisted[project.id];
    next[project.id] = typeof stored === "boolean"
      ? stored
      : index !== 0;
  });
  return next;
}

export function reconcileProjectCollapse(
  projects: ProjectCollapseEntry[],
  current: Record<string, boolean>,
  persisted: Record<string, boolean>,
): Record<string, boolean> {
  const next: Record<string, boolean> = {};
  for (const project of projects) {
    next[project.id] = Object.hasOwn(current, project.id)
      ? current[project.id]!
      : persisted[project.id] ?? true;
  }
  return next;
}

export function toggleProjectCollapse(
  current: Record<string, boolean>,
  projectId: string,
): Record<string, boolean> {
  return {
    ...current,
    // Rendering treats a missing key as collapsed. Toggle that visible state
    // to false (expanded), rather than `!undefined === true` (still collapsed).
    [projectId]: current[projectId] === false,
  };
}
