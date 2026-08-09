import { runTrustedVaultFillDriver } from "./trusted-vault-fill-driver";

runTrustedVaultFillDriver({
  id: "ui-control-trusted-vault-fill-installed",
  kind: "ui-control",
  invocationTransport: "native-installed-input",
  controllerFiles: [
    "scripts/lib/release-surface-bounded-observation.ts",
    "scripts/lib/release-surface-installed-input-client.ts",
    "scripts/lib/release-surface-macos-native-input.ts",
  ],
});
