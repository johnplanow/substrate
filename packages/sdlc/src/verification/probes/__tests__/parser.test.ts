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

  // -------------------------------------------------------------------------
  // Story 58-4: code-fence depth awareness
  //
  // Stories that DOCUMENT runtime probes in prose (regression fixtures,
  // how-to-author docs) embed illustrative `## Runtime Probes` examples
  // inside outer ``` code blocks. Without fence awareness the parser
  // matches those illustrations as the story's own section, fails to find
  // a terminated yaml block (the inner fences are typically escaped),
  // and emits a spurious `runtime-probe-parse-error`. Hit live on Epic 58
  // Story 58-3's artifact during the 2026-04-20 substrate dispatch.
  // -------------------------------------------------------------------------

  it('58-4: returns "absent" when ## Runtime Probes appears only inside an outer ``` block', () => {
    const content = [
      '# story',
      '',
      'Example shape (inside a code fence for illustration):',
      '',
      '```',
      '### Story 1-x: Example',
      '',
      '## Runtime Probes',
      '',
      '\\`\\`\\`yaml',
      '- name: example',
      '  sandbox: host',
      '  command: echo',
      '\\`\\`\\`',
      '```',
      '',
      'No real Runtime Probes section outside any fence.',
      '',
    ].join('\n')
    expect(parseRuntimeProbes(content).kind).toBe('absent')
  })

  it('58-4: returns "absent" when ## Runtime Probes appears only inside an outer ```markdown block', () => {
    const content = [
      '# story',
      '',
      '```markdown',
      '## Runtime Probes',
      '',
      'documentation-style illustration',
      '```',
      '',
    ].join('\n')
    expect(parseRuntimeProbes(content).kind).toBe('absent')
  })

  it('58-4: real section outside a fence takes precedence even when preceded by an illustrative fenced heading', () => {
    const content = [
      '# story',
      '',
      'Illustrative example first:',
      '',
      '```',
      '## Runtime Probes',
      'illustrative text only',
      '```',
      '',
      "Now the actual section:",
      '',
      '## Runtime Probes',
      '',
      '```yaml',
      '- name: real-probe',
      '  sandbox: host',
      '  command: echo real',
      '```',
      '',
    ].join('\n')
    const result = parseRuntimeProbes(content)
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.probes).toHaveLength(1)
    expect(result.probes[0]!.name).toBe('real-probe')
  })

  it('58-4: end-boundary scan also respects code fences (next ## inside a fence is not the section terminator)', () => {
    // Real section exists; later prose contains a fenced `## Something Else`
    // that must NOT be treated as the section's end boundary when we're
    // scanning fence-aware. The parsed probe list should still come out
    // correctly.
    const content = [
      '# story',
      '',
      '## Runtime Probes',
      '',
      '```yaml',
      '- name: real-probe',
      '  sandbox: host',
      '  command: echo real',
      '```',
      '',
      'Prose that contains an illustrative next-section heading inside a fence:',
      '',
      '```',
      '## Implementation',
      'example',
      '```',
      '',
      '## Real Implementation',
      'real content here.',
      '',
    ].join('\n')
    const result = parseRuntimeProbes(content)
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.probes).toHaveLength(1)
    expect(result.probes[0]!.name).toBe('real-probe')
  })

  // -------------------------------------------------------------------------
  // Story 58-8: accept `probes:` root wrapper in addition to bare list
  //
  // Strata's epics.md author convention uses a `probes:` mapping at the
  // YAML root rather than a bare list. Substrate's parser previously rejected
  // this with `probe block root must be a YAML list; got object`. This is
  // a common config-file shape (docker-compose `services:`, GitHub Actions
  // `jobs:`) so substrate now accepts both forms cleanly.
  // -------------------------------------------------------------------------

  it('58-8: accepts `probes:` root wrapper (strata author convention)', () => {
    const body = [
      '```yaml',
      'probes:',
      '  - name: wrapped-probe',
      '    sandbox: host',
      '    command: echo wrapped',
      '```',
    ].join('\n')
    const result = parseRuntimeProbes(wrap(body))
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.probes).toHaveLength(1)
    expect(result.probes[0]!.name).toBe('wrapped-probe')
  })

  it('58-8: accepts bare-list form (substrate-canonical, no regression)', () => {
    const body = [
      '```yaml',
      '- name: bare-probe',
      '  sandbox: host',
      '  command: echo bare',
      '```',
    ].join('\n')
    const result = parseRuntimeProbes(wrap(body))
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.probes).toHaveLength(1)
    expect(result.probes[0]!.name).toBe('bare-probe')
  })

  it('58-8: wrapped form with multiple probes validates schema on each entry', () => {
    const body = [
      '```yaml',
      'probes:',
      '  - name: probe-a',
      '    sandbox: host',
      '    command: echo a',
      '  - name: probe-b',
      '    sandbox: twin',
      '    command: echo b',
      '```',
    ].join('\n')
    const result = parseRuntimeProbes(wrap(body))
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.probes).toHaveLength(2)
    expect(result.probes.map((p) => p.name).sort()).toEqual(['probe-a', 'probe-b'])
  })

  it('58-8: object root without a `probes:` key still fails with an updated error message', () => {
    const body = [
      '```yaml',
      'stages:',
      '  - name: not-probes',
      '```',
    ].join('\n')
    const result = parseRuntimeProbes(wrap(body))
    expect(result.kind).toBe('invalid')
    if (result.kind !== 'invalid') return
    expect(result.error).toMatch(/probe block root must be a YAML list or a `probes:` mapping/)
  })

  it('58-8: wrapped form with duplicate probe names still rejected', () => {
    const body = [
      '```yaml',
      'probes:',
      '  - name: dup',
      '    sandbox: host',
      '    command: echo a',
      '  - name: dup',
      '    sandbox: host',
      '    command: echo b',
      '```',
    ].join('\n')
    const result = parseRuntimeProbes(wrap(body))
    expect(result.kind).toBe('invalid')
    if (result.kind !== 'invalid') return
    expect(result.error).toMatch(/duplicate probe name: dup/)
  })
})
