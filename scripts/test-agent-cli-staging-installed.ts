import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, win32 } from "node:path";

import {
  parseJsonValue,
  readJsonProperty,
  requireBooleanProperty,
  requireIntegerProperty,
  requireJsonObject,
  requireStringProperty,
} from "./runtime-json";
import { validateHarnessState } from "./shellx-installed-harness";

const RECEIPT_SCHEMA = "shellx.agent-cli-staging-installed.v1";

function readArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function post(base: string, token: string, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(150_000),
  });
  const text = await response.text();
  const parsed = parseJsonValue(text, `${path} response`);
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${text.slice(0, 500)}`);
  }
  return parsed;
}

function wslPathAbsent(distro: string, path: string): boolean {
  const result = execFileSync("wsl.exe", ["-d", distro, "-e", "test", "!", "-e", path], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.trim() === "";
}

async function main(): Promise<void> {
  const statePath = readArg("--harness-state");
  const outputDir = readArg("--out");
  const distro = readArg("--distro") ?? process.env.SHELLX_AGENT_CLI_SETUP_WSL_DISTRO ?? "Ubuntu-24.04";
  if (!statePath || !outputDir) {
    throw new Error("Usage: tsx scripts/test-agent-cli-staging-installed.ts --harness-state <path> --out <dir> [--distro <name>]");
  }

  const state = validateHarnessState(parseJsonValue(readFileSync(resolve(statePath), "utf8"), "Installed harness state"));
  const token = readFileSync(join(state.shellxHome, "shellxagent.token"), "utf8").trim();
  assert(token.length >= 32, "installed harness token must be available for the live request");

  const now = Date.now();
  const preset = {
    id: `agent-cli-staging-${now}`,
    label: "Agent CLI staging installed proof",
    transport: { kind: "wsl", distro, grokPath: "" },
    createdMs: now,
    lastUsedMs: now,
  };

  let confirmationId: string | null = null;
  let stagedPath: string | null = null;
  try {
    const prepared = requireJsonObject(await post(state.debugBase, token, "/agent_cli_setup/install/prepare", {
      preset,
      providerId: "grok",
      methodId: "macLinux",
    }), "prepare response");
    confirmationId = requireStringProperty(prepared, "confirmationId", "prepare response");
    stagedPath = requireStringProperty(prepared, "stagedPath", "prepare response");
    const sourceUrl = requireStringProperty(prepared, "installerSourceUrl", "prepare response");
    const sha256 = requireStringProperty(prepared, "artifactSha256", "prepare response");
    const bytes = requireIntegerProperty(prepared, "artifactBytes", "prepare response");
    const command = requireStringProperty(prepared, "command", "prepare response");
    const verification = requireStringProperty(prepared, "verification", "prepare response");
    const detectedVersion = readJsonProperty(prepared, "detectedVersion", "prepare response");
    const requiresConfirmation = requireBooleanProperty(prepared, "requiresConfirmation", "prepare response");

    assert.equal(sourceUrl, "https://x.ai/cli/install.sh", "prepare must use the allowlisted Grok installer source");
    assert.match(sha256, /^[a-f0-9]{64}$/, "prepare must return a lowercase SHA-256 digest");
    assert(bytes > 0 && bytes <= 8 * 1024 * 1024, "prepare must return a bounded non-empty artifact");
    assert.equal(requiresConfirmation, true, "prepare must require explicit confirmation");
    assert(
      !/curl[^\n|]*\|\s*(?:ba)?sh\b/i.test(command),
      "confirmation command must not pipe a curl response into a shell",
    );
    assert(
      !/invoke-webrequest[^\n|]*\|/i.test(command),
      "confirmation command must not pipe an Invoke-WebRequest response",
    );
    assert(!/\b(?:iex|invoke-expression)\b/i.test(command), "confirmation command must not evaluate downloaded text");
    assert.match(
      stagedPath,
      /^\/[^\0\r\n]+\/shellx-agent-cli-setup-[a-f0-9]{32}\.sh$/,
      "staged path must use an isolated WSL temp directory and confirmation-bound filename",
    );
    assert(verification.toLowerCase().includes("sha-256"), "prepare must explain digest verification");
    assert(detectedVersion === undefined || typeof detectedVersion === "string", "detectedVersion must be absent or a string");

    const cancelled = requireJsonObject(await post(state.debugBase, token, "/agent_cli_setup/install/cancel", {
      confirmationId,
    }), "cancel response");
    assert.equal(requireBooleanProperty(cancelled, "ok", "cancel response"), true);
    assert.equal(requireBooleanProperty(cancelled, "cleaned", "cancel response"), true);
    const cleanupVerified = wslPathAbsent(distro, stagedPath);
    assert.equal(cleanupVerified, true, "cancel must remove the exact staged WSL artifact");

    const receipt = {
      schemaVersion: RECEIPT_SCHEMA,
      generatedAt: new Date().toISOString(),
      candidate: {
        sourcePath: state.candidateSourcePath,
        executableName: win32.basename(state.executablePath),
        executableVersion: state.executableVersion,
        appVersion: state.appVersion,
        artifactSha256: state.artifactSha256,
      },
      target: { transport: "wsl", distro },
      prepare: {
        providerId: "grok",
        methodId: "macLinux",
        installerSourceUrl: sourceUrl,
        stagedPath,
        artifactSha256: sha256,
        artifactBytes: bytes,
        detectedVersion: typeof detectedVersion === "string" ? detectedVersion : null,
        verification,
        requiresConfirmation,
        networkPipeRejected: true,
      },
      cancel: { ok: true, cleaned: true, stagedPathAbsent: cleanupVerified },
      verdict: "pass",
    };
    const absoluteOutputDir = resolve(outputDir);
    mkdirSync(absoluteOutputDir, { recursive: true });
    const receiptPath = join(absoluteOutputDir, "agent-cli-staging-installed.json");
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    console.log(`PASS installed Agent CLI staging proof: ${receiptPath}`);
  } catch (error) {
    if (confirmationId) {
      try {
        await post(state.debugBase, token, "/agent_cli_setup/install/cancel", { confirmationId });
      } catch {
        // Preserve the primary failure; the installed harness profile remains disposable.
      }
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(`FAIL installed Agent CLI staging proof: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
