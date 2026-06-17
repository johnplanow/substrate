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

### B. Managed `env` OVERRIDES inherited env → substrate's telemetry pipeline goes dark (SILENT)

- **Verified behavior:** a managed `env` value **overrides** an env var already set in the launching process — the managed value wins inside the `claude` process and its subprocesses.
- **Why it hits substrate:** substrate sets `OTEL_EXPORTER_OTLP_ENDPOINT` per-dispatch pointing at its **own local ingestion server** (`claude-adapter.ts:253-260` → `telemetry/ingestion-server.ts`). The managed block sets `OTEL_EXPORTER_OTLP_ENDPOINT=https://otel-collector.example.internal:4318`, which **overrides** substrate's per-dispatch endpoint. Claude's OTLP telemetry then flows to the corp collector and substrate's ingestion server receives nothing.
- **What actually breaks (corrected 2026-06-17):** the OTEL-fed subsystem — `TelemetryPipeline` → efficiency scoring, `substrate metrics`, task-baselines, and OTEL observability/repo-map persistence. **NOT the cost axis:** `total_turns` is read from the stream-json `num_turns` field by the adapter's `parseStreamOutput` (Story 81-9), independent of the OTEL endpoint, so the cost axis survives the override. (Earlier draft of this review wrongly attributed the breakage to 81-9/total_turns.)
- **Severity:** silent functional regression of substrate's metrics/efficiency/observability subsystem. No error; the data just routes elsewhere.
- **Substrate cannot self-fix this:** managed `env` is highest precedence and overrides the child env substrate sets. This is the R8 concern, confirmed as override — and the one item that requires policy advocacy (see below).

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

## Advocacy priorities (assuming this config IS the org default)

Premise shift (2026-06-17): treat this config as the **non-negotiable default on every machine, substrate's included.** That collapses the ask list, because **substrate concedes the biggest item by fixing its own side** (see "Substrate-side change" below). What remains:

### Concession (no longer an ask): conflict A — bypass mode

Substrate will stop passing `--dangerously-skip-permissions` and move to `--permission-mode acceptEdits` + the sandbox (verified compatible with `disableBypassPermissionsMode: "disable"`). So **we do NOT ask InfoSec to relax `disableBypassPermissionsMode`** — we adapt to it. This is the credibility-builder: we give them the control they most want.

### KEY ask #1 (the only hard blocker): don't force-override `OTEL_EXPORTER_OTLP_ENDPOINT` in the global managed `env`

This is the single item substrate cannot engineer around — managed `env` overrides the per-process endpoint substrate sets, silently routing its telemetry to the corp collector and breaking `substrate metrics` / efficiency / observability. The ask is **general-purpose, not substrate-special:** *any* tool that runs its own local OTLP collector and sets the endpoint per-invocation (a common pattern) is broken by a force-overriding global telemetry endpoint. Requested change, in order of preference:
1. Don't put `OTEL_EXPORTER_OTLP_ENDPOINT` in the **global** managed `env`; scope corp-OTEL to hosts/users that need it, or
2. Leave telemetry endpoints to per-process configuration (managed `env` is too blunt an instrument for an endpoint tools set themselves), or
3. If corp OTEL is mandatory on all hosts, accept that substrate will run a forwarding collector (substrate-side work) — but that's strictly more complex than (1)/(2).

### KEY ask #2 (the enabler, mostly operational): guarantee the sandbox is actually available on hosts that run automation

The moment substrate drops `--dangerously-skip-permissions`, its autonomy depends on `autoAllowBashIfSandboxed` — which only fires when the sandbox is **available**. With `failIfUnavailable:false` (correct, keep it), a host missing `bubblewrap`+`socat` (or native Windows) runs unsandboxed → bash falls back to the permission flow → auto-denied in `-p` → substrate stalls. So: **keep `sandbox.enabled:true` + `autoAllowBashIfSandboxed:true` (already set), and provision automation/dev hosts with the sandbox dependencies.** This is provisioning, not a policy concession — but it's load-bearing for the concession on A to actually work.

### KEY ask #3 (narrow, conditional): prefer the sandbox network allowlist over `ask` egress rules

`ask` rules (`Bash(curl *)`, `Bash(wget *)`) auto-deny in `-p` even when sandboxed (content-scoped ask rules still force a prompt). If any substrate dev-story agent or runtime probe needs outbound HTTP, it dies silently. The sandbox `network.allowedDomains` is the correct egress boundary for automation and already present. Ask: on automation, rely on the network allowlist and drop the `ask`-on-curl/wget (or accept that in-agent network egress is unsupported and keep substrate's network-touching work in the orchestrator/probe-executor, outside the dispatched agent). Lowest priority — most dispatches never egress.

### Summary for the advocate

> "We'll adapt substrate to your permission policy — dropping `--dangerously-skip-permissions` for `acceptEdits` + the sandbox, so you keep `disableBypassPermissionsMode` on. In return we need one thing: don't globally force `OTEL_EXPORTER_OTLP_ENDPOINT` in managed `env` — it silently hijacks any tool that runs its own collector. Plus an operational dependency: automation/dev hosts need the bash sandbox actually installed (bubblewrap+socat), since that's now what lets trusted automation run without bypass mode."

That's one real policy ask, one provisioning requirement, one minor preference — a far stronger position than asking them to weaken permissions.

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

### Substrate-side change (decided 2026-06-17): drop `--dangerously-skip-permissions`

This is now the plan, not just an option — and the verification (code.claude.com, 2026-06-17) confirms it works under the strict config:

- **New dispatch form:** `claude -p --model X --permission-mode acceptEdits --output-format stream-json --verbose` (drop `--dangerously-skip-permissions`).
- **Why it's headless-complete:** `acceptEdits` auto-accepts file Write/Edit (+ filesystem bash like mkdir/cp/rm/mv/sed) without prompting and is **not** blocked by `disableBypassPermissionsMode`; the remaining bash (npm build/test, git status/add) is auto-approved by `autoAllowBashIfSandboxed` when sandboxed. Together: full autonomy, no allowlist enumeration — which fits substrate's open-ended dev-story work (a fixed `--allowedTools` list can't anticipate every build/test command).
- **Boundary preserved:** managed `permissions.deny` still applies under acceptEdits (deny is evaluated first, always). So InfoSec's secret-deny boundary holds against substrate dispatches too — strictly better than today's bypass mode, which skips the prompt layer entirely (deny still applied, but this removes the scary flag).
- **Dependencies / caveats:**
  - Requires the **sandbox available** on the host (advocacy ask #2) — else bash auto-denies.
  - The dispatched agent must not need the `ask`-listed commands (curl/wget/git push). git commit/push is done by substrate's orchestrator outside the agent, so this is mostly fine; in-agent network egress is the one gap (ask #3).
  - **Empirical smoke required before shipping** (the session's standing discipline — verify the exact arg form against the live CLI, including under a local `disableBypassPermissionsMode` managed setting, not just docs).
- **Filed as a story** (`81-12` / adapter change) — see implementation-artifacts.

With this change, substrate runs under InfoSec's **strict** profile directly; the only residual policy need is advocacy ask #1 (OTEL), and the two-profile split below becomes optional rather than required.

---

## Minor notes

- **`cleanupPeriodDays: 30`** vs our suggested 90 — a pure data-retention policy call (minimization vs forensic window). InfoSec's 30 is defensible; just confirm against the incident-investigation needs.
- **`deniedMcpServers` (denylist)** blocks the `filesystem` server but doesn't prevent arbitrary *additions* — a denylist only stops known-bad. If the intent is lockdown, pair with `allowedMcpServers` + `allowManagedMcpServersOnly` (our Part-2 D2 allowlist posture). For a workstation "block the obviously-dangerous one" posture, the denylist is a reasonable lighter touch.
- **Sandbox unavailability gap:** with `failIfUnavailable:false`, a machine lacking the sandbox (Linux without bubblewrap/socat, native Windows) runs UNsandboxed — and there `autoAllowBashIfSandboxed` doesn't apply, so under `disableBypassPermissionsMode` bash would prompt → auto-deny in `-p`. So even the reconciliation depends on the sandbox actually being installed on automation hosts. Ensure bubblewrap+socat are part of the automation-host image.

## Bottom line

Approve InfoSec's config for **developer workstations** (with the two enhancements). Do **not** deploy it to the hosts substrate runs on without the Profile-2 carve-outs (or the substrate `acceptEdits` change) — conflicts A and B are confirmed and would, respectively, kill every dispatch and silently re-break the cost-axis telemetry. The disagreement is narrow and entirely about automation scoping; the security posture itself is sound and we should adopt most of it upward into our own recommendations.
