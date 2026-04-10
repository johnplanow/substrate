/**
 * Condition expression parser and evaluator for the factory graph engine.
 *
 * Grammar (Attractor Spec §10, extended in story 44-5):
 *   condition      ::= clause ('&&' clause)*
 *   clause         ::= key op value
 *   key            ::= [a-zA-Z_][a-zA-Z0-9_]*
 *   op             ::= '=' | '!=' | '>=' | '<=' | '>' | '<'
 *   value          ::= quoted_string | unquoted_token
 *   quoted_string  ::= '"' [^"]* '"' | "'" [^']* "'"
 *   unquoted_token ::= [^\s&&]+
 *
 * Numeric operators (>=, <=, >, <) coerce context values to Number and compare.
 * String operators (=, !=) retain existing case-sensitive string-equality semantics.
 * Missing context keys resolve to "" for = / != and NaN for numeric operators.
 * Only && conjunction is supported; || is out of scope.
 *
 * Story 42-6, extended in story 44-5.
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
 *
 * Operator matching order (two-character before one-character to avoid mis-parsing):
 *   >=  <=  !=  >  <  =
 */
function parseClause(clauseStr: string): ConditionClause {
  const trimmed = clauseStr.trim()

  if (trimmed === '') {
    throw new ConditionParseError(
      `Empty clause in condition; each clause must be in the form 'key=value' or 'key!=value'`
    )
  }

  // Detect double-equals (invalid operator) — check before any single-= matching
  if (trimmed.includes('==')) {
    throw new ConditionParseError(
      `Invalid operator '==' in clause '${trimmed}'; use '=' for equality comparison`
    )
  }

  // --- Two-character operators (must be checked BEFORE single-character) ---

  // Try >= operator
  const gteMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*>=\s*(.*)$/.exec(trimmed)
  if (gteMatch) {
    const key = gteMatch[1]!
    const rawValue = gteMatch[2]!.trim()
    if (rawValue === '') {
      throw new ConditionParseError(`Missing value in clause '${trimmed}'; expected 'key>=value'`)
    }
    return { key, op: '>=', value: stripQuotes(rawValue) }
  }

  // Try <= operator
  const lteMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*<=\s*(.*)$/.exec(trimmed)
  if (lteMatch) {
    const key = lteMatch[1]!
    const rawValue = lteMatch[2]!.trim()
    if (rawValue === '') {
      throw new ConditionParseError(`Missing value in clause '${trimmed}'; expected 'key<=value'`)
    }
    return { key, op: '<=', value: stripQuotes(rawValue) }
  }

  // Try != operator (must precede = check to avoid false match on the '=' within '!=')
  const neqMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*!=\s*(.*)$/.exec(trimmed)
  if (neqMatch) {
    const key = neqMatch[1]!
    const rawValue = neqMatch[2]!.trim()
    if (rawValue === '') {
      throw new ConditionParseError(`Missing value in clause '${trimmed}'; expected 'key!=value'`)
    }
    return { key, op: '!=', value: stripQuotes(rawValue) }
  }

  // --- Single-character operators ---

  // Try > operator (single, after >= has been excluded)
  const gtMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*>\s*(.*)$/.exec(trimmed)
  if (gtMatch) {
    const key = gtMatch[1]!
    const rawValue = gtMatch[2]!.trim()
    if (rawValue === '') {
      throw new ConditionParseError(`Missing value in clause '${trimmed}'; expected 'key>value'`)
    }
    return { key, op: '>', value: stripQuotes(rawValue) }
  }

  // Try < operator (single, after <= has been excluded)
  const ltMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*<\s*(.*)$/.exec(trimmed)
  if (ltMatch) {
    const key = ltMatch[1]!
    const rawValue = ltMatch[2]!.trim()
    if (rawValue === '') {
      throw new ConditionParseError(`Missing value in clause '${trimmed}'; expected 'key<value'`)
    }
    return { key, op: '<', value: stripQuotes(rawValue) }
  }

  // Try = operator (single equality, after all compound operators)
  const eqMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.*)$/.exec(trimmed)
  if (eqMatch) {
    const key = eqMatch[1]!
    const rawValue = eqMatch[2]!.trim()
    if (rawValue === '') {
      throw new ConditionParseError(`Missing value in clause '${trimmed}'; expected 'key=value'`)
    }
    return { key, op: '=', value: stripQuotes(rawValue) }
  }

  throw new ConditionParseError(
    `Invalid clause syntax: '${trimmed}'; expected 'key=value', 'key!=value', or a numeric comparison`
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
 * String operators (=, !=): context values are coerced to strings via String().
 *   Context keys absent from context resolve to "" (empty string).
 *
 * Numeric operators (>=, <=, >, <): context values are coerced to numbers via Number().
 *   Absent keys or non-numeric values produce NaN, which causes the comparison to return false.
 *   The clause value is parsed via parseFloat().
 *
 * Returns `true` only if every clause in the conjunction passes.
 *
 * @param conditionStr - The condition string to evaluate.
 * @param context      - Key/value map of the current runtime context.
 * @returns `true` if all clauses evaluate to true, `false` otherwise.
 * @throws `ConditionParseError` if `conditionStr` has invalid syntax.
 */
export function evaluateCondition(conditionStr: string, context: Record<string, unknown>): boolean {
  const clauses = parseCondition(conditionStr)

  for (const clause of clauses) {
    const rawValue = context[clause.key]

    if (clause.op === '=' || clause.op === '!=') {
      // String equality — coerce context value to string; absent keys → ""
      const contextStr = rawValue !== undefined ? String(rawValue) : ''
      if (clause.op === '=') {
        if (contextStr !== clause.value) return false
      } else {
        // '!='
        if (contextStr === clause.value) return false
      }
    } else {
      // Numeric comparison — coerce context value to number; absent/non-numeric → NaN → false
      const numContextValue = rawValue !== undefined ? Number(rawValue) : NaN
      const numClauseValue = parseFloat(clause.value)
      if (Number.isNaN(numContextValue) || Number.isNaN(numClauseValue)) return false
      switch (clause.op) {
        case '>=':
          if (!(numContextValue >= numClauseValue)) return false
          break
        case '<=':
          if (!(numContextValue <= numClauseValue)) return false
          break
        case '>':
          if (!(numContextValue > numClauseValue)) return false
          break
        case '<':
          if (!(numContextValue < numClauseValue)) return false
          break
      }
    }
  }

  return true
}
