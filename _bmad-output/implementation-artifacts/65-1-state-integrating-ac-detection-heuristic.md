# Story 65-1: state-integrating AC detection heuristic

## Story

As a substrate pipeline,
I want to detect when an AC describes state-integrating behavior (subprocess, filesystem, git, database, network, or registry interactions),
so that probe-author dispatch is triggered for stories whose production code paths hit real external state — not just event-driven mechanisms.

## Acceptance Criteria

<!-- source-ac-hash: 8e81b2d3db33c26697c4fbc9751078f861ec301265c44de9c335cdc611a20275 -->

1. `detectsStateIntegratingAC` exported from
   `packages/sdlc/src/verification/checks/runtime-probe-check.ts` (or sibling).
2. Returns `true` when source AC content contains any of the
   subprocess / filesystem / git / database / network / registry signals
   listed below:
   - subprocess: `execSync(`, `spawn(`, `exec(`, `child_process`,
     `runs <command>`, "spawns", "invokes <binary>"
   - filesystem: `fs.read`, `fs.write`, `readFile`, `writeFile`,
     `path.join` against `homedir()` / `os.homedir()` / absolute paths,
     "reads from disk", "writes to disk", "scans filesystem"
   - git: `git log`, `git push`, `git pull`, `git merge`,
     "queries git", "runs git", git porcelain output parsing
   - database: `Dolt`, `mysql`, `pg`, `sqlite`, `INSERT`, `SELECT`,
     "queries the database", "writes to Dolt"
   - network: `fetch(`, `axios`, `http.get`, `https.get`,
     "fetches", "POSTs to", "calls the API"
   - registry: registry-name patterns, "queries registry",
     "scans the registry"
3. Returns `false` for purely-algorithmic AC text (parse, format,
   sort, transform, score, calculate).
4. Returns `false` when source AC describes only **mock** integration
   ("mocks the database", "stubs the registry") — ground truth is
   whether the production code path hits real state, not whether
   tests exercise it.
5. Coexists with `detectsEventDrivenAC`. ACs matching both heuristics
   dispatch probe-author once (single dispatch covers both classes).
6. Unit tests cover positive, negative, and ambiguous cases. Use
   strata Story 2-4's actual AC text as a positive-case fixture so
   Epic 65 directly exercises the obs_017 reproduction.

## Tasks / Subtasks

- [ ] Task 1: Define `STATE_INTEGRATING_KEYWORDS` pattern array in `runtime-probe-check.ts` (AC: #1, #2)
  - [ ] Add a `STATE_INTEGRATING_KEYWORDS: RegExp[]` constant mirroring the `EVENT_DRIVEN_KEYWORDS` pattern — cover all six signal categories (subprocess, filesystem, git, database, network, registry) using the exact identifiers and phrases listed in AC #2
  - [ ] Place the constant immediately after the existing `EVENT_DRIVEN_KEYWORDS` block for co-location

- [ ] Task 2: Implement and export `detectsStateIntegratingAC` (AC: #1, #2, #3, #4, #5)
  - [ ] Add exported `detectsStateIntegratingAC(sourceContent: string): boolean` function iterating `STATE_INTEGRATING_KEYWORDS`, returning `true` on first match
  - [ ] Ensure the function signature and placement mirrors `detectsEventDrivenAC` exactly so callers can call either/both without structural friction
  - [ ] Mock/stub guard: scan the matched line's surrounding context (or the full string) for negating mock-phrases ("mocks the", "stubs the", "mock ", "stub ") and return `false` when the only matches are mock-context hits (AC #4)

- [ ] Task 3: Wire single-dispatch coexistence check (AC: #5)
  - [ ] Locate the probe-author dispatch gate in the orchestrator integration (likely `packages/sdlc/src/verification/checks/runtime-probe-check.ts` or `probe-author-integration.ts`) where `detectsEventDrivenAC` is already consulted
  - [ ] Update that gate to also call `detectsStateIntegratingAC(context.sourceEpicContent)`; combine with `||` so either heuristic firing triggers a single probe-author dispatch (no double-dispatch)

- [ ] Task 4: Write unit tests (AC: #2, #3, #4, #6)
  - [ ] Add tests in `packages/sdlc/src/__tests__/verification/runtime-probe-check.test.ts` (or a sibling) covering:
    - Positive cases: each of the six signal categories fires (`execSync(`, `git log`, `fetch(`, `Dolt`, `readFile`, "queries registry")
    - Strata Story 2-4 actual AC text as a positive fixture (obs_017 reproduction; the AC describes `fetchGitLog` running `git log` against project repos)
    - Negative cases: purely-algorithmic verbs (`parse`, `format`, `sort`, `transform`, `score`, `calculate`) return `false`
    - Mock-exclusion cases: "mocks the database", "stubs the registry" return `false`
    - Ambiguous cases (e.g., description-only mentions without code signals) return expected values per documented heuristic
  - [ ] Verify `detectsStateIntegratingAC` is importable from the same module path as `detectsEventDrivenAC`

## Dev Notes

### Architecture Constraints

- **Target file**: `packages/sdlc/src/verification/checks/runtime-probe-check.ts` — add the constant and function here, immediately after the `EVENT_DRIVEN_KEYWORDS` / `detectsEventDrivenAC` block. A sibling module is acceptable only if the existing `detectsEventDrivenAC` is moved there too (they must share an import boundary).
- **Export style**: named export matching the existing pattern (`export function detectsStateIntegratingAC(...)`). No default exports.
- **Pattern format**: `RegExp[]`, same as `EVENT_DRIVEN_KEYWORDS`. Patterns should be case-sensitive where the signal is a code identifier (e.g., `` `execSync(` ``), case-insensitive for natural-language phrases (e.g., "reads from disk").
- **Mock guard**: the exclusion in AC #4 must be implemented conservatively. The safest approach is to check whether every match in the AC text is accompanied by a mock/stub qualifier on the same line or in the same sentence. If any match is NOT in a mock context, return `true`.
- **Dispatch gate**: the existing orchestrator call site already guards on `detectsEventDrivenAC`; a simple `|| detectsStateIntegratingAC(...)` extension is the expected change. Do not introduce a separate dispatch path.

### Testing Requirements

- Framework: vitest (existing project standard)
- Test file: `packages/sdlc/src/__tests__/verification/runtime-probe-check.test.ts` (extend existing file; add a `describe('detectsStateIntegratingAC', ...)` block)
- The strata Story 2-4 fixture: include the actual AC text verbatim from strata (it contains `fetchGitLog`, `git log`, per-project `cwd`) as a `const storyTwoFourACText = \`...\`` inline fixture — this directly exercises the obs_017 reproduction scenario
- Negative cases must also include the strata Story 2-4 purely-algorithmic sibling (a sort/format AC from the same epic) to confirm the heuristic discriminates within the same corpus

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
