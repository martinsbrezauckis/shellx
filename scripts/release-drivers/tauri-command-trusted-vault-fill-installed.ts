import { runTrustedVaultFillDriver } from "./trusted-vault-fill-driver";

runTrustedVaultFillDriver({
  id: "tauri-command-trusted-vault-fill-installed",
  kind: "tauri-command",
  invocationTransport: "debug-api-direct",
});
