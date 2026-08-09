import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  RELEASE_SURFACE_WINDOWS_NSIS_INSTALLATION_SCHEMA,
  validateReleaseSurfaceWindowsNsisInstallationObservation,
  windowsNsisPowerShellArguments,
  type ReleaseSurfaceWindowsNsisInstallationObservation,
} from "./lib/release-surface-windows-nsis-installation";

const artifact = { basename: "ShellX_0.3.5_x64-setup.exe", sha256: "a".repeat(64), bytes: 12_345 };
const targetRoot = "C:\\Users\\release-fixture\\AppData\\Local\\ShellXReleaseEvidence\\shellx-final-install-run-1";
const artifactPath = "C:\\Release Evidence\\ShellX_0.3.5_x64-setup.exe";
const expectedUser = "SHELLX-TEST\\release-fixture";
const approvedSignature = {
  kind: "windows-authenticode" as const,
  collector: "windows-powershell-authenticode-v1" as const,
  status: "Valid" as const,
  verifiedAt: "2026-07-28T17:59:00.000Z",
  publisher: { commonName: "U1C", organization: "U1C", country: "LV" },
  verificationPolicy: {
    provider: "azure-artifact-signing" as const,
    expectedEndpointHost: "fixture.codesigning.azure.net",
    expectedAccountName: "fixture-account",
    expectedProfileName: "fixture-profile",
    metadata: { basename: "shellx-artifact-signing-metadata.json", sha256: "c".repeat(64), bytes: 512 },
  },
  signerCertificate: certificate("CN=U1C, O=U1C, C=LV", "CN=Microsoft ID Verified CS AOC CA 04, O=Microsoft Corporation, C=US", "b"),
  timestampCertificate: certificate("CN=Microsoft Public RSA Time Stamping Authority", "CN=Microsoft Public RSA Timestamping CA 2020, O=Microsoft Corporation, C=US", "d"),
};
const effects = [
  {
    id: "windows-product-registration",
    status: "pass" as const,
    observed: "exact product registration",
    details: { registryPath: "HKCU\\Software\\shellx\\shellX", installLocation: targetRoot },
  },
  {
    id: "windows-uninstall-registration",
    status: "pass" as const,
    observed: "exact uninstall registration",
    details: {
      registryPath: "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\shellX",
      displayName: "shellX",
      displayVersion: "0.3.5",
      publisher: "shellx",
      mainBinaryName: "shellx.exe",
      installLocation: targetRoot,
      uninstallExecutable: `${targetRoot}\\uninstall.exe`,
      displayIcon: `${targetRoot}\\shellx.exe`,
      noModify: 1,
      noRepair: 1,
    },
  },
  {
    id: "windows-shortcuts-suppressed",
    status: "pass" as const,
    observed: "no shortcuts",
    details: { startMenuAbsent: true, desktopAbsent: true },
  },
  {
    id: "windows-explorer-handoff-suppressed",
    status: "pass" as const,
    observed: "no Explorer handoff",
    details: { fileContextMenuAbsent: true, directoryContextMenuAbsent: true, sendToAbsent: true },
  },
];
const observation: ReleaseSurfaceWindowsNsisInstallationObservation = {
  schema: RELEASE_SURFACE_WINDOWS_NSIS_INSTALLATION_SCHEMA,
  collector: "windows-powershell-nsis-v1",
  orchestrator: "wsl",
  userName: expectedUser,
  userSid: "S-1-5-21-1000-1001-1002-1003",
  userIsAdministrator: false,
  userIsAdministratorsMember: false,
  artifact: {
    ...artifact,
    path: artifactPath,
    signatureStatus: "Valid",
    signerThumbprint: approvedSignature.signerCertificate.thumbprint,
    signerSubject: approvedSignature.signerCertificate.subject,
    signerIssuer: approvedSignature.signerCertificate.issuer,
    timestampSubject: approvedSignature.timestampCertificate.subject,
    timestampIssuer: approvedSignature.timestampCertificate.issuer,
    timestampThumbprint: approvedSignature.timestampCertificate.thumbprint,
  },
  operation: {
    startedAt: "2026-07-28T18:00:00.000Z",
    completedAt: "2026-07-28T18:00:01.000Z",
    exitCode: 0,
    targetRootStateBefore: "absent",
    arguments: ["/S", "/NS", "/D=<redacted-run-owned-target>"],
  },
  targetRoot,
  mainExecutablePath: `${targetRoot}\\shellx.exe`,
  expectedVersion: "0.3.5",
  webView2Identity: [{ scope: "machine-wow6432", version: "138.0.3351.121" }],
  safety: {
    machineRegistrationsBefore: [],
    machineRegistrationsAfter: [],
    shellxProcessCountBefore: 0,
    shellxProcessCountAfter: 0,
    webView2IdentityUnchanged: true,
  },
  systemEffects: effects,
};

const validationInput = {
  observation,
  orchestrator: "wsl" as const,
  expectedUser,
  expectedVersion: "0.3.5",
  artifact,
  artifactPath,
  targetRoot,
  approvedSignature,
};
assert.deepEqual(validateReleaseSurfaceWindowsNsisInstallationObservation(validationInput), []);

const wrongUser = structuredClone(observation);
wrongUser.userName = "normal-user";
assert(validateReleaseSurfaceWindowsNsisInstallationObservation({ ...validationInput, observation: wrongUser })
  .some((error) => error.includes("disposable user")));
const wrongArguments = structuredClone(observation);
wrongArguments.operation.arguments = ["/S", "/NS", "/D=<redacted-run-owned-target>"];
(wrongArguments.operation.arguments as string[]).splice(1, 0, "/R");
assert(validateReleaseSurfaceWindowsNsisInstallationObservation({ ...validationInput, observation: wrongArguments })
  .some((error) => error.includes("arguments")));
const missingWebView = structuredClone(observation);
missingWebView.webView2Identity = [];
assert(validateReleaseSurfaceWindowsNsisInstallationObservation({ ...validationInput, observation: missingWebView })
  .some((error) => error.includes("WebView2")));
const wrongNativeSigner = structuredClone(observation);
wrongNativeSigner.artifact.signerThumbprint = "e".repeat(40);
assert(validateReleaseSurfaceWindowsNsisInstallationObservation({ ...validationInput, observation: wrongNativeSigner })
  .some((error) => error.includes("approved structured signing profile")));

const psArguments = windowsNsisPowerShellArguments({
  scriptPath: "C:\\evidence\\run.ps1",
  artifactPath,
  targetRoot,
  expectedUser,
  expectedVersion: "0.3.5",
  orchestrator: "wsl",
});
assert.deepEqual(psArguments.slice(-10), [
  "-ArtifactPath", artifactPath,
  "-TargetRoot", targetRoot,
  "-ExpectedUser", expectedUser,
  "-ExpectedVersion", "0.3.5",
  "-Orchestrator", "wsl",
]);
assert.throws(() => windowsNsisPowerShellArguments({
  scriptPath: "C:\\evidence\\run.ps1",
  artifactPath: `${artifactPath}\n/R`,
  targetRoot,
  expectedUser,
  expectedVersion: "0.3.5",
  orchestrator: "wsl",
}), /invalid/);

const installerSource = readFileSync(resolve(import.meta.dirname, "run-release-surface-windows-nsis-install.ps1"), "utf8");
assert(installerSource.includes('$startInfo.Arguments = "/S /NS /D=$target"'));
assert(installerSource.includes("[Diagnostics.ProcessStartInfo]::new()"));
assert(!installerSource.includes("Start-Process -FilePath"));
assert(!installerSource.includes('Arguments = "/R'));
assert(!installerSource.includes('Arguments = "/P'));
assert(!installerSource.includes('Arguments = "/UPDATE'));
assert(!installerSource.includes('Arguments = "/NCRC'));
assert(installerSource.includes('[IO.DriveInfo]::new("$driveLetter\\")'));
assert(installerSource.includes("[IO.DriveType]::Fixed"));
assert(installerSource.includes('"$env:SystemRoot\\System32\\subst.exe"'));
assert(installerSource.includes("$substExitCode -ne 1"));
assert(!installerSource.includes("Get-CimInstance Win32_Volume"));
assert(installerSource.includes('Get-Process -Name "shellx", "app" -ErrorAction SilentlyContinue'));
assert(!installerSource.includes("Get-CimInstance Win32_Process"));
assert(installerSource.includes('$values.PSObject.Properties["DisplayName"]'));
assert(installerSource.includes('$values.PSObject.Properties["Publisher"]'));
assert(!installerSource.includes("$values.DisplayName"));
assert(!installerSource.includes("$values.Publisher"));
assert(installerSource.includes("basename = $artifact.Name"));
for (const safetyProof of [
  "fresh non-admin disposable Windows user",
  "local fixed volume",
  "TargetRoot parent must be owned",
  "WebView2 must already be installed",
  "machine-wide ShellX",
  "unexpectedly launched ShellX",
  "changed during execution",
]) {
  assert(installerSource.includes(safetyProof), `Windows NSIS adapter must retain safety proof: ${safetyProof}`);
}
const finalizerSource = readFileSync(resolve(import.meta.dirname, "finalize-release-surface-windows-nsis-installation.ps1"), "utf8");
assert(finalizerSource.includes('$startInfo.Arguments = "/S _?=$target"'));
assert(finalizerSource.includes("$identity.User.Value -ne $ExpectedUserSid"));
assert(finalizerSource.includes("WaitForExit(5 * 60 * 1000)"));
assert(finalizerSource.includes("unexpected residual; preserving TargetRoot"));
assert(finalizerSource.includes("[IO.Directory]::Delete($target, $false)"));
assert(finalizerSource.includes("Remove-Item -LiteralPath $uninstallerPath"));
assert(finalizerSource.includes('[IO.DriveInfo]::new("$driveLetter\\")'));
assert(finalizerSource.includes('"$env:SystemRoot\\System32\\subst.exe"'));
assert(finalizerSource.includes('Get-Process -Name "shellx", "app" -ErrorAction SilentlyContinue'));
assert(!finalizerSource.includes("Get-CimInstance Win32_Volume"));
assert(!finalizerSource.includes("Get-CimInstance Win32_Process"));
assert(!finalizerSource.includes("Remove-Item -Recurse"));
assert(!finalizerSource.includes("Remove-Item -LiteralPath $target"));
assert(!finalizerSource.includes("RMDir /r"));
assert(installerSource.includes('$administratorsSid = "S-1-5-32-544"'));
assert(installerSource.includes("$identity.Groups"));
assert(installerSource.includes("WaitForExit(15 * 60 * 1000)"));
assert(installerSource.includes("taskkill.exe"));
assert(installerSource.includes("$taskKillExitCode -ne 0"));
assert(installerSource.includes("$process.HasExited"));
assert(finalizerSource.includes("$taskKillExitCode -ne 0"));
assert(finalizerSource.includes("$process.HasExited"));

if (process.platform === "win32" || process.env.WSL_INTEROP?.trim()) {
  for (const scriptName of [
    "collect-release-surface-windows-authenticode.ps1",
    "collect-release-surface-windows-payload.ps1",
    "run-release-surface-windows-nsis-install.ps1",
    "finalize-release-surface-windows-nsis-installation.ps1",
  ]) {
    const scriptPath = resolve(import.meta.dirname, scriptName);
    const env = {
      ...process.env,
      SHELLX_PS_PARSE_PATH: scriptPath,
      WSLENV: appendWslenv(process.env.WSLENV, "SHELLX_PS_PARSE_PATH/p"),
    };
    const parsed = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "$errors=$null; [System.Management.Automation.Language.Parser]::ParseFile($env:SHELLX_PS_PARSE_PATH, [ref]$null, [ref]$errors) > $null; if($errors){$errors | ForEach-Object { $_.ToString() }; exit 1 }",
    ], { encoding: "utf8", env });
    assert.equal(parsed.status, 0, `${scriptName} must parse in Windows PowerShell 5.1: ${parsed.stderr || parsed.stdout}`);
  }
  const bindingProbe = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "$one=Join-Path $env:TEMP 'shellx-finalizer-missing-one'; $two=Join-Path $env:TEMP 'shellx-finalizer-missing-two'; if ((Test-Path -LiteralPath $one) -or (Test-Path -LiteralPath $two)) { exit 9 }; Write-Output pass",
  ], { encoding: "utf8" });
  assert.equal(bindingProbe.status, 0, `PowerShell 5.1 finalizer postcondition must execute: ${bindingProbe.stderr}`);
  assert.equal(bindingProbe.stdout.trim(), "pass");
}

console.log("Release surface Windows NSIS installation tests passed");

function appendWslenv(current: string | undefined, entry: string): string {
  return current?.trim() ? `${current}:${entry}` : entry;
}

function certificate(subject: string, issuer: string, fill: string) {
  return {
    subject,
    issuer,
    thumbprint: fill.repeat(40),
    serialNumber: fill.repeat(16),
    notBefore: "2026-07-01T00:00:00.000Z",
    notAfter: "2026-08-01T00:00:00.000Z",
  };
}
