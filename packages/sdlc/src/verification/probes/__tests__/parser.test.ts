/**
 * Unit tests for parseRuntimeProbes — Epic 55 / Phase 2.
 *
 * Covers:
 *   - section absent → { kind: 'absent' }
 *   - section present with yaml fence, valid  → { kind: 'parsed' } with expected entries
 *   - section present with yaml fence, empty list → { kind: 'parsed', probes: [] }
 *   - section present with no yaml fence → { kind: 'invalid' }
 *   - yaml malformed → { kind: 'invalid' }
 *   - yaml root is scalar/map → { kind: 'invalid' }
 *   - probe missing required field → { kind: 'invalid' } with the field name surfaced
 *   - unknown sandbox → { kind: 'invalid' }
 *   - duplicate probe names → { kind: 'invalid' }
 *   - trailing content after closing fence does not confuse the parser
 */

import { describe, it, expect } from 'vitest'
import { parseRuntimeProbes } from '../parser.js'

function wrap(body: string): string {
  return `# Story 99-9\n\nSome prelude.\n\n## Runtime Probes\n\n${body}\n\n## Something Else\n`
}

describe('parseRuntimeProbes', () => {
  it('returns { kind: "absent" } when the story has no ## Runtime Probes section', () => {
    const result = parseRuntimeProbes('# Story\n\nNo probes here.\n')
    expect(result.kind).toBe('absent')
  })

  it('returns { kind: "parsed" } with all fields for a well-formed declaration', () => {
    const body = [
      '```yaml',
      '- name: install-smoke',
      '  sandbox: host',
      '  command: |',
      '    task dolt:install',
      '    systemctl --user status dolt.service',
      '  timeout_ms: 30000',
      '  description: verify Quadlet unit starts cleanly',
      '```',
    ].join('\n')
    const result = parseRuntimeProbes(wrap(body))
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.probes).toHaveLength(1)
    const probe = result.probes[0]!
    expect(probe.name).toBe('install-smoke')
    expect(probe.sandbox).toBe('host')
    expect(probe.command).toContain('task dolt:install')
    expect(probe.command).toContain('systemctl --user status dolt.service')
    expect(probe.timeout_ms).toBe(30000)
    expect(probe.description).toContain('Quadlet')
  })

  it('returns { kind: "parsed", probes: [] } for an empty yaml list', () => {
    const body = '```yaml\n[]\n```'
    const result = parseRuntimeProbes(wrap(body))
    expect(result.kind).toBe('parsed')
    if (result.kind === 'parsed') expect(result.probes).toHaveLength(0)
  })

  it('accepts multiple probes and preserves order', () => {
    const body = [
      '```yaml',
      '- name: one',
      '  sandbox: host',
      '  command: echo 1',
      '- name: two',
      '  sandbox: twin',
      '  command: echo 2',
      '```',
    ].join('\n')
    const result = parseRuntimeProbes(wrap(body))
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.probes.map((p) => p.name)).toEqual(['one', 'two'])
    expect(result.probes.map((p) => p.sandbox)).toEqual(['host', 'twin'])
  })

  it('accepts ```yml as an alias for ```yaml', () => {
    // Note: YAML parses bare `true` as a boolean; probe authors must quote
    // string commands that collide with YAML keywords. This is documented
    // behavior, not a schema bug.
    const body = '```yml\n- name: a\n  sandbox: host\n  command: "true"\n```'
    const result = parseRuntimeProbes(wrap(body))
    expect(result.kind).toBe('parsed')
  })

  it('returns { kind: "invalid" } when the section has no yaml fence', () => {
    const body = 'prose but no fence'
    const result = parseRuntimeProbes(wrap(body))
    expect(result.kind).toBe('invalid')
    if (result.kind === 'invalid') expect(result.error).toMatch(/no terminated ```yaml fenced block/)
  })

  it('returns { kind: "invalid" } when the yaml is malformed', () => {
    const body = '```yaml\n- name: busted\n  command: [unclosed\n```'
    const result = parseRuntimeProbes(wrap(body))
    expect(result.kind).toBe('invalid')
    if (result.kind === 'invalid') expect(result.error).toMatch(/YAML parse error/)
  })

  it('returns { kind: "invalid" } when the yaml root is a map (not a list)', () => {
    const body = '```yaml\nname: solo\nsandbox: host\ncommand: true\n```'
    const result = parseRuntimeProbes(wrap(body))
    expect(result.kind).toBe('invalid')
    if (result.kind === 'invalid') expect(result.error).toMatch(/must be a YAML list/)
  })

  it('returns { kind: "invalid" } when a probe is missing the required sandbox field', () => {
    const body = '```yaml\n- name: x\n  command: echo hi\n```'
    const result = parseRuntimeProbes(wrap(body))
    expect(result.kind).toBe('invalid')
    if (result.kind === 'invalid') expect(result.error).toMatch(/sandbox/)
  })

  it('returns { kind: "invalid" } for an unknown sandbox value', () => {
    const body = '```yaml\n- name: x\n  sandbox: aliens\n  command: echo hi\n```'
    const result = parseRuntimeProbes(wrap(body))
    expect(result.kind).toBe('invalid')
  })

  it('returns { kind: "invalid" } for duplicate probe names', () => {
    const body = [
      '```yaml',
      '- name: dup',
      '  sandbox: host',
      '  command: echo one',
      '- name: dup',
      '  sandbox: host',
      '  command: echo two',
      '```',
    ].join('\n')
    const result = parseRuntimeProbes(wrap(body))
    expect(result.kind).toBe('invalid')
    if (result.kind === 'invalid') expect(result.error).toMatch(/duplicate probe name: dup/)
  })

  it('ignores yaml fences that appear after the ## Runtime Probes section ended', () => {
    const content =
      '# story\n\n## Runtime Probes\n\nplain prose, no fence\n\n## Implementation\n\n```yaml\n- name: later\n  sandbox: host\n  command: echo hi\n```\n'
    const result = parseRuntimeProbes(content)
    expect(result.kind).toBe('invalid') // because the Runtime Probes section had no fence
  })
})
