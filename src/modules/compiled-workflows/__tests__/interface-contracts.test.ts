/**
 * Unit tests for parseInterfaceContracts() — Interface Contracts parser.
 *
 * Covers AC2 (story file Interface Contracts section) and AC4 (contract
 * declaration schema: name, direction, filePath, storyKey, transport).
 */

import { describe, it, expect } from 'vitest'
import { parseInterfaceContracts } from '../interface-contracts.js'

// ---------------------------------------------------------------------------
// AC4: Test: story with exports and imports parses correctly
// ---------------------------------------------------------------------------

describe('parseInterfaceContracts: exports and imports', () => {
  it('parses a story with both exports and imports', () => {
    const storyContent = `# Story 25-4: Contract Declaration in Story Creation

Status: pending

## User Story

As a pipeline operator...

## Acceptance Criteria

AC1: Something useful

## Interface Contracts

- **Export**: JudgeResult @ src/modules/judge/types.ts (queue: judge-results)
- **Import**: CheckRunInput @ src/modules/check-publisher/types.ts (from story 25-5)

## Dev Notes

Some notes here.
`
    const result = parseInterfaceContracts(storyContent, '25-4')

    expect(result).toHaveLength(2)

    const exported = result.find((c) => c.direction === 'export')
    expect(exported).toBeDefined()
    expect(exported!.contractName).toBe('JudgeResult')
    expect(exported!.filePath).toBe('src/modules/judge/types.ts')
    expect(exported!.storyKey).toBe('25-4')
    expect(exported!.transport).toBe('queue: judge-results')

    const imported = result.find((c) => c.direction === 'import')
    expect(imported).toBeDefined()
    expect(imported!.contractName).toBe('CheckRunInput')
    expect(imported!.filePath).toBe('src/modules/check-publisher/types.ts')
    expect(imported!.storyKey).toBe('25-4')
    expect(imported!.transport).toBe('from story 25-5')
  })
})

// ---------------------------------------------------------------------------
// AC2/AC4: Test: story with no Interface Contracts section returns empty array
// ---------------------------------------------------------------------------

describe('parseInterfaceContracts: no section', () => {
  it('returns empty array when story has no Interface Contracts section', () => {
    const storyContent = `# Story 25-3: LGTM_WITH_NOTES Verdict

Status: pending

## User Story

As a pipeline operator...

## Acceptance Criteria

AC1: Something

## Dev Notes

No contracts here.
`
    const result = parseInterfaceContracts(storyContent, '25-3')
    expect(result).toEqual([])
  })

  it('returns empty array for empty string', () => {
    const result = parseInterfaceContracts('', '25-3')
    expect(result).toEqual([])
  })

  it('returns empty array for empty storyKey', () => {
    const storyContent = `## Interface Contracts\n- **Export**: Foo @ src/foo.ts\n`
    const result = parseInterfaceContracts(storyContent, '')
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// AC2/AC4: Test: story with only exports (no imports) works
// ---------------------------------------------------------------------------

describe('parseInterfaceContracts: only exports', () => {
  it('parses a story with only exports and no imports', () => {
    const storyContent = `# Story 25-5: Contract-Aware Dispatch

## Acceptance Criteria

AC1: Ordering matters

## Interface Contracts

- **Export**: DispatchOrder @ src/modules/orchestrator/types.ts

## Dev Notes

Notes.
`
    const result = parseInterfaceContracts(storyContent, '25-5')
    expect(result).toHaveLength(1)
    expect(result[0].direction).toBe('export')
    expect(result[0].contractName).toBe('DispatchOrder')
    expect(result[0].filePath).toBe('src/modules/orchestrator/types.ts')
    expect(result[0].storyKey).toBe('25-5')
    expect(result[0].transport).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AC4: Test: story with transport metadata parses correctly
// ---------------------------------------------------------------------------

describe('parseInterfaceContracts: transport metadata', () => {
  it('parses export with queue transport annotation', () => {
    const storyContent = `## Interface Contracts

- **Export**: JudgeResult @ src/modules/judge/types.ts (queue: judge-queue)
`
    const result = parseInterfaceContracts(storyContent, '4-5')
    expect(result).toHaveLength(1)
    expect(result[0].transport).toBe('queue: judge-queue')
  })

  it('parses import with "from story" annotation', () => {
    const storyContent = `## Interface Contracts

- **Import**: JudgeResult @ src/modules/check-publisher/consumer.ts (from story 4-5)
`
    const result = parseInterfaceContracts(storyContent, '4-6')
    expect(result).toHaveLength(1)
    expect(result[0].transport).toBe('from story 4-5')
  })

  it('parses export with api transport annotation', () => {
    const storyContent = `## Interface Contracts

- **Export**: CheckRunPayload @ src/modules/check/api.ts (api: /api/check-runs)
`
    const result = parseInterfaceContracts(storyContent, '4-7')
    expect(result).toHaveLength(1)
    expect(result[0].transport).toBe('api: /api/check-runs')
  })

  it('does not set transport when annotation is absent', () => {
    const storyContent = `## Interface Contracts

- **Export**: MySchema @ src/schema.ts
`
    const result = parseInterfaceContracts(storyContent, '1-1')
    expect(result).toHaveLength(1)
    expect(result[0].transport).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AC2: Test: malformed section returns empty array gracefully
// ---------------------------------------------------------------------------

describe('parseInterfaceContracts: malformed / edge cases', () => {
  it('returns empty array when Interface Contracts section has no valid bullet items', () => {
    const storyContent = `## Interface Contracts

This section has no properly-formatted bullets.
Just some random text here.
`
    const result = parseInterfaceContracts(storyContent, '1-1')
    expect(result).toEqual([])
  })

  it('stops parsing at the next ## heading after Interface Contracts', () => {
    const storyContent = `## Interface Contracts

- **Export**: SchemaA @ src/a.ts

## Dev Notes

- **Export**: SchemaB @ src/b.ts (this is in the wrong section)
`
    const result = parseInterfaceContracts(storyContent, '1-2')
    expect(result).toHaveLength(1)
    expect(result[0].contractName).toBe('SchemaA')
  })

  it('handles case-insensitive direction (Export vs export)', () => {
    // The format is **Export** with capital E — test that it parses correctly
    const storyContent = `## Interface Contracts

- **Export**: SchemaX @ src/x.ts
`
    const result = parseInterfaceContracts(storyContent, '1-3')
    expect(result).toHaveLength(1)
    expect(result[0].direction).toBe('export')
  })

  it('handles case-insensitive direction (Import vs import)', () => {
    const storyContent = `## Interface Contracts

- **Import**: SchemaY @ src/y.ts
`
    const result = parseInterfaceContracts(storyContent, '1-4')
    expect(result).toHaveLength(1)
    expect(result[0].direction).toBe('import')
  })

  it('returns empty array for content with no ## heading markers', () => {
    const result = parseInterfaceContracts('just some text', '1-5')
    expect(result).toEqual([])
  })

  it('parses multiple exports and multiple imports', () => {
    const storyContent = `## Interface Contracts

- **Export**: SchemaA @ src/a.ts (queue: a-queue)
- **Export**: SchemaB @ src/b.ts
- **Import**: SchemaC @ src/c.ts (from story 2-1)
- **Import**: SchemaD @ src/d.ts

## Tasks
`
    const result = parseInterfaceContracts(storyContent, '2-2')
    expect(result).toHaveLength(4)
    expect(result.filter((c) => c.direction === 'export')).toHaveLength(2)
    expect(result.filter((c) => c.direction === 'import')).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// AC4: Contract declaration shape matches schema spec
// ---------------------------------------------------------------------------

describe('parseInterfaceContracts: contract declaration schema', () => {
  it('each declaration includes contractName, direction, filePath, storyKey', () => {
    const storyContent = `## Interface Contracts

- **Export**: MySchema @ src/my/schema.ts
`
    const result = parseInterfaceContracts(storyContent, 'test-key')
    expect(result).toHaveLength(1)
    const decl = result[0]
    expect(typeof decl.contractName).toBe('string')
    expect(typeof decl.direction).toBe('string')
    expect(typeof decl.filePath).toBe('string')
    expect(typeof decl.storyKey).toBe('string')
    expect(decl.storyKey).toBe('test-key')
  })

  it('direction is strictly "export" or "import" (lowercase)', () => {
    const storyContent = `## Interface Contracts

- **Export**: A @ src/a.ts
- **Import**: B @ src/b.ts
`
    const result = parseInterfaceContracts(storyContent, '1-1')
    expect(result[0].direction).toBe('export')
    expect(result[1].direction).toBe('import')
  })
})
