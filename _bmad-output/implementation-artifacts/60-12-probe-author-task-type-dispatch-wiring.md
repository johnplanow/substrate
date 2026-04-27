# Story 60-12: probe-author task type + dispatch wiring

## Story

As a pipeline engineer,
I want a `probe-author` compiled workflow that authors runtime probes from AC intent alone,
so that probe quality is grounded in the story's acceptance criteria rather than implementation details.

## Acceptance Criteria

<!-- source-ac-hash: 73445108a4f55d3ac2849ff59da2d2e981b6bd9c621876be08e7c8b53183c5de -->

- New entry in `src/modules/agent-dispatch/types.ts` adds `'probe-author'`
  to the `taskType` union literal
- New file `packs/bmad/prompts/probe-author.md` with the probe-author
  prompt template. The prompt receives `{{rendered_ac_section}}` and
  `{{source_epic_ac_section}}` as context, NOT `{{implementation_files}}`
  or `{{architecture_constraints}}` (deliberately scope-limited)
- The probe-author prompt explicitly inherits 60-4's success-shape
  guidance (`expect_stdout_no_regex` / `expect_stdout_regex` patterns
  for structured-output probes) and 60-10's production-trigger guidance
  (event-driven mechanisms must invoke the real trigger). Both subsections
  copied / linked from `create-story.md`'s current 60-4 and 60-10 sections
  so the probe-author has the same calibration as the create-story agent
- **BDD-clause-driven probe requirement** (mitigates Hole 7 / Mary's
  Assumption 1): the prompt MUST include the directive: "For each
  `Given X / When Y / Then Z` scenario in the AC section, you MUST
  author at least one probe whose `command:` makes Y happen and whose
  `expect_stdout_regex` / `expect_stdout_no_regex` (or shell exit code
  for natively-exiting commands) asserts Z. Probes that only verify
  the implementation produces correct outputs given pre-existing
  inputs do NOT satisfy this requirement — those probes skip the
  wiring layer that the AC's user-facing event would exercise." This
  directive is the spec-level countermeasure to "probe-author authors
  generic abstractions that don't catch real bugs"; 60-14's go/no-go
  gate measures whether the directive actually translates to better
  probe quality in practice
- The probe-author prompt's Output Contract requires a single yaml block
  conforming to `RuntimeProbeListSchema` (re-uses the existing parser
  from `packages/sdlc/src/verification/probes/parser.ts`)
- New compiled-workflow definition in `src/modules/compiled-workflows/`
  for the probe-author phase (`probe-author.ts` mirroring `test-plan.ts`'s
  shape) — input validation, prompt rendering, output parsing into
  `{ probes: RuntimeProbe[] }` shape
- Token ceiling for probe-author registered in
  `src/modules/compiled-workflows/token-ceiling.ts` — start at **50000**
  (between create-story's 50000 and test-plan's 100000; probe-author's
  prompt inherits 60-4 + 60-10 guidance so it's larger than test-plan's
  but its OUTPUT is small — only the probes yaml block, not a full
  story spec or test plan). Re-calibrate after first 5 dispatches
  if real input+output usage runs > 80% of ceiling
- **Probe-author prompt size budget**: hard cap of **22000 chars**
  (~5500 tokens) on the prompt template at
  `packs/bmad/prompts/probe-author.md`. The prompt inherits the bulk
  of create-story.md's 60-4 and 60-10 subsections (~4000 chars combined)
  + AC-rendering instructions + output contract + BDD-clause directive.
  Budget enforced by a test mirroring `methodology-pack.test.ts`'s
  `BMAD pack create-story prompt exists and is within token budget`
  pattern. Bump with same justification-comment discipline if growth
  is needed
- Default model: `claude-sonnet-4-6` (same as test-plan / create-story).
  No 1M-context dependency for v1.
- 4-6 unit tests at `src/modules/compiled-workflows/__tests__/probe-author.test.ts`
  covering: prompt template renders with AC inputs, output parser handles
  valid yaml block, parser rejects schema-invalid output, missing AC
  input fails loudly, schema-drift guardrail validates every yaml fence
  in the prompt against `RuntimeProbeListSchema`, prompt budget cap test
  in `methodology-pack.test.ts` pattern

## Tasks / Subtasks

- [ ] Task 1: Add `'probe-author'` to the `taskType` union and dispatch defaults (AC: AC1)
  - [ ] In `src/modules/agent-dispatch/types.ts`, add `'probe-author'` to the `taskType`-bearing `DEFAULT_TIMEOUTS` and `DEFAULT_MAX_TURNS` maps with sensible values (timeout: 300_000; maxTurns: 20 — lightweight call, output is small)
  - [ ] Confirm no TypeScript literal union enforcing `taskType` values in the codebase; if one exists, add `'probe-author'` there too (search for `taskType.*literal` or similar)

- [ ] Task 2: Add `ProbeAuthorParams` / `ProbeAuthorResult` types and `ProbeAuthorResultSchema` (AC: AC5, AC6)
  - [ ] Add `ProbeAuthorParams` interface to `src/modules/compiled-workflows/types.ts` — fields: `storyKey: string`, `renderedAcSection: string`, `sourceEpicAcSection: string`, `pipelineRunId?: string`
  - [ ] Add `ProbeAuthorResult` interface to `src/modules/compiled-workflows/types.ts` — fields: `result: 'success' | 'failed'`, `probes: RuntimeProbe[]`, `error?: string`, `tokenUsage: { input: number; output: number }`
  - [ ] Add `ProbeAuthorResultSchema` to `src/modules/compiled-workflows/schemas.ts` — a Zod object with `result` enum and `probes` array validated via `RuntimeProbeListSchema` (import from `@substrate-ai/sdlc`)

- [ ] Task 3: Register `'probe-author'` token ceiling (AC: AC7)
  - [ ] Add `'probe-author': 50_000` to `TOKEN_CEILING_DEFAULTS` in `src/modules/compiled-workflows/token-ceiling.ts`
  - [ ] Add a justification comment matching the existing pattern explaining 50k choice

- [ ] Task 4: Author `packs/bmad/prompts/probe-author.md` (AC: AC2, AC3, AC4, AC8)
  - [ ] Create `packs/bmad/prompts/probe-author.md` with these sections (in order):
    - Context preamble explaining the probe-author's scope-limited role (receives AC only, not implementation)
    - `{{rendered_ac_section}}` and `{{source_epic_ac_section}}` template variables with clear labels
    - BDD-clause-driven probe requirement directive (verbatim from AC4 above)
    - Success-shape assertion guidance (copied from create-story.md's 60-4 section: `expect_stdout_no_regex` / `expect_stdout_regex` patterns)
    - Production-trigger guidance (copied from create-story.md's 60-10 section: event-driven mechanisms must invoke the real trigger, including the trigger-shape table and the post-merge hook example)
    - Probe YAML shape reference (name, sandbox, command, timeout_ms?, description?, expect_stdout_no_regex?, expect_stdout_regex?)
    - Output Contract: emit a single `yaml` fenced block containing a list of probes conforming to `RuntimeProbeListSchema`
  - [ ] Verify prompt length is < 22000 chars
  - [ ] Ensure every `yaml` fenced block in the prompt is a valid `RuntimeProbeListSchema` list (no placeholder-only blocks that would break the schema-drift guardrail)

- [ ] Task 5: Implement `src/modules/compiled-workflows/probe-author.ts` (AC: AC5, AC6)
  - [ ] Mirror `test-plan.ts` structure: `runProbeAuthor(deps, params)` async function
  - [ ] Step 1: retrieve template via `deps.pack.getPrompt('probe-author')`; return failure on error
  - [ ] Step 2: validate `params.renderedAcSection` and `params.sourceEpicAcSection` are non-empty strings; return failure with `missing_ac_input` error if either is blank
  - [ ] Step 3: assemble prompt via `assemblePrompt()` — inject `rendered_ac_section` (required) and `source_epic_ac_section` (required) against TOKEN_CEILING of 50000
  - [ ] Step 4: dispatch via `deps.dispatcher.dispatch({ prompt, agent, taskType: 'probe-author', timeout: DEFAULT_TIMEOUT_MS, outputSchema: ProbeAuthorResultSchema })`
  - [ ] Step 5: handle timeout / failed / parseError — return failure result
  - [ ] Step 6: on success, parse `dispatchResult.parsed.probes` through `RuntimeProbeListSchema`; return `{ result: 'success', probes: parsed.probes, tokenUsage }`
  - [ ] Helper: `makeProbeAuthorFailureResult(error)` returning `{ result: 'failed', probes: [], error, tokenUsage: { input: 0, output: 0 } }`

- [ ] Task 6: Write unit tests `src/modules/compiled-workflows/__tests__/probe-author.test.ts` (AC: AC9)
  - [ ] Test: prompt template renders with AC inputs — `assemblePrompt` receives both `{{rendered_ac_section}}` and `{{source_epic_ac_section}}`
  - [ ] Test: output parser handles valid yaml probe block — returns `probes` array matching input
  - [ ] Test: parser rejects schema-invalid output (e.g., probe missing `name` or `sandbox`) — returns `failed` with `schema_validation_failed`
  - [ ] Test: missing `renderedAcSection` input fails loudly — returns `failed` with `missing_ac_input` before dispatch
  - [ ] Test: schema-drift guardrail — reads `packs/bmad/prompts/probe-author.md`, extracts every `yaml` fenced block, validates each list against `RuntimeProbeListSchema` (mirrors create-story.test.ts AC1 guardrail)
  - [ ] Test: prompt budget cap — reads the prompt file, asserts `prompt.length < 22000` (mirrors methodology-pack.test.ts pattern)

- [ ] Task 7: Add `probe-author` to `compiled-workflows/index.ts` exports (AC: AC5)
  - [ ] Export `runProbeAuthor`, `ProbeAuthorParams`, `ProbeAuthorResult` from `src/modules/compiled-workflows/index.ts`

## Dev Notes

### File Paths

| File | Action |
|---|---|
| `src/modules/agent-dispatch/types.ts` | Modify — add `'probe-author'` to `DEFAULT_TIMEOUTS` and `DEFAULT_MAX_TURNS` |
| `src/modules/compiled-workflows/types.ts` | Modify — add `ProbeAuthorParams`, `ProbeAuthorResult` interfaces |
| `src/modules/compiled-workflows/schemas.ts` | Modify — add `ProbeAuthorResultSchema` |
| `src/modules/compiled-workflows/token-ceiling.ts` | Modify — add `'probe-author': 50_000` to `TOKEN_CEILING_DEFAULTS` |
| `packs/bmad/prompts/probe-author.md` | New — probe-author prompt template |
| `src/modules/compiled-workflows/probe-author.ts` | New — `runProbeAuthor()` workflow function |
| `src/modules/compiled-workflows/__tests__/probe-author.test.ts` | New — unit tests |
| `src/modules/compiled-workflows/index.ts` | Modify — export new workflow |

### Architecture Constraints

- **ESM imports**: all intra-package imports must use `.js` extension (e.g., `import { ... } from './types.js'`)
- **No direct module imports**: services consumed via `WorkflowDeps` injection (ADR-001, ADR-003)
- **RuntimeProbeListSchema import**: from `@substrate-ai/sdlc` (not from the internal path) — matches the pattern in `create-story.test.ts`
- **ProbeAuthorResultSchema**: the output schema wraps `RuntimeProbeListSchema` — the probes field should be `z.array(RuntimeProbeSchema)` or use the existing schema from `@substrate-ai/sdlc`
- **assemblePrompt**: import from `./prompt-assembler.js` — same pattern as `test-plan.ts`
- **getTokenCeiling**: import from `./token-ceiling.js`
- **Logger**: `createLogger('compiled-workflows:probe-author')`

### Implementing `ProbeAuthorResultSchema`

The schema wraps the RuntimeProbeListSchema. Check how `RuntimeProbe` and `RuntimeProbeListSchema` are exported from `@substrate-ai/sdlc`:

```typescript
import { RuntimeProbeListSchema } from '@substrate-ai/sdlc'
import type { RuntimeProbe } from '@substrate-ai/sdlc'

export const ProbeAuthorResultSchema = z.object({
  result: z.preprocess(
    (val) => (val === 'failure' ? 'failed' : val),
    z.enum(['success', 'failed']),
  ),
  probes: RuntimeProbeListSchema,
})
```

The agent emits a yaml block like:
```yaml
result: success
probes:
  - name: my-probe
    sandbox: host
    command: echo "hello"
```

### Prompt Template Design (`probe-author.md`)

The prompt is deliberately scope-limited: no implementation files, no architecture constraints. Context provided:
- `{{rendered_ac_section}}` — the story artifact's rendered AC section (post-create-story)
- `{{source_epic_ac_section}}` — the raw AC from the epic file (pre-create-story)

Both are `priority: 'required'` in `assemblePrompt()` since the probe-author cannot function without AC context.

The 60-4 and 60-10 sections to copy are in `packs/bmad/prompts/create-story.md`. Find the subsections:
- "Asserting success-shape on structured-output probes" (60-4 section)
- "Probes for event-driven mechanisms must invoke the production trigger" (60-10 section, including the trigger-shape table and post-merge example)

Copy these verbatim into probe-author.md. Do NOT link — the probe-author prompt must be self-contained since it is dispatched as a standalone agent.

### Test Pattern: Schema-Drift Guardrail

Mirror the pattern from `src/modules/compiled-workflows/__tests__/create-story.test.ts` lines ~1930-1952:

```typescript
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { RuntimeProbeListSchema } from '@substrate-ai/sdlc'
import { load as yamlLoad } from 'js-yaml'

it('schema-drift guardrail: every yaml fenced block parses against RuntimeProbeListSchema', async () => {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const promptPath = join(__dirname, '..', '..', '..', '..', 'packs', 'bmad', 'prompts', 'probe-author.md')
  const content = await readFile(promptPath, 'utf-8')
  const fences = [...content.matchAll(/```yaml\n([\s\S]*?)\n```/g)].map((m) => m[1])
  expect(fences.length).toBeGreaterThan(0)
  for (const body of fences) {
    const parsed = yamlLoad(body)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) continue
    expect(Array.isArray(parsed)).toBe(true)
    const result = RuntimeProbeListSchema.safeParse(parsed)
    if (!result.success) {
      throw new Error(`Probe example failed schema validation:\n--- yaml ---\n${body}\n--- error ---\n${result.error.message}`)
    }
  }
})
```

### Test Pattern: Budget Cap

Mirror `methodology-pack.test.ts` pattern:

```typescript
it('probe-author prompt exists and is within 22000 char budget', async () => {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const promptPath = join(__dirname, '..', '..', '..', '..', 'packs', 'bmad', 'prompts', 'probe-author.md')
  const content = await readFile(promptPath, 'utf-8')
  expect(content).toBeDefined()
  expect(content.length).toBeGreaterThan(100)
  expect(content.length).toBeLessThan(22000)
})
```

### Testing Requirements

- Test framework: Vitest (matches all other `compiled-workflows/__tests__/` files)
- Mock `createLogger` from `../../../utils/logger.js` (same vi.mock pattern as test-plan.test.ts)
- Mock `node:fs/promises` for `readFile` calls in the workflow function
- Import `RuntimeProbeListSchema` from `@substrate-ai/sdlc` for schema-drift and schema validation tests
- Import `load as yamlLoad` from `js-yaml` for fenced block parsing
- 4-6 tests total; prefer focused unit tests over integration tests (no DB or real filesystem for the workflow function tests)

### DEFAULT_TIMEOUTS and DEFAULT_MAX_TURNS entries

In `src/modules/agent-dispatch/types.ts`, append to the `DEFAULT_TIMEOUTS` map:
```typescript
'probe-author': 300_000,
```

And to `DEFAULT_MAX_TURNS`:
```typescript
'probe-author': 20,
```

These are conservative values; probe-author is lighter than test-plan since output is only a YAML probes block.

### Missing AC Input Validation

The probe-author fails loudly (before dispatch) if either AC section is blank/empty:

```typescript
if (!params.renderedAcSection.trim() || !params.sourceEpicAcSection.trim()) {
  logger.warn({ storyKey }, 'Probe-author called with empty AC section(s) — failing loudly')
  return makeProbeAuthorFailureResult('missing_ac_input: renderedAcSection and sourceEpicAcSection are required')
}
```

## Interface Contracts

- **Export**: `ProbeAuthorParams` @ `src/modules/compiled-workflows/types.ts`
- **Export**: `ProbeAuthorResult` @ `src/modules/compiled-workflows/types.ts`
- **Export**: `ProbeAuthorResultSchema` @ `src/modules/compiled-workflows/schemas.ts`
- **Export**: `runProbeAuthor` @ `src/modules/compiled-workflows/probe-author.ts`
- **Import**: `RuntimeProbeListSchema`, `RuntimeProbe` @ `@substrate-ai/sdlc` (from package, not internal path)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
