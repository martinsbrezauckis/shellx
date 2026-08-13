import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const readSource = (url) => readFileSync(url, "utf8").replaceAll("\r\n", "\n");
const buildScript = readSource(new URL("./build-windows-from-wsl.sh", import.meta.url));
const adapter = readSource(new URL("./windows-artifact-sign-command.sh", import.meta.url));
const adapterPath = fileURLToPath(new URL("./windows-artifact-sign-command.sh", import.meta.url));
const signer = readSource(new URL("./windows-artifact-sign.ps1", import.meta.url));
const verifier = readSource(new URL("./verify-release-build-input.mjs", import.meta.url));
const packageJson = JSON.parse(readSource(new URL("../package.json", import.meta.url)));

assert.match(buildScript, /signCommand:\{cmd:process\.env\.SHELLX_SIGN_COMMAND_PATH,args:\["%1"\]\}/);
assert.match(buildScript, /export SHELLX_WINDOWS_SIGNING_METADATA_PATH="\$metadata_path"/);
assert.match(buildScript, /-VerifyOnly/);
assert.match(buildScript, /signing_required="\$\{SHELLX_WINDOWS_SIGNING_REQUIRED:-1\}"/);
assert.match(buildScript, /updater_required="\$\{SHELLX_WINDOWS_UPDATER_REQUIRED:-1\}"/);
assert.match(buildScript, /SHELLX_EXPECTED_SOURCE_COMMIT/);
assert.match(buildScript, /SHELLX_RELEASE_SOURCE_REPO/);
assert.match(buildScript, /verify-release-build-input\.mjs/);
assert.match(buildScript, /pnpm install --frozen-lockfile --force --verify-store-integrity --ignore-scripts/);
assert.match(buildScript, /pnpm store status/);
assert.match(buildScript, /pnpm rebuild/);
assert.ok(
  buildScript.indexOf("pnpm store status") < buildScript.indexOf("pnpm rebuild")
    && buildScript.indexOf("pnpm rebuild") < buildScript.indexOf("SHELLX_RELEASE_GENERATED_INPUT_DIGEST="),
  "the pristine store is verified before lifecycle scripts and generated dependencies are sealed afterwards",
);
assert.match(buildScript, /SHELLX_RELEASE_GENERATED_INPUT_DIGEST/);
assert.match(buildScript, /SHELLX_RELEASE_ARTIFACT_ROOT/);
assert.match(buildScript, /SHELLX_RELEASE_NSIS_EXECUTABLE/);
assert.match(buildScript, /SHELLX_RELEASE_NSIS_EXECUTABLE_SHA256/);
assert.match(buildScript, /SHELLX_RELEASE_BUILD_STARTED/);
assert.match(buildScript, /SHELLX_RELEASE_NSIS_SIGNING_STAGE_ROOT/);
assert.match(buildScript, /embedded NSIS uninstaller did not pass the provenance-bound signing callback/);
assert.match(
  packageJson.scripts?.build ?? "",
  /vite build --configLoader runner/,
  "production Vite builds must not write bundled config state into the sealed node_modules tree",
);
assert.doesNotMatch(buildScript, /sed -n 's\/\^Source commit:/);
assert.match(buildScript, /export SHELLX_BUILD_COMMIT="\$build_commit"/);
assert.ok(
  buildScript.indexOf('export SHELLX_BUILD_COMMIT="$build_commit"') <
    buildScript.indexOf('pnpm "${tauri_args[@]}"'),
  "the canonical source identity must be exported before the Tauri build",
);
assert.ok(
  (buildScript.match(/verify_build_input/g) ?? []).length >= 4,
  "exact build input is checked initially, after the Tauri build, and before updater signing",
);
assert.doesNotMatch(buildScript, /--password=/, "updater key passphrase must not be exposed in argv");
assert.equal(
  buildScript.match(/TAURI_SIGNING_PRIVATE_KEY_PASSWORD="\$\{TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-\}"/g)?.length,
  2,
  "both updater-signing lanes must provide a non-interactive password environment value",
);
assert.match(
  buildScript,
  /if \[\[ -n "\$\{TAURI_SIGNING_PRIVATE_KEY:-\}" \]\]; then[\s\S]*?env -u TAURI_SIGNING_PRIVATE_KEY_PATH \\\n+    pnpm exec tauri signer sign "\$dest_nsis"/,
  "an environment private key must be used without a conflicting key-file argument",
);
assert.match(
  buildScript,
  /elif \[\[ -n "\$updater_key_path" \]\]; then[\s\S]*?env -u TAURI_SIGNING_PRIVATE_KEY -u TAURI_SIGNING_PRIVATE_KEY_PATH \\\n+    pnpm exec tauri signer sign \\\n+    --private-key-path "\$updater_key_path"/,
  "the key-file lane must remove any ambient private-key selector",
);
assert.match(buildScript, /trap cleanup_build_log EXIT/);
assert.match(buildScript, /cleanup_build_log\n+build_log=""\n+trap - EXIT/);
assert.match(buildScript, /--target "\$target" --bundles nsis --ci/);
assert.match(buildScript, /grep -Fq "Failed to add bundler type" "\$build_log"/);
assert.match(buildScript, /Built application at: \.\*\/shellx\\\.exe\$/);
assert.match(buildScript, /Windows desktop executable MCP EOF smoke/);
assert.match(buildScript, /exe_win_ps="\$\{exe_win\/\/\\'\/\\'\\'\}"/);
assert.match(buildScript, /& '\$exe_win_ps' --mcp-server; exit \\\$LASTEXITCODE/);
assert.ok(
  buildScript.indexOf('pnpm "${tauri_args[@]}"') <
    buildScript.indexOf("Authenticode verifying copied final artifacts"),
  "Tauri signs the app and installer before copied artifacts are verified",
);
assert.ok(
  buildScript.indexOf("Authenticode verifying copied final artifacts") <
    buildScript.indexOf('if [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]'),
  "Authenticode verification precedes updater signature generation",
);

assert.match(adapter, /wslpath -w "\$artifact_real"/);
assert.match(adapter, /windows-artifact-sign\.ps1/);
assert.match(adapter, /verify-release-build-input\.mjs/);
assert.match(adapter, /--expected-commit "\$expected_commit"/);
assert.match(adapter, /--expected-generated-input-digest "\$generated_input_digest"/);
assert.match(adapter, /Windows signing artifact is outside the exact release target root/);
assert.match(adapter, /Windows signing artifact must be an EXE, MSI, contained NSIS plugin DLL, or controlled NSIS uninstaller/);
assert.match(adapter, /"\$artifact_root"\/\[nN\]\[sS\]\[iI\]\[sS\]\/\*\/\[pP\]\[lL\]\[uU\]\[gG\]\[iI\]\[nN\]\[sS\]\/\*\/\*\.\[dD\]\[lL\]\[lL\]/);
assert.doesNotMatch(adapter, /\$\{[^}]+,,\}/, "signing adapter must remain compatible with macOS system Bash 3.2");
assert.match(adapter, /"\$artifact_directory" != "\/tmp"/);
assert.match(adapter, /\^makensis\[A-Za-z0-9\]\{6\}\$/);
assert.match(adapter, /"\$\(LC_ALL=C head -c 2 "\$artifact_real"\)" != "MZ"/);
assert.match(adapter, /uninstaller-\$makensis_pid-\$\(basename "\$artifact_real"\)\.exe/);
assert.match(adapter, /"\$artifact_root"\/nsis\/\*\/installer\.nsi/);
assert.match(adapter, /NSIS uninstaller signing callback accepted from pinned makensis/);
assert.match(adapter, /NSIS uninstaller signing did not preserve the callback inode/);
assert.ok(
  adapter.indexOf('node "$verifier"') < adapter.indexOf("windows-artifact-sign.ps1"),
  "the canonical tree is reverified before every Authenticode signing invocation",
);
assert.match(verifier, /shellx\/public-export-manifest@4/);
assert.match(verifier, /regenerateExpectedExport/);
assert.match(verifier, /assertExactFileTree/);
assert.match(verifier, /requireCleanGitCheckout\(sourceRepo, "canonical source checkout"\)/);
assert.match(verifier, /verifyCanonicalSourceTree/);
assert.match(verifier, /generated dependency input drifted after its clean install seal/);
assert.match(verifier, /`\$\{label\} has tracked or staged changes`/);
assert.match(signer, /\[switch\] \$VerifyOnly/);
assert.match(signer, /if \(-not \$VerifyOnly\)/);
assert.match(signer, /Authenticode verifying/);
assert.match(signer, /if \(\$Artifact -match "\\\\nsis\\\\\.\*\\\\Plugins\\\\"\)/);
assert.match(signer, /Skipping NSIS plugin helper/);

const temp = mkdtempSync(join(tmpdir(), "shellx-windows-signing-adapter-"));
try {
  const sourceRepo = join(temp, "source");
  const buildRoot = join(temp, "build");
  const artifactRoot = join(buildRoot, "src-tauri", "target", "release");
  const nsisSigningStageRoot = join(artifactRoot, ".shellx-nsis-signing-stage");
  const fakeBin = join(temp, "bin");
  const metadataPath = join(temp, "signing-profile.json");
  const verifierReceipt = join(temp, "verifier-args.json");
  const signerReceipt = join(temp, "powershell-args.txt");
  const fixtureAdapterPath = join(sourceRepo, "scripts", "windows-artifact-sign-command.sh");
  const makensisLookup = spawnSync("bash", ["-lc", 'readlink -f "$(command -v makensis)"'], { encoding: "utf8" });
  const makensisPath = makensisLookup.status === 0 ? makensisLookup.stdout.trim() : "";
  const canRunRealNsisFixture = process.platform === "linux" && makensisPath.length > 0;
  const requireRealNsisFixture = process.env.SHELLX_REQUIRE_REAL_NSIS_FIXTURE === "1";
  if (requireRealNsisFixture) {
    assert.equal(process.platform, "linux", "the real NSIS callback fixture is supported only on Linux/WSL");
    assert.ok(makensisPath, "makensis is required when the real NSIS callback fixture is mandatory");
  }
  const pinnedExecutableLookup = makensisPath
    ? makensisLookup
    : spawnSync("bash", ["-lc", 'readlink -f "$(command -v node)"'], { encoding: "utf8" });
  assert.equal(pinnedExecutableLookup.status, 0, "a pinned executable is required for adapter boundary tests");
  const pinnedExecutablePath = pinnedExecutableLookup.stdout.trim();
  const pinnedExecutableHostPath = process.platform === "win32"
    ? (makensisPath
        ? spawnSync("bash", ["-lc", 'cygpath -w "$(readlink -f "$(command -v makensis)")"'], { encoding: "utf8" })
        : { status: 0, stdout: process.execPath })
    : pinnedExecutableLookup;
  assert.equal(pinnedExecutableHostPath.status, 0, "the pinned executable must resolve in the host filesystem");
  const pinnedExecutableSha256 = createHash("sha256")
    .update(readFileSync(pinnedExecutableHostPath.stdout.trim()))
    .digest("hex");
  mkdirSync(join(sourceRepo, "scripts"), { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  mkdirSync(nsisSigningStageRoot, { mode: 0o700 });
  mkdirSync(fakeBin);
  writeFileSync(metadataPath, "{}\n");
  writeFileSync(fixtureAdapterPath, adapter);
  chmodSync(fixtureAdapterPath, 0o755);
  writeFileSync(join(sourceRepo, "scripts", "windows-artifact-sign.ps1"), "# fixture\n");
  writeFileSync(join(sourceRepo, "scripts", "verify-release-build-input.mjs"), [
    'import { writeFileSync } from "node:fs";',
    'writeFileSync(process.env.SHELLX_TEST_VERIFIER_RECEIPT, JSON.stringify(process.argv.slice(2)));',
    "",
  ].join("\n"));
  writeFileSync(join(fakeBin, "wslpath"), '#!/usr/bin/env bash\nprintf "%s\\n" "${@: -1}"\n');
  writeFileSync(join(fakeBin, "powershell.exe"), '#!/usr/bin/env bash\nprintf "%s\\n" "$*" > "$SHELLX_TEST_SIGNER_RECEIPT"\n');
  chmodSync(join(fakeBin, "wslpath"), 0o755);
  chmodSync(join(fakeBin, "powershell.exe"), 0o755);

  const insideExe = join(artifactRoot, "shellx.exe");
  const wrongExtension = join(artifactRoot, "shellx.txt");
  const arbitraryDll = join(artifactRoot, "helper.dll");
  const nsisPluginDll = join(artifactRoot, "nsis", "x64", "Plugins", "x86-unicode", "NSISdl.dll");
  const misplacedNsisUninstaller = join(artifactRoot, "makensis-misplaced");
  const outsideExe = join(buildRoot, "outside.exe");
  const symlinkExe = join(artifactRoot, "linked.exe");
  writeFileSync(insideExe, "fixture exe\n");
  writeFileSync(wrongExtension, "fixture text\n");
  writeFileSync(arbitraryDll, "fixture dll\n");
  mkdirSync(join(artifactRoot, "nsis", "x64", "Plugins", "x86-unicode"), { recursive: true });
  writeFileSync(nsisPluginDll, "fixture NSIS plugin dll\n");
  writeFileSync(misplacedNsisUninstaller, "MZmisplaced image\n");
  writeFileSync(outsideExe, "fixture outside\n");
  symlinkSync(insideExe, symlinkExe);
  const environment = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    SHELLX_WINDOWS_SIGNING_METADATA_PATH: metadataPath,
    SHELLX_RELEASE_BUILD_ROOT: buildRoot,
    SHELLX_RELEASE_SOURCE_REPO: sourceRepo,
    SHELLX_EXPECTED_SOURCE_COMMIT: "a".repeat(40),
    SHELLX_RELEASE_BUILD_INPUT_VERIFIER: join(sourceRepo, "scripts", "verify-release-build-input.mjs"),
    SHELLX_RELEASE_GENERATED_INPUT_DIGEST: "b".repeat(64),
    SHELLX_RELEASE_ARTIFACT_ROOT: artifactRoot,
    SHELLX_RELEASE_NSIS_EXECUTABLE: pinnedExecutablePath,
    SHELLX_RELEASE_NSIS_EXECUTABLE_SHA256: pinnedExecutableSha256,
    SHELLX_RELEASE_BUILD_STARTED: String(Math.floor(Date.now() / 1000) - 10),
    SHELLX_RELEASE_NSIS_SIGNING_STAGE_ROOT: nsisSigningStageRoot,
    SHELLX_TEST_VERIFIER_RECEIPT: verifierReceipt,
    SHELLX_TEST_SIGNER_RECEIPT: signerReceipt,
  };
  const runAdapter = (artifactPath) => spawnSync("bash", [adapterPath, artifactPath], {
    encoding: "utf8",
    env: environment,
  });

  const outside = runAdapter(outsideExe);
  assert.notEqual(outside.status, 0);
  assert.match(outside.stderr, /outside the exact release target root/);
  const extension = runAdapter(wrongExtension);
  assert.notEqual(extension.status, 0);
  assert.match(extension.stderr, /must be an EXE, MSI, contained NSIS plugin DLL, or controlled NSIS uninstaller/);
  const dll = runAdapter(arbitraryDll);
  assert.notEqual(dll.status, 0);
  assert.match(dll.stderr, /must be an EXE, MSI, contained NSIS plugin DLL, or controlled NSIS uninstaller/);
  const misplaced = runAdapter(misplacedNsisUninstaller);
  assert.notEqual(misplaced.status, 0);
  assert.match(misplaced.stderr, /controlled NSIS uninstaller/);
  const linked = runAdapter(symlinkExe);
  assert.notEqual(linked.status, 0);
  assert.match(linked.stderr, /regular non-symlink file/);

  const accepted = runAdapter(insideExe);
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  const verifierArgs = JSON.parse(readFileSync(verifierReceipt, "utf8"));
  assert.deepEqual(verifierArgs.map((argument, index) => (
    index === 1 || index === 3 ? realpathSync(argument) : argument
  )), [
    "--build-root", realpathSync(buildRoot),
    "--source-repo", realpathSync(sourceRepo),
    "--expected-commit", "a".repeat(40),
    "--expected-generated-input-digest", "b".repeat(64),
  ]);
  assert.match(readFileSync(signerReceipt, "utf8"), /windows-artifact-sign\.ps1/);
  assert.match(readFileSync(signerReceipt, "utf8"), /shellx\.exe/);

  const acceptedNsisPlugin = runAdapter(nsisPluginDll);
  assert.equal(acceptedNsisPlugin.status, 0, acceptedNsisPlugin.stderr || acceptedNsisPlugin.stdout);
  assert.match(readFileSync(signerReceipt, "utf8"), /NSISdl\.dll/);

  if (canRunRealNsisFixture) {
    const nsisFixtureRoot = join(artifactRoot, "nsis", "fixture");
    const nsisScript = join(nsisFixtureRoot, "installer.nsi");
    const nsisOut = join(nsisFixtureRoot, "fixture-installer.exe");
    mkdirSync(nsisFixtureRoot, { recursive: true });
    writeFileSync(nsisScript, [
      'Name "ShellX signing callback fixture"',
      `OutFile "${nsisOut}"`,
      `!uninstfinalize '\"${fixtureAdapterPath}\" \"%1\"'`,
      "Section",
      '  WriteUninstaller "$TEMP\\shellx-signing-callback-fixture.exe"',
      "SectionEnd",
      'Section "Uninstall"',
      "SectionEnd",
      "",
    ].join("\n"));
    const realNsisCallback = spawnSync(makensisPath, ["-V2", nsisScript], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(realNsisCallback.status, 0, realNsisCallback.stderr || realNsisCallback.stdout);
    assert.match(realNsisCallback.stdout, /NSIS uninstaller signing callback accepted from pinned makensis/);
    assert.match(readFileSync(signerReceipt, "utf8"), /\.shellx-nsis-signing-stage\/uninstaller-[0-9]+-makensis[A-Za-z0-9]{6}\.exe/);
    assert.deepEqual(readdirSync(nsisSigningStageRoot), []);
  } else {
    console.log("SKIP real NSIS callback fixture: Linux/WSL with makensis is required");
  }

} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log("PASS Windows signing pipeline tests");
