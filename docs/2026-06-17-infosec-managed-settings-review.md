# Review: InfoSec-proposed Claude Code managed-settings.json

**Reviewer:** John Planow (with Claude)
**Date:** 2026-06-17
**Subject:** InfoSec colleague's proposed `managed-settings.json` / `.jsonc`
**Compared against:** `docs/2026-06-12-claude-code-enterprise-config-recommendations.md`
**Behavior verification:** code.claude.com docs, verified 2026-06-17 (every runtime claim below was doc-confirmed; nothing asserted from memory)

## Verdict

**The config is good — genuinely more complete than our recommendation for developer workstations** (it adds login-org lock, a version floor, a plugin-marketplace allowlist, HTTP-hook pinning, and a broad sandbox network allowlist we should adopt). The annotations are careful and the security instincts are sound.

**But as written it will break substrate's headless automation** on any machine it's deployed to — in two *confirmed* ways (one fatal, one silent) plus one conditional. The root cause is the same structural tension as the Codex case: a workstation security policy and headless automation collide, and the right fix is to **scope the policy** (a separate automation/CI profile), not to weaken it for everyone or break automation.

The two files are consistent (`.jsonc` = annotated review copy; `.json` = comment-stripped deploy copy) — confirmed equivalent.

---

## Confirmed conflicts with substrate automation

### A. `permissions.disableBypassPermissionsMode: "disable"` — FATAL to substrate dispatch

- **Verified behavior:** with this set, `claude -p --dangerously-skip-permissions` **hard-errors at startup** (non-zero exit; not a silent downgrade).
- **Why it hits substrate:** substrate's Claude adapter passes `--dangerously-skip-permissions` on every dispatch (`packages/core/src/adapters/claude-adapter.ts:198,374` — comment: *"Without this, Claude in -p mode refuses to write files, asking for permission"*). Every dispatch on a machine with this setting dies at argv.
- **Severity:** fatal, total — no substrate run completes a single story.
- This is the exact R1 trap, and the Claude-side analog of the Codex `Never` exclusion: an approval-mode policy that's structurally incompatible with headless writes.

### B. Managed `env` OVERRIDES inherited env → substrate's telemetry goes dark (SILENT)

- **Verified behavior:** a managed `env` value **overrides** an env var already set in the launching process — the managed value wins inside the `claude` process and its subprocesses.
- **Why it hits substrate:** substrate sets `OTEL_EXPORTER_OTLP_ENDPOINT` per-dispatch pointing at its **own local ingestion server** (`claude-adapter.ts:253-260` → `telemetry/ingestion-server.ts:259`). That pipeline is what feeds `total_turns` — the cost axis we un-blinded in Story 81-9. The managed block sets `OTEL_EXPORTER_OTLP_ENDPOINT=https://otel-collector.example.internal:4318`, which **overrides** substrate's per-dispatch endpoint. Claude's telemetry then flows to the corp collector, substrate's ingestion server receives nothing, and `total_turns` reverts to null — silently re-breaking the cost axis.
- **Severity:** silent functional regression of shipped work. No error; the data just disappears.
- This is exactly the R8 concern, now confirmed (we'd flagged the override-vs-merge behavior as a doc gap; it's override).

### C. `ask` rules auto-DENY in headless `-p` (CONDITIONAL)

- **Verified behavior:** in `-p` mode there's no human to prompt, so an `ask`-matched tool call is **auto-denied silently** (repeated blocks abort the session).
- **Why it may hit substrate:** the `ask` list includes `Bash(curl *)`, `Bash(wget *)`, `Bash(git push *)`, `Bash(npm publish *)`, `Bash(docker push *)`. Substrate's *orchestrator* does git operations outside the agent (so `git push` is likely safe), but a dispatched dev-story agent or a runtime probe that runs `curl`/`wget` (e.g. a probe hitting an MCP/REST endpoint) would be silently denied.
- **Severity:** low-to-moderate, surface-dependent — most dev-story dispatches won't curl, but anything that does fails with no signal. Note: for automation the `ask`-on-curl is strictly worse than the sandbox network allowlist (which already bounds egress); the `ask` denies *before* the sandbox is consulted.

---

## Good additions InfoSec made that we should adopt

These are real improvements over our `docs/2026-06-12` recommendation — fold them back in:

| Setting | Why it's good | Verified |
|---|---|---|
| `forceLoginOrgUUID` | Locks login to the org; also blocks raw API-key sessions (aligns with our R7 OAuth-seat stance) — Bedrock/Vertex/Foundry NOT blocked | ✅ valid key; array form = any listed org |
| `requiredMinimumVersion` | Version floor (our R11 discipline, enforced) — and it **fails OPEN** if invalid, so a bad push can't lock everyone out | ✅ fail-open confirmed |
| `strictKnownMarketplaces` + `extraKnownMarketplaces` | Plugin-marketplace allowlist — closes a supply-chain vector we didn't cover | ✅ valid |
| `allowedHttpHookUrls` | Pins where HTTP hooks may send data — good middle ground vs blocking hooks (our R5) | ✅ valid |
| `sandbox.network.allowedDomains` (broad) | Covers Go/Rust/Ruby/Docker + internal registries, not just npm/GitHub — better than our skeleton | ✅ valid |
| deny list additions | `secrets/**`, `config/credentials.json`, `id_rsa`/`id_ed25519` (committed-key globs), `~/.docker/config.json`, `~/.config/gh/hosts.yml` — more credential surfaces than ours; and correctly avoids `*.pem`/`*.key` extension globs (false-positive trap) | ✅ |

(We had `~/.gnupg/**` and `~/.azure/**` which theirs omits — merge both lists.)

## Non-conflicts (verified clear — no action)

- **`claudeMd` is suppressed by `--system-prompt`** (which substrate uses) → no token/context bloat on substrate dispatches, and substrate's context isolation holds. Fine.
- **`companyAnnouncements` do NOT emit to `-p`/stream-json stdout** → no NDJSON parse corruption. Fine.
- **`requiredMinimumVersion` fails open**, **`deniedMcpServers`/marketplace/hook keys all valid** → no automation impact.
- **`sandbox.failIfUnavailable` left at default false** → matches our R4 (won't brick hosts missing bubblewrap); good.

---

## Recommended resolution: two profiles (the Codex lesson, applied)

Don't weaken the workstation config and don't break automation — **scope the policy to the population:**

### Profile 1 — Developer workstations: deploy InfoSec's config nearly as-is

Adopt it. Two small enhancements:
1. Merge our `~/.gnupg/**` and `~/.azure/**` into the deny list.
2. Add `sandbox.filesystem.denyRead` mirroring the credential paths. **Why:** the `Read(...)` denies bind Claude's Read tool but NOT `bash cat` — and with `autoAllowBashIfSandboxed: true` + no sandbox filesystem policy, a sandboxed `cat ~/.aws/credentials` is auto-approved and unblocked. `sandbox.filesystem.denyRead` closes that hole (the documented limitation our doc calls out).

### Profile 2 — Automation / CI hosts (where substrate runs): a relaxed sibling

Same file, deployed only to automation machines, differing in exactly the conflict points:

- **Omit `disableBypassPermissionsMode`** (resolves A) — OR pursue the substrate-side fix below.
- **Omit the `OTEL_EXPORTER_OTLP_ENDPOINT` override** (resolves B) so substrate's per-dispatch telemetry endpoint survives. If corp OTEL collection is required on these hosts, that needs a non-clobbering design (substrate owns that env var for its turn pipeline).
- **Drop or narrow the `ask` list** (resolves C) — rely on the sandbox network allowlist as the egress boundary, which works headlessly.
- **Keep everything else** — deny rules, sandbox, login-org, version floor, MCP/marketplace allowlists all apply fine to automation and remain the real security boundary.

This is the same shape as the accepted Codex resolution: the sandbox + deny rules are the boundary that works identically for humans and automation; the approval-mode/egress-prompt controls are workstation-UX affordances that don't belong on headless hosts.

### Substrate-side option (lets automation hosts run the STRICT profile too)

Worth a follow-up story: change substrate's Claude adapter to stop relying on `--dangerously-skip-permissions` and instead dispatch with `--permission-mode acceptEdits` (auto-accepts file edits, **not** blocked by `disableBypassPermissionsMode`) backed by the managed deny rules + sandbox as the boundary. If that works headlessly (needs a quick empirical check — acceptEdits is a distinct mode from bypassPermissions), substrate could run under InfoSec's strict config unchanged, and Profile 2 would only need the OTEL carve-out. This is the most robust long-term answer and aligns with "deny rules are the boundary, not the approval mode."

---

## Minor notes

- **`cleanupPeriodDays: 30`** vs our suggested 90 — a pure data-retention policy call (minimization vs forensic window). InfoSec's 30 is defensible; just confirm against the incident-investigation needs.
- **`deniedMcpServers` (denylist)** blocks the `filesystem` server but doesn't prevent arbitrary *additions* — a denylist only stops known-bad. If the intent is lockdown, pair with `allowedMcpServers` + `allowManagedMcpServersOnly` (our Part-2 D2 allowlist posture). For a workstation "block the obviously-dangerous one" posture, the denylist is a reasonable lighter touch.
- **Sandbox unavailability gap:** with `failIfUnavailable:false`, a machine lacking the sandbox (Linux without bubblewrap/socat, native Windows) runs UNsandboxed — and there `autoAllowBashIfSandboxed` doesn't apply, so under `disableBypassPermissionsMode` bash would prompt → auto-deny in `-p`. So even the reconciliation depends on the sandbox actually being installed on automation hosts. Ensure bubblewrap+socat are part of the automation-host image.

## Bottom line

Approve InfoSec's config for **developer workstations** (with the two enhancements). Do **not** deploy it to the hosts substrate runs on without the Profile-2 carve-outs (or the substrate `acceptEdits` change) — conflicts A and B are confirmed and would, respectively, kill every dispatch and silently re-break the cost-axis telemetry. The disagreement is narrow and entirely about automation scoping; the security posture itself is sound and we should adopt most of it upward into our own recommendations.
