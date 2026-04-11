// src/modules/eval/__tests__/prompt-compliance.test.ts
import { describe, it, expect } from 'vitest'
import { PromptComplianceLayer } from '../layers/prompt-compliance.js'
import type { EvalAssertion } from '../types.js'

describe('PromptComplianceLayer', () => {
  it('extracts instructions from a prompt template and builds assertions', () => {
    const layer = new PromptComplianceLayer()

    const promptTemplate = `
# Analysis Agent

## Mission
Analyze the project concept and produce a structured Product Brief.

## Instructions
1. Identify the core problem being solved
2. Define target user segments with specificity
3. List core features that address user needs
4. Define measurable success metrics

## Quality Bar
Every field should contain enough detail that a developer could begin work without further clarification.

## Output Contract
Emit ONLY this YAML block as your final output.
`
    const output = 'problem_statement: A CLI tool for task management...'
    const context = { concept: 'Build a CLI task tracker' }

    const assertions = layer.buildAssertions(promptTemplate, output, context)

    expect(assertions.length).toBeGreaterThan(0)
    expect(assertions.some((a: EvalAssertion) => a.type === 'llm-rubric')).toBe(true)
    const rubric = assertions.find((a: EvalAssertion) => a.type === 'llm-rubric')!
    expect(rubric.value).toContain('Instructions')
  })

  it('includes context awareness check when context is provided', () => {
    const layer = new PromptComplianceLayer()

    const promptTemplate = `
## Mission
Create a PRD from the product brief.

## Context
### Product Brief
{{product_brief}}
`
    const output = 'functional_requirements: ...'
    const context = { product_brief: 'Problem: Users cannot track CLI tasks...' }

    const assertions = layer.buildAssertions(promptTemplate, output, context)

    const contextAssertion = assertions.find((a: EvalAssertion) => a.label === 'context-awareness')
    expect(contextAssertion).toBeDefined()
    expect(contextAssertion!.value).toContain('context')
  })

  it('returns empty assertions for empty prompt template', () => {
    const layer = new PromptComplianceLayer()
    const assertions = layer.buildAssertions('', 'output', {})
    expect(assertions).toEqual([])
  })
})
