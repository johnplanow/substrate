# Story 48-9: Output Truncation — Two-Phase Algorithm

## Story

As a coding agent session,
I want a two-phase output truncation pipeline (Phase 1 character-based, Phase 2 line-based) applied to tool output before it is sent to the LLM,
so that large tool outputs fit within LLM context windows while preserving the most relevant content and allowing host applications to tune truncation behavior per tool.

## Acceptance Criteria

### AC1: Phase 1 — head_tail Character Truncation
**Given** `truncateToolOutput` is called with a 100,000-character output and a 10,000-character limit in `head_tail` mode (the default)
**When** Phase 1 applies character-based truncation
**Then** the result contains the first 5,000 characters, followed by a `\n\n[... 90000 characters truncated from middle. Full output available in event stream.]\n\n` marker, followed by the last 5,000 characters; the total character count is approximately 10,000 + marker length; the `removed` value in the marker equals `output.length - limit`

### AC2: Phase 1 — tail Mode Character Truncation
**Given** `truncateToolOutput` is called with output exceeding the character limit and `SessionConfig.truncation_mode` set to `'tail'`
**When** Phase 1 applies character-based truncation in tail mode
**Then** the result contains only the last `limit` characters from the original output — no head content, no truncation marker; output shorter than the limit is returned unchanged

### AC3: Phase 2 — Line-Based Truncation Applied After Phase 1
**Given** `truncateToolOutput` is called with output that after Phase 1 still contains more lines than `SessionConfig.max_output_lines` (default 500)
**When** Phase 2 applies line-based truncation
**Then** in `head_tail` mode, the result is trimmed so that `ceil(max_output_lines / 2)` lines are kept from the head and `floor(max_output_lines / 2)` lines from the tail, separated by a `\n[... N lines truncated from middle ...]\n` marker where N is the removed line count; in `tail` mode, only the last `max_output_lines` lines are kept with no marker; if the line count is within the limit, Phase 2 is a no-op

### AC4: Per-Tool Character Limits Applied Correctly
**Given** `DEFAULT_TOOL_LIMITS` is exported from `truncation.ts` with values `read_file: 50000`, `shell: 30000`, `grep: 20000`, `glob: 20000` and a fallback of 10,000 for all other tools
**When** `truncateToolOutput` is called without an explicit override in `config.tool_output_limits`
**Then** the correct per-tool default is applied; a custom tool not listed in `DEFAULT_TOOL_LIMITS` falls back to 10,000 characters; `config.tool_output_limits.get(toolName)` overrides the default when present

### AC5: SessionConfig Extended with Truncation Fields
**Given** `packages/factory/src/agent/types.ts` is imported
**When** a `SessionConfig` is constructed
**Then** it includes `truncation_mode: 'head_tail' | 'tail'` (default `'head_tail'`) and `max_output_lines: number` (default `500`); `createSession` resolves both fields in the config defaults block alongside the existing fields

### AC6: Output Within All Limits Returned Unchanged
**Given** `truncateToolOutput` is called with output whose character count is at or below the per-tool character limit AND whose line count is at or below `max_output_lines`
**When** both phases run
**Then** the original string is returned unchanged — no markers, no modifications; if Phase 1 removes content but the result has fewer lines than `max_output_lines`, Phase 2 is a no-op

### AC7: `DEFAULT_LINE_LIMIT` Constant Exported and Used as Default
**Given** `truncation.ts` is imported
**When** the module is loaded
**Then** `DEFAULT_LINE_LIMIT = 500` is exported as a named constant; `truncateToolOutput` uses `config.max_output_lines ?? DEFAULT_LINE_LIMIT` to resolve the effective line limit, ensuring callers can omit the field and still get 500-line enforcement

## Tasks / Subtasks

- [ ] Task 1: Extend `SessionConfig` in `packages/factory/src/agent/types.ts` (AC: #5, #7)
  - [ ] Add `truncation_mode: 'head_tail' | 'tail'` field to `SessionConfig` interface (default `'head_tail'`)
  - [ ] Add `max_output_lines: number` field to `SessionConfig` interface (default `500`)
  - [ ] Ensure the `createSession` default-resolution block in `loop.ts` includes both new fields with their defaults (e.g., `truncation_mode: options.config?.truncation_mode ?? 'head_tail'`, `max_output_lines: options.config?.max_output_lines ?? DEFAULT_LINE_LIMIT`)

- [ ] Task 2: Implement Phase 1 character truncation in `packages/factory/src/agent/truncation.ts` (AC: #1, #2, #4)
  - [ ] Export `DEFAULT_TOOL_LIMITS` const: `{ read_file: 50000, shell: 30000, grep: 20000, glob: 20000 }` — keep existing values from story 48-7; do NOT change shell to 10,000
  - [ ] Export `DEFAULT_FALLBACK_CHAR_LIMIT = 10_000` for unlisted tools
  - [ ] Implement private/unexported helper `truncateByChars(output: string, limit: number, mode: 'head_tail' | 'tail'): string`:
    - If `output.length <= limit`, return unchanged
    - `tail` mode: return `output.slice(-limit)` (no marker)
    - `head_tail` mode: `half = Math.floor(limit / 2)`; `removed = output.length - limit`; return `output.slice(0, half) + \n\n[... ${removed} characters truncated from middle. Full output available in event stream.]\n\n + output.slice(-half)`
  - [ ] Resolve character limit: `config.tool_output_limits.get(toolName) ?? DEFAULT_TOOL_LIMITS[toolName as keyof typeof DEFAULT_TOOL_LIMITS] ?? DEFAULT_FALLBACK_CHAR_LIMIT`

- [ ] Task 3: Implement Phase 2 line-based truncation in `packages/factory/src/agent/truncation.ts` (AC: #3, #7)
  - [ ] Export `DEFAULT_LINE_LIMIT = 500`
  - [ ] Implement private/unexported helper `truncateByLines(output: string, maxLines: number, mode: 'head_tail' | 'tail'): string`:
    - Split on `\n`: `const lines = output.split('\n')`
    - If `lines.length <= maxLines`, return unchanged
    - `tail` mode: return `lines.slice(-maxLines).join('\n')`
    - `head_tail` mode: `headCount = Math.ceil(maxLines / 2)`, `tailCount = Math.floor(maxLines / 2)`, `removed = lines.length - maxLines`
    - Return `lines.slice(0, headCount).join('\n') + \n[... ${removed} lines truncated from middle ...]\n + lines.slice(-tailCount).join('\n')`

- [ ] Task 4: Compose two-phase pipeline in `truncateToolOutput` (AC: #1, #2, #3, #4, #5, #6)
  - [ ] Replace the single-phase implementation from story 48-7 with the two-phase version
  - [ ] Signature remains: `export function truncateToolOutput(output: string, toolName: string, config: SessionConfig): string`
  - [ ] Resolve `mode = config.truncation_mode ?? 'head_tail'` and `maxLines = config.max_output_lines ?? DEFAULT_LINE_LIMIT`
  - [ ] Apply Phase 1: `const afterPhase1 = truncateByChars(output, charLimit, mode)`
  - [ ] Apply Phase 2: `const afterPhase2 = truncateByLines(afterPhase1, maxLines, mode)`
  - [ ] Return `afterPhase2`
  - [ ] Verify that if both limits are satisfied, the original string is returned by reference equality (no unnecessary allocation)

- [ ] Task 5: Update `packages/factory/src/agent/index.ts` barrel exports (AC: all)
  - [ ] Ensure `export * from './truncation.js'` is present in `agent/index.ts` so `DEFAULT_TOOL_LIMITS`, `DEFAULT_LINE_LIMIT`, `DEFAULT_FALLBACK_CHAR_LIMIT`, and `truncateToolOutput` are all re-exported
  - [ ] Verify `packages/factory/src/index.ts` re-exports `'./agent/index.js'` (no change needed if 48-7 already added it)

- [ ] Task 6: Write unit tests for Phase 1 in `packages/factory/src/agent/__tests__/truncation.test.ts` (AC: #1, #2, #4, #6)
  - [ ] Extend or replace tests from story 48-7 — this file is owned by 48-9 post-handoff
  - [ ] `head_tail` mode: output at exactly the limit returns unchanged
  - [ ] `head_tail` mode: output 10× over limit produces head + marker + tail; verify marker contains correct `removed` count
  - [ ] `tail` mode: output 10× over limit returns only last `limit` chars with no marker
  - [ ] Per-tool default lookup: `read_file` uses 50,000; `shell` uses 30,000; `grep` uses 20,000; `glob` uses 20,000; unknown tool uses 10,000
  - [ ] Config override: `tool_output_limits.set('shell', 5000)` applies 5,000 instead of 30,000
  - [ ] Output within limit in both phases: returned unchanged (exact reference equality via `toBe`)
  - [ ] `DEFAULT_TOOL_LIMITS` is exported and has the expected keys and values

- [ ] Task 7: Write unit tests for Phase 2 in `packages/factory/src/agent/__tests__/truncation.test.ts` (AC: #3, #5, #6, #7)
  - [ ] Phase 2 no-op: 499-line output with `max_output_lines: 500` is returned unchanged after Phase 2
  - [ ] Phase 2 `head_tail` mode: 1,000-line output with `max_output_lines: 500` keeps first 250 + marker + last 250; marker reports 500 removed lines
  - [ ] Phase 2 `tail` mode: 1,000-line output with `max_output_lines: 500` keeps last 500 lines only; no marker present
  - [ ] Two-phase combined: 200,000-char, 2,000-line output with default config (10K char limit, 500 line limit, head_tail mode) applies both phases in sequence; result fits within both limits
  - [ ] `DEFAULT_LINE_LIMIT` is exported and equals 500
  - [ ] `max_output_lines` field on SessionConfig is respected when non-default value provided (e.g., 100-line limit)
  - [ ] Phase 1 marker lines are counted as part of the line count for Phase 2 (marker is ~1–2 lines); verify combined output respects `max_output_lines` after Phase 2

## Dev Notes

### Architecture Constraints
- **ESM imports**: all imports within `packages/factory/` MUST use `.js` extensions (e.g., `import type { SessionConfig } from './types.js'`)
- **Named exports only** — no default exports in any file
- **ADR-003**: `packages/factory` MUST NOT import from `packages/sdlc` or the sdlc entry point; no cross-package imports are needed for this story
- **Story 48-7 pre-created `truncation.ts`** with a single-phase head/tail implementation. This story **replaces** that implementation with the two-phase version. The function signature `truncateToolOutput(output, toolName, config)` must be preserved for backward compatibility with `loop.ts` from 48-7.
- **Story 48-7 pre-created `truncation.test.ts`** with ≥5 basic test cases. This story extends or replaces those tests. The dev agent should overwrite the test file with the comprehensive suite from Tasks 6–7 (which subsumes the 48-7 tests).
- **`DEFAULT_TOOL_LIMITS` in 48-7**: the story 48-7 task specified `shell: 30000` (30K). The Epic 48 planning doc mentions "shell 10K" as a per-tool default. **Use 30,000 for shell** per 48-7's established contract — do NOT change it to 10,000. The planning doc reference was approximate shorthand.
- **`SessionConfig` is defined in `types.ts`** (created by story 48-7). The `createSession` factory in `loop.ts` resolves defaults. This story adds two fields to `SessionConfig` and must also update the defaults block in `createSession`. Check that story 48-8 did not already add these fields before adding them.

### Key File Locations
- **Modify**: `packages/factory/src/agent/truncation.ts` — replace single-phase with two-phase algorithm; add `DEFAULT_LINE_LIMIT`, `DEFAULT_FALLBACK_CHAR_LIMIT`
- **Modify**: `packages/factory/src/agent/types.ts` — add `truncation_mode` and `max_output_lines` to `SessionConfig`
- **Modify**: `packages/factory/src/agent/loop.ts` — add `truncation_mode` and `max_output_lines` to default resolution in `createSession`
- **Modify**: `packages/factory/src/agent/index.ts` — ensure `truncation.ts` exports are re-exported
- **Modify**: `packages/factory/src/agent/__tests__/truncation.test.ts` — extend/replace with comprehensive two-phase tests

### Truncation Algorithm Reference

**Phase 1 (character-based):**
```
FUNCTION phase1(output, toolName, config):
    limit = config.tool_output_limits.get(toolName)
          ?? DEFAULT_TOOL_LIMITS[toolName]
          ?? DEFAULT_FALLBACK_CHAR_LIMIT
    IF output.length <= limit: RETURN output
    IF config.truncation_mode == 'tail':
        RETURN output.slice(-limit)
    ELSE (head_tail):
        half = floor(limit / 2)
        removed = output.length - limit
        RETURN output[0..half]
             + "\n\n[... {removed} characters truncated from middle. Full output available in event stream.]\n\n"
             + output[-half..]
```

**Phase 2 (line-based):**
```
FUNCTION phase2(output, config):
    maxLines = config.max_output_lines ?? DEFAULT_LINE_LIMIT
    lines = output.split('\n')
    IF lines.length <= maxLines: RETURN output
    IF config.truncation_mode == 'tail':
        RETURN lines[-maxLines..].join('\n')
    ELSE (head_tail):
        headCount = ceil(maxLines / 2)
        tailCount = floor(maxLines / 2)
        removed = lines.length - maxLines
        RETURN lines[0..headCount].join('\n')
             + "\n[... {removed} lines truncated from middle ...]\n"
             + lines[-tailCount..].join('\n')
```

**Composed pipeline:**
```typescript
export function truncateToolOutput(
  output: string,
  toolName: string,
  config: SessionConfig
): string {
  const afterPhase1 = truncateByChars(output, resolveCharLimit(toolName, config), config.truncation_mode ?? 'head_tail')
  return truncateByLines(afterPhase1, config.max_output_lines ?? DEFAULT_LINE_LIMIT, config.truncation_mode ?? 'head_tail')
}
```

### SessionConfig Extension Pattern
```typescript
// In types.ts — add to existing SessionConfig:
export interface SessionConfig {
  // ... existing fields from 48-7 ...
  truncation_mode: 'head_tail' | 'tail'   // NEW: default 'head_tail'
  max_output_lines: number                  // NEW: default 500
}

// In loop.ts createSession defaults block — add:
truncation_mode: options.config?.truncation_mode ?? 'head_tail',
max_output_lines: options.config?.max_output_lines ?? DEFAULT_LINE_LIMIT,
```

Import `DEFAULT_LINE_LIMIT` in `loop.ts`: `import { DEFAULT_LINE_LIMIT } from './truncation.js'`

### Testing Requirements
- Use vitest (`describe`, `it`, `expect`, `vi`, `beforeEach`)
- No mocking needed — `truncateToolOutput` is pure computation (no I/O, no dependencies beyond `SessionConfig`)
- Build minimal `SessionConfig` stubs for tests: only the fields used by `truncateToolOutput` need to be populated; use an empty `new Map()` for `tool_output_limits` when not testing overrides
- Test edge cases: empty string, exactly-at-limit string, single-character over limit, output that is exactly `maxLines` lines
- Run with `npm run test:fast` (timeout 300000ms) — never pipe output

### Key Imports Pattern
```typescript
import type { SessionConfig } from './types.js'

export const DEFAULT_TOOL_LIMITS = {
  read_file: 50_000,
  shell: 30_000,
  grep: 20_000,
  glob: 20_000,
} as const

export const DEFAULT_FALLBACK_CHAR_LIMIT = 10_000
export const DEFAULT_LINE_LIMIT = 500

export function truncateToolOutput(
  output: string,
  toolName: string,
  config: SessionConfig
): string { ... }
```

## Interface Contracts

- **Import**: `SessionConfig` @ `packages/factory/src/agent/types.ts` (from story 48-7; this story extends it)
- **Export**: `truncateToolOutput` @ `packages/factory/src/agent/truncation.ts` (consumed by story 48-7 loop.ts; signature unchanged)
- **Export**: `DEFAULT_TOOL_LIMITS`, `DEFAULT_LINE_LIMIT`, `DEFAULT_FALLBACK_CHAR_LIMIT` @ `packages/factory/src/agent/truncation.ts` (consumed by story 48-10 `DirectCodergenBackend` for config validation)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
