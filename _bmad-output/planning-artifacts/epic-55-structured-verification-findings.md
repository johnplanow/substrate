# Epic 55: Structured Verification Findings (Phase 1 of Verification Runtime Gates)

**Status: SHIPPED v0.20.4.** Phase 2 (runtime probes) continues in
[epic-56-runtime-verification-gates.md](epic-56-runtime-verification-gates.md),
shipped v0.20.5 Sprint 1.


## Vision

Replace `VerificationResult.details: string` — substrate's free-form failure-summary blob — with a structured `findings` array carrying `{category, severity, message, command?, exitCode?, stdoutTail?, stderrTail?, durationMs?}`. This is the load-bearing foundation for the multi-phase Verification Runtime Gates design (see design direction recorded 2026-04-18, originally tracked as closed issue #4).

Without structured findings, every downstream consumer of verification results — retry-prompt assembly, post-run analysis, learning-loop classifier, the `NEEDS_MINOR_FIXES "3 issues"` text that the strata agent flagged as unqueryable — has to string-parse a free-form blob that the originating check never promised a schema for. Runtime probes (Phase 2+) would bake in more of the same pain.

Source: strata Story 1-4 cross-project validation findings (2026-04-18) — 7 real bugs shipped past four passing static verification checks. Design direction recorded in closed issue #4 and the party-mode session that produced this epic.

## Scope

### In Scope

- New `VerificationFinding` type + optional `findings` field on `VerificationResult` with backward-compat rendering to `details`
- Migrate all four existing Tier A checks (`PhantomReviewCheck`, `TrivialOutputCheck`, `AcceptanceCriteriaEvidenceCheck`, `BuildCheck`) to emit structured findings alongside the rendered `details` string
- Persist findings on the `RunManifest` per-story verification record
- Inject structured findings into retry prompts so review cycles can reason about each issue independently

### Out of Scope (Deferred to Phase 2+)

- `RuntimeProbeCheck` — the actual new verification capability. Arrives once the foundation is in place.
- `sandbox: host` / `sandbox: twin` declaration semantics
- Digital Twin (Epic 47) integration for probe execution
- Story-template changes for probe declaration in `packs/bmad/prompts/`
- Code-review `CodeReviewResult.issue_list` unification with `VerificationFinding` (adjacent but separable — can converge later via a common base type)

## Story Map

```
Sprint 1 — Foundation (SHIPPED v0.20.4):
  Story 55-1: VerificationFinding type + backward-compat VerificationResult  ✓
  Story 55-2: Migrate Tier A checks to emit structured findings              ✓
  Story 55-3: Persist findings in RunManifest + inject into retry prompts    ✓

Sprint 2 — Fast-follows (partially deferred):
  Story 55-3b: Status/metrics CLI JSON finding counts  (pending; see 55-3b-*.md)
```

**Followed up by:** Epic 56 (Runtime Verification Gates) Sprint 1
shipped v0.20.5 — `RuntimeProbeCheck` is the actual runtime gate this
foundation was built for.

## Dependency Chain

- 55-1 introduces the type — no dependencies.
- 55-2 migrates existing checks to populate findings — depends on 55-1.
- 55-3 consumes findings downstream (manifest + retry prompts) — depends on 55-1 for the type and on 55-2 for checks that actually emit findings.

## Success Criteria

- All four existing Tier A checks emit structured findings when they detect an issue, and pass with `findings: []` when clean.
- `RunManifest` round-trips findings losslessly through write/read.
- Retry prompts for rework/fix dispatches contain the structured finding text verbatim.
- Full test suite green; no regression in the four existing check behaviors.
- `details: string` continues to render (derived from findings) so any consumer that still reads it sees equivalent information.
