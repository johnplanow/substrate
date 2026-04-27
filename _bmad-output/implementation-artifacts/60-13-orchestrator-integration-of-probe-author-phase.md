# Story 60-13: Orchestrator Integration of Probe-Author Phase

## Story

As a substrate pipeline orchestrator,
I want to dispatch a `probe-author` agent between `create-story` and `dev-story` when the story has event-driven acceptance criteria and no author-declared probes,
so that dev-story receives a pre-authored `## Runtime Probes` section ensuring event-driven implementations are runtime-verified before declaring success.

## Acceptance Criteria

<!-- source-ac-hash: d7b5fc741bc447e662d83b212e648ed378f5ec8a01cca600726e1ceaa5846e9b -->

- New helper `src/modules/implementation-orchestrator/probe-author-integration.ts`
  exporting `runProbeAuthor(deps, params): Promise<ProbeAuthorResult>`
  mirroring `runTestPlan` shape
- Integration in `orchestrator-impl.ts` between the existing `runCreateStory`
  call and `runTestPlan` call: call `runProbeAuthor` when the
  event-driven-keyword detector (extracted from 60-11's `detectsEventDrivenAC`
  helper, exported from `runtime-probe-check.ts`) returns true AND the
  story artifact does NOT already contain a `## Runtime Probes` section
- When probe-author runs, its yaml output is appended to the story
  artifact file (`_bmad-output/implementation-artifacts/<story_key>-<title>.md`)
  in a new `## Runtime Probes` section. The append is atomic
  (write-temp-then-rename) and idempotent (subsequent re-renders of
  the same story do not duplicate the section)
- Dev-story prompt at `packs/bmad/prompts/dev-story.md` gains a one-line
  TDD framing: "If the story artifact contains a `## Runtime Probes`
  section, your implementation MUST satisfy every probe in that section.
  Run probes locally before declaring success." Existing dev-story
  guidance unchanged otherwise
- Telemetry event `probe-author:dispatched` emitted on each invocation
  with `{storyKey, runId, probesAuthoredCount, dispatchDurationMs,
  costUsd}` payload (paired with 60-15's KPI tracking)
- Skip path: when source AC is not event-driven OR story artifact already
  has author-declared probes from create-story, no probe-author dispatch
  fires (no cost, no event)
- Backward-compat: existing strata stories (1-1 through 1-11) re-verifiable
  without probe-author firing because they don't have event-driven ACs
  (or already have author-declared probes from prior runs)
- **Failure mode recovery (mitigates Hole 6)**: probe-author dispatch
  failures are categorized and handled distinctly:
  1. **Dispatch error** (process crash, network failure, adapter
     exception): log `probe-author:dispatch-error` event, fall through
     to dev-story without authored probes. Non-fatal. Story still ships
     with whatever probes (if any) the source-AC-transfer / dev-authored
     path produces — same as pre-Sprint-13 behavior.
  2. **Timeout** (probe-author dispatch exceeds timeout): log
     `probe-author:timeout` event with elapsed ms. Single retry with
     extended timeout (1.5×). If retry also times out, fall through
     to dev-story (same as dispatch error). No more retries.
  3. **Invalid YAML** (probe-author returned output that doesn't parse):
     log `probe-author:invalid-output` event with parse error + first
     500 chars of output. Single retry with augmented prompt
     ("previous output failed parsing with: <error>; produce a single
     yaml block conforming to RuntimeProbeListSchema"). If retry also
     fails, fall through.
  4. **Empty probes list** (parsed valid yaml but list is empty): not
     a failure — author may legitimately decide no probes are needed.
     Log `probe-author:no-probes-authored` info event for telemetry;
     fall through to dev-story without authored probes. No retry.
  All failure paths are non-fatal — substrate falls through to existing
  dev-story behavior so probe-author NEVER worsens the pre-Sprint-13
  outcome
- 8-10 unit tests at
  `src/modules/implementation-orchestrator/__tests__/probe-author-integration.test.ts`
  covering: event-driven AC + no probes → probe-author runs; non-event AC
  → skip; AC has probes already → skip; story artifact mutation is
  idempotent across multiple runs; telemetry event emitted with correct
  shape; **the four failure paths above** (dispatch error, timeout +
  retry, invalid YAML + retry, empty probes list); end-to-end smoke
  test that a probe-author run for a synthetic event-driven AC
  produces an artifact-augmented story file with probes invoking the
  expected trigger

## Tasks / Subtasks

- [ ] Task 1: Export `detectsEventDrivenAC` from `runtime-probe-check.ts` (AC: skip path, integration gate)
  - [ ] Change `function detectsEventDrivenAC(...)` at line ~116 of `packages/sdlc/src/verification/checks/runtime-probe-check.ts` from a private function to an exported one
  - [ ] Verify the function's existing signature `(sourceEpicContent: string): boolean` matches what orchestrator-impl.ts will call

- [ ] Task 2: Create `probe-author-integration.ts` with `runProbeAuthor` (AC: new helper, mirroring runTestPlan shape)
  - [ ] Create `src/modules/implementation-orchestrator/probe-author-integration.ts`
  - [ ] Define `ProbeAuthorParams` interface: `{ storyKey, storyFilePath, pipelineRunId, sourceAcContent, epicContent }`
  - [ ] Define `ProbeAuthorResult` interface: `{ result: 'success' | 'failed' | 'skipped', probesAuthoredCount: number, error?: string, tokenUsage: { input: number, output: number }, durationMs: number }`
  - [ ] Implement `runProbeAuthor(deps: WorkflowDeps, params: ProbeAuthorParams): Promise<ProbeAuthorResult>` that dispatches the probe-author agent
  - [ ] Parse probe-author output as YAML (`RuntimeProbeListSchema` from `@substrate-ai/sdlc`)
  - [ ] Handle all four failure modes: dispatch error (fall-through), timeout + 1.5× retry (fall-through on second timeout), invalid YAML + retry with augmented prompt (fall-through), empty probes list (info event, fall-through)
  - [ ] Implement atomic idempotent file append: check for existing `## Runtime Probes` section before appending; use write-temp-then-rename pattern
  - [ ] Emit `probe-author:dispatched` event via orchestrator event emitter with correct payload shape

- [ ] Task 3: Wire `runProbeAuthor` into `orchestrator-impl.ts` (AC: integration between runCreateStory and runTestPlan)
  - [ ] Import `runProbeAuthor` from `./probe-author-integration.js`
  - [ ] Import `detectsEventDrivenAC` from `@substrate-ai/sdlc` (or direct path to runtime-probe-check.ts)
  - [ ] After `runCreateStory` resolves and `storyFilePath` is set, insert probe-author gate: check `detectsEventDrivenAC(epicContent)` AND absence of `## Runtime Probes` in story file
  - [ ] Call `runProbeAuthor` when gate passes; log skip reason when gate fails
  - [ ] Add `addTokenUsage` call for probe-author dispatch (wrapped in defensive Promise chain like other 57-4 fixes)

- [ ] Task 4: Update dev-story prompt (AC: TDD framing line)
  - [ ] Open `packs/bmad/prompts/dev-story.md`
  - [ ] Insert the line: "If the story artifact contains a `## Runtime Probes` section, your implementation MUST satisfy every probe in that section. Run probes locally before declaring success." at an appropriate location (e.g., before the main implementation instructions, without altering existing guidance)

- [ ] Task 5: Write unit tests (AC: 8-10 tests)
  - [ ] Create `src/modules/implementation-orchestrator/__tests__/probe-author-integration.test.ts`
  - [ ] Test: event-driven AC + no `## Runtime Probes` in artifact → `runProbeAuthor` dispatches
  - [ ] Test: non-event-driven AC → skip (result `'skipped'`, no dispatch)
  - [ ] Test: story artifact already has `## Runtime Probes` → skip (result `'skipped'`, no dispatch)
  - [ ] Test: idempotent append — calling probe-author twice on same file does not duplicate section
  - [ ] Test: telemetry event `probe-author:dispatched` emitted with correct `{storyKey, runId, probesAuthoredCount, dispatchDurationMs, costUsd}` shape
  - [ ] Test: dispatch error → `probe-author:dispatch-error` event logged, result falls through (no throw)
  - [ ] Test: timeout → `probe-author:timeout` event, single 1.5× retry, fall-through if second timeout
  - [ ] Test: invalid YAML → `probe-author:invalid-output` event with parse error + first 500 chars, single retry with augmented prompt, fall-through if second failure
  - [ ] Test: empty probes list → `probe-author:no-probes-authored` info event, no retry, fall-through
  - [ ] Test (smoke): end-to-end with synthetic event-driven AC → artifact file gains `## Runtime Probes` section with probe entries

## Dev Notes

### Architecture Constraints

- All imports use `.js` extension (ESM — ADR-001, ADR-003)
- Services consumed via `WorkflowDeps` injection (`db`, `pack`, `contextCompiler`, `dispatcher`, `projectRoot`, `tokenCeilings`, `otlpEndpoint`, `agentId`)
- `runProbeAuthor` MUST mirror `runTestPlan` shape: same `(deps, params)` signature, returns typed result object with `tokenUsage`, never throws — all errors are result-encoded
- Atomic file append: write to a `.tmp` file alongside the target, then `rename()` — prevents partial writes visible to concurrent readers
- Idempotency check: before appending, `readFile` the story artifact and test for `/^## Runtime Probes/m` — if present, return `'skipped'`
- `detectsEventDrivenAC` lives in `packages/sdlc/src/verification/checks/runtime-probe-check.ts` at line ~116. Currently unexported; story 60-13 exports it. Import path from orchestrator-impl.ts: `@substrate-ai/sdlc` (if re-exported from sdlc index) or relative `../../../packages/sdlc/src/...` — prefer the package import if sdlc exports it
- Retry timeout multiplier: `1.5` (not configurable for now — simple constant in probe-author-integration.ts)
- Event emission: use the existing `emitEvent` / `EventEmitter` pattern already established in orchestrator-impl.ts (see how `story:created`, `test-plan:dispatched` etc. are emitted)
- Token usage: wrap `addTokenUsage` call in `void Promise.resolve().then(() => addTokenUsage(...)).catch(logger.warn)` per the 57-4 pattern

### Key File Paths

- `src/modules/implementation-orchestrator/probe-author-integration.ts` — **new**
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` — modify: wire probe-author call between `runCreateStory` and `runTestPlan`
- `src/modules/implementation-orchestrator/__tests__/probe-author-integration.test.ts` — **new**
- `packs/bmad/prompts/dev-story.md` — modify: add TDD framing line
- `packages/sdlc/src/verification/checks/runtime-probe-check.ts` — modify: export `detectsEventDrivenAC`

### Testing Requirements

- Use `vitest` (project standard)
- Mock `WorkflowDeps` (db, dispatcher, etc.) via `vi.fn()` / `vi.fn().mockResolvedValue(...)`
- Use `tmp` directories (via `mkdtemp` or vitest's temp fixtures) for file mutation tests — do not write to real `_bmad-output`
- Timeout + retry tests: use fake timers (`vi.useFakeTimers`) or mock dispatcher to throw/reject with timeout error
- The invalid-YAML retry test must assert that the second dispatch prompt includes the parse error and first 500 chars of the bad output
- The smoke test should verify the appended `## Runtime Probes` section parses as valid YAML conforming to `RuntimeProbeListSchema`

### Import Reference

```typescript
// In probe-author-integration.ts
import type { WorkflowDeps } from '../compiled-workflows/types.js'
import { detectsEventDrivenAC } from '@substrate-ai/sdlc'   // after exporting from sdlc
// OR: import { detectsEventDrivenAC } from '../../../packages/sdlc/src/verification/checks/runtime-probe-check.js'
import { RuntimeProbeListSchema } from '@substrate-ai/sdlc'

// In orchestrator-impl.ts (additions)
import { runProbeAuthor } from './probe-author-integration.js'
import { detectsEventDrivenAC } from '@substrate-ai/sdlc'
```

## Interface Contracts

- **Import**: `detectsEventDrivenAC` @ `packages/sdlc/src/verification/checks/runtime-probe-check.ts` (from story 60-11, newly exported by this story)
- **Import**: `RuntimeProbeListSchema` @ `@substrate-ai/sdlc` (existing sdlc export)
- **Export**: `ProbeAuthorResult` @ `src/modules/implementation-orchestrator/probe-author-integration.ts` (consumed by orchestrator-impl.ts)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
