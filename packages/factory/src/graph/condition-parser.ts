/**
 * Condition expression parser and evaluator for the factory graph engine.
 *
 * Grammar (Attractor Spec §10):
 *   condition      ::= clause ('&&' clause)*
 *   clause         ::= key op value
 *   key            ::= [a-zA-Z_][a-zA-Z0-9_]*
 *   op             ::= '=' | '!='
 *   value          ::= quoted_string | unquoted_token
 *   quoted_string  ::= '"' [^"]* '"' | "'" [^']* "'"
 *   unquoted_token ::= [^\s&&]+
 *
 * All comparisons are case-sensitive.
 * Missing context keys resolve to "" (empty string).
 * Only && conjunction is supported; || is out of scope.
 *
 * Story 42-6.
 */

import type { ConditionClause, ParsedCondition } from './types.js'

// ---------------------------------------------------------------------------
// ConditionParseError
// ---------------------------------------------------------------------------

/**
 * Thrown by `parseCondition` when a condition string does not conform
 * to the supported grammar.
 */
export class ConditionParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConditionParseError'
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Strip surrounding single or double quotes from a value string.
 * Returns the original string unchanged if it is not a quoted string.
 */
function stripQuotes(value: string): string {
  if (value.length >= 2) {
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1)
    }
  }
  return value
}

/**
 * Parse a single clause string into a `ConditionClause`.
 * Throws `ConditionParseError` for invalid syntax.
 */
function parseClause(clauseStr: string): ConditionClause {
  const trimmed = clauseStr.trim()

  if (trimmed === '') {
    throw new ConditionParseError(
      `Empty clause in condition; each clause must be in the form 'key=value' or 'key!=value'`,
    )
  }

  // Detect double-equals (invalid operator)
  if (trimmed.includes('==')) {
    throw new ConditionParseError(
      `Invalid operator '==' in clause '${trimmed}'; use '=' for equality comparison`,
    )
  }

  // Try != operator first (must precede = check to avoid false match on the '=' within '!=')
  const neqMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*!=\s*(.*)$/.exec(trimmed)
  if (neqMatch) {
    const key = neqMatch[1]!
    const rawValue = neqMatch[2]!.trim()
    if (rawValue === '') {
      throw new ConditionParseError(
        `Missing value in clause '${trimmed}'; expected 'key!=value'`,
      )
    }
    return { key, op: '!=', value: stripQuotes(rawValue) }
  }

  // Try = operator
  const eqMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.*)$/.exec(trimmed)
  if (eqMatch) {
    const key = eqMatch[1]!
    const rawValue = eqMatch[2]!.trim()
    if (rawValue === '') {
      throw new ConditionParseError(
        `Missing value in clause '${trimmed}'; expected 'key=value'`,
      )
    }
    return { key, op: '=', value: stripQuotes(rawValue) }
  }

  throw new ConditionParseError(
    `Invalid clause syntax: '${trimmed}'; expected 'key=value' or 'key!=value'`,
  )
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a condition expression string into a `ParsedCondition` (array of clauses).
 *
 * @param conditionStr - The condition string to parse (e.g. `"outcome=success && iteration!=0"`).
 * @returns An array of `ConditionClause` objects representing the conjunction.
 * @throws `ConditionParseError` if the string is empty, contains an empty clause,
 *   uses an invalid operator (`==`), or otherwise does not conform to the grammar.
 */
export function parseCondition(conditionStr: string): ParsedCondition {
  if (!conditionStr || conditionStr.trim() === '') {
    throw new ConditionParseError('Condition string must not be empty')
  }

  const clauseStrings = conditionStr.split('&&')
  const clauses: ConditionClause[] = []

  for (const clauseStr of clauseStrings) {
    clauses.push(parseClause(clauseStr))
  }

  return clauses
}

/**
 * Evaluate a condition expression against a runtime context.
 *
 * All context values are coerced to strings via `String()`.
 * Context keys absent from `context` resolve to `""` (empty string).
 * Returns `true` only if every clause in the conjunction passes.
 *
 * @param conditionStr - The condition string to evaluate.
 * @param context      - Key/value map of the current runtime context.
 * @returns `true` if all clauses evaluate to true, `false` otherwise.
 * @throws `ConditionParseError` if `conditionStr` has invalid syntax.
 */
export function evaluateCondition(
  conditionStr: string,
  context: Record<string, unknown>,
): boolean {
  const clauses = parseCondition(conditionStr)

  for (const clause of clauses) {
    const rawValue = context[clause.key]
    const contextStr = rawValue !== undefined ? String(rawValue) : ''

    if (clause.op === '=') {
      if (contextStr !== clause.value) return false
    } else {
      // '!='
      if (contextStr === clause.value) return false
    }
  }

  return true
}
