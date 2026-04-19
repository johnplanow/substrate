# Epic 56: Runtime Verification Gates

## Vision

Bridge the capability gap between substrate's four static shape-checks
(phantom-review, trivial-output, acceptance-criteria-evidence, build) and
the real-world correctness of artifacts whose behavior depends on runtime
execution — container definitions, systemd units, install scripts,
migration runners, anything where static analysis cannot answer "does it
actually work on a real host?"

Source: strata agent report 2026-04-18 — substrate Story 1-4 shipped
SHIP_IT with 7 real runtime bugs (wrong image path, bad systemctl
invocation on a Quadlet unit, unset `DOLT_ROOT_HOST`, swallowed mysql
auth failures) because the pipeline's Tier A checks never executed the
produced artifacts. Design direction established in the Epic 55 Phase 1
follow-up discussion (see `epic-55-structured-verification-findings.md`).

This epic builds on Epic 55 Phase 1: the `VerificationFinding` surface
introduced there — `{category, severity, message, command?, exitCode?,
stdoutTail?, stderrTail?, durationMs?}` — was shaped specifically so
runtime-probe output would flow through without a second refactor.

## Scope

### Sprint 1 — Phase 2 MVP (SHIPPED v0.20.5)

- `RuntimeProbeCheck` as a 5th Tier A check, registered last (runs after
  `BuildCheck` so probes may depend on built artifacts)
- Author-declared probe syntax: `## Runtime Probes` markdown section with
  a `yaml` code fence containing a list of `{name, sandbox, command,
  timeout_ms?, description?}` entries
- Host-sandbox executor using detached process groups + SIGKILL on
  timeout (same safety posture as `BuildCheck`); stream-separated
  stdout/stderr capture tailed to 4 KiB each per the Phase 1 convention
- Five finding categories:
  - `runtime-probe-fail` — probe exited non-zero within timeout
  - `runtime-probe-timeout` — probe killed after its timeout ceiling
  - `runtime-probe-deferred` — `sandbox: twin` declared; Phase 3 pending
  - `runtime-probe-parse-error` — YAML malformed, schema invalid, or
    duplicate probe name within a story
  - `runtime-probe-skip` — warn when `storyContent` unavailable on the
    VerificationContext (distinct from "section present but empty")
- Backward compatibility: stories without a `## Runtime Probes` section
  emit pass-with-skip — no new failure mode for existing consumers
- Pipeline findings-passthrough bug fixed (latent Phase 1 regression —
  `VerificationPipeline.run()` was dropping `findings` when projecting
  `VerificationResult` → `VerificationCheckResult`)
- Unit tests: parser (12), executor (6), check (11), e2e (5)
- Live-registry consumer probe reproduces strata Story 1-4's repro
  (`403 Forbidden on ghcr.io/dolthub/dolt-sql-server`) and captures
  exit code + stderr tail cleanly

Shipped commits: `c17de32` (feature), `d280aae` (e2e validation),
`9053b05` (version bump).

### Sprint 2 — Phase 3: Digital Twin executor integration

- Route `sandbox: twin` probes through Epic 47's `TwinManager` /
  `TwinRegistry` / `TwinHealthMonitor` instead of emitting the
  `runtime-probe-deferred` warn finding
- Twin lifecycle: per-probe ephemeral (bring up, execute, tear down) vs.
  per-story shared? Decide during story detail write-up
- Twin health gate: refuse to execute a probe against an unhealthy twin
  (emit `runtime-probe-twin-unhealthy` warn finding)
- Twin selection: probe entry may declare `twin: <template-name>` to pick
  from `TWIN_TEMPLATES`; default resolves via project config
- Cleanup discipline: twin state is ephemeral; failing probes must not
  leak running twins across runs

Candidate stories (not yet authored):

- `56-phase3-twin-executor.md` — `RuntimeProbeExecutors.twin` implementation
- `56-phase3-twin-template-selection.md` — story-level twin template binding
- `56-phase3-twin-lifecycle.md` — per-probe vs per-story lifecycle policy

### Sprint 3 — Story-author integration + dogfood

- Update `create-story` prompt so agents proactively propose probes when
  a story's output is runtime-dependent (systemd units, containers,
  migrations, install scripts)
- Update `fix-story` / `rework-story` retry prompts to surface runtime
  probe findings with the same prominence as code-review issues (the
  Phase 1 `{{verification_findings}}` placeholder already injects them —
  this sprint adds dedicated agent guidance for interpreting probe
  failures)
- Retrofit one or two previously-shipped substrate stories with probes,
  demonstrate probe catches the class of bug retroactively
- Cross-project dogfood: re-run strata Story 1-4 with probes declared,
  confirm the pipeline hard-gates at the failures that shipped
  previously

Candidate stories (not yet authored):

- `56-create-story-probe-awareness.md` — prompt update
- `56-retry-prompt-probe-guidance.md` — retry prompt guidance for probes
- `56-dogfood-probe-retrofit.md` — retrofit one shipped story + validate

## Out of Scope

- Inference: auto-generating probes from artifact patterns (too
  heuristic-heavy for v1; author declaration is always the primary path).
- Probe result caching. Each probe runs on every verification cycle.
- Multi-host sandbox: probes that need to coordinate across nodes.
  Single-host-or-twin covers the reported failure classes.

## Success Criteria (for full epic)

1. Author declares a probe in story markdown → pipeline executes it —
   done in Sprint 1.
2. Probe failure produces a structured finding that retries, run
   manifests, and CLI readers can reason about without string-parsing —
   done (Phase 1 surface, Phase 2 emitter).
3. `sandbox: twin` probes run against ephemeral twins with clean
   teardown — **pending Sprint 2**.
4. The strata Story 1-4 class of bug demonstrably hard-gates at
   verification when probes are declared — done (Sprint 1 e2e + live
   registry validation).
5. `create-story` agent proposes probes proactively for runtime-
   dependent artifacts — **pending Sprint 3**.

## References

- Epic 55 Phase 1 brief: `epic-55-structured-verification-findings.md`
- Phase 2 sprint 1 commits: `c17de32`, `d280aae`, `9053b05`
- Phase 2 sprint 1 e2e validation: `src/__tests__/e2e/epic-56-runtime-probes-e2e.test.ts`
- Digital Twin primitives (Epic 47): `packages/factory/src/twins/`
