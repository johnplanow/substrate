/**
 * Prompt assembler for the compiled-workflows module.
 *
 * Provides shared prompt assembly logic with token budget enforcement.
 * Replaces {{placeholder}} patterns in a template with section content,
 * then truncates optional sections if the total exceeds the token ceiling.
 *
 * Token estimation uses chars/4, consistent with context-compiler/token-counter.ts.
 */

import { countTokens, truncateToTokens } from '../context-compiler/token-counter.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('compiled-workflows:prompt-assembler')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Priority ordering for sections in the prompt assembler.
 * Required sections are never truncated; optional sections are truncated first.
 */
export type SectionPriority = 'required' | 'important' | 'optional'

/**
 * A named section with its content and priority.
 */
export interface PromptSection {
  name: string
  content: string
  priority: SectionPriority
}

/**
 * Result from assemblePrompt().
 */
export interface AssembleResult {
  prompt: string
  tokenCount: number
  truncated: boolean
}

// ---------------------------------------------------------------------------
// assemblePrompt
// ---------------------------------------------------------------------------

/**
 * Assemble a final prompt from a template and sections map.
 *
 * Steps:
 * 1. Build a map of placeholder → content from sections array
 * 2. Replace {{placeholder}} patterns in the template
 * 3. Estimate total token count
 * 4. If over ceiling, truncate sections in reverse priority order
 * 5. Return assembled prompt with token count and truncation flag
 *
 * @param template - Prompt template with {{placeholder}} markers
 * @param sections - Named sections with content and priority
 * @param tokenCeiling - Hard token ceiling (default: 2200)
 */
export function assemblePrompt(
  template: string,
  sections: PromptSection[],
  tokenCeiling: number = 2200,
): AssembleResult {
  // Build content map from sections
  const contentMap: Record<string, string> = {}
  for (const section of sections) {
    contentMap[section.name] = section.content
  }

  // Apply initial placeholder replacement
  let prompt = replacePlaceholders(template, contentMap)
  let tokenCount = countTokens(prompt)

  if (tokenCount <= tokenCeiling) {
    return { prompt, tokenCount, truncated: false }
  }

  // Over budget — truncate sections by reverse priority (optional first)
  logger.warn(
    { tokenCount, ceiling: tokenCeiling },
    'Prompt exceeds token ceiling — truncating optional sections',
  )

  const priorityOrder: SectionPriority[] = ['optional', 'important']
  let truncated = false

  for (const priority of priorityOrder) {
    const sectionsAtPriority = sections.filter((s) => s.priority === priority)

    for (const section of sectionsAtPriority) {
      if (tokenCount <= tokenCeiling) break

      // Estimate how many tokens are over budget
      const overBy = tokenCount - tokenCeiling
      const currentSectionTokens = countTokens(section.content)

      if (currentSectionTokens === 0) continue

      // Calculate how much to cut from this section
      const targetSectionTokens = Math.max(0, currentSectionTokens - overBy)

      if (targetSectionTokens === 0) {
        // Eliminate this section entirely
        contentMap[section.name] = ''
        logger.warn({ sectionName: section.name }, 'Section eliminated to fit token budget')
      } else {
        // Truncate the section
        contentMap[section.name] = truncateToTokens(section.content, targetSectionTokens)
        logger.warn(
          { sectionName: section.name, targetSectionTokens },
          'Section truncated to fit token budget',
        )
      }

      truncated = true
      // Rebuild prompt with updated content
      prompt = replacePlaceholders(template, contentMap)
      tokenCount = countTokens(prompt)
    }

    if (tokenCount <= tokenCeiling) break
  }

  // If required sections alone exceed the ceiling, we cannot truncate further.
  // Warn and return the over-budget prompt so the caller can proceed.
  if (tokenCount > tokenCeiling) {
    logger.warn(
      { tokenCount, ceiling: tokenCeiling },
      'Required sections alone exceed token ceiling — returning over-budget prompt',
    )
  }

  return { prompt, tokenCount, truncated }
}

// ---------------------------------------------------------------------------
// replacePlaceholders
// ---------------------------------------------------------------------------

/**
 * Replace {{placeholder}} patterns in template with values from contentMap.
 * Missing placeholders are replaced with an empty string.
 */
function replacePlaceholders(template: string, contentMap: Record<string, string>): string {
  return template.replace(/\{\{(\w[\w_-]*)\}\}/g, (_match, key: string) => {
    return contentMap[key] ?? ''
  })
}
