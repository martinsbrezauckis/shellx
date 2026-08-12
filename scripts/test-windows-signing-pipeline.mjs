import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readSource = (url) => readFileSync(url, "utf8").replaceAll("\r\n", "\n");
const buildScript = readSource(new URL("./build-windows-from-wsl.sh", import.meta.url));
const adapter = readSource(new URL("./windows-artifact-sign-command.sh", import.meta.url));
const signer = readSource(new URL("./windows-artifact-sign.ps1", import.meta.url));
const verifier = readSource(new URL("./verify-release-build-input.mjs", import.meta.url));

assert.match(buildScript, /signCommand:\{cmd:process\.env\.SHELLX_SIGN_COMMAND_PATH,args:\["%1"\]\}/);
assert.match(buildScript, /export SHELLX_WINDOWS_SIGNING_METADATA_PATH="\$metadata_path"/);
assert.match(buildScript, /-VerifyOnly/);
assert.match(buildScript, /signing_required="\$\{SHELLX_WINDOWS_SIGNING_REQUIRED:-1\}"/);
assert.match(buildScript, /updater_required="\$\{SHELLX_WINDOWS_UPDATER_REQUIRED:-1\}"/);
assert.match(buildScript, /SHELLX_EXPECTED_SOURCE_COMMIT/);
assert.match(buildScript, /SHELLX_RELEASE_SOURCE_REPO/);
assert.match(buildScript, /verify-release-build-input\.mjs/);
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

assert.match(adapter, /wslpath -w "\$artifact_path"/);
assert.match(adapter, /windows-artifact-sign\.ps1/);
assert.match(adapter, /verify-release-build-input\.mjs/);
assert.match(adapter, /--expected-commit "\$expected_commit"/);
assert.ok(
  adapter.indexOf('node "$verifier"') < adapter.indexOf("windows-artifact-sign.ps1"),
  "the canonical tree is reverified before every Authenticode signing invocation",
);
assert.match(verifier, /shellx\/public-export-manifest@4/);
assert.match(verifier, /regenerateExpectedExport/);
assert.match(verifier, /assertExactFileTree/);
assert.match(verifier, /requireCleanGitCheckout\(sourceRepo, "canonical source checkout"\)/);
assert.match(verifier, /`\$\{label\} has tracked or staged changes`/);
assert.match(signer, /\[switch\] \$VerifyOnly/);
assert.match(signer, /if \(-not \$VerifyOnly\)/);
assert.match(signer, /Authenticode verifying/);

console.log("PASS Windows signing pipeline tests");
