import { runTrustedVaultFillDriver } from "./trusted-vault-fill-driver";

runTrustedVaultFillDriver({
  id: "host-mcp-trusted-vault-fill-installed",
  kind: "host-mcp-tool",
  invocationTransport: "process-cli",
});
