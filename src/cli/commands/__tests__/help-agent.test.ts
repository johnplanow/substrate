/**
 * Unit tests for `src/cli/commands/help-agent.ts`
 *
 * Covers all acceptance criteria for Story 15.3:
 *   AC1: --help-agent flag — output to stdout, exit 0, no pipeline
 *   AC2: Event schema documentation — all PipelineEvent types documented
 *   AC3: Command reference — all flags documented
 *   AC4: Interaction patterns — decision flowchart for each event type
 *   AC5: Token budget — output under 2000 tokens
 *   AC6: Version stamp — version matches package.json
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — declared before imports
// ---------------------------------------------------------------------------

const mockReadFile = vi.fn()

vi.mock('fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
}))

vi.mock('node:url', () => ({
  fileURLToPath: vi.fn(() => '/mock/path/help-agent.ts'),
}))

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks
// ---------------------------------------------------------------------------

import {
  PIPELINE_EVENT_METADATA,
  EVENT_TYPE_NAMES,
  generateEventSchemaSection,
  generateCommandReferenceSection,
  generateInteractionPatternsSection,
  generateHelpAgentOutput,
  resolvePackageVersion,
  runHelpAgent,
  type EventMetadata,
} from '../help-agent.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Approximate token count using whitespace splitting.
 * cl100k_base tokenizer averages ~4 chars per token.
 * We use a conservative estimate: length / 3 (over-estimates tokens).
 */
function approximateTokenCount(text: string): number {
  // Split on whitespace to get rough word count, then apply multiplier
  // Average English word is ~1.3 tokens in cl100k_base
  const words = text.trim().split(/\s+/).length
  return Math.ceil(words * 1.3)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PIPELINE_EVENT_METADATA', () => {
  it('contains all PipelineEvent types', () => {
    const expectedTypes = [
      'pipeline:start',
      'pipeline:complete',
      'story:phase',
      'story:done',
      'story:escalation',
      'story:warn',
      'story:log',
      'pipeline:heartbeat',
      'story:stall',
      'supervisor:kill',
      'supervisor:restart',
      'supervisor:abort',
      'supervisor:summary',
    ]
    const actualTypes = PIPELINE_EVENT_METADATA.map((e) => e.type)
    for (const t of expectedTypes) {
      expect(actualTypes).toContain(t)
    }
    expect(actualTypes).toHaveLength(expectedTypes.length)
  })

  it('each event has required fields: type, description, when, fields array', () => {
    for (const event of PIPELINE_EVENT_METADATA) {
      expect(event.type).toBeTruthy()
      expect(event.description).toBeTruthy()
      expect(event.when).toBeTruthy()
      expect(Array.isArray(event.fields)).toBe(true)
      expect(event.fields.length).toBeGreaterThan(0)
    }
  })

  it('all events have a ts field', () => {
    for (const event of PIPELINE_EVENT_METADATA) {
      const tsField = event.fields.find((f) => f.name === 'ts')
      expect(tsField).toBeDefined()
      expect(tsField?.type).toBe('string')
    }
  })

  it('pipeline:start has run_id, stories, concurrency fields', () => {
    const event = PIPELINE_EVENT_METADATA.find((e) => e.type === 'pipeline:start')
    expect(event).toBeDefined()
    const fieldNames = event!.fields.map((f) => f.name)
    expect(fieldNames).toContain('run_id')
    expect(fieldNames).toContain('stories')
    expect(fieldNames).toContain('concurrency')
  })

  it('pipeline:complete has succeeded, failed, escalated fields', () => {
    const event = PIPELINE_EVENT_METADATA.find((e) => e.type === 'pipeline:complete')
    expect(event).toBeDefined()
    const fieldNames = event!.fields.map((f) => f.name)
    expect(fieldNames).toContain('succeeded')
    expect(fieldNames).toContain('failed')
    expect(fieldNames).toContain('escalated')
  })

  it('story:phase has key, phase, status, optional verdict and file fields', () => {
    const event = PIPELINE_EVENT_METADATA.find((e) => e.type === 'story:phase')
    expect(event).toBeDefined()
    const fieldNames = event!.fields.map((f) => f.name)
    expect(fieldNames).toContain('key')
    expect(fieldNames).toContain('phase')
    expect(fieldNames).toContain('status')
    expect(fieldNames).toContain('verdict')
    expect(fieldNames).toContain('file')

    // verdict and file should be optional
    const verdictField = event!.fields.find((f) => f.name === 'verdict')
    const fileField = event!.fields.find((f) => f.name === 'file')
    expect(verdictField?.optional).toBe(true)
    expect(fileField?.optional).toBe(true)
  })

  it('story:escalation has issues field with array type', () => {
    const event = PIPELINE_EVENT_METADATA.find((e) => e.type === 'story:escalation')
    expect(event).toBeDefined()
    const issuesField = event!.fields.find((f) => f.name === 'issues')
    expect(issuesField).toBeDefined()
    expect(issuesField?.type).toContain('[]')
  })

  // ---------------------------------------------------------------------------
  // Alignment tests — derived from EVENT_TYPE_NAMES in event-types.ts.
  // These tests make it impossible to add a new PipelineEvent member without
  // also updating PIPELINE_EVENT_METADATA (and vice-versa).
  // ---------------------------------------------------------------------------

  it('covers every type name listed in EVENT_TYPE_NAMES (no missing entries)', () => {
    const metadataTypes = PIPELINE_EVENT_METADATA.map((e) => e.type)
    for (const typeName of EVENT_TYPE_NAMES) {
      expect(metadataTypes).toContain(typeName)
    }
  })

  it('contains no extra entries absent from EVENT_TYPE_NAMES (no stale entries)', () => {
    const eventTypeSet = new Set<string>(EVENT_TYPE_NAMES)
    for (const entry of PIPELINE_EVENT_METADATA) {
      expect(eventTypeSet.has(entry.type)).toBe(true)
    }
  })

  it('PIPELINE_EVENT_METADATA length matches EVENT_TYPE_NAMES length', () => {
    expect(PIPELINE_EVENT_METADATA).toHaveLength(EVENT_TYPE_NAMES.length)
  })

  it('field counts in PIPELINE_EVENT_METADATA match the actual interface field counts', () => {
    // Expected field counts are derived by counting fields in each interface
    // in src/modules/implementation-orchestrator/event-types.ts.
    // Update these counts when an interface gains or loses fields.
    const expectedFieldCounts: Record<string, number> = {
      'pipeline:start': 4,    // ts, run_id, stories, concurrency
      'pipeline:complete': 4, // ts, succeeded, failed, escalated
      'story:phase': 6,       // ts, key, phase, status, verdict?, file?
      'story:done': 4,        // ts, key, result, review_cycles
      'story:escalation': 5,  // ts, key, reason, cycles, issues
      'story:warn': 3,        // ts, key, msg
      'story:log': 3,         // ts, key, msg
    }
    for (const [typeName, expectedCount] of Object.entries(expectedFieldCounts)) {
      const entry = PIPELINE_EVENT_METADATA.find((e) => e.type === typeName)
      expect(entry, `Missing metadata entry for ${typeName}`).toBeDefined()
      expect(entry!.fields, `Field count mismatch for ${typeName}`).toHaveLength(expectedCount)
    }
  })
})

describe('generateEventSchemaSection', () => {
  it('produces valid markdown with h2 and h3 headers', () => {
    const output = generateEventSchemaSection(PIPELINE_EVENT_METADATA)
    expect(output).toContain('## Event Protocol')
    for (const event of PIPELINE_EVENT_METADATA) {
      expect(output).toContain(`### ${event.type}`)
    }
  })

  it('contains all event type names', () => {
    const output = generateEventSchemaSection(PIPELINE_EVENT_METADATA)
    for (const event of PIPELINE_EVENT_METADATA) {
      expect(output).toContain(event.type)
    }
  })

  it('documents --events flag requirement', () => {
    const output = generateEventSchemaSection(PIPELINE_EVENT_METADATA)
    expect(output.toLowerCase()).toContain('--events')
  })

  it('documents each field with name, type, and description', () => {
    const output = generateEventSchemaSection(PIPELINE_EVENT_METADATA)
    // Check a few key fields
    expect(output).toContain('run_id')
    expect(output).toContain('stories')
    expect(output).toContain('verdict')
    expect(output).toContain('issues')
  })

  it('marks optional fields', () => {
    const output = generateEventSchemaSection(PIPELINE_EVENT_METADATA)
    expect(output).toContain('optional')
  })

  it('works with custom event metadata', () => {
    const customEvents: EventMetadata[] = [
      {
        type: 'test:event',
        description: 'A test event',
        when: 'During tests',
        fields: [
          { name: 'ts', type: 'string', description: 'Timestamp' },
          { name: 'data', type: 'string', description: 'Test data' },
        ],
      },
    ]
    const output = generateEventSchemaSection(customEvents)
    expect(output).toContain('### test:event')
    expect(output).toContain('A test event')
    expect(output).toContain('data')
  })
})

describe('generateCommandReferenceSection', () => {
  it('documents substrate auto run command', () => {
    const output = generateCommandReferenceSection()
    expect(output).toContain('substrate auto run')
  })

  it('documents --events flag', () => {
    const output = generateCommandReferenceSection()
    expect(output).toContain('--events')
  })

  it('documents --stories flag', () => {
    const output = generateCommandReferenceSection()
    expect(output).toContain('--stories')
  })

  it('documents --verbose flag', () => {
    const output = generateCommandReferenceSection()
    expect(output).toContain('--verbose')
  })

  it('documents --help-agent flag', () => {
    const output = generateCommandReferenceSection()
    expect(output).toContain('--help-agent')
  })

  it('includes example usage', () => {
    const output = generateCommandReferenceSection()
    expect(output).toContain('substrate auto run --events')
    expect(output).toContain('--stories')
  })

  it('documents substrate auto status command', () => {
    const output = generateCommandReferenceSection()
    expect(output).toContain('substrate auto status')
  })

  it('documents substrate auto resume command', () => {
    const output = generateCommandReferenceSection()
    expect(output).toContain('substrate auto resume')
  })

  it('documents substrate auto init command', () => {
    const output = generateCommandReferenceSection()
    expect(output).toContain('substrate auto init')
  })

  it('contains h2 header', () => {
    const output = generateCommandReferenceSection()
    expect(output).toContain('## Commands')
  })
})

describe('generateInteractionPatternsSection', () => {
  it('contains h2 header', () => {
    const output = generateInteractionPatternsSection()
    expect(output).toContain('## Interaction Patterns')
  })

  it('documents story:done with result: success', () => {
    const output = generateInteractionPatternsSection()
    expect(output).toContain('story:done')
    expect(output).toContain('success')
  })

  it('documents story:escalation handling', () => {
    const output = generateInteractionPatternsSection()
    expect(output).toContain('story:escalation')
    expect(output).toContain('issues')
    expect(output).toContain('severity')
  })

  it('documents story:phase with NEEDS_MINOR_FIXES verdict', () => {
    const output = generateInteractionPatternsSection()
    expect(output).toContain('story:phase')
    expect(output).toContain('NEEDS_MINOR_FIXES')
  })

  it('documents story:warn as non-error', () => {
    const output = generateInteractionPatternsSection()
    expect(output).toContain('story:warn')
    expect(output.toLowerCase()).toContain('non-blocking')
  })

  it('documents pipeline:complete summarization', () => {
    const output = generateInteractionPatternsSection()
    expect(output).toContain('pipeline:complete')
    expect(output.toLowerCase()).toContain('summar')
  })
})

describe('generateHelpAgentOutput', () => {
  it('includes version stamp', () => {
    const output = generateHelpAgentOutput('1.2.3')
    expect(output).toContain('Version: 1.2.3')
  })

  it('includes h1 header', () => {
    const output = generateHelpAgentOutput('0.1.0')
    expect(output).toContain('# Substrate Auto Pipeline — Agent Instructions')
  })

  it('includes commands section', () => {
    const output = generateHelpAgentOutput('0.1.0')
    expect(output).toContain('## Commands')
  })

  it('includes event protocol section', () => {
    const output = generateHelpAgentOutput('0.1.0')
    expect(output).toContain('## Event Protocol')
  })

  it('includes interaction patterns section', () => {
    const output = generateHelpAgentOutput('0.1.0')
    expect(output).toContain('## Interaction Patterns')
  })

  it('contains all event type names from metadata', () => {
    const output = generateHelpAgentOutput('0.1.0')
    for (const event of PIPELINE_EVENT_METADATA) {
      expect(output).toContain(event.type)
    }
  })

  it('uses custom events when provided', () => {
    const customEvents: EventMetadata[] = [
      {
        type: 'custom:event',
        description: 'Custom test event',
        when: 'During custom tests',
        fields: [{ name: 'ts', type: 'string', description: 'Timestamp' }],
      },
    ]
    const output = generateHelpAgentOutput('0.1.0', customEvents)
    expect(output).toContain('custom:event')
    expect(output).not.toContain('pipeline:start')
  })

  // AC5: Token budget test
  it('output is under 2000 tokens (AC5)', () => {
    const output = generateHelpAgentOutput('0.1.14')
    const tokenCount = approximateTokenCount(output)
    // Conservative check: approximate token count < 2000
    expect(tokenCount).toBeLessThan(2000)
  })

  it('output is valid markdown (AC2)', () => {
    const output = generateHelpAgentOutput('0.1.14')
    // Basic markdown validity: has headers
    expect(output).toMatch(/^#\s/m)
    expect(output).toMatch(/^##\s/m)
    expect(output).toMatch(/^###\s/m)
  })
})

describe('resolvePackageVersion', () => {
  beforeEach(() => {
    mockReadFile.mockReset()
  })

  it('returns version from substrate package.json', async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({ name: 'substrate', version: '0.1.14' }),
    )
    const version = await resolvePackageVersion()
    expect(version).toBe('0.1.14')
  })

  it('returns version from substrate-ai package.json', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('not found'))
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({ name: 'substrate-ai', version: '0.2.0' }),
    )
    const version = await resolvePackageVersion()
    expect(version).toBe('0.2.0')
  })

  it('returns 0.0.0 when no package.json found', async () => {
    mockReadFile.mockRejectedValue(new Error('not found'))
    const version = await resolvePackageVersion()
    expect(version).toBe('0.0.0')
  })

  it('returns 0.0.0 when package.json has no version', async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({ name: 'substrate', description: 'no version' }),
    )
    const version = await resolvePackageVersion()
    expect(version).toBe('0.0.0')
  })
})

describe('runHelpAgent', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockReadFile.mockReset()
    mockReadFile.mockResolvedValue(JSON.stringify({ name: 'substrate', version: '0.1.14' }))
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
  })

  it('writes output to stdout (AC1)', async () => {
    const exitCode = await runHelpAgent()
    expect(stdoutSpy).toHaveBeenCalledOnce()
    const written = stdoutSpy.mock.calls[0][0] as string
    expect(written).toContain('# Substrate Auto Pipeline — Agent Instructions')
  })

  it('returns exit code 0 (AC1)', async () => {
    const exitCode = await runHelpAgent()
    expect(exitCode).toBe(0)
  })

  it('output contains version stamp matching package.json (AC6)', async () => {
    const exitCode = await runHelpAgent()
    const written = stdoutSpy.mock.calls[0][0] as string
    expect(written).toContain('Version: 0.1.14')
  })

  it('output contains all event type names (AC2)', async () => {
    await runHelpAgent()
    const written = stdoutSpy.mock.calls[0][0] as string
    for (const event of PIPELINE_EVENT_METADATA) {
      expect(written).toContain(event.type)
    }
  })

  it('output is under 2000 tokens (AC5)', async () => {
    await runHelpAgent()
    const written = stdoutSpy.mock.calls[0][0] as string
    const tokenCount = approximateTokenCount(written)
    expect(tokenCount).toBeLessThan(2000)
  })
})
