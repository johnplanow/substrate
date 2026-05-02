# Story 64.2: `external_state_dependencies` Story Frontmatter + Escalation

## Story

As a substrate pipeline operator,
I want story artifacts to declare their external state dependencies in machine-readable frontmatter,
so that the verification pipeline can escalate a missing `## Runtime Probes` section to an error when external state is involved, hard-gating stories that interact with the host before they can SHIP_IT.

## Acceptance Criteria

<!-- source-ac-hash: c2259865337082e4f6994be93d2a668e22e3df91c002e62920f6a15b044b23ce -->

1. `external_state_dependencies` added to the story-artifact frontmatter
   Zod schema (`packages/sdlc/src/run-model/story-artifact-schema.ts` or
   equivalent). Optional, default empty array.
2. `create-story.md` Runtime Verification Guidance section instructs the
   agent to populate the field when the AC matches any behavioral signal.
   Suggested values documented: `subprocess`, `filesystem`, `git`,
   `database`, `network`, `registry`, `os`.
3. Verification check (`runtime-probe-check.ts` or
   `source-ac-fidelity-check.ts`) reads the frontmatter field. When
   non-empty AND no `## Runtime Probes` section, severity escalates from
   `warn` to `error` with explicit message: "story declares
   external_state_dependencies but has no `## Runtime Probes` section —
   probes required per obs_2026-05-01_017."
4. Empty/absent `external_state_dependencies` preserves current behavior:
   missing section emits `warn` (or, if the AC is event-driven per
   `detectsEventDrivenAC`, `error` per the obs_016 escalation — unchanged).
5. Backward-compat: stories without the field continue to dispatch
   normally; old stories without frontmatter declarations don't
   retroactively fail verification.
6. Round-trip test: a story artifact with `external_state_dependencies:
   [git, subprocess]` and a `## Runtime Probes` section passes
   verification cleanly.
7. Negative test: a story with `external_state_dependencies: [git]` and
   NO `## Runtime Probes` section produces an `error`-severity finding,
   blocks SHIP_IT.

## Tasks / Subtasks

- [ ] Task 1: Create `packages/sdlc/src/run-model/story-artifact-schema.ts` with `external_state_dependencies` Zod schema and frontmatter parser (AC: #1, #5)
  - [ ] Define `ExternalStateDependencySchema` as `z.string()` (open enum — gate cares only about non-empty vs empty)
  - [ ] Define `StoryFrontmatterSchema` with `external_state_dependencies: z.array(ExternalStateDependencySchema).optional().default([])`
  - [ ] Implement `parseStoryFrontmatter(content: string): StoryFrontmatter` — strip YAML between leading `---` delimiters, parse with `js-yaml`, validate against schema; return empty-array default on parse failure (backward-compat)
  - [ ] Export `StoryFrontmatterSchema`, `StoryFrontmatter` (inferred type), and `parseStoryFrontmatter` from the module

- [ ] Task 2: Update `runtime-probe-check.ts` to escalate when frontmatter declares dependencies but probes are absent (AC: #3, #4, #5)
  - [ ] Import `parseStoryFrontmatter` from `../../run-model/story-artifact-schema.js`
  - [ ] Add new finding category constant `CATEGORY_MISSING_PROBES_DECLARED = 'runtime-probe-missing-declared-probes'`
  - [ ] In the `parsed.kind === 'absent'` branch of `RuntimeProbeCheck.run()`: call `parseStoryFrontmatter(context.storyContent)`, check if `external_state_dependencies.length > 0`; when true, emit error finding with message "story declares external_state_dependencies but has no `## Runtime Probes` section — probes required per obs_2026-05-01_017." and return `status: 'fail'`
  - [ ] When `external_state_dependencies` is empty/absent, preserve existing pass return (no regression for stories without field)
  - [ ] The existing `detectsEventDrivenAC` escalation in `source-ac-fidelity-check.ts` is untouched — different code path, different check

- [ ] Task 3: Update `packs/bmad/prompts/create-story.md` Runtime Verification Guidance section (AC: #2)
  - [ ] After the behavioral-signals enumeration (under the Runtime Verification Guidance heading already rewritten by Story 64-1), add a new sub-section instructing the create-story agent to populate `external_state_dependencies` in YAML frontmatter whenever any behavioral signal fires
  - [ ] Document the suggested seed values with a brief description for each: `subprocess`, `filesystem`, `git`, `database`, `network`, `registry`, `os`
  - [ ] Provide a concrete frontmatter example showing the `---` delimiter block with `external_state_dependencies:` populated
  - [ ] Clarify: the frontmatter field is the machine-readable declaration; the `## Runtime Probes` section is the operational artifact — both are required when behavioral signals are present
  - [ ] Update token-budget assertion in `src/modules/compiled-workflows/__tests__/create-story.test.ts` if the new text pushes past the current assertion threshold

- [ ] Task 4: Write tests for the new frontmatter schema and escalation (AC: #6, #7)
  - [ ] New test file `packages/sdlc/src/__tests__/verification/runtime-probe-frontmatter-escalation.test.ts`
  - [ ] Test: `parseStoryFrontmatter` with valid `external_state_dependencies: [git, subprocess]` returns correct array
  - [ ] Test: `parseStoryFrontmatter` with no frontmatter block returns `{ external_state_dependencies: [] }` (backward-compat)
  - [ ] Test: `parseStoryFrontmatter` with empty `external_state_dependencies:` list returns `{ external_state_dependencies: [] }`
  - [ ] Round-trip test (AC: #6): `RuntimeProbeCheck.run()` with a story that has `external_state_dependencies: [git, subprocess]` **and** a valid `## Runtime Probes` section → `status: 'pass'`, no error findings
  - [ ] Negative test (AC: #7): `RuntimeProbeCheck.run()` with a story that has `external_state_dependencies: [git]` and **no** `## Runtime Probes` section → `status: 'fail'`, one finding with category `runtime-probe-missing-declared-probes`, severity `error`, message contains "story declares external_state_dependencies"
  - [ ] Backward-compat test (AC: #5): `RuntimeProbeCheck.run()` with a story that has **no** frontmatter and **no** `## Runtime Probes` section → `status: 'pass'` (existing behavior)
  - [ ] Backward-compat test: `RuntimeProbeCheck.run()` with `external_state_dependencies: []` and no probes section → `status: 'pass'`

## Dev Notes

### File Paths

- **New**: `packages/sdlc/src/run-model/story-artifact-schema.ts` — Zod schema + parser for story frontmatter
- **Modified**: `packages/sdlc/src/verification/checks/runtime-probe-check.ts` — new escalation branch in `parsed.kind === 'absent'` handler
- **Modified**: `packs/bmad/prompts/create-story.md` — add frontmatter-population instruction to Runtime Verification Guidance section
- **Modified (if threshold changed)**: `src/modules/compiled-workflows/__tests__/create-story.test.ts` — token-budget assertion
- **New tests**: `packages/sdlc/src/__tests__/verification/runtime-probe-frontmatter-escalation.test.ts`

### Architecture Constraints

- **Open enum**: `ExternalStateDependencySchema` is `z.string()` not `z.enum([...])`. The gate only cares about non-empty vs. empty. A closed enum risks false silences if agents invent novel category names. Follow the obs_017 party-mode design call.
- **Frontmatter format**: YAML delimited by `---` at the start of the story file. Parser must handle stories with no frontmatter block (return default) and stories where frontmatter YAML is invalid (return default, don't throw — backward-compat AC5).
- **Import path style**: use `.js` extension on all relative imports (ESM-mode project). Import `js-yaml` directly (already in `@substrate-ai/sdlc` dependencies).
- **Escalation placement**: put the `external_state_dependencies` check inside `runtime-probe-check.ts`, specifically in the `parsed.kind === 'absent'` branch, NOT in `source-ac-fidelity-check.ts`. The obs_016 `detectsEventDrivenAC` escalation in `source-ac-fidelity-check.ts` is a separate code path that must remain unchanged (AC4 backward-compat).
- **Finding category**: use `runtime-probe-missing-declared-probes` (distinct from `runtime-probe-missing-production-trigger` which handles event-driven AC detection).
- **Test framework**: vitest with `import { describe, it, expect } from 'vitest'`. Stub `RuntimeProbeExecutors` in tests that would invoke the host executor.
- **No new exported symbols from `verification/checks/runtime-probe-check.ts`** other than those already public — `parseStoryFrontmatter` is an implementation detail imported from `run-model`.

### Frontmatter Parser Design

```typescript
// packages/sdlc/src/run-model/story-artifact-schema.ts
import { z } from 'zod'
import { load as yamlLoad } from 'js-yaml'

export const StoryFrontmatterSchema = z.object({
  external_state_dependencies: z.array(z.string()).optional().default([]),
})

export type StoryFrontmatter = z.infer<typeof StoryFrontmatterSchema>

export function parseStoryFrontmatter(content: string): StoryFrontmatter {
  // Match optional leading `---\n...\n---\n` block
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content)
  if (!match) return StoryFrontmatterSchema.parse({})
  try {
    const raw = yamlLoad(match[1])
    return StoryFrontmatterSchema.parse(raw ?? {})
  } catch {
    // Malformed frontmatter — treat as empty (backward-compat)
    return StoryFrontmatterSchema.parse({})
  }
}
```

### Escalation Insertion Point in `runtime-probe-check.ts`

The `parsed.kind === 'absent'` branch currently returns `status: 'pass'` immediately. After this story, it should:

```typescript
if (parsed.kind === 'absent') {
  const frontmatter = parseStoryFrontmatter(context.storyContent)
  if (frontmatter.external_state_dependencies.length > 0) {
    const findings: VerificationFinding[] = [{
      category: CATEGORY_MISSING_PROBES_DECLARED,
      severity: 'error',
      message:
        "story declares external_state_dependencies but has no `## Runtime Probes` section — probes required per obs_2026-05-01_017.",
    }]
    return {
      status: 'fail',
      details: renderFindings(findings),
      duration_ms: Date.now() - start,
      findings,
    }
  }
  return {
    status: 'pass',
    details: 'runtime-probes: no ## Runtime Probes section declared — skipping',
    duration_ms: Date.now() - start,
    findings: [],
  }
}
```

### `create-story.md` Frontmatter Instruction (to add under Runtime Verification Guidance)

After the behavioral-signals block (added by Story 64-1), insert a new paragraph instructing:

> When you author a `## Runtime Probes` section, also populate the `external_state_dependencies` YAML frontmatter field at the top of the story file. This is the machine-readable declaration that pairs with the operational `## Runtime Probes` section. Example frontmatter:
>
> ```yaml
> ---
> external_state_dependencies:
>   - subprocess
>   - filesystem
> ---
> ```
>
> Suggested values: `subprocess` (execSync/spawn), `filesystem` (fs.read*/write* on host paths), `git` (git log/push/merge), `database` (Dolt/sqlite/mysql queries), `network` (fetch/axios/http.get), `registry` (npm/package scan), `os` (system-level state not covered above).
>
> Omit the field (or leave it empty) only for purely-algorithmic modules where you also omit `## Runtime Probes`.

### Testing Requirements

- All tests in `packages/sdlc/src/__tests__/verification/runtime-probe-frontmatter-escalation.test.ts`
- Stub the `RuntimeProbeExecutors` to prevent real shell execution in unit tests (pass mock executor that returns pass results)
- Use `context.storyContent` strings directly — no filesystem reads in tests
- Tests must cover: parse success, parse no-frontmatter fallback, parse empty-list, round-trip pass (AC6), negative error escalation (AC7), backward-compat no-field pass (AC5), backward-compat empty-field pass

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

| Date | Version | Description | Author |
|---|---|---|---|
| 2026-05-02 | 0.1 | Initial story creation | create-story |
