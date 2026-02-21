/**
 * Tests for yaml-parser.ts — YAML extraction and parsing for sub-agent output
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { extractYamlBlock, parseYamlResult } from '../yaml-parser.js'

// ---------------------------------------------------------------------------
// extractYamlBlock tests
// ---------------------------------------------------------------------------

describe('extractYamlBlock', () => {
  it('returns null for empty output', () => {
    expect(extractYamlBlock('')).toBeNull()
    expect(extractYamlBlock('   ')).toBeNull()
  })

  it('extracts from a fenced yaml block (```yaml)', () => {
    const output = `
Some narrative text here explaining the implementation.

\`\`\`yaml
result: success
ac_met: yes
ac_failures: []
\`\`\`
`
    const result = extractYamlBlock(output)
    expect(result).not.toBeNull()
    expect(result).toContain('result: success')
    expect(result).toContain('ac_met: yes')
  })

  it('extracts from a fenced block without yaml language tag', () => {
    const output = `
Agent output here.

\`\`\`
result: success
ac_met: yes
\`\`\`
`
    const result = extractYamlBlock(output)
    expect(result).not.toBeNull()
    expect(result).toContain('result: success')
  })

  it('extracts from unfenced YAML starting with result:', () => {
    const output = `
Some reasoning text.
More reasoning.

result: success
ac_met: yes
ac_failures: []
files_modified:
  - src/foo.ts
`
    const result = extractYamlBlock(output)
    expect(result).not.toBeNull()
    expect(result).toContain('result: success')
  })

  it('extracts from unfenced YAML starting with verdict:', () => {
    const output = `
Code review analysis...

verdict: approved
issues: []
`
    const result = extractYamlBlock(output)
    expect(result).not.toBeNull()
    expect(result).toContain('verdict: approved')
  })

  it('extracts from unfenced YAML starting with story_file:', () => {
    const output = `
Created the story file.

story_file: _bmad-output/implementation-artifacts/9-3.md
status: done
`
    const result = extractYamlBlock(output)
    expect(result).not.toBeNull()
    expect(result).toContain('story_file:')
  })

  it('takes the LAST fenced YAML block when multiple exist', () => {
    const output = `
\`\`\`yaml
result: partial
ac_met: no
\`\`\`

Some more narrative.

\`\`\`yaml
result: success
ac_met: yes
\`\`\`
`
    const result = extractYamlBlock(output)
    expect(result).not.toBeNull()
    expect(result).toContain('result: success')
    expect(result).toContain('ac_met: yes')
  })

  it('returns null when output has no YAML anchor keys', () => {
    const output = `
This is just narrative text without any YAML.
No result or verdict keys here.
Just plain text output.
`
    const result = extractYamlBlock(output)
    expect(result).toBeNull()
  })

  it('handles output with narrative text before and after the YAML', () => {
    const output = `
I implemented all the features described in the story.
The tests are passing and the code is clean.

Here is my final summary:

result: success
ac_met: yes
ac_failures: []
tests:
  pass: 42
  fail: 0
`
    const result = extractYamlBlock(output)
    expect(result).not.toBeNull()
    expect(result).toContain('result: success')
    expect(result).toContain('tests:')
  })

  it('ignores fenced blocks that do not contain anchor keys', () => {
    const output = `
Here is some code:

\`\`\`typescript
const x = 42
\`\`\`

result: success
ac_met: yes
`
    // The code fence doesn't have anchor keys, so should fall through to unfenced
    const result = extractYamlBlock(output)
    expect(result).not.toBeNull()
    expect(result).toContain('result: success')
  })

  it('extracts YAML from output containing embedded code fences before the result', () => {
    const output = `
I modified the file:

\`\`\`typescript
function doSomething() {
  return 42
}
\`\`\`

\`\`\`yaml
result: success
ac_met: yes
\`\`\`
`
    const result = extractYamlBlock(output)
    expect(result).not.toBeNull()
    expect(result).toContain('result: success')
  })
})

// ---------------------------------------------------------------------------
// parseYamlResult tests
// ---------------------------------------------------------------------------

describe('parseYamlResult', () => {
  it('parses valid YAML without a schema', () => {
    const yaml = `
result: success
ac_met: yes
`
    const { parsed, error } = parseYamlResult(yaml)
    expect(error).toBeNull()
    expect(parsed).toEqual({ result: 'success', ac_met: 'yes' })
  })

  it('returns error for invalid YAML', () => {
    const invalidYaml = `
result: [unclosed bracket
  bad: yaml: here:
`
    const { parsed, error } = parseYamlResult(invalidYaml)
    expect(parsed).toBeNull()
    expect(error).not.toBeNull()
    expect(error).toContain('YAML parse error')
  })

  it('validates successfully with a matching Zod schema', () => {
    const schema = z.object({
      result: z.enum(['success', 'failure']),
      ac_met: z.enum(['yes', 'no']),
    })

    const yaml = `
result: success
ac_met: yes
`
    const { parsed, error } = parseYamlResult(yaml, schema)
    expect(error).toBeNull()
    expect(parsed).toEqual({ result: 'success', ac_met: 'yes' })
  })

  it('returns schema validation error when YAML does not match schema', () => {
    const schema = z.object({
      result: z.enum(['success', 'failure']),
      ac_met: z.enum(['yes', 'no']),
    })

    const yaml = `
result: invalid_value
ac_met: maybe
`
    const { parsed, error } = parseYamlResult(yaml, schema)
    expect(parsed).toBeNull()
    expect(error).not.toBeNull()
    expect(error).toContain('Schema validation error')
  })

  it('returns error for YAML that parses to null', () => {
    const yaml = '~'
    const { parsed, error } = parseYamlResult(yaml)
    expect(parsed).toBeNull()
    expect(error).not.toBeNull()
    expect(error).toContain('null or undefined')
  })

  it('handles complex nested YAML', () => {
    const schema = z.object({
      result: z.string(),
      tests: z.object({
        pass: z.number(),
        fail: z.number(),
      }),
      files_modified: z.array(z.string()),
    })

    const yaml = `
result: success
tests:
  pass: 42
  fail: 0
files_modified:
  - src/foo.ts
  - src/bar.ts
`
    const { parsed, error } = parseYamlResult(yaml, schema)
    expect(error).toBeNull()
    expect(parsed).not.toBeNull()
    expect(parsed?.result).toBe('success')
    expect(parsed?.tests.pass).toBe(42)
    expect(parsed?.files_modified).toHaveLength(2)
  })

  it('returns raw parsed value without schema even for complex types', () => {
    const yaml = `
result: success
nested:
  key: value
  array:
    - item1
    - item2
`
    const { parsed, error } = parseYamlResult(yaml)
    expect(error).toBeNull()
    expect(parsed).not.toBeNull()
  })
})
