/**
 * Cross-platform folder path helpers shared by the Files pane and the remote
 * folder picker. Paths stay in the syntax understood by their target runtime:
 * POSIX paths use `/`, native Windows and UNC paths use `\`, and WSL UNC paths
 * are translated to their Linux path before an in-WSL file request is sent.
 */

function isWindowsFolderPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.includes("\\");
}

export function normalizeFolderPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";
  if (!isWindowsFolderPath(trimmed)) {
    const normalized = trimmed.replace(/\\/g, "/").replace(/\/+/g, "/");
    if (normalized === "/") return "/";
    return normalized.replace(/\/+$/, "") || "/";
  }
  const normalized = trimmed.replace(/\//g, "\\");
  if (/^[A-Za-z]:\\?$/.test(normalized)) return `${normalized.slice(0, 2)}\\`;
  if (normalized.startsWith("\\\\")) {
    const parts = normalized.split("\\").filter(Boolean);
    return `\\\\${parts.join("\\")}`.replace(/\\+$/, "");
  }
  return normalized.replace(/\\+$/, "");
}

export function parentFolderPath(path: string): string | null {
  const normalized = normalizeFolderPath(path);
  if (!normalized) return null;
  if (!isWindowsFolderPath(normalized)) {
    if (normalized === "/") return null;
    const idx = normalized.lastIndexOf("/");
    return idx <= 0 ? "/" : normalized.slice(0, idx);
  }
  if (/^[A-Za-z]:\\?$/.test(normalized)) return null;
  if (normalized.startsWith("\\\\")) {
    const parts = normalized.split("\\").filter(Boolean);
    if (parts.length <= 2) return null;
    return `\\\\${parts.slice(0, -1).join("\\")}`;
  }
  const idx = normalized.lastIndexOf("\\");
  if (idx < 0) return null;
  if (idx === 2 && /^[A-Za-z]:/.test(normalized)) return `${normalized.slice(0, 2)}\\`;
  return normalized.slice(0, idx);
}

export function joinFolderPath(base: string, child: string): string {
  const normalizedBase = normalizeFolderPath(base);
  const windowsStyle = isWindowsFolderPath(normalizedBase);
  const separator = windowsStyle ? "\\" : "/";
  const normalizedChild = windowsStyle ? child.replace(/\//g, "\\") : child.replace(/\\/g, "/");
  return normalizeFolderPath(
    `${normalizedBase.replace(/[\\/]$/, "")}${separator}${normalizedChild.replace(/^[\\/]/, "")}`,
  );
}

export function folderPathsEqual(a: string, b: string): boolean {
  const left = normalizeFolderPath(a);
  const right = normalizeFolderPath(b);
  return isWindowsFolderPath(left) || isWindowsFolderPath(right)
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

export function folderDisplayLabel(path: string, cwd: string): string {
  const folder = normalizeFolderPath(path);
  const root = normalizeFolderPath(cwd);
  if (!folder) return "/";
  if (folderPathsEqual(folder, root)) {
    const parts = folder.split(/[\\/]/).filter(Boolean);
    return parts.at(-1) ?? folder;
  }
  const windowsStyle = isWindowsFolderPath(folder) || isWindowsFolderPath(root);
  const separator = windowsStyle ? "\\" : "/";
  const comparableFolder = windowsStyle ? folder.toLowerCase() : folder;
  const comparableRoot = windowsStyle ? root.toLowerCase() : root;
  if (comparableRoot && comparableFolder.startsWith(`${comparableRoot}${separator}`)) {
    return `.../${folder.slice(root.length + 1).replace(/\\/g, "/")}`;
  }
  return folder;
}

export function normalizeRemoteFolderPath(path: string): string {
  const slashPath = path.trim().replace(/\\/g, "/");
  const wslUnc = slashPath.match(/^\/\/wsl(?:\.localhost|\$)\/[^/]+(\/.*)?$/i);
  if (wslUnc) return normalizeFolderPath(wslUnc[1] || "/") || "/";
  return normalizeFolderPath(path) || "/";
}

export function parentRemoteFolderPath(path: string): string | null {
  return parentFolderPath(normalizeRemoteFolderPath(path));
}

export function joinRemoteFolderPath(base: string, child: string): string {
  return joinFolderPath(normalizeRemoteFolderPath(base), child);
}
