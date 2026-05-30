# Request: Add `Never` to `allowed_approval_policies` in Codex managed configuration

**Author:** John Planow
**Date:** 2026-05-29
**Codex CLI version observed:** 0.134.0 (issue reproduced against `rust-v0.134.0` source)
**Substrate version that surfaced this:** v0.20.131–137 (six iterations attempting CLI-layer workarounds)

## Summary

`codex exec` (the non-interactive automation entrypoint) is structurally incompatible with the current enterprise managed configuration on this account. **No CLI flag combination can work around it** — the incompatibility is hardcoded in Codex source. This request is for the smallest policy change that unblocks non-interactive automation workflows without weakening the actual security boundary, grounded in citations from OpenAI's published Codex source code.

The requested change:

```toml
# requirements.toml
allowed_approval_policies = ["untrusted", "on-request", "never"]   # add "never"
allowed_sandbox_modes      = ["read-only", "workspace-write"]      # KEEP without "danger-full-access"
```

## The structural problem

### 1. `codex exec` hardcodes `approval_policy=Never`

In `codex-rs/exec/src/lib.rs:407` ([source @ rust-v0.134.0](https://github.com/openai/codex/blob/rust-v0.134.0/codex-rs/exec/src/lib.rs#L407)):

```rust
// Default to never ask for approvals in headless mode. Feature flags can override.
approval_policy: Some(AskForApproval::Never),
```

This sets `approval_policy = Never` unconditionally as a *harness override* on every `codex exec` invocation. The comment line literally documents the intent: headless mode is designed to run with `Never` and no human in the loop.

### 2. Harness overrides beat all other configuration

In `codex-rs/core/src/config/mod.rs:2902-2914` ([source](https://github.com/openai/codex/blob/rust-v0.134.0/codex-rs/core/src/config/mod.rs#L2902-L2914)):

```rust
let approval_policy_was_explicit =
    approval_policy_override.is_some() || cfg.approval_policy.is_some();
let mut approval_policy = approval_policy_override
    .or(cfg.approval_policy)
    .unwrap_or_else(|| { ... });
```

`approval_policy_override` is the harness `Some(Never)` from above. It beats `cfg.approval_policy`, which is where both `~/.codex/config.toml` settings and `-c approval_policy=...` CLI overrides land.

### 3. There is no `--ask-for-approval` flag on `codex exec`

Verified by exhaustive search of `codex-rs/exec/src/cli.rs` and the flattened `codex-rs/utils/cli/src/shared_options.rs` at tag `rust-v0.134.0`: zero references to `ask-for-approval` or `ask_for_approval` on the `exec` subcommand. The `-a` / `--ask-for-approval` flag exists, but only as a top-level argument on the interactive TUI (`codex` without `exec`).

### 4. The result on our managed config

When `codex exec` requests `Never` and the managed `requirements.toml` allow-list is `[UnlessTrusted, OnRequest]`:

1. Constrained-set check rejects `Never`.
2. Falls back to `UnlessTrusted` (first in the allow-list).
3. The `apply_patch` safety check (`codex-rs/core/src/safety.rs:47-58`) hits a **maintainer-flagged design defect** under `UnlessTrusted`:

   ```rust
   // TODO(ragona): I'm not sure this is actually correct? I believe in this case
   // we want to continue to the writable paths check before asking the user.
   AskForApproval::UnlessTrusted => {
       return SafetyCheck::AskUser;
   }
   ```

   This returns `AskUser` unconditionally — bypassing the writable-paths safety check that all the other policies use. The `TODO(ragona)` is a maintainer-authored in-code admission that this branch is probably wrong.

4. `exec` mode rejects all approval requests (`codex-rs/exec/src/lib.rs:1562-1573`):
   ```
   file change approval is not supported in exec mode
   ```

5. The patch is rejected. File writes fail. **Every non-interactive Codex automation workflow that needs to write files fails on this account, regardless of CLI invocation.**

### 5. Codex's deprecation of `--full-auto` confirms the design intent

In Codex v0.128.0 ([PR #20133](https://github.com/openai/codex/pull/20133), [release notes](https://github.com/openai/codex/releases/tag/rust-v0.128.0)), the `--full-auto` convenience flag was deprecated in favor of `--sandbox workspace-write`. The deprecation message printed on every invocation reads:

```
warning: `--full-auto` is deprecated; use `--sandbox workspace-write` instead.
```

The intent is explicit: **`exec` is supposed to run with `--sandbox workspace-write` (the sandbox is the security boundary) paired with `approval_policy=Never` (because non-interactive mode has no human to ask for approval).** The sandbox enforces the security guarantee; the approval policy is irrelevant in headless mode because exec can't service approvals anyway.

## The security argument

The requested change adds `Never` to the approval-policy allow-list while **explicitly keeping `danger-full-access` out of the sandbox allow-list**. The resulting threat model:

| What the model could do under… | `UnlessTrusted` + `workspace-write` (current) | `Never` + `workspace-write` (requested) | `Never` + `danger-full-access` (NOT requested) |
|---|---|---|---|
| Write inside the workspace sandbox roots | ✗ (exec rejects approval → write fails) | ✓ (intended path) | ✓ |
| Write outside the workspace sandbox | ✗ (rejected by `Reject` branch in safety.rs) | ✗ (rejected by `Reject` branch in safety.rs) | ✓ (unsafe) |
| Execute non-trusted shell commands inside sandbox | Escalates → exec rejects → fails | Fails silently (no escalation; `Never` doesn't ask) | Runs unsandboxed |
| Bypass the sandbox via host syscalls | ✗ (sandbox enforces) | ✗ (sandbox enforces) | ✓ (no sandbox) |

The actual security boundary in every case is `--sandbox`, not `--ask-for-approval`. Approval policies only matter when there is a human to grant escalation. In `codex exec`, **there is no human**, so the only practical difference between `UnlessTrusted` and `Never` is:

- `UnlessTrusted` causes the model's normal operations (`apply_patch`) to fail because of a Codex source defect.
- `Never` lets the model operate within the sandbox boundary as designed.

**Neither lets the model do anything the workspace-write sandbox doesn't allow.**

## The minimal requested change

```toml
# requirements.toml — minimal change to unblock non-interactive automation
allowed_approval_policies = ["untrusted", "on-request", "never"]
allowed_sandbox_modes      = ["read-only", "workspace-write"]      # NOT "danger-full-access"
```

- **`allowed_approval_policies`**: add `"never"`. Keep `"untrusted"` and `"on-request"` for users who want them in interactive contexts. Do not add `"on-failure"` (deprecated by Codex).
- **`allowed_sandbox_modes`**: keep exactly the current two — `"read-only"` and `"workspace-write"`. Continue to *exclude* `"danger-full-access"`. This is the actual security boundary.

This change unblocks `codex exec` for substrate-driven CI/automation workflows while keeping the sandbox as the security boundary. It does not affect interactive Codex usage (which uses the TUI, where approval policies operate normally).

## Alternative paths (less practical)

For completeness, the other ways this could be unblocked:

1. **Upstream Codex fix**: comment on [issue #10949](https://github.com/openai/codex/issues/10949) (open since Codex v0.98.0). The fix is either (a) make the `exec` harness honor `-c approval_policy` overrides, or (b) fix the `TODO(ragona)` branch in `safety.rs` so `UnlessTrusted` falls through to the writable-paths check like every other policy. Upstream timeline unknown; not actionable on our timeframe.
2. **Direct-API path**: bypass `codex exec` entirely by calling OpenAI's API directly. Architecturally feasible (1–2 week build); requires that our enterprise API key permits direct Chat Completions tool-call usage with `apply_patch`-equivalent file writes. Larger investment, longer timeline.
3. **Different agent**: substrate already supports Claude Code and Gemini. If either is permitted in our environment without comparable managed-config restrictions, switching agents for CI workflows is a 30-second fix. This is the operational workaround we'll use in the meantime.

## What the request does NOT include

To be clear about the scope, this request:

- ✗ Does NOT request adding `"danger-full-access"` to `allowed_sandbox_modes`.
- ✗ Does NOT request enabling `--dangerously-bypass-approvals-and-sandbox`.
- ✗ Does NOT affect interactive Codex TUI usage (no policy change there).
- ✗ Does NOT request any change to the Codex auth model, billing, or model selection.

The sole change is one entry in one allow-list.

## References

- Codex source @ tag rust-v0.134.0:
  - [exec/src/lib.rs:407 (harness override `Some(Never)`)](https://github.com/openai/codex/blob/rust-v0.134.0/codex-rs/exec/src/lib.rs#L407)
  - [core/src/safety.rs:47-58 (the `TODO(ragona)` defect)](https://github.com/openai/codex/blob/rust-v0.134.0/codex-rs/core/src/safety.rs#L47-L58)
  - [core/src/config/mod.rs:2902-2914 (harness-override precedence)](https://github.com/openai/codex/blob/rust-v0.134.0/codex-rs/core/src/config/mod.rs#L2902-L2914)
  - [exec/src/lib.rs:1562-1573 (exec rejects approval requests)](https://github.com/openai/codex/blob/rust-v0.134.0/codex-rs/exec/src/lib.rs#L1562-L1573)
- PR / release that deprecated `--full-auto`:
  - [PR #20133](https://github.com/openai/codex/pull/20133)
  - [rust-v0.128.0 release notes](https://github.com/openai/codex/releases/tag/rust-v0.128.0)
- Existing open issue on this exact failure mode:
  - [Issue #10949 — approval_policy defaults to Never, `-c` not respected (open since v0.98.0)](https://github.com/openai/codex/issues/10949)
- Codex documentation:
  - [Managed configuration](https://developers.openai.com/codex/enterprise/managed-configuration)
  - [Non-interactive mode](https://developers.openai.com/codex/noninteractive)
  - [Agent approvals & security](https://developers.openai.com/codex/agent-approvals-security)
