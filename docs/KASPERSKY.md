# Kaspersky exclusions for grok.exe

Kaspersky deletes or quarantines `grok.exe` on download because xAI
ships the binary unsigned. Confirmed empirically on 2026-05-19:
**Kaspersky leaves shellX alone** — only `grok.exe` is flagged. So we
only need to whitelist the grok binary + the directories that grok
itself reads/writes.

## Workaround (until xAI signs grok.exe)

Add these to Kaspersky → Settings → Threats and Exclusions → Manage
exclusions:

| Path | Purpose |
|---|---|
| `C:\Users\<you>\.grok\bin\grok.exe` | xAI grok-build binary |
| `C:\Users\<you>\.grok\` (whole dir, recursive) | grok config, session db, plugins |

Also set the **Application control** rule for `grok.exe` to **Trusted**
(so the realtime scanner doesn't intercept stdio between shellX and
grok — that breaks the ACP JSON-RPC pipe with a 1-3 s lag).

## Symptoms when exclusions are NOT in place

- Fresh download of `grok.exe`: file is deleted from `Downloads/`
  within ~5 s, no on-screen notification (silent quarantine).
- shellX runtime: `Connect` button hangs forever — Kaspersky is
  blocking the grok.exe spawn but not surfacing the block.
  `Get-Process grok*` on Windows shows nothing.
- `/connect` over the debug API: returns a generic
  "Failed to spawn grok" with no useful detail in the body.

## Post-beta plan (xAI's side, not ours)

This is a `grok.exe` problem, not a shellX problem. The fix is for xAI
to ship `grok.exe` with a code-signing certificate. Until then, the
exclusions above are required on every Windows install that uses
Kaspersky. shellX itself doesn't need any whitelist entry.

## Source of truth

If Kaspersky lists either path in its quarantine UI, restore from
quarantine before re-installing. A fresh download of the same byte
sequence will be re-quarantined within seconds; the exclusion must
land BEFORE re-downloading.
