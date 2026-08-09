export function verifyDebugApiBrowserRead(
  path: string,
  body: Record<string, unknown>,
): string | null {
  if (path === "/browser/check") {
    if (body.schema !== "shellx/browser-quiet-check@1" || body.ok !== true || body.mode !== "quiet") {
      throw new Error("Browser check omitted its exact quiet-check identity");
    }
    const effects = requireObject(body.effects, `${path}.effects`);
    for (const key of ["uiMutation", "windowOpened", "taskCreated", "engineMounted", "receiptEmitted"]) {
      if (effects[key] !== false) throw new Error(`Browser check did not prove zero ${key} effect`);
    }
    const settle = requireObject(body.settle, `${path}.settle`);
    if (settle.settled !== true) throw new Error("Browser check did not return a settled result");
    requireObject(body.summary, `${path}.summary`);
    return "Browser check returned a settled, zero-mutation quiet-check receipt.";
  }
  if (path === "/browser/state") {
    for (const key of ["profiles", "tabs", "tasks"]) requireArray(body, key, path);
    if (typeof body.windowOpen !== "boolean") throw new Error("Browser state omitted windowOpen");
    requireObject(body.engine, `${path}.engine`);
    return `Browser state returned ${(body.tabs as unknown[]).length} tab(s), ${(body.tasks as unknown[]).length} task(s), and ${(body.profiles as unknown[]).length} profile(s).`;
  }
  if (path === "/browser/bookmarks") {
    const bookmarks = requireArray(body, "bookmarks", path);
    requireArray(body, "bookmarkToolbar", path);
    return `Browser bookmarks returned ${bookmarks.length} bounded row(s) and a typed toolbar order.`;
  }
  if (path === "/browser/requests") {
    for (const key of ["sessionGrants", "vaultDeposits", "dialogs", "permissions"]) requireArray(body, key, path);
    if (typeof body.revision !== "string" || !body.revision) throw new Error("Browser requests omitted its revision");
    return "Browser requests returned four bounded request collections at one explicit revision.";
  }
  if (path === "/browser/evidence") {
    const recent = requireCountedArray(body, "recent", "count", path);
    requireObject(body.schemas, `${path}.schemas`);
    requireObject(body.routedActions, `${path}.routedActions`);
    for (const key of ["callerScoped", "durableScanTruncated", "durableScanFailed"]) {
      if (typeof body[key] !== "boolean") throw new Error(`Browser evidence omitted boolean ${key}`);
    }
    return `Browser evidence returned ${recent.length} bounded row(s) with explicit scope and durable-scan state.`;
  }
  const arraysByPath: Record<string, string> = {
    "/browser/dialogs": "dialogs",
    "/browser/downloads": "downloads",
    "/browser/history": "history",
    "/browser/logs": "logs",
    "/browser/network": "entries",
    "/browser/permissions": "permissions",
    "/browser/popups": "popups",
    "/browser/receipts": "receipts",
    "/browser/robots": "robots",
    "/browser/storage-state": "profiles",
    "/browser/uploads": "uploads",
  };
  const arrayKey = arraysByPath[path];
  if (arrayKey) {
    const rows = requireArray(body, arrayKey, path);
    if (path === "/browser/history" && (typeof body.revision !== "string" || !body.revision)) {
      throw new Error("Browser history omitted its revision");
    }
    return `${path} returned ${rows.length} bounded ${arrayKey} row(s); row content was not retained.`;
  }
  const objectsByPath: Record<string, string> = {
    "/browser/developer-mode": "developerMode",
    "/browser/engine-pool": "enginePool",
    "/browser/personal-lock": "personalLock",
    "/browser/privacy": "privacy",
    "/browser/shields": "shields",
  };
  const objectKey = objectsByPath[path];
  if (objectKey) {
    requireObject(body[objectKey], `${path}.${objectKey}`);
    return `${path} returned its typed ${objectKey} settings object.`;
  }
  return null;
}

function requireArray(body: Record<string, unknown>, key: string, path: string): unknown[] {
  const value = body[key];
  if (!Array.isArray(value)) throw new Error(`${path} did not return a ${key} array`);
  return value;
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} did not return an object`);
  return value as Record<string, unknown>;
}

function requireCountedArray(body: Record<string, unknown>, key: string, countKey: string, path: string): unknown[] {
  const rows = requireArray(body, key, path);
  if (!Number.isSafeInteger(body[countKey]) || Number(body[countKey]) !== rows.length) {
    throw new Error(`${path} ${countKey} does not match its ${key} array`);
  }
  return rows;
}
