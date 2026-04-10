/**
 * Unit tests for computeStoryComplexity(), resolveDevStoryMaxTurns(), resolveFixStoryMaxTurns(),
 * and logComplexityResult().
 *
 * Story 24-6 AC1-AC6 coverage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Logger mock — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockLoggerInfo = vi.hoisted(() => vi.fn())

vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: mockLoggerInfo,
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))

import {
  computeStoryComplexity,
  resolveDevStoryMaxTurns,
  resolveFixStoryMaxTurns,
  logComplexityResult,
} from '../story-complexity.js'
import type { StoryComplexity } from '../story-complexity.js'

// ---------------------------------------------------------------------------
// Helpers for building test markdown
// ---------------------------------------------------------------------------

function buildStoryMarkdown({
  tasks = 0,
  subtasksPerTask = 0,
  files = 0,
}: {
  tasks?: number
  subtasksPerTask?: number
  files?: number
}): string {
  const lines: string[] = ['# Story Test', '', '## Tasks / Subtasks', '']

  for (let t = 1; t <= tasks; t++) {
    lines.push(`- [ ] Task ${t}: Do thing ${t}`)
    for (let s = 1; s <= subtasksPerTask; s++) {
      lines.push(`  - [ ] Subtask ${s} of task ${t}`)
    }
  }

  if (files > 0) {
    lines.push('')
    lines.push('## File Layout')
    lines.push('')
    lines.push('```')
    for (let f = 1; f <= files; f++) {
      lines.push(`src/modules/example/file-${f}.ts`)
    }
    lines.push('```')
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// computeStoryComplexity tests
// ---------------------------------------------------------------------------

describe('computeStoryComplexity', () => {
  it('returns score 0 for empty content', () => {
    const result = computeStoryComplexity('')
    expect(result).toEqual<StoryComplexity>({
      taskCount: 0,
      subtaskCount: 0,
      fileCount: 0,
      complexityScore: 0,
    })
  })

  it('returns score 0 when no parseable sections exist', () => {
    const content = '# Story 1\n\nSome description without standard sections.\n'
    const result = computeStoryComplexity(content)
    expect(result).toEqual<StoryComplexity>({
      taskCount: 0,
      subtaskCount: 0,
      fileCount: 0,
      complexityScore: 0,
    })
  })

  it('counts 3 tasks, 6 subtasks, 4 files → score 8', () => {
    // 3 tasks + 6 * 0.5 + 4 * 0.5 = 3 + 3 + 2 = 8
    const content = buildStoryMarkdown({ tasks: 3, subtasksPerTask: 2, files: 4 })
    const result = computeStoryComplexity(content)
    expect(result.taskCount).toBe(3)
    expect(result.subtaskCount).toBe(6)
    expect(result.fileCount).toBe(4)
    expect(result.complexityScore).toBe(8)
  })

  it('counts 8 tasks, 20 subtasks, 15 files → score 26', () => {
    // 8 + 20 * 0.5 + 15 * 0.5 = 8 + 10 + 7.5 = 25.5 → Math.round = 26
    // Build with varying subtasks per task: 20 total across 8 tasks
    // Easier: build manually
    const lines: string[] = ['# Story Test', '', '## Tasks / Subtasks', '']
    for (let t = 1; t <= 8; t++) {
      lines.push(`- [ ] Task ${t}: Do thing ${t}`)
      // ~2-3 subtasks each to get 20 total
      const subs = t <= 4 ? 3 : 2 // 4*3 + 4*2 = 12+8 = 20
      for (let s = 1; s <= subs; s++) {
        lines.push(`  - [ ] Subtask ${s}`)
      }
    }
    lines.push('')
    lines.push('## File Layout')
    lines.push('')
    lines.push('```')
    for (let f = 1; f <= 15; f++) {
      lines.push(`src/modules/example/file-${f}.ts`)
    }
    lines.push('```')
    const content = lines.join('\n')

    const result = computeStoryComplexity(content)
    expect(result.taskCount).toBe(8)
    expect(result.subtaskCount).toBe(20)
    expect(result.fileCount).toBe(15)
    expect(result.complexityScore).toBe(26)
  })

  it('counts only top-level Task N: lines, not generic - [ ] lines', () => {
    const content = [
      '## Tasks',
      '',
      '- [ ] Task 1: First task',
      '- [ ] Task 2: Second task',
      '- [ ] Some other checklist item (not a task)',
      '  - [ ] Nested item under other checklist',
    ].join('\n')

    const result = computeStoryComplexity(content)
    expect(result.taskCount).toBe(2)
    // Subtask count: only the indented one
    expect(result.subtaskCount).toBe(1)
  })

  it('handles File Layout with multiple file extensions', () => {
    const content = [
      '## File Layout',
      '',
      '```',
      'src/foo.ts',
      'src/bar.js',
      'config/settings.json',
      'migrations/001.sql',
      'infra/deploy.yaml',
      'docs/readme.md',
      'src/foo.test.ts', // test file counts too
      '```',
    ].join('\n')

    const result = computeStoryComplexity(content)
    expect(result.fileCount).toBe(7)
  })

  it('returns 0 fileCount when no File Layout section exists', () => {
    const content = ['## Dev Notes', '- New: `src/foo.ts`', '- Modify: `src/bar.ts`'].join('\n')

    const result = computeStoryComplexity(content)
    expect(result.fileCount).toBe(0)
  })

  it('returns 0 fileCount when File Layout section has no fenced code block', () => {
    const content = ['## File Layout', '', '- src/foo.ts', '- src/bar.ts'].join('\n')

    const result = computeStoryComplexity(content)
    expect(result.fileCount).toBe(0)
  })

  it('rounds fractional scores to nearest integer', () => {
    // 1 task + 1 subtask * 0.5 + 1 file * 0.5 = 1 + 0.5 + 0.5 = 2.0
    const content = buildStoryMarkdown({ tasks: 1, subtasksPerTask: 1, files: 1 })
    const result = computeStoryComplexity(content)
    expect(result.complexityScore).toBe(2)
    expect(Number.isInteger(result.complexityScore)).toBe(true)
  })

  it('rounds up at .5 (odd subtask/file counts)', () => {
    // 1 task + 3 subtasks * 0.5 + 1 file * 0.5 = 1 + 1.5 + 0.5 = 3
    const content = buildStoryMarkdown({ tasks: 1, subtasksPerTask: 3, files: 1 })
    const result = computeStoryComplexity(content)
    expect(result.complexityScore).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// resolveDevStoryMaxTurns tests
// ---------------------------------------------------------------------------

describe('resolveDevStoryMaxTurns', () => {
  it('returns 75 for score 0 (default, no parseable sections)', () => {
    expect(resolveDevStoryMaxTurns(0)).toBe(75)
  })

  it('returns 75 for score 8 (3 tasks, 6 subtasks, 4 files)', () => {
    expect(resolveDevStoryMaxTurns(8)).toBe(75)
  })

  it('returns 75 for score exactly 10 (boundary)', () => {
    expect(resolveDevStoryMaxTurns(10)).toBe(75)
  })

  it('returns 85 for score 11 (+10 per point above 10)', () => {
    expect(resolveDevStoryMaxTurns(11)).toBe(85)
  })

  it('returns 200 for score 26 (8 tasks, 20 subtasks, 15 files → capped)', () => {
    // 75 + (26 - 10) * 10 = 75 + 160 = 235 → capped at 200
    expect(resolveDevStoryMaxTurns(26)).toBe(200)
  })

  it('caps at 200 for very large scores', () => {
    expect(resolveDevStoryMaxTurns(100)).toBe(200)
    expect(resolveDevStoryMaxTurns(1000)).toBe(200)
  })

  it('handles score exactly at cap boundary (score 22: 75+120=195)', () => {
    expect(resolveDevStoryMaxTurns(22)).toBe(195)
  })
})

// ---------------------------------------------------------------------------
// resolveFixStoryMaxTurns tests
// ---------------------------------------------------------------------------

describe('resolveFixStoryMaxTurns', () => {
  it('returns 50 for score 0 (base for fix-story)', () => {
    expect(resolveFixStoryMaxTurns(0)).toBe(50)
  })

  it('returns 50 for score 8 (below threshold)', () => {
    expect(resolveFixStoryMaxTurns(8)).toBe(50)
  })

  it('returns 50 for score exactly 10', () => {
    expect(resolveFixStoryMaxTurns(10)).toBe(50)
  })

  it('returns 60 for score 11', () => {
    expect(resolveFixStoryMaxTurns(11)).toBe(60)
  })

  it('caps at 150 for large scores', () => {
    // 50 + (26 - 10) * 10 = 50 + 160 = 210 → capped at 150
    expect(resolveFixStoryMaxTurns(26)).toBe(150)
    expect(resolveFixStoryMaxTurns(100)).toBe(150)
  })

  it('is different from dev-story for same score (lower base and cap)', () => {
    const devTurns = resolveDevStoryMaxTurns(15)
    const fixTurns = resolveFixStoryMaxTurns(15)
    expect(fixTurns).toBeLessThan(devTurns)
    expect(fixTurns).toBe(100) // 50 + (15-10)*10 = 100
    expect(devTurns).toBe(125) // 75 + (15-10)*10 = 125
  })
})

// ---------------------------------------------------------------------------
// logComplexityResult tests (AC6)
// ---------------------------------------------------------------------------

describe('logComplexityResult', () => {
  beforeEach(() => {
    mockLoggerInfo.mockClear()
  })

  it('logs info with all required fields: storyKey, taskCount, subtaskCount, fileCount, complexityScore, resolvedMaxTurns', () => {
    const complexity: StoryComplexity = {
      taskCount: 3,
      subtaskCount: 6,
      fileCount: 4,
      complexityScore: 8,
    }
    const resolvedMaxTurns = 75

    logComplexityResult('24-6', complexity, resolvedMaxTurns)

    expect(mockLoggerInfo).toHaveBeenCalledOnce()
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      {
        storyKey: '24-6',
        taskCount: 3,
        subtaskCount: 6,
        fileCount: 4,
        complexityScore: 8,
        resolvedMaxTurns: 75,
      },
      expect.any(String)
    )
  })

  it('logs correct values for a large story (capped turns)', () => {
    const complexity: StoryComplexity = {
      taskCount: 8,
      subtaskCount: 20,
      fileCount: 15,
      complexityScore: 26,
    }
    const resolvedMaxTurns = 200

    logComplexityResult('4-6', complexity, resolvedMaxTurns)

    expect(mockLoggerInfo).toHaveBeenCalledOnce()
    const [logObj] = mockLoggerInfo.mock.calls[0] as [Record<string, unknown>, string]
    expect(logObj).toMatchObject({
      storyKey: '4-6',
      taskCount: 8,
      subtaskCount: 20,
      fileCount: 15,
      complexityScore: 26,
      resolvedMaxTurns: 200,
    })
  })

  it('logs correct values for a story with no parseable sections (score 0)', () => {
    const complexity: StoryComplexity = {
      taskCount: 0,
      subtaskCount: 0,
      fileCount: 0,
      complexityScore: 0,
    }

    logComplexityResult('1-1', complexity, 75)

    expect(mockLoggerInfo).toHaveBeenCalledOnce()
    const [logObj] = mockLoggerInfo.mock.calls[0] as [Record<string, unknown>, string]
    expect(logObj.storyKey).toBe('1-1')
    expect(logObj.complexityScore).toBe(0)
    expect(logObj.resolvedMaxTurns).toBe(75)
  })
})
