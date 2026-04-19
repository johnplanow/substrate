# Story 56-phase3-twin-executor: Route `sandbox: twin` probes through Digital Twin

## Story

As a story author,
I want `sandbox: twin` runtime probes to execute inside an ephemeral Digital Twin sandbox instead of emitting a `runtime-probe-deferred` warn,
so that I can declare host-dangerous probes (systemd unit start, container lifecycle, migration runners, anything that mutates the operator's machine) and have them run safely against a disposable environment.

## Context

Epic 56 Phase 2 shipped host-sandbox probe execution with explicit
opt-in (`sandbox: host`). `sandbox: twin` probes currently emit a
`runtime-probe-deferred` warn finding; they are future-ready in story
markdown but do not yet execute.

Digital Twin primitives already exist from Epic 47:
- `TwinManager` — Docker Compose orchestration
- `TwinRegistry` — twin definition storage
- `TwinHealthMonitor` — liveness / readiness checks
- `TWIN_TEMPLATES` — pre-built template catalog

The `RuntimeProbeCheck` constructor already exposes a
`RuntimeProbeExecutors.twin` injection slot; this story wires a real
implementation in.

## Acceptance Criteria

### AC1: Twin executor implementation
**Given** a `RuntimeProbe` with `sandbox: twin` and a project whose
configured twin template is resolvable
**When** the RuntimeProbeCheck dispatches that probe
**Then** a dedicated twin executor — `executeProbeInTwin(probe,
deps)` — brings the twin up (via `TwinManager`), waits for health
(via `TwinHealthMonitor`), exec's `probe.command` inside it, captures
stdout / stderr / exit code / duration, tears the twin down, and
returns a `ProbeResult` with the same shape host execution produces

### AC2: Twin selection
**Given** a probe that does not explicitly declare a twin template
**When** the twin executor runs the probe
**Then** it resolves the twin template name from the project's
configuration (`.substrate/config.yaml`) via a new
`runtime_probes.default_twin` field (or a per-project `config:` block —
pick during story detail)
**And** when a probe declares `twin: <template-name>`, that explicit
value overrides the default

### AC3: Twin health gate
**Given** the twin executor attempts to exec a probe but
`TwinHealthMonitor` reports the twin as unhealthy
**When** the probe would have executed
**Then** the executor returns a `ProbeResult` with `outcome: 'fail'`
and a distinct failure signal that the check surfaces as a
`runtime-probe-twin-unhealthy` warn finding (NOT a fail — twin infra
issues are distinct from probe-run failures, mirroring the existing
"infra fail = warn, probe fail = fail" distinction)

### AC4: Teardown discipline
**Given** any code path that starts a twin for a probe
**When** the probe completes (pass, fail, or timeout) OR the executor
itself throws
**Then** the twin is torn down via the normal `TwinManager` shutdown
path before the `ProbeResult` is returned
**And** a failing probe does not leak a running twin between runs

### AC5: Lifecycle policy — per-probe ephemeral (v1)
**Given** a story declaring multiple twin-sandboxed probes
**When** `RuntimeProbeCheck` executes them sequentially
**Then** each probe brings up its own twin instance (per-probe
ephemeral) — no shared twin across probes in the same check run
**Note:** a follow-up story (`56-phase3-twin-shared-lifecycle.md`) may
introduce per-story or per-run shared lifecycle if the ephemeral-per-
probe cost is measurably too high.

### AC6: `runtime-probe-deferred` finding replaced
**Given** a probe with `sandbox: twin` and a working twin executor
**When** the check runs
**Then** no `runtime-probe-deferred` finding is emitted — the probe
executes, emits the usual `runtime-probe-fail` / `runtime-probe-timeout`
/ empty-findings outcome
**And** the `runtime-probe-deferred` category is removed from the code
(no longer possible to emit)

### AC7: Backward compatibility with projects that have no twins
**Given** a project where twin bring-up fails (no Docker/Compose, no
matching template, etc.) AND the probe declares `sandbox: twin`
**When** the check runs
**Then** the probe emits a `runtime-probe-twin-unavailable` warn
finding with a clear message naming the specific failure mode (no
Compose binary, template not found, etc.)
**And** the verdict is `warn`, not `fail` — a project without twin
infrastructure should not hard-gate on a probe that requires one

### AC8: Test coverage
**Given** the changes landed
**When** `npm run test:fast` and `npm test` run
**Then** new tests cover:
  - happy-path twin execution (mocked `TwinManager`)
  - twin-unhealthy path emits the right warn category
  - twin-unavailable path (no Compose on PATH) emits the right warn category
  - teardown fires on every exit path including errors thrown mid-exec
  - multiple twin probes in one check each get their own lifecycle
  - e2e: a real docker-compose bring-up / teardown (skipped when Docker
    is not available on the runner)

## Out of Scope

- Shared twin lifecycle across probes / stories / runs — follow-up story.
- Remote twin orchestration (Kubernetes, cloud VMs) — v1 is Compose-local.
- Probe output streaming into the twin for interactive debugging.
- Twin resource governance (memory/CPU caps beyond what
  `TwinDefinitionSchema` already supports).

## Key File Paths

### Files to Create
- `packages/sdlc/src/verification/probes/twin-executor.ts` —
  `executeProbeInTwin(probe, deps): Promise<ProbeResult>`; `deps`
  injects `TwinManager`, `TwinHealthMonitor`, and a template resolver
  so the file has no direct import from `@substrate-ai/factory` (keeps
  the package graph clean)
- `packages/sdlc/src/verification/probes/__tests__/twin-executor.test.ts`

### Files to Modify
- `packages/sdlc/src/verification/checks/runtime-probe-check.ts` —
  replace the `runtime-probe-deferred` path with twin executor dispatch
- `packages/sdlc/src/verification/verification-pipeline.ts` —
  `createDefaultVerificationPipeline` accepts an optional twin executor;
  the CLI composition root wires the factory's `TwinManager` in
- Config schema in `packages/core/src/config/` (or the appropriate
  package) — add `runtime_probes.default_twin` field

## Dependencies

- Blocked by Epic 56 Sprint 1 (Phase 2 MVP) — satisfied as of v0.20.5.
- Reads `@substrate-ai/factory` twin surface at the CLI composition
  root only. The sdlc package remains free of a factory dependency.

## Verification

- `npm run build` / `check:circular` / `typecheck:gate` all clean
- `npm run test:fast` clean
- Manual: author a story with a `sandbox: twin` probe, run
  `substrate run --events` against a project with Compose installed,
  observe probe execution inside the twin and clean teardown afterward
- Live consumer probe similar to Phase 2's strata-style repro: install
  `@substrate-ai/sdlc` from the registry, run a twin probe end-to-end

## Design notes

- Twin executor injection keeps the sdlc → factory dependency out of
  the package graph; only the CLI composition root needs to know about
  both.
- `RuntimeProbeCheck` today exposes `RuntimeProbeExecutors.twin` as an
  optional slot. This story promotes it to required-at-composition
  (with a clear error when the CLI constructs a probe check without a
  twin executor wired).
