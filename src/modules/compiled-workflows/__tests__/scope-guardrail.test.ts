/**
 * Tests for ScopeGuardrail utility.
 *
 * Pure string I/O — no mocks needed.
 */

import { describe, it, expect } from 'vitest'
import { ScopeGuardrail, isTestFile } from '../scope-guardrail.js'

// ---------------------------------------------------------------------------
// isTestFile
// ---------------------------------------------------------------------------

describe('isTestFile', () => {
  it('returns true for .test.ts files', () => {
    expect(isTestFile('src/modules/foo/bar.test.ts')).toBe(true)
  })

  it('returns true for .spec.ts files', () => {
    expect(isTestFile('src/modules/foo/bar.spec.ts')).toBe(true)
  })

  it('returns true for paths inside __tests__/', () => {
    expect(isTestFile('src/foo/__tests__/bar.ts')).toBe(true)
  })

  it('returns true for paths inside __mocks__/', () => {
    expect(isTestFile('src/foo/__mocks__/foo.ts')).toBe(true)
  })

  it('returns false for a regular source file', () => {
    expect(isTestFile('src/foo/bar.ts')).toBe(false)
  })

  it('returns false for a file with test in the name but no pattern match', () => {
    expect(isTestFile('src/test-helpers/util.ts')).toBe(false)
  })

  it('returns true for .test.js files', () => {
    expect(isTestFile('lib/foo.test.js')).toBe(true)
  })

  it('returns true for .spec.js files', () => {
    expect(isTestFile('lib/foo.spec.js')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ScopeGuardrail.parseExpectedFiles
// ---------------------------------------------------------------------------

describe('ScopeGuardrail.parseExpectedFiles', () => {
  it('extracts paths from a "### File Paths to Create" section', () => {
    const storyContent = `
## Story
Some description.

### File Paths to Create
- src/foo/bar.ts
- src/foo/baz.ts

### Tasks
- [ ] Do something
`
    const result = ScopeGuardrail.parseExpectedFiles(storyContent)
    expect(result.has('src/foo/bar.ts')).toBe(true)
    expect(result.has('src/foo/baz.ts')).toBe(true)
  })

  it('extracts paths from a "### File Paths to Modify" section', () => {
    const storyContent = `
### File Paths to Modify
- src/modules/code-review.ts
- packs/bmad/prompts/code-review.md
`
    const result = ScopeGuardrail.parseExpectedFiles(storyContent)
    expect(result.has('src/modules/code-review.ts')).toBe(true)
    expect(result.has('packs/bmad/prompts/code-review.md')).toBe(true)
  })

  it('extracts paths from a "### Key File Paths" section', () => {
    const storyContent = `
### Key File Paths
- packages/core/src/adapters/types.ts
- src/modules/workflow/index.ts
`
    const result = ScopeGuardrail.parseExpectedFiles(storyContent)
    expect(result.has('packages/core/src/adapters/types.ts')).toBe(true)
    expect(result.has('src/modules/workflow/index.ts')).toBe(true)
  })

  it('extracts backtick-wrapped paths from Tasks / Subtasks bullets', () => {
    const storyContent = `
### Tasks / Subtasks
- [ ] Create \`packages/core/src/adapters/types.ts\` with the new interface
- [ ] Modify \`src/modules/compiled-workflows/code-review.ts\` to wire it in
`
    const result = ScopeGuardrail.parseExpectedFiles(storyContent)
    expect(result.has('packages/core/src/adapters/types.ts')).toBe(true)
    expect(result.has('src/modules/compiled-workflows/code-review.ts')).toBe(true)
  })

  it('extracts plain (non-backtick) path-like strings from Tasks / Subtasks', () => {
    const storyContent = `
### Tasks
- [ ] Open src/modules/foo/bar.ts and add the new method
`
    const result = ScopeGuardrail.parseExpectedFiles(storyContent)
    expect(result.has('src/modules/foo/bar.ts')).toBe(true)
  })

  it('does not include non-path plain text from Tasks bullets', () => {
    const storyContent = `
### Tasks / Subtasks
- [ ] Add error handling and logging
- [ ] Run tests with vitest
- [ ] Update the README
`
    const result = ScopeGuardrail.parseExpectedFiles(storyContent)
    // These are all non-path strings; set should be empty
    expect(result.size).toBe(0)
  })

  it('handles sections with both backtick and plain file paths', () => {
    const storyContent = `
### File Paths to Create
- \`src/new/file.ts\`
- src/another/file.json
`
    const result = ScopeGuardrail.parseExpectedFiles(storyContent)
    expect(result.has('src/new/file.ts')).toBe(true)
    expect(result.has('src/another/file.json')).toBe(true)
  })

  it('is whitespace-tolerant (extra spaces around paths)', () => {
    const storyContent = `
### File Paths to Create
  -   src/foo/bar.ts
`
    const result = ScopeGuardrail.parseExpectedFiles(storyContent)
    expect(result.has('src/foo/bar.ts')).toBe(true)
  })

  it('returns empty set for story with no file path sections', () => {
    const storyContent = `
## Story
As a developer, I want to do something.

## Acceptance Criteria

### AC1: Something happens
`
    const result = ScopeGuardrail.parseExpectedFiles(storyContent)
    expect(result.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ScopeGuardrail.buildAnalysis
// ---------------------------------------------------------------------------

describe('ScopeGuardrail.buildAnalysis', () => {
  const STORY_WITH_PATHS = `
## Story
Some story.

### File Paths to Create
- src/modules/foo/new-file.ts

### File Paths to Modify
- src/modules/foo/existing.ts
`

  it('returns empty string when filesModified is a subset of expected files', () => {
    const result = ScopeGuardrail.buildAnalysis(STORY_WITH_PATHS, [
      'src/modules/foo/new-file.ts',
      'src/modules/foo/existing.ts',
    ])
    expect(result).toBe('')
  })

  it('returns empty string when filesModified is empty', () => {
    const result = ScopeGuardrail.buildAnalysis(STORY_WITH_PATHS, [])
    expect(result).toBe('')
  })

  it('returns non-empty string when an unexpected file appears in filesModified', () => {
    const result = ScopeGuardrail.buildAnalysis(STORY_WITH_PATHS, [
      'src/modules/foo/new-file.ts',
      'src/modules/foo/unexpected.ts',
    ])
    expect(result).not.toBe('')
    expect(result).toContain('src/modules/foo/unexpected.ts')
  })

  it('names unexpected files under "Out-of-scope files" heading', () => {
    const result = ScopeGuardrail.buildAnalysis(STORY_WITH_PATHS, ['src/modules/foo/unexpected.ts'])
    expect(result).toContain('Out-of-scope files')
    expect(result).toContain('src/modules/foo/unexpected.ts')
  })

  it('lists expected files in the analysis output', () => {
    const result = ScopeGuardrail.buildAnalysis(STORY_WITH_PATHS, ['src/modules/foo/unexpected.ts'])
    expect(result).toContain('src/modules/foo/new-file.ts')
    expect(result).toContain('src/modules/foo/existing.ts')
  })

  it('exempts test files from out-of-scope listing (*.test.ts)', () => {
    const result = ScopeGuardrail.buildAnalysis(STORY_WITH_PATHS, [
      'src/modules/foo/unexpected.ts',
      'src/modules/foo/__tests__/bar.test.ts',
    ])
    // The unexpected source file is flagged
    expect(result).toContain('src/modules/foo/unexpected.ts')
    // The test file is NOT listed in out-of-scope
    expect(result).not.toContain('src/modules/foo/__tests__/bar.test.ts')
  })

  it('returns empty string when only test files appear outside the expected set', () => {
    const result = ScopeGuardrail.buildAnalysis(STORY_WITH_PATHS, [
      'src/modules/foo/new-file.ts',
      'src/modules/foo/__tests__/new-file.test.ts',
    ])
    // Test file is not in expected set but is exempt → no violations
    expect(result).toBe('')
  })

  it('handles story with no file path sections gracefully', () => {
    const emptyStory = '## Story\nAs a developer, I want something.\n'
    const result = ScopeGuardrail.buildAnalysis(emptyStory, ['src/some/unexpected.ts'])
    // Expected set is empty, all files are out-of-scope
    expect(result).not.toBe('')
    expect(result).toContain('src/some/unexpected.ts')
  })

  it('exempts __mocks__/ paths from out-of-scope listing', () => {
    const result = ScopeGuardrail.buildAnalysis(STORY_WITH_PATHS, [
      'src/modules/foo/unexpected.ts',
      'src/modules/foo/__mocks__/dep.ts',
    ])
    expect(result).toContain('src/modules/foo/unexpected.ts')
    // The mock file path should NOT appear in the out-of-scope section
    expect(result).not.toContain('src/modules/foo/__mocks__/dep.ts')
  })
})
