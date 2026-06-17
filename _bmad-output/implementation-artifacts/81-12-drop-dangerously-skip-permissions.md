# Story 81-12: Drop `--dangerously-skip-permissions` from the Claude adapter

## Story

As a substrate operator on an enterprise-managed Claude Code install,
I want substrate's Claude dispatch to run headless WITHOUT `--dangerously-skip-permissions`,
so that substrate keeps working when the org sets `permissions.disableBypassPermissionsMode: "disable"` (which hard-errors that flag) — and so substrate stops depending on the one control enterprise InfoSec most wants enabled.

Motivated by the 2026-06-17 review of the InfoSec-proposed managed-settings.json (`docs/2026-06-17-infosec-managed-settings-review.md`). Treat that config as the org default.

## Background — established facts (verified against code.claude.com, 2026-06-17; do NOT re-derive)

- Substrate's Claude adapter passes `--dangerously-skip-permissions` on every dispatch (`packages/core/src/adapters/claude-adapter.ts` ~lines 198 and 374). Comment: *"Without this, Claude in -p mode refuses to write files, asking for permission."*
- `permissions.disableBypassPermissionsMode: "disable"` makes `claude -p --dangerously-skip-permissions` **hard-error at startup** (non-zero exit, not a silent downgrade). Under the org's default managed config, every dispatch dies at argv.
- `--permission-mode acceptEdits` is a DISTINCT mode, **not** blocked by `disableBypassPermissionsMode`. It auto-accepts file Write/Edit (and filesystem bash: mkdir/touch/rm/rmdir/mv/cp/sed) without prompting in `-p`.
- `sandbox.autoAllowBashIfSandboxed: true` (set in the org config) auto-approves sandboxed bash (non-excluded) without prompting — covering the rest of substrate's bash (npm build/test, git status/add). Requires the sandbox to be AVAILABLE (Linux: bubblewrap+socat; native Windows unsupported → falls back to permission flow → auto-deny in `-p`).
- Managed `permissions.deny` rules are evaluated FIRST and apply under acceptEdits — the secret-deny boundary is preserved (strictly better posture than bypass).
- CLI `--permission-mode` beats managed `permissions.defaultMode`; `acceptEdits` is not a forbidden mode, so the flag takes effect.

## Acceptance Criteria

1. **Replace the flag.** Claude adapter `buildCommand` drops `--dangerously-skip-permissions` and adds `--permission-mode acceptEdits`. Forward-only; the stream-json + `--verbose` handling (Story 81-9 era) is unchanged.

2. **Empirical smoke against the real CLI (MANDATORY — session discipline).** Verify the exact new arg form runs a real `claude -p` dispatch to completion (writes a file, runs a bash command) on the operator's CLI version — AND verify it works with a local `managed-settings.json` containing `permissions.disableBypassPermissionsMode: "disable"` + `sandbox.enabled:true` + `autoAllowBashIfSandboxed:true`, reproducing the org default. Docs are necessary but not sufficient (the `stream-json`→`--verbose` arc is the standing lesson). Capture the smoke transcript.

3. **Sandbox-unavailable behavior is explicit.** When the sandbox is unavailable, bash auto-denies under acceptEdits — detect/surface this as a clear adapter health warning (reuse the `TESTED_CLI_VERSION_RANGE`/`compatibilityWarning` surfacing) rather than letting dispatches stall mysteriously. Document the bubblewrap+socat requirement for automation hosts.

4. **Deny boundary regression check.** Confirm a managed `permissions.deny` (e.g. `Read(./.env)`) still blocks the dispatched agent under acceptEdits — the security boundary must hold without the bypass flag.

5. **No behavior change on non-managed installs.** On a machine with no managed settings, the new form must still run fully autonomously (acceptEdits + whatever sandbox state) — i.e. don't regress the default developer-laptop dispatch.

6. **Unit tests.** buildCommand asserts `acceptEdits` present and `--dangerously-skip-permissions` absent; health-warning emitted when sandbox unavailable (synthetic). No live calls in the suite.

7. **Ship gate GREEN**: build, test:fast, eval-outcomes 35/35.

8. **Update both adapter copies** (`packages/core/src/adapters/claude-adapter.ts` AND `src/adapters/` if the dual-source pattern still applies) and the adapter's doc-comment/`Uses:` line.

## Tasks / Subtasks

- [ ] Task 1 — Swap the flag in buildCommand (both adapter sources) (AC1, AC8)
- [ ] Task 2 — Sandbox-availability detection + health warning (AC3)
- [ ] Task 3 — Empirical smoke incl. a local strict managed-settings (AC2)
- [ ] Task 4 — Deny-boundary + non-managed regression checks (AC4, AC5)
- [ ] Task 5 — Unit tests (AC6)
- [ ] Task 6 — Docs: bubblewrap+socat host requirement; update review doc residuals (AC3)
- [ ] Task 7 — Regression validation (AC7)

## Dev Notes

### Why acceptEdits + sandbox, not an `--allowedTools` allowlist

An allowlist (`--allowedTools "Bash(npm test *)",...`) can't anticipate the open-ended command set a dev-story agent runs across arbitrary projects — it would be brittle and cause silent auto-denies. `acceptEdits` (writes) + `autoAllowBashIfSandboxed` (bash) gives broad autonomy with the **sandbox** as the boundary, which is the posture the org config already adopts. The deny rules remain the hard floor.

### Residual gaps this story does NOT close

- **OTEL env override** (managed `env` clobbers substrate's per-dispatch `OTEL_EXPORTER_OTLP_ENDPOINT`): substrate cannot self-fix; it's the one policy advocacy ask. Out of scope here. Note: this breaks the OTEL telemetry/metrics pipeline, NOT the cost axis (`total_turns` comes from stream-json `num_turns`, not OTEL).
- **In-agent network egress** (`ask` on curl/wget auto-denies headless): keep network-touching work in the orchestrator/probe-executor, not the dispatched agent.

### Canonical paths

| Item | Path |
|---|---|
| Claude adapter buildCommand | `packages/core/src/adapters/claude-adapter.ts` (~198, ~374) |
| Adapter health / version-compat surfacing | `packages/core/src/adapters/version-compat.ts`, `claude-adapter.ts` `TESTED_CLI_VERSION_RANGE` |
| Review doc (context + advocacy) | `docs/2026-06-17-infosec-managed-settings-review.md` |

## Interface Contracts

- buildCommand arg-set change only (drop one flag, add one). No DispatchResult/envelope schema change. Forward-only.

## Dev Agent Record
### Agent Model Used
<to be filled in by dispatched agent>
### Completion Notes List
<to be filled in by dispatched agent>
### File List
<to be filled in by dispatched agent>
## Change Log
