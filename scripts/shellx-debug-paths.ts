import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function wslWindowsShellxHomes(): string[] {
  const usersRoot = "/mnt/c/Users";
  let entries: string[];
  try {
    entries = readdirSync(usersRoot);
  } catch {
    return [];
  }
  return entries
    .filter((name) => !["All Users", "Default", "Default User", "Public"].includes(name))
    .map((name) => join(usersRoot, name, ".shellx"))
    .filter((dir) => existsSync(dir));
}

export function shellxHomeCandidates(): string[] {
  return [
    process.env.SHELLX_HOME,
    join(homedir(), ".shellx"),
    ...wslWindowsShellxHomes(),
  ].filter((entry): entry is string => Boolean(entry));
}

export function shellxDataPaths(file: string): string[] {
  return shellxHomeCandidates().map((dir) => join(dir, file));
}
