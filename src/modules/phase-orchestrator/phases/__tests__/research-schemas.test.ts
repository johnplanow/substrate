import { describe, it, expect } from 'vitest'
import { ResearchDiscoveryOutputSchema, ResearchSynthesisOutputSchema } from '../schemas.js'

describe('ResearchDiscoveryOutputSchema', () => {
  it('parses valid discovery output with all fields', () => {
    const input = {
      result: 'success',
      concept_classification: 'B2B SaaS platform targeting DevOps teams in the cloud infrastructure space',
      market_findings: 'The cloud automation market is valued at $12B growing at 18% CAGR.',
      domain_findings: 'Industry standards include Terraform HCL and GitOps workflows (CNCF). SOC 2 Type II is table stakes for enterprise.',
      technical_findings: 'Dominant pattern is event-driven with control plane / data plane separation. Primary challenge is state reconciliation.',
    }
    const result = ResearchDiscoveryOutputSchema.parse(input)
    expect(result.result).toBe('success')
    expect(result.concept_classification).toBe(input.concept_classification)
    expect(result.market_findings).toBe(input.market_findings)
    expect(result.domain_findings).toBe(input.domain_findings)
    expect(result.technical_findings).toBe(input.technical_findings)
  })

  it('parses result: failed without content fields (AC7)', () => {
    const input = { result: 'failed' }
    const result = ResearchDiscoveryOutputSchema.parse(input)
    expect(result.result).toBe('failed')
    expect(result.concept_classification).toBeUndefined()
    expect(result.market_findings).toBeUndefined()
    expect(result.domain_findings).toBeUndefined()
    expect(result.technical_findings).toBeUndefined()
  })

  it('rejects invalid result enum value', () => {
    const input = { result: 'invalid' }
    expect(() => ResearchDiscoveryOutputSchema.parse(input)).toThrow()
  })
})

describe('ResearchSynthesisOutputSchema', () => {
  it('parses valid synthesis output with all fields', () => {
    const input = {
      result: 'success',
      market_context: 'The cloud infrastructure automation market is a $12B opportunity growing at 18% CAGR.',
      competitive_landscape: 'Direct competitors include Terraform Cloud, Spacelift, and Scalr. Differentiation opportunity in AI-assisted workflows.',
      technical_feasibility: 'High feasibility using proven Go agent + event-driven control plane pattern.',
      risk_flags: [
        'Regulatory: SOC 2 Type II compliance adds 4-6 months to enterprise close',
        'Technical: Distributed state reconciliation under network partitions is an unsolved problem',
      ],
      opportunity_signals: [
        'AI-native workflows: no incumbent offers natural-language policy authoring',
        'OpenTofu migration wave: 30%+ of Terraform users are evaluating alternatives',
      ],
    }
    const result = ResearchSynthesisOutputSchema.parse(input)
    expect(result.result).toBe('success')
    expect(result.market_context).toBe(input.market_context)
    expect(result.competitive_landscape).toBe(input.competitive_landscape)
    expect(result.technical_feasibility).toBe(input.technical_feasibility)
    expect(result.risk_flags).toHaveLength(2)
    expect(result.opportunity_signals).toHaveLength(2)
  })

  it('parses result: failed without content fields (AC7)', () => {
    const input = { result: 'failed' }
    const result = ResearchSynthesisOutputSchema.parse(input)
    expect(result.result).toBe('failed')
    expect(result.market_context).toBeUndefined()
    expect(result.competitive_landscape).toBeUndefined()
    expect(result.technical_feasibility).toBeUndefined()
  })

  it('rejects invalid result enum value', () => {
    const input = { result: 'invalid' }
    expect(() => ResearchSynthesisOutputSchema.parse(input)).toThrow()
  })

  it('defaults risk_flags and opportunity_signals to [] when omitted', () => {
    const input = { result: 'success', market_context: 'Some market context.' }
    const result = ResearchSynthesisOutputSchema.parse(input)
    expect(result.risk_flags).toEqual([])
    expect(result.opportunity_signals).toEqual([])
  })
})
