// src/modules/eval/layers/prompt-compliance.ts
import type { EvalAssertion } from '../types.js'

export class PromptComplianceLayer {
  buildAssertions(
    promptTemplate: string,
    output: string,
    context: Record<string, string>,
  ): EvalAssertion[] {
    if (!promptTemplate.trim()) return []

    const assertions: EvalAssertion[] = []

    const mission = this.extractSection(promptTemplate, 'Mission')
    const instructions = this.extractSection(promptTemplate, 'Instructions')
    const qualityBar = this.extractSection(promptTemplate, 'Quality Bar')

    const rubricParts: string[] = [
      'Evaluate whether this output follows the prompt instructions.',
      '',
      'The prompt specified:',
    ]

    if (mission) {
      rubricParts.push(`\n**Mission:**\n${mission}`)
    }
    if (instructions) {
      rubricParts.push(`\n**Instructions:**\n${instructions}`)
    }
    if (qualityBar) {
      rubricParts.push(`\n**Quality Bar:**\n${qualityBar}`)
    }

    rubricParts.push(
      '',
      'Score on a 0-1 scale:',
      '- 1.0: Output fully follows all instructions with depth and specificity',
      '- 0.7: Output addresses most instructions but some lack depth',
      '- 0.4: Output misses significant instructions or is shallow',
      '- 0.0: Output ignores the prompt instructions entirely',
    )

    if (rubricParts.length > 3) {
      assertions.push({
        type: 'llm-rubric',
        value: rubricParts.join('\n'),
        label: 'instruction-compliance',
      })
    }

    const contextKeys = Object.keys(context).filter((k) => context[k].length > 0)
    if (contextKeys.length > 0) {
      const contextSummary = contextKeys
        .map((k) => {
          const val = context[k]
          const preview = val.length > 200 ? val.slice(0, 200) + '...' : val
          return `- ${k}: "${preview}"`
        })
        .join('\n')

      assertions.push({
        type: 'llm-rubric',
        value: [
          'Evaluate whether this output demonstrates awareness of the context it was given.',
          '',
          'The following context was injected into the prompt:',
          contextSummary,
          '',
          'Score on a 0-1 scale:',
          '- 1.0: Output clearly references and builds on the provided context',
          '- 0.7: Output uses most of the context but misses some key details',
          '- 0.4: Output mentions the context superficially without incorporating it',
          '- 0.0: Output ignores the provided context entirely',
        ].join('\n'),
        label: 'context-awareness',
      })
    }

    return assertions
  }

  private extractSection(template: string, sectionName: string): string | null {
    const regex = new RegExp(`^(#{1,3})\\s+${sectionName}\\s*$`, 'im')
    const match = regex.exec(template)
    if (!match) return null

    const headerLevel = match[1].length
    const startIdx = match.index + match[0].length

    const nextHeaderRegex = new RegExp(`^#{1,${headerLevel}}\\s+`, 'im')
    const remaining = template.slice(startIdx)
    const nextMatch = nextHeaderRegex.exec(remaining)

    const content = nextMatch
      ? remaining.slice(0, nextMatch.index).trim()
      : remaining.trim()

    return content || null
  }
}
