/**
 * Verification tests for critique prompt templates (Story 16-4, T11).
 *
 * Validates that each critique prompt file:
 *  - Exists and is non-empty
 *  - Contains required template placeholders for context injection
 *  - Adopts an adversarial reviewer persona
 *  - Defines phase-specific quality standards (AC6)
 *  - Specifies a structured YAML output contract with actionable examples
 *  - Uses correct severity levels (blocker | major | minor)
 *
 * Also validates the refine-artifact prompt for structural correctness.
 *
 * These are static content tests — no agents are dispatched.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve a prompt file path relative to the project root. */
function promptPath(filename: string): string {
  return resolve(process.cwd(), 'packs', 'bmad', 'prompts', filename)
}

/** Read a prompt file and return its content. */
function readPrompt(filename: string): string {
  return readFileSync(promptPath(filename), 'utf-8')
}

// ---------------------------------------------------------------------------
// Shared structural assertions
// ---------------------------------------------------------------------------

/**
 * Assert that a critique prompt has the required structural elements:
 *  - artifact_content placeholder for the artifact under review
 *  - project_context placeholder for project-specific context
 *  - adversarial reviewer persona statement
 *  - YAML output contract with all required fields
 *  - severity classification (blocker | major | minor)
 */
function assertCritiqueStructure(content: string, promptName: string): void {
  // Required template placeholders
  expect(content, `${promptName}: missing {{artifact_content}} placeholder`).toContain(
    '{{artifact_content}}'
  )
  expect(content, `${promptName}: missing {{project_context}} placeholder`).toContain(
    '{{project_context}}'
  )

  // Adversarial persona — the reviewer must be instructed to find problems
  const hasAdversarialPersona =
    content.includes('adversarial') ||
    content.includes('find what') ||
    content.includes('Your job is to find')
  expect(hasAdversarialPersona, `${promptName}: missing adversarial reviewer persona`).toBe(true)

  // Output contract must specify YAML format with all required fields
  expect(content, `${promptName}: missing 'verdict' field in output contract`).toContain('verdict:')
  expect(content, `${promptName}: missing 'issue_count' field in output contract`).toContain(
    'issue_count:'
  )
  expect(content, `${promptName}: missing 'issues' field in output contract`).toContain('issues:')

  // Output contract must include both verdict values
  expect(content, `${promptName}: missing 'pass' verdict example`).toContain('verdict: pass')
  expect(content, `${promptName}: missing 'needs_work' verdict example`).toContain(
    'verdict: needs_work'
  )

  // Severity classification — all three levels must be documented
  expect(content, `${promptName}: missing 'blocker' severity`).toContain('blocker')
  expect(content, `${promptName}: missing 'major' severity`).toContain('major')
  expect(content, `${promptName}: missing 'minor' severity`).toContain('minor')

  // Issue fields must be present in the example
  expect(content, `${promptName}: missing 'category' field in issues`).toContain('category:')
  expect(content, `${promptName}: missing 'description' field in issues`).toContain('description:')
  expect(content, `${promptName}: missing 'suggestion' field in issues`).toContain('suggestion:')

  // Output contract correctness note
  expect(content, `${promptName}: missing issue_count integrity note`).toContain('issue_count')
}

/**
 * Assert that the example issues in the output contract are actionable:
 *  - Descriptions are specific (not generic "it's bad")
 *  - Suggestions are concrete improvements (not "fix it")
 */
function assertActionableExamples(content: string, promptName: string): void {
  // Extract the issues example section (between the first "issues:" and end of code block)
  const issuesSectionMatch = content.match(/issues:\s*\n([\s\S]*?)```/)
  expect(issuesSectionMatch, `${promptName}: could not find issues example block`).not.toBeNull()

  if (!issuesSectionMatch) return

  const issuesSection = issuesSectionMatch[1] ?? ''

  // Suggestions must reference specific actions, not vague ones
  const hasConcreteSuggestion =
    issuesSection.includes('Add') ||
    issuesSection.includes('Replace') ||
    issuesSection.includes('Define') ||
    issuesSection.includes('Specify') ||
    issuesSection.includes('Include')
  expect(
    hasConcreteSuggestion,
    `${promptName}: example suggestions must include concrete actions (Add, Replace, Define, etc.)`
  ).toBe(true)

  // Descriptions must be longer than a single word (at least 20 chars after the key)
  const descriptionMatches = [...issuesSection.matchAll(/description:\s*"([^"]+)"/g)]
  expect(
    descriptionMatches.length,
    `${promptName}: no description examples found in issues block`
  ).toBeGreaterThan(0)

  for (const match of descriptionMatches) {
    const desc = match[1] ?? ''
    expect(
      desc.length,
      `${promptName}: description "${desc}" is too short to be actionable`
    ).toBeGreaterThan(20)
  }

  // Suggestions must be longer than a single instruction (at least 20 chars)
  const suggestionMatches = [...issuesSection.matchAll(/suggestion:\s*"([^"]+)"/g)]
  expect(
    suggestionMatches.length,
    `${promptName}: no suggestion examples found in issues block`
  ).toBeGreaterThan(0)

  for (const match of suggestionMatches) {
    const suggestion = match[1] ?? ''
    expect(
      suggestion.length,
      `${promptName}: suggestion "${suggestion}" is too short to be actionable`
    ).toBeGreaterThan(20)
  }
}

// ---------------------------------------------------------------------------
// critique-analysis.md
// ---------------------------------------------------------------------------

describe('critique-analysis.md', () => {
  let content: string

  beforeAll(() => {
    content = readPrompt('critique-analysis.md')
  })

  it('exists and is non-empty', () => {
    expect(content.length).toBeGreaterThan(100)
  })

  it('has required structural elements', () => {
    assertCritiqueStructure(content, 'critique-analysis.md')
  })

  it('has actionable example issues', () => {
    assertActionableExamples(content, 'critique-analysis.md')
  })

  // AC6: Analysis-specific quality criteria
  it('checks problem clarity (AC6)', () => {
    const hasProblemClarity =
      content.toLowerCase().includes('problem clarity') ||
      content.toLowerCase().includes('problem statement')
    expect(hasProblemClarity, 'must check problem clarity').toBe(true)
  })

  it('checks user persona specificity (AC6)', () => {
    const hasPersona =
      content.toLowerCase().includes('user persona') ||
      content.toLowerCase().includes('persona specificity') ||
      content.toLowerCase().includes('target user')
    expect(hasPersona, 'must check user persona specificity').toBe(true)
  })

  it('checks metrics measurability (AC6)', () => {
    const hasMetrics =
      content.toLowerCase().includes('metric') &&
      (content.toLowerCase().includes('measur') || content.toLowerCase().includes('quantifi'))
    expect(hasMetrics, 'must check metrics measurability').toBe(true)
  })

  it('checks scope boundaries (AC6)', () => {
    const hasScope =
      content.toLowerCase().includes('scope') ||
      content.toLowerCase().includes('out-of-scope') ||
      content.toLowerCase().includes('boundaries')
    expect(hasScope, 'must check scope boundaries').toBe(true)
  })

  it('instructs agent to emit YAML only (no prose preamble)', () => {
    const hasYamlOnlyInstruction =
      content.includes('Emit ONLY') ||
      content.includes('ONLY this YAML') ||
      content.includes('no preamble') ||
      content.includes('no explanation')
    expect(hasYamlOnlyInstruction, 'must instruct agent to emit YAML only').toBe(true)
  })
})

// ---------------------------------------------------------------------------
// critique-planning.md
// ---------------------------------------------------------------------------

describe('critique-planning.md', () => {
  let content: string

  beforeAll(() => {
    content = readPrompt('critique-planning.md')
  })

  it('exists and is non-empty', () => {
    expect(content.length).toBeGreaterThan(100)
  })

  it('has required structural elements', () => {
    assertCritiqueStructure(content, 'critique-planning.md')
  })

  it('has actionable example issues', () => {
    assertActionableExamples(content, 'critique-planning.md')
  })

  // AC6: Planning-specific quality criteria
  it('checks FR completeness (AC6)', () => {
    const hasFR =
      content.toLowerCase().includes('functional requirement') ||
      content.toLowerCase().includes('fr completeness') ||
      content.match(/\bFR\b/)
    expect(hasFR, 'must check functional requirement completeness').toBeTruthy()
  })

  it('checks NFR measurability (AC6)', () => {
    const hasNFR =
      content.toLowerCase().includes('non-functional') ||
      content.toLowerCase().includes('nfr measurability') ||
      content.match(/\bNFR\b/)
    expect(hasNFR, 'must check NFR measurability').toBeTruthy()
  })

  it('checks user story quality (AC6)', () => {
    const hasUserStory =
      content.toLowerCase().includes('user story') || content.toLowerCase().includes('user stories')
    expect(hasUserStory, 'must check user story quality').toBe(true)
  })

  it('checks tech stack justification (AC6)', () => {
    const hasTechStack =
      content.toLowerCase().includes('tech stack') ||
      (content.toLowerCase().includes('technology') &&
        (content.toLowerCase().includes('justif') || content.toLowerCase().includes('rationale')))
    expect(hasTechStack, 'must check tech stack justification').toBeTruthy()
  })

  it('checks requirement traceability (AC6)', () => {
    const hasTraceability =
      content.toLowerCase().includes('tracability') ||
      content.toLowerCase().includes('traceability') ||
      content.toLowerCase().includes('trace back')
    expect(hasTraceability, 'must check requirement traceability').toBe(true)
  })

  it('instructs agent to emit YAML only (no prose preamble)', () => {
    const hasYamlOnlyInstruction =
      content.includes('Emit ONLY') ||
      content.includes('ONLY this YAML') ||
      content.includes('no preamble')
    expect(hasYamlOnlyInstruction, 'must instruct agent to emit YAML only').toBe(true)
  })
})

// ---------------------------------------------------------------------------
// critique-architecture.md
// ---------------------------------------------------------------------------

describe('critique-architecture.md', () => {
  let content: string

  beforeAll(() => {
    content = readPrompt('critique-architecture.md')
  })

  it('exists and is non-empty', () => {
    expect(content.length).toBeGreaterThan(100)
  })

  it('has required structural elements', () => {
    assertCritiqueStructure(content, 'critique-architecture.md')
  })

  it('has actionable example issues', () => {
    assertActionableExamples(content, 'critique-architecture.md')
  })

  // AC6: Architecture-specific quality criteria
  it('checks decision consistency / no contradictions (AC6)', () => {
    const hasConsistency =
      content.toLowerCase().includes('decision consistency') ||
      content.toLowerCase().includes('contradict') ||
      content.toLowerCase().includes('consistent')
    expect(hasConsistency, 'must check decision consistency').toBe(true)
  })

  it('checks technology version currency (AC6)', () => {
    const hasVersionCurrency =
      content.toLowerCase().includes('version currency') ||
      content.toLowerCase().includes('technology version') ||
      content.toLowerCase().includes('end-of-life') ||
      content.toLowerCase().includes('maintained')
    expect(hasVersionCurrency, 'must check technology version currency').toBe(true)
  })

  it('checks scalability considerations (AC6)', () => {
    const hasScalability =
      content.toLowerCase().includes('scalability') ||
      content.toLowerCase().includes('scaling') ||
      content.toLowerCase().includes('horizontal scal')
    expect(hasScalability, 'must check scalability considerations').toBe(true)
  })

  it('checks security coverage (AC6)', () => {
    const hasSecurity =
      content.toLowerCase().includes('security coverage') ||
      content.toLowerCase().includes('authentication') ||
      content.toLowerCase().includes('authorization')
    expect(hasSecurity, 'must check security coverage').toBe(true)
  })

  it('checks pattern coherence (AC6)', () => {
    const hasPatternCoherence =
      content.toLowerCase().includes('pattern coherence') ||
      content.toLowerCase().includes('architectural pattern') ||
      content.toLowerCase().includes('pattern violation')
    expect(hasPatternCoherence, 'must check pattern coherence').toBe(true)
  })

  it('instructs agent to emit YAML only (no prose preamble)', () => {
    const hasYamlOnlyInstruction =
      content.includes('Emit ONLY') ||
      content.includes('ONLY this YAML') ||
      content.includes('no preamble')
    expect(hasYamlOnlyInstruction, 'must instruct agent to emit YAML only').toBe(true)
  })
})

// ---------------------------------------------------------------------------
// critique-stories.md
// ---------------------------------------------------------------------------

describe('critique-stories.md', () => {
  let content: string

  beforeAll(() => {
    content = readPrompt('critique-stories.md')
  })

  it('exists and is non-empty', () => {
    expect(content.length).toBeGreaterThan(100)
  })

  it('has required structural elements', () => {
    assertCritiqueStructure(content, 'critique-stories.md')
  })

  it('has actionable example issues', () => {
    assertActionableExamples(content, 'critique-stories.md')
  })

  // AC6: Stories-specific quality criteria
  it('checks FR coverage (AC6)', () => {
    const hasFRCoverage =
      content.toLowerCase().includes('fr coverage') ||
      (content.toLowerCase().includes('functional requirement') &&
        content.toLowerCase().includes('covered'))
    expect(hasFRCoverage, 'must check FR coverage').toBeTruthy()
  })

  it('checks acceptance criteria testability (AC6)', () => {
    const hasAC =
      (content.toLowerCase().includes('acceptance criteria') ||
        content.toLowerCase().includes('acceptance criterion')) &&
      content.toLowerCase().includes('testab')
    expect(hasAC, 'must check acceptance criteria testability').toBe(true)
  })

  it('checks task granularity (AC6)', () => {
    const hasTaskGranularity =
      content.toLowerCase().includes('task granularity') ||
      content.toLowerCase().includes('task breakdown') ||
      content.toLowerCase().includes('granularity')
    expect(hasTaskGranularity, 'must check task granularity').toBe(true)
  })

  it('checks dependency validity (AC6)', () => {
    const hasDependency =
      content.toLowerCase().includes('dependency validity') ||
      content.toLowerCase().includes('circular dependency') ||
      content.toLowerCase().includes('dependencies')
    expect(hasDependency, 'must check dependency validity').toBe(true)
  })

  it('instructs agent to emit YAML only (no prose preamble)', () => {
    const hasYamlOnlyInstruction =
      content.includes('Emit ONLY') ||
      content.includes('ONLY this YAML') ||
      content.includes('no preamble')
    expect(hasYamlOnlyInstruction, 'must instruct agent to emit YAML only').toBe(true)
  })
})

// ---------------------------------------------------------------------------
// refine-artifact.md
// ---------------------------------------------------------------------------

describe('refine-artifact.md', () => {
  let content: string

  beforeAll(() => {
    content = readPrompt('refine-artifact.md')
  })

  it('exists and is non-empty', () => {
    expect(content.length).toBeGreaterThan(100)
  })

  it('has {{original_artifact}} placeholder', () => {
    expect(content).toContain('{{original_artifact}}')
  })

  it('has {{critique_issues}} placeholder', () => {
    expect(content).toContain('{{critique_issues}}')
  })

  it('has {{phase_context}} placeholder', () => {
    expect(content).toContain('{{phase_context}}')
  })

  it('instructs agent to address blocker issues', () => {
    const hasBlockerInstruction =
      content.toLowerCase().includes('blocker') &&
      (content.toLowerCase().includes('must be') ||
        content.toLowerCase().includes('fully resolved') ||
        content.toLowerCase().includes('resolved'))
    expect(hasBlockerInstruction, 'must instruct agent to fully resolve blockers').toBe(true)
  })

  it('instructs agent to address major issues', () => {
    const hasMajorInstruction =
      content.toLowerCase().includes('major') &&
      (content.toLowerCase().includes('addressed') || content.toLowerCase().includes('substantive'))
    expect(hasMajorInstruction, 'must instruct agent to address major issues').toBe(true)
  })

  it('instructs agent to return only the refined artifact (no prose preamble)', () => {
    const hasOutputOnlyInstruction =
      content.includes('Return ONLY') ||
      content.includes('no preamble') ||
      content.includes('no explanation') ||
      content.includes('Start directly')
    expect(
      hasOutputOnlyInstruction,
      'must instruct agent to return only the refined artifact'
    ).toBe(true)
  })

  it('instructs agent to preserve correct content from original', () => {
    const hasPreserveInstruction =
      content.toLowerCase().includes('preserv') &&
      (content.toLowerCase().includes('correct') || content.toLowerCase().includes('valid'))
    expect(hasPreserveInstruction, 'must instruct agent to preserve valid original content').toBe(
      true
    )
  })

  it('instructs agent to maintain original format/structure', () => {
    const hasFormatInstruction =
      content.toLowerCase().includes('format') ||
      content.toLowerCase().includes('structure') ||
      content.toLowerCase().includes('same format')
    expect(hasFormatInstruction, 'must instruct agent to maintain original format').toBe(true)
  })
})

// ---------------------------------------------------------------------------
// critique-research.md
// ---------------------------------------------------------------------------

describe('critique-research.md', () => {
  let content: string

  beforeAll(() => {
    content = readPrompt('critique-research.md')
  })

  it('exists and is non-empty', () => {
    expect(content.length).toBeGreaterThan(100)
  })

  it('has required structural elements', () => {
    assertCritiqueStructure(content, 'critique-research.md')
  })

  it('has actionable example issues', () => {
    assertActionableExamples(content, 'critique-research.md')
  })

  // AC6: Research-specific quality criteria
  it('checks source credibility (AC6)', () => {
    const hasSourceCredibility =
      content.toLowerCase().includes('source credibility') ||
      content.toLowerCase().includes('credible source') ||
      content.toLowerCase().includes('credibility')
    expect(hasSourceCredibility, 'must check source credibility').toBe(true)
  })

  it('checks finding relevance (AC6)', () => {
    const hasFindingRelevance =
      content.toLowerCase().includes('finding relevance') ||
      content.toLowerCase().includes('relevance') ||
      content.toLowerCase().includes('relevant')
    expect(hasFindingRelevance, 'must check finding relevance').toBe(true)
  })

  it('checks gap identification (AC6)', () => {
    const hasGapIdentification =
      content.toLowerCase().includes('gap identification') ||
      content.toLowerCase().includes('gap') ||
      content.toLowerCase().includes('missing')
    expect(hasGapIdentification, 'must check gap identification').toBe(true)
  })

  it('checks synthesis coherence (AC6)', () => {
    const hasSynthesisCoherence =
      content.toLowerCase().includes('synthesis coherence') ||
      content.toLowerCase().includes('synthesis') ||
      content.toLowerCase().includes('coherence')
    expect(hasSynthesisCoherence, 'must check synthesis coherence').toBe(true)
  })

  it('instructs agent to emit YAML only (no prose preamble)', () => {
    const hasYamlOnlyInstruction =
      content.includes('Emit ONLY') ||
      content.includes('ONLY this YAML') ||
      content.includes('no preamble') ||
      content.includes('no explanation')
    expect(hasYamlOnlyInstruction, 'must instruct agent to emit YAML only').toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Cross-prompt consistency
// ---------------------------------------------------------------------------

describe('critique prompt consistency', () => {
  const critiquePrompts = [
    'critique-analysis.md',
    'critique-planning.md',
    'critique-architecture.md',
    'critique-stories.md',
  ]

  it('all critique prompts use the same YAML output contract structure', () => {
    for (const promptFile of critiquePrompts) {
      const content = readPrompt(promptFile)

      // All must have the pass example
      expect(content, `${promptFile}: missing pass example`).toContain(
        'verdict: pass\nissue_count: 0\nissues: []'
      )

      // All must have the needs_work example
      expect(content, `${promptFile}: missing needs_work example`).toContain('verdict: needs_work')

      // All must enforce issue_count integrity
      expect(content, `${promptFile}: missing issue_count integrity enforcement`).toContain(
        'issue_count'
      )
    }
  })

  it('all critique prompts instruct agent to emit YAML only (structured output, not prose)', () => {
    for (const promptFile of critiquePrompts) {
      const content = readPrompt(promptFile)
      const hasStructuredOutputInstruction =
        content.includes('Emit ONLY') ||
        content.includes('ONLY this YAML') ||
        content.includes('no preamble, no explanation')
      expect(
        hasStructuredOutputInstruction,
        `${promptFile}: must instruct agent to emit structured output only`
      ).toBe(true)
    }
  })

  it('all critique prompts have distinct phase-specific quality standards sections', () => {
    const contents = critiquePrompts.map((f) => readPrompt(f))

    // Each prompt must have a "Quality Standards" section
    for (let i = 0; i < critiquePrompts.length; i++) {
      const content = contents[i]!
      expect(content, `${critiquePrompts[i]}: missing Quality Standards section`).toContain(
        'Quality Standards'
      )
    }

    // The quality standard section headers should differ between prompts
    // (i.e., they are phase-specific, not copy-pasted from each other)
    const qualityKeywords = contents.map((c) => {
      const match = c.match(/## Quality Standards[\s\S]*?---/)
      return match ? match[0] : ''
    })

    // Each prompt must have a non-empty quality standards section
    for (let i = 0; i < critiquePrompts.length; i++) {
      expect(
        qualityKeywords[i]?.length ?? 0,
        `${critiquePrompts[i]}: Quality Standards section is empty`
      ).toBeGreaterThan(50)
    }

    // Quality standards sections must not be identical (each is phase-specific)
    const uniqueSections = new Set(qualityKeywords)
    expect(
      uniqueSections.size,
      'All critique prompts have identical quality standards — they must be phase-specific'
    ).toBe(critiquePrompts.length)
  })
})
