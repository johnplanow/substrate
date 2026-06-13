# Recommendations: Claude Code enterprise configuration

**Author:** John Planow
**Date:** 2026-06-12
**Companion to:** `docs/2026-05-29-codex-managed-config-policy-ask.md` (accepted 2026-06; org added `never` to Codex `allowed_approval_policies`)
**Verified against:** code.claude.com docs (server-managed-settings, permissions, sandboxing, settings reference), 2026-06-12. Unverifiable items are flagged inline rather than asserted.

## Purpose

Configuration recommendations for Claude Code under enterprise management that (a) keep **headless automation** working — substrate's pipeline dispatches `claude -p` agents non-interactively — and (b) are **appropriate defaults for general-purpose interactive use**. These are not automation-only carve-outs; each recommendation is justified for both populations.

## The governing principle (the lesson from the Codex arc)

**Approval prompts are a UX affordance, not a security boundary.** Any account that runs headless automation must be able to run without a human answering prompts — so the security controls must be the ones that work identically for humans and automation:

1. **Deny rules** — absolute; verified enforced *even in bypass mode* ("deny rules are the one safety control that always runs — even in bypass mode", permissions docs).
2. **Filesystem scope** — git worktrees + (optionally) OS sandbox path policy.
3. **Network policy** — sandbox domain allowlists, proxies.
4. **Git itself** — every automated change is a revertible commit on a branch behind review gates.

The Codex incident was exactly this principle violated: an approval-policy allow-list was load-bearing, headless mode couldn't satisfy it, and six engineering iterations confirmed no workaround existed below the policy layer. The same failure is available in Claude Code via one setting (below).

## What automation requires (the headless contract)

Substrate dispatches: `claude -p --model <m> --dangerously-skip-permissions --output-format stream-json --verbose` under a Claude Code subscription OAuth session. Anything that breaks that invocation — or prompts mid-run — kills every dispatch.

---

## Recommendations

### R1 — Do NOT set `permissions.disableBypassPermissionsMode: "disable"` (the headline)

This is the Claude Code analog of Codex's missing `Never`. Setting it makes `--dangerously-skip-permissions` **fail with an error** — every headless dispatch dies at argv, no flag workaround exists. (Verified: permissions docs, Permission modes.)

*General-purpose rationale:* interactive users are protected by the default prompt flow regardless; this setting only removes the headless lane. The real boundary belongs in R2.

### R2 — DO deploy managed `permissions.deny` rules as the absolute boundary

Verified: deny rules are evaluated **first** and enforced in every mode, including bypass. This is where enterprise security policy belongs. Recommended baseline:

```json
{
  "permissions": {
    "deny": [
      "Read(./.env)",
      "Read(./.env.*)",
      "Read(**/.env)",
      "Read(~/.ssh/**)",
      "Read(~/.aws/**)",
      "Read(~/.kube/**)",
      "Read(**/credentials*)"
    ]
  }
}
```

Two cautions, both verified in the docs:
- **Keep Bash deny patterns few and precise.** Pattern matching has documented limits (can't reliably constrain URL protocols; compound commands are matched per-subcommand). Broad patterns false-positive on legitimate work — prefer file-path and domain denies over command-string denies.
- Deny rules bind automation too (that's the point). Only deny what no legitimate workflow — human or automated — should ever do.

### R3 — If `allowManagedPermissionRulesOnly` is used, pair it with comprehensive managed `allow` rules

Verified failure mode: with this on and no managed allow rules, headless mode skips prompts → first tool use fails. Either leave it off, or ship a real allow list with it.

### R4 — Sandbox: adopt deliberately, not fail-closed org-wide

If OS sandboxing is adopted (`sandbox.enabled: true`), mirror the Codex posture — the sandbox IS the boundary:
- `sandbox.network.allowedDomains` must include the package registries and git hosts automation needs (`registry.npmjs.org`, `github.com`, …). A sandbox that blocks `npm install` silently degrades automated dev work into build failures.
- Do **not** set `sandbox.failIfUnavailable: true` org-wide: Linux requires `bubblewrap`+`socat`, native Windows is unsupported — fail-closed bricks headless runs on any machine missing the prerequisites. Scope it to platforms where the prerequisites are managed.

### R5 — Managed hooks: minimal, fast, never interactive

Verified: managed hooks **do run in `-p` (headless) mode**. A 5-second hook multiplies across hundreds of automated turns; a hook that blocks on input hangs a dispatch forever. Keep org-wide hooks few and sub-second. `allowManagedHooksOnly: true` is available if the org wants to suppress user/project hooks entirely.

### R6 — Do not enable `forceRemoteSettingsRefresh` on automation machines

Verified: it blocks CLI startup until a remote settings fetch succeeds and exits non-zero on failure — a network blip fails every queued headless run. Acceptable for interactive laptops; wrong for CI/automation hosts.

### R7 — Auth: subscription OAuth seats for automation; don't force API-key auth onto them

Substrate authenticates via the Claude Code OAuth session (subscription seats), not API keys. Deploying `apiKeyHelper` / forcing console auth to those seats changes the billing and auth model. **Doc gap (flagged, not asserted):** the official docs do not currently document `forceLoginMethod` values or `apiKeyHelper` billing implications — verify with Anthropic before forcing either org-wide.

### R8 — `env` block: don't force `OTEL_*` without testing the automation path

Substrate runs a local OTLP ingestion server and sets per-dispatch OTEL env to feed its turn-telemetry pipeline. **Doc gap:** whether a managed `env` block overrides parent-process env is not documented. If corporate OTEL collection is required, test one orchestrated dispatch in staging first; if managed env clobbers per-process endpoints, automation telemetry silently disappears.

### R9 — Models: keep a fast tier and a frontier tier available

Substrate's routing assumes model tiering (haiku-class for cheap steps, sonnet/opus-class for dev work). Cost control is better done via plan/seat limits than model bans. **Doc gap:** no managed-only model-restriction setting is documented (`availableModels` is not managed-only); if hard model restriction is a requirement, ask Anthropic rather than assuming it exists.

### R10 — Capacity: size usage limits for bursty automation

Orchestrated runs are bursty heavy users — we have empirically hit session/rate-limit exhaustion mid-run (4 of 8 eval dispatches died once limits were reached). Automation seats need headroom (highest usage tier, or dedicated seats), and heavy eval/pipeline runs should be staggered.

### R11 — Updates: predictable cadence beats per-machine drift

Claude Code releases fast and flag semantics change between versions (empirical: `-p --output-format stream-json` began requiring `--verbose`; `--max-turns` silently ignored on 2.x). Substrate pins a tested version range and surfaces compatibility warnings (`substrate adapters list`); a predictable org-wide update cadence lets that check run once per bump instead of per machine. After each org bump: `substrate adapters list` + one smoke dispatch.

---

## Full recommended managed-settings.json (baseline)

Deploy at `/etc/claude-code/managed-settings.json` (Linux/WSL), `/Library/Application Support/ClaudeCode/managed-settings.json` (macOS), `C:\Program Files\ClaudeCode\managed-settings.json` (Windows):

```json
{
  "permissions": {
    "deny": [
      "Read(./.env)",
      "Read(./.env.*)",
      "Read(**/.env)",
      "Read(**/.env.*)",
      "Read(~/.ssh/**)",
      "Read(~/.aws/**)",
      "Read(~/.kube/**)",
      "Read(~/.gnupg/**)",
      "Read(~/.config/gcloud/**)",
      "Read(~/.azure/**)",
      "Read(~/.netrc)",
      "Read(~/.npmrc)"
    ],
    "allow": [
      "Bash(git status)",
      "Bash(git diff *)",
      "Bash(git log *)",
      "Bash(git show *)",
      "Bash(git branch)",
      "Bash(ls *)",
      "Bash(pwd)",
      "Bash(which *)"
    ]
  },
  "cleanupPeriodDays": 90
}
```

### Rationale per choice

- **`deny` = credential surfaces only** — things no workflow, human or automated, legitimately reads through Claude. Nothing project-shaped is denied: no `**/*.pem` / `**/*.key` globs, because they false-positive on test fixtures and break legitimate dev work (broad-pattern false-positives are an empirically expensive failure class).
- **`allow` = strictly read-only commands**, to cut interactive prompt fatigue org-wide. `git branch` is exact-match only (no trailing `*`), so `git branch -D` still prompts. Anything write-shaped stays prompt-gated for interactive users; teams add project-level allows in their own `.claude/settings.json`.
- **No Bash `deny` patterns — deliberate.** Command-string matching is best-effort (documented limits: can't constrain URL protocols, compound commands matched per-subcommand). Pretending it is a boundary is worse than not having it; the boundary is file denies + sandbox + git review.
- **`cleanupPeriodDays: 90`** — longer transcript retention for incident forensics. Optional; drop if storage policy says otherwise.

### Optional add-on: sandbox enforcement (adopt once prerequisites are managed)

macOS has built-in support (Seatbelt); Linux/WSL2 requires `bubblewrap` + `socat`; native Windows and WSL1 are unsupported — which is why `failIfUnavailable` stays `false` until the fleet is known-ready.

```json
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": false,
    "filesystem": {
      "denyRead": ["~/.ssh", "~/.aws", "~/.kube", "~/.gnupg"]
    },
    "network": {
      "allowedDomains": [
        "registry.npmjs.org",
        "registry.yarnpkg.com",
        "github.com",
        "*.githubusercontent.com"
      ]
    }
  }
}
```

Add internal package registries and git hosts to `allowedDomains` before enforcing — a sandbox that blocks `npm install` silently degrades automated dev work into build failures (R4).

### Known limitation to state plainly

`Read(...)` deny rules bind Claude's file-reading tool, but Bash can still `cat` a file — a documented limitation of the permissions layer. The baseline deny is real protection on the common path; the sandbox add-on's `filesystem.denyRead` closes the Bash channel too, which is the long-term reason to adopt it.

### Deliberately omitted (each would break headless automation)

`disableBypassPermissionsMode` (R1), `forceRemoteSettingsRefresh` (R6), `sandbox.failIfUnavailable: true` (R4), `allowManagedPermissionRulesOnly` without allow rules (R3), `apiKeyHelper`/`forceLoginMethod` (R7 — pending Anthropic clarification), forced `OTEL_*` env (R8), managed hooks (R5).

## Scope boundary: what this config does and does NOT govern (verified 2026-06-12)

**This file governs Claude Code — not Claude Desktop's chat surface.** Deploying it does not harden the Desktop app. Verified coverage:

| Surface | Governed by this managed-settings.json? |
|---|---|
| Claude Code CLI (`claude`, `claude -p`) | ✅ yes |
| Claude Code in VS Code / JetBrains | ✅ yes |
| Claude Desktop → **Code tab** | ✅ yes — it spawns a local Claude Code session, which reads the on-disk managed settings (note: admin-console-pushed managed settings reach CLI/IDE only; for Desktop Code sessions the file must be on disk via MDM) |
| Claude Desktop → **Chat tab** (conversations, extensions, app-level MCP) | ❌ **no** |
| claude.ai web | ❌ no |

**If Desktop hardening is wanted, it's a separate, three-layer workstream:**

1. **claude.ai admin console** (org-wide toggles): enable/disable Code-in-desktop, web sessions, Remote Control; disable bypass-permissions org-wide; SSO enforcement.
2. **MDM-deployed files** (same directories as this config): `managed-mcp.json` + `allowedMcpServers` / `deniedMcpServers` / `allowManagedMcpServersOnly` in managed settings — this is the ONLY way to stop users adding arbitrary local MCP servers, and it restricts BOTH Desktop's `claude_desktop_config.json` and Claude Code's MCP configs. There is no org-console MCP control.
3. **OS-level MDM/GPO policies** (macOS `com.anthropic.claudefordesktop` configuration profile; Windows `SOFTWARE\Policies\Claude` registry/GPO): enable/disable Desktop extensions and the extension directory, local MCP servers, Code/Cowork access, auto-update windows, mountable workspace folders, forced org UUID.

**The riskiest Desktop vectors to prioritize if hardening:** arbitrary local MCP servers (arbitrary code execution on the host) and the extensions directory — both controllable only via layer 2/3 above, not via this file and not via the admin console alone.

Source: code.claude.com desktop + managed-mcp + admin-setup docs; support.claude.com "Enterprise configuration for Claude Desktop" (all verified 2026-06-12).

## Items to clarify with Anthropic (doc gaps, not assertions)

1. `forceLoginMethod` accepted values + `apiKeyHelper` billing semantics (R7).
2. Managed `env` block: override vs merge with parent-process env (R8).
3. Whether managed-only model restriction exists or is roadmapped (R9).
4. Whether org-level session/rate policies exist that can fail `-p` invocations (R10).

## Provenance

Settings keys, precedence, deny-in-bypass enforcement, hook headless behavior, sandbox keys/platforms, and the headless blockers were verified against code.claude.com documentation on 2026-06-12 (server-managed-settings, permissions, sandboxing, settings, admin-setup pages). Every unverifiable claim above is explicitly marked as a doc gap. The structural lesson and the security-equivalence argument generalize from `docs/2026-05-29-codex-managed-config-policy-ask.md`, which this org has since accepted.
