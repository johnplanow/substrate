# Backlog: Pack / Methodology Abstraction — decouple substrate's core from BMad-specific assumptions

**Status:** OPEN — candidates, audit-derived; need fuller speccing before dispatch
**Priority:** P2 — strategic enabler, not blocking current work
**Category:** Architecture / extensibility
**Date identified:** 2026-06-06 (from the in-session pack-abstraction audit; bmad-party-mode)

## Motivation

Substrate's orchestrator and CLI carry BMad-pack-specific assumptions in places that *look*
generic but aren't. This surfaced while scoping "what would it take to run substrate against an
alternative methodology pack (e.g. GSD — https://github.com/open-gsd/gsd-core) instead of BMad?"
The Epic-81 pack-upgrade work validates *version* upgrades within BMad; this backlog is about the
deeper *methodology* swap — making the pack a true plug-in boundary.

These are **candidate stories**, captured so the audit findings aren't lost. None is fully specced
to the 81-x bar yet; each needs a discovery pass (confirm the exact coupling sites, current
behavior, and blast radius) before dispatch. All are intended to be **additive / forward-only**
and should not change BMad behavior.

## Candidate stories

### A. `init --pack` flag fix (pack selection at init)
- **Gap**: `substrate init` assumes the BMad pack; there's no clean operator-facing way to select
  an alternative methodology pack at init time. (Related but distinct from Epic 81's
  `--pack-current`/`--pack-candidate`, which are *eval-harness* flags, not init.)
- **Scope sketch**: add `init --pack <name|path>` that scaffolds the chosen pack's prompts/skills
  and writes pack identity into `.substrate/config.yaml`; default remains BMad when omitted.
- **Discovery first**: enumerate where init hard-codes BMad pack paths / skill lists.

### B. Verdict → model routing extraction
- **Gap**: the mapping from a story's verdict/state to which model gets routed (the
  verdict→model routing policy) has BMad-shaped assumptions baked into core rather than living in
  the pack or a pack-supplied routing policy.
- **Scope sketch**: extract the routing policy into a pack-declared (or config-declared) table so a
  different methodology can define its own state→model routing without core edits. Reuse the
  existing `routing-policy.yaml` mechanism where possible.
- **Discovery first**: locate the routing decision sites in the orchestrator; confirm which
  assumptions are BMad-specific vs genuinely universal.

### C. Recovery-taxonomy extraction
- **Gap**: the Recovery Engine's 3-tier ladder and its escalation/recovery taxonomy
  (`escalation_reason` vocabulary, recovery-action classes) encode BMad-pipeline phase semantics.
  An alternative methodology with different phases/gates would need its own taxonomy.
- **Scope sketch**: make the recovery taxonomy pack-declarable (or at least pack-overridable), so
  the verification gates and recovery classes map to the active methodology's phases. Keep BMad's
  taxonomy as the default.
- **Discovery first**: catalog the hard-coded `escalation_reason` strings and gate names; map them
  to BMad phases; identify which the Recovery Engine branches on.

## Why deferred (not blocking)

The operator explicitly pulled back from the GSD/methodology-swap track to focus on making the eval
framework sufficient for a BMad *version* upgrade first (Epic 81). This backlog preserves the audit
conclusion so the methodology-abstraction work can be picked up deliberately later, with the eval
harness (Epic 81 + 77) in place to validate that an abstraction change doesn't regress BMad behavior.

## Related

- `_bmad-output/planning-artifacts/epic-81-pack-upgrade-ab-validation.md` — pack *version* upgrade validation (the narrower, shipped capability)
- `_bmad-output/planning-artifacts/epic-77-eval-framework.md` — the standing regression suite that would guard an abstraction refactor
- The pack abstraction itself: `packs/bmad/` (prompts, skills, manifest) — the current single in-tree pack
