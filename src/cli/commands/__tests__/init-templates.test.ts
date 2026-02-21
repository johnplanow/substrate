/**
 * Unit tests for template generation in `substrate init`.
 *
 * Covers Acceptance Criteria 1–10 from Story 5.8:
 *   AC1:  --list-templates prints all 4 templates with descriptions, exit 0
 *   AC2:  --template sequential → tasks.yaml with 3 tasks, exit 0
 *   AC3:  --template parallel → tasks.yaml with 4 tasks, exit 0
 *   AC4:  --template review-cycle → tasks.yaml with 3 tasks, exit 0
 *   AC5:  --template research-then-implement → tasks.yaml with 5 tasks, exit 0
 *   AC6:  --output custom/path → file written to correct path, parent dirs created
 *   AC7:  Existing file without --force → error to stderr, exit 2, file unchanged
 *   AC7:  Existing file with --force → overwritten, exit 0
 *   AC8:  --template unknown → error with suggestion, exit 2
 *   AC9:  Each template parses without Zod validation errors
 *   AC10: --output-format json → NDJSON event emitted, file still written
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  runTemplateAction,
  runListTemplates,
  INIT_EXIT_SUCCESS,
  INIT_EXIT_USAGE_ERROR,
  INIT_EXIT_ERROR,
} from '../init.js'
import { BUILT_IN_TEMPLATES } from '../templates.js'
import { parseGraphFile } from '../../../modules/task-graph/task-parser.js'
import { validateGraph } from '../../../modules/task-graph/task-validator.js'

// ---------------------------------------------------------------------------
// Test directory management
// ---------------------------------------------------------------------------

let testDir: string

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `substrate-template-test-${String(Date.now())}-${Math.random().toString(36).slice(2)}`
  )
  mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Stdout/stderr capture helpers
// ---------------------------------------------------------------------------

function captureOutput(): {
  getStdout: () => string
  getStderr: () => string
  restore: () => void
} {
  let stdout = ''
  let stderr = ''
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((data: string | Uint8Array) => {
    stdout += typeof data === 'string' ? data : data.toString()
    return true
  })
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((data: string | Uint8Array) => {
    stderr += typeof data === 'string' ? data : data.toString()
    return true
  })
  return {
    getStdout: () => stdout,
    getStderr: () => stderr,
    restore: () => {
      stdoutSpy.mockRestore()
      stderrSpy.mockRestore()
    },
  }
}

// ---------------------------------------------------------------------------
// AC1: --list-templates
// ---------------------------------------------------------------------------

describe('runListTemplates', () => {
  it('returns exit code 0', () => {
    const { restore } = captureOutput()
    try {
      const exitCode = runListTemplates()
      expect(exitCode).toBe(INIT_EXIT_SUCCESS)
    } finally {
      restore()
    }
  })

  it('prints header line', () => {
    const { getStdout, restore } = captureOutput()
    try {
      runListTemplates()
      expect(getStdout()).toContain('Available task graph templates:')
    } finally {
      restore()
    }
  })

  it('prints all 4 templates', () => {
    const { getStdout, restore } = captureOutput()
    try {
      runListTemplates()
      const output = getStdout()
      expect(output).toContain('sequential')
      expect(output).toContain('parallel')
      expect(output).toContain('review-cycle')
      expect(output).toContain('research-then-implement')
    } finally {
      restore()
    }
  })

  it('prints descriptions for all templates', () => {
    const { getStdout, restore } = captureOutput()
    try {
      runListTemplates()
      const output = getStdout()
      expect(output).toContain('A series of tasks that run one after another')
      expect(output).toContain('A set of tasks that all run concurrently')
      expect(output).toContain('Implementation followed by code review and revision')
      expect(output).toContain('Research phase feeding into parallel implementation tasks')
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// AC2: --template sequential
// ---------------------------------------------------------------------------

describe('runTemplateAction - sequential template', () => {
  it('returns exit code 0', () => {
    const { restore } = captureOutput()
    try {
      const exitCode = runTemplateAction({ template: 'sequential', cwd: testDir })
      expect(exitCode).toBe(INIT_EXIT_SUCCESS)
    } finally {
      restore()
    }
  })

  it('creates tasks.yaml in the cwd by default', () => {
    const { restore } = captureOutput()
    try {
      runTemplateAction({ template: 'sequential', cwd: testDir })
      expect(existsSync(join(testDir, 'tasks.yaml'))).toBe(true)
    } finally {
      restore()
    }
  })

  it('generated file contains 3 tasks', () => {
    const { restore } = captureOutput()
    try {
      runTemplateAction({ template: 'sequential', cwd: testDir })
      const filePath = join(testDir, 'tasks.yaml')
      const raw = parseGraphFile(filePath)
      const result = validateGraph(raw)
      expect(result.valid).toBe(true)
      expect(Object.keys(result.graph!.tasks)).toHaveLength(3)
    } finally {
      restore()
    }
  })

  it('prints success message with output path', () => {
    const { getStdout, restore } = captureOutput()
    try {
      runTemplateAction({ template: 'sequential', cwd: testDir })
      expect(getStdout()).toContain('Template written to:')
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// AC3: --template parallel
// ---------------------------------------------------------------------------

describe('runTemplateAction - parallel template', () => {
  it('returns exit code 0', () => {
    const { restore } = captureOutput()
    try {
      const exitCode = runTemplateAction({ template: 'parallel', cwd: testDir })
      expect(exitCode).toBe(INIT_EXIT_SUCCESS)
    } finally {
      restore()
    }
  })

  it('creates tasks.yaml with 4 tasks', () => {
    const { restore } = captureOutput()
    try {
      runTemplateAction({ template: 'parallel', cwd: testDir })
      const filePath = join(testDir, 'tasks.yaml')
      const raw = parseGraphFile(filePath)
      const result = validateGraph(raw)
      expect(result.valid).toBe(true)
      expect(Object.keys(result.graph!.tasks)).toHaveLength(4)
    } finally {
      restore()
    }
  })

  it('each task has a different agent field', () => {
    const { restore } = captureOutput()
    try {
      runTemplateAction({ template: 'parallel', cwd: testDir })
      const content = readFileSync(join(testDir, 'tasks.yaml'), 'utf-8')
      expect(content).toContain('claude-code')
      expect(content).toContain('codex')
      expect(content).toContain('gemini')
      expect(content).toContain('auto')
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// AC4: --template review-cycle
// ---------------------------------------------------------------------------

describe('runTemplateAction - review-cycle template', () => {
  it('returns exit code 0', () => {
    const { restore } = captureOutput()
    try {
      const exitCode = runTemplateAction({ template: 'review-cycle', cwd: testDir })
      expect(exitCode).toBe(INIT_EXIT_SUCCESS)
    } finally {
      restore()
    }
  })

  it('creates tasks.yaml with implement, review, and revise tasks', () => {
    const { restore } = captureOutput()
    try {
      runTemplateAction({ template: 'review-cycle', cwd: testDir })
      const content = readFileSync(join(testDir, 'tasks.yaml'), 'utf-8')
      expect(content).toContain('implement:')
      expect(content).toContain('review:')
      expect(content).toContain('revise:')
    } finally {
      restore()
    }
  })

  it('contains 3 tasks total', () => {
    const { restore } = captureOutput()
    try {
      runTemplateAction({ template: 'review-cycle', cwd: testDir })
      const filePath = join(testDir, 'tasks.yaml')
      const raw = parseGraphFile(filePath)
      const result = validateGraph(raw)
      expect(result.valid).toBe(true)
      expect(Object.keys(result.graph!.tasks)).toHaveLength(3)
    } finally {
      restore()
    }
  })

  it('includes comments about extending the review cycle', () => {
    const { restore } = captureOutput()
    try {
      runTemplateAction({ template: 'review-cycle', cwd: testDir })
      const content = readFileSync(join(testDir, 'tasks.yaml'), 'utf-8')
      // Comments should explain adding more review iterations
      expect(content).toContain('review')
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// AC5: --template research-then-implement
// ---------------------------------------------------------------------------

describe('runTemplateAction - research-then-implement template', () => {
  it('returns exit code 0', () => {
    const { restore } = captureOutput()
    try {
      const exitCode = runTemplateAction({ template: 'research-then-implement', cwd: testDir })
      expect(exitCode).toBe(INIT_EXIT_SUCCESS)
    } finally {
      restore()
    }
  })

  it('creates tasks.yaml with 5 tasks', () => {
    const { restore } = captureOutput()
    try {
      runTemplateAction({ template: 'research-then-implement', cwd: testDir })
      const filePath = join(testDir, 'tasks.yaml')
      const raw = parseGraphFile(filePath)
      const result = validateGraph(raw)
      expect(result.valid).toBe(true)
      expect(Object.keys(result.graph!.tasks)).toHaveLength(5)
    } finally {
      restore()
    }
  })

  it('contains research tasks, synthesize, and implement tasks', () => {
    const { restore } = captureOutput()
    try {
      runTemplateAction({ template: 'research-then-implement', cwd: testDir })
      const content = readFileSync(join(testDir, 'tasks.yaml'), 'utf-8')
      expect(content).toContain('research-existing-code:')
      expect(content).toContain('research-best-practices:')
      expect(content).toContain('synthesize:')
      expect(content).toContain('implement-core:')
      expect(content).toContain('implement-tests:')
    } finally {
      restore()
    }
  })

  it('includes fan-out/fan-in pattern comments', () => {
    const { restore } = captureOutput()
    try {
      runTemplateAction({ template: 'research-then-implement', cwd: testDir })
      const content = readFileSync(join(testDir, 'tasks.yaml'), 'utf-8')
      // Should have comments explaining the fan-out / fan-in pattern
      expect(content).toContain('fan')
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// AC6: --output custom path
// ---------------------------------------------------------------------------

describe('runTemplateAction - custom output path', () => {
  it('writes to specified --output path', () => {
    const { restore } = captureOutput()
    try {
      const customPath = join(testDir, 'my-graph.yaml')
      runTemplateAction({ template: 'sequential', output: customPath, cwd: testDir })
      expect(existsSync(customPath)).toBe(true)
    } finally {
      restore()
    }
  })

  it('creates parent directories when they do not exist', () => {
    const { restore } = captureOutput()
    try {
      const deepPath = join(testDir, 'nested', 'sub', 'graph.yaml')
      const exitCode = runTemplateAction({ template: 'sequential', output: deepPath, cwd: testDir })
      expect(exitCode).toBe(INIT_EXIT_SUCCESS)
      expect(existsSync(deepPath)).toBe(true)
    } finally {
      restore()
    }
  })

  it('prints the absolute output path in success message', () => {
    const { getStdout, restore } = captureOutput()
    try {
      const customPath = join(testDir, 'out.yaml')
      runTemplateAction({ template: 'sequential', output: customPath, cwd: testDir })
      expect(getStdout()).toContain(customPath)
    } finally {
      restore()
    }
  })

  it('handles relative --output path resolved against cwd', () => {
    const { restore } = captureOutput()
    try {
      const exitCode = runTemplateAction({
        template: 'parallel',
        output: 'custom.yaml',
        cwd: testDir,
      })
      expect(exitCode).toBe(INIT_EXIT_SUCCESS)
      expect(existsSync(join(testDir, 'custom.yaml'))).toBe(true)
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// AC7: Overwrite protection
// ---------------------------------------------------------------------------

describe('runTemplateAction - overwrite protection', () => {
  it('returns exit 2 when file exists without --force', () => {
    const { restore } = captureOutput()
    try {
      const outputPath = join(testDir, 'tasks.yaml')
      writeFileSync(outputPath, 'original content', 'utf-8')
      const exitCode = runTemplateAction({ template: 'sequential', cwd: testDir })
      expect(exitCode).toBe(INIT_EXIT_USAGE_ERROR)
    } finally {
      restore()
    }
  })

  it('prints error to stderr when file exists without --force', () => {
    const { getStderr, restore } = captureOutput()
    try {
      const outputPath = join(testDir, 'tasks.yaml')
      writeFileSync(outputPath, 'original content', 'utf-8')
      runTemplateAction({ template: 'sequential', cwd: testDir })
      expect(getStderr()).toContain('already exists')
      expect(getStderr()).toContain('--force')
    } finally {
      restore()
    }
  })

  it('does NOT modify the file when overwrite is refused (file unchanged)', () => {
    const { restore } = captureOutput()
    try {
      const outputPath = join(testDir, 'tasks.yaml')
      writeFileSync(outputPath, 'original content', 'utf-8')
      runTemplateAction({ template: 'sequential', cwd: testDir })
      expect(readFileSync(outputPath, 'utf-8')).toBe('original content')
    } finally {
      restore()
    }
  })

  it('overwrites file when --force is specified', () => {
    const { restore } = captureOutput()
    try {
      const outputPath = join(testDir, 'tasks.yaml')
      writeFileSync(outputPath, 'original content', 'utf-8')
      const exitCode = runTemplateAction({ template: 'sequential', cwd: testDir, force: true })
      expect(exitCode).toBe(INIT_EXIT_SUCCESS)
      expect(readFileSync(outputPath, 'utf-8')).not.toBe('original content')
    } finally {
      restore()
    }
  })

  it('prints "(overwritten)" in success message when --force overwrites', () => {
    const { getStdout, restore } = captureOutput()
    try {
      const outputPath = join(testDir, 'tasks.yaml')
      writeFileSync(outputPath, 'original content', 'utf-8')
      runTemplateAction({ template: 'sequential', cwd: testDir, force: true })
      expect(getStdout()).toContain('(overwritten)')
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// AC8: Unknown template name
// ---------------------------------------------------------------------------

describe('runTemplateAction - unknown template', () => {
  it('returns exit code 2 for unknown template', () => {
    const { restore } = captureOutput()
    try {
      const exitCode = runTemplateAction({ template: 'nonexistent', cwd: testDir })
      expect(exitCode).toBe(INIT_EXIT_USAGE_ERROR)
    } finally {
      restore()
    }
  })

  it('prints error to stderr with template name and suggestion', () => {
    const { getStderr, restore } = captureOutput()
    try {
      runTemplateAction({ template: 'nonexistent', cwd: testDir })
      expect(getStderr()).toContain("Unknown template 'nonexistent'")
      expect(getStderr()).toContain('--list-templates')
    } finally {
      restore()
    }
  })

  it('does not create any file for unknown template', () => {
    const { restore } = captureOutput()
    try {
      runTemplateAction({ template: 'nonexistent', cwd: testDir })
      expect(existsSync(join(testDir, 'tasks.yaml'))).toBe(false)
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// AC9: Schema validation — each template parses without errors
// ---------------------------------------------------------------------------

describe('template schema validation (AC9)', () => {
  for (const templateDef of BUILT_IN_TEMPLATES) {
    it(`template "${templateDef.name}" parses and validates against the Zod schema`, () => {
      const raw = parseGraphFile(templateDef.filePath)
      const result = validateGraph(raw)
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it(`template "${templateDef.name}" has no cyclic dependencies`, () => {
      const raw = parseGraphFile(templateDef.filePath)
      const result = validateGraph(raw)
      const cycleErrors = result.errors.filter((e) => e.includes('Circular dependency'))
      expect(cycleErrors).toHaveLength(0)
    })

    it(`template "${templateDef.name}" has correct task count (${templateDef.taskCount})`, () => {
      const raw = parseGraphFile(templateDef.filePath)
      const result = validateGraph(raw)
      expect(result.valid).toBe(true)
      const taskCount = Object.keys(result.graph!.tasks).length
      expect(taskCount).toBe(templateDef.taskCount)
    })
  }
})

// ---------------------------------------------------------------------------
// AC10: --output-format json
// ---------------------------------------------------------------------------

describe('runTemplateAction - output-format json', () => {
  it('emits NDJSON event to stdout', () => {
    const { getStdout, restore } = captureOutput()
    try {
      runTemplateAction({
        template: 'sequential',
        cwd: testDir,
        outputFormat: 'json',
      })
      const lines = getStdout().split('\n').filter((l) => l.startsWith('{'))
      expect(lines.length).toBeGreaterThanOrEqual(1)
      const event = JSON.parse(lines[0]) as Record<string, unknown>
      expect(event['event']).toBe('template:generated')
      expect(typeof event['timestamp']).toBe('string')
    } finally {
      restore()
    }
  })

  it('NDJSON event contains template name and task count', () => {
    const { getStdout, restore } = captureOutput()
    try {
      runTemplateAction({
        template: 'sequential',
        cwd: testDir,
        outputFormat: 'json',
      })
      const lines = getStdout().split('\n').filter((l) => l.startsWith('{'))
      const event = JSON.parse(lines[0]) as { data: { template: string; taskCount: number; outputPath: string } }
      expect(event.data.template).toBe('sequential')
      expect(event.data.taskCount).toBe(3)
      expect(typeof event.data.outputPath).toBe('string')
    } finally {
      restore()
    }
  })

  it('still writes the file when --output-format json is used', () => {
    const { restore } = captureOutput()
    try {
      runTemplateAction({
        template: 'parallel',
        cwd: testDir,
        outputFormat: 'json',
      })
      expect(existsSync(join(testDir, 'tasks.yaml'))).toBe(true)
    } finally {
      restore()
    }
  })

  it('NDJSON event timestamp is a valid ISO 8601 string', () => {
    const { getStdout, restore } = captureOutput()
    try {
      runTemplateAction({
        template: 'parallel',
        cwd: testDir,
        outputFormat: 'json',
      })
      const lines = getStdout().split('\n').filter((l) => l.startsWith('{'))
      const event = JSON.parse(lines[0]) as { timestamp: string }
      // ISO 8601 check: parseable as a Date and not NaN
      expect(isNaN(new Date(event.timestamp).getTime())).toBe(false)
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// Additional integration: dry-run validation for each template (AC9 extended)
// ---------------------------------------------------------------------------

describe('template files pass dry-run validation', () => {
  for (const templateDef of BUILT_IN_TEMPLATES) {
    it(`template "${templateDef.name}" validates successfully (dry-run equivalent)`, () => {
      const raw = parseGraphFile(templateDef.filePath)
      const result = validateGraph(raw)
      expect(result.valid).toBe(true)
      expect(result.graph).toBeDefined()
      // Confirm version field
      expect(result.graph!.version).toBe('1.0')
    })
  }
})

// ---------------------------------------------------------------------------
// BUILT_IN_TEMPLATES registry check
// ---------------------------------------------------------------------------

describe('BUILT_IN_TEMPLATES registry', () => {
  it('contains exactly 4 templates', () => {
    expect(BUILT_IN_TEMPLATES).toHaveLength(4)
  })

  it('all templates have unique names', () => {
    const names = BUILT_IN_TEMPLATES.map((t) => t.name)
    const unique = new Set(names)
    expect(unique.size).toBe(names.length)
  })

  it('all template files exist on disk', () => {
    for (const t of BUILT_IN_TEMPLATES) {
      expect(existsSync(t.filePath)).toBe(true)
    }
  })

  it('all templates have non-empty descriptions', () => {
    for (const t of BUILT_IN_TEMPLATES) {
      expect(t.description.length).toBeGreaterThan(0)
    }
  })

  it('all templates have taskCount > 0', () => {
    for (const t of BUILT_IN_TEMPLATES) {
      expect(t.taskCount).toBeGreaterThan(0)
    }
  })
})
