import { runTrustedVaultFillDriver } from "./trusted-vault-fill-driver";

runTrustedVaultFillDriver({
  id: "browser-cli-trusted-vault-fill-installed",
  kind: "browser-cli-command",
  invocationTransport: "process-cli",
  controllerFiles: ["scripts/shellx-browser-cli.ts"],
});
