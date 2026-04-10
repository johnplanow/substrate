/**
 * Graph validator factory.
 * Story 42-4: Graph Validator — Error Rules
 *
 * `createValidator()` returns a `GraphValidator` pre-loaded with all 8 error rules.
 * Additional rules (e.g., warnings from story 42-5) can be added via `registerRule()`.
 */

import type { Graph, GraphValidator, LintRule, ValidationDiagnostic } from './types.js'
import { errorRules } from './rules/error-rules.js'
import { warningRules } from './rules/warning-rules.js'

// Re-export node detection helpers for consumers (stories 42-9, 42-14).
export { isStartNode, isExitNode } from './rules/error-rules.js'

/**
 * Create a new `GraphValidator` pre-registered with all 8 error-severity rules
 * and all 5 warning-severity rules.
 * Additional rules can be registered via `registerRule()`.
 */
export function createValidator(): GraphValidator {
  const rules: LintRule[] = [...errorRules, ...warningRules]

  return {
    registerRule(rule: LintRule): void {
      rules.push(rule)
    },

    validate(graph: Graph): ValidationDiagnostic[] {
      const diagnostics: ValidationDiagnostic[] = []
      for (const rule of rules) {
        diagnostics.push(...rule.check(graph))
      }
      return diagnostics
    },

    validateOrRaise(graph: Graph): void {
      const diagnostics = this.validate(graph)
      const errors = diagnostics.filter((d) => d.severity === 'error')
      if (errors.length > 0) {
        throw new Error(
          'Graph validation failed:\n' + errors.map((d) => `[${d.ruleId}] ${d.message}`).join('\n')
        )
      }
    },
  }
}
