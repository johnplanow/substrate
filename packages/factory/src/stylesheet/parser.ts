/**
 * CSS-like stylesheet parser for the `model_stylesheet` graph attribute.
 *
 * Grammar (Attractor Spec §8.2):
 *   Stylesheet    ::= Rule*
 *   Rule          ::= Selector '{' Declaration ( ';' Declaration )* ';'? '}'
 *   Selector      ::= '*' | ShapeName | '#' Identifier | '.' ClassName
 *   ClassName     ::= [a-z0-9_-]+
 *   ShapeName     ::= [a-zA-Z_][a-zA-Z0-9_]*
 *   Identifier    ::= [a-zA-Z_][a-zA-Z0-9_]*
 *   Declaration   ::= Property ':' PropertyValue
 *   Property      ::= 'llm_model' | 'llm_provider' | 'reasoning_effort'
 *   PropertyValue ::= QuotedString | BareValue
 *   QuotedString  ::= '"' [^"]* '"' | "'" [^']* "'"
 *   BareValue     ::= [^\s;{}]+
 *
 * Story 42-7.
 */

import type {
  ParsedStylesheet,
  StylesheetDeclaration,
  StylesheetProperty,
  StylesheetRule,
  StylesheetSelector,
} from '../graph/types.js'

// ---------------------------------------------------------------------------
// StylesheetParseError
// ---------------------------------------------------------------------------

/**
 * Thrown by `parseStylesheet` when the stylesheet source does not conform
 * to the supported grammar.
 */
export class StylesheetParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StylesheetParseError'
  }
}

// ---------------------------------------------------------------------------
// Valid properties
// ---------------------------------------------------------------------------

const VALID_PROPERTIES: ReadonlySet<string> = new Set<StylesheetProperty>([
  'llm_model',
  'llm_provider',
  'reasoning_effort',
])

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Strip C-style block comments (`/* ... *\/`) and line comments (`// ...`)
 * from the source string before parsing.
 */
function stripComments(source: string): string {
  // Strip block comments: /* ... */  (non-greedy, dotall)
  let result = source.replace(/\/\*[\s\S]*?\*\//g, '')
  // Strip line comments: // ... (to end of line)
  result = result.replace(/\/\/[^\n]*/g, '')
  return result
}

/**
 * Strip surrounding single or double quotes from a property value string.
 * Returns the original string if it is not quoted.
 */
function stripValueQuotes(value: string): string {
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
 * Parse a selector token string into a `StylesheetSelector`.
 * Throws `StylesheetParseError` for invalid selector syntax.
 */
function parseSelector(token: string): StylesheetSelector {
  if (token === '*') {
    return { type: 'universal', value: '*', specificity: 0 }
  }

  if (token.startsWith('#')) {
    const name = token.slice(1)
    if (!name || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      throw new StylesheetParseError(
        `Invalid ID selector '${token}'; expected '#' followed by an identifier matching [a-zA-Z_][a-zA-Z0-9_]*`
      )
    }
    return { type: 'id', value: name, specificity: 3 }
  }

  if (token.startsWith('.')) {
    const name = token.slice(1)
    if (!name || !/^[a-z0-9_-]+$/.test(name)) {
      throw new StylesheetParseError(
        `Invalid class selector '${token}'; expected '.' followed by a class name matching [a-z0-9_-]+`
      )
    }
    return { type: 'class', value: name, specificity: 2 }
  }

  // Shape selector — bare identifier
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(token)) {
    throw new StylesheetParseError(
      `Invalid selector '${token}'; expected '*', a shape name ([a-zA-Z_][a-zA-Z0-9_]*), '#identifier', or '.classname'`
    )
  }
  return { type: 'shape', value: token, specificity: 1 }
}

/**
 * Parse the declaration block content (text between `{` and `}`) for a rule.
 *
 * @param content   - Raw text between the opening and closing braces.
 * @param selector  - Selector token string (used only for error messages).
 * @returns An array of parsed `StylesheetDeclaration` objects.
 * @throws `StylesheetParseError` on unknown property or malformed pair.
 */
function parseDeclarations(content: string, selector: string): StylesheetDeclaration[] {
  const declarations: StylesheetDeclaration[] = []
  const segments = content.split(';')

  for (const segment of segments) {
    const trimmed = segment.trim()
    if (trimmed === '') continue // empty segment from trailing semicolon or whitespace

    const colonPos = trimmed.indexOf(':')
    if (colonPos === -1) {
      throw new StylesheetParseError(
        `Invalid declaration in selector '${selector}': missing ':' in '${trimmed}'`
      )
    }

    const propRaw = trimmed.slice(0, colonPos).trim()
    const valueRaw = trimmed.slice(colonPos + 1).trim()

    if (!VALID_PROPERTIES.has(propRaw)) {
      throw new StylesheetParseError(
        `Unknown property '${propRaw}' in selector '${selector}'; ` +
          `expected one of: ${[...VALID_PROPERTIES].join(', ')}`
      )
    }

    const value = stripValueQuotes(valueRaw)
    if (value === '') {
      throw new StylesheetParseError(
        `Missing value for property '${propRaw}' in selector '${selector}'`
      )
    }

    declarations.push({ property: propRaw as StylesheetProperty, value })
  }

  return declarations
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a CSS-like model stylesheet string into a `ParsedStylesheet`.
 *
 * The parser:
 * - Strips C-style block comments (`/* ... * /`) and `//` line comments before parsing.
 * - Recognises four selector types: universal (`*`), shape (bare identifier),
 *   class (`.name`), and ID (`#name`).
 * - Validates that every declared property is one of the three known routing
 *   properties: `llm_model`, `llm_provider`, `reasoning_effort`.
 * - Preserves source order in the returned array.
 *
 * @param source - The raw stylesheet string.
 * @returns A `ParsedStylesheet` (array of `StylesheetRule`) in source order.
 * @throws `StylesheetParseError` on syntax errors, unknown properties, or
 *   unbalanced braces.
 */
export function parseStylesheet(source: string): ParsedStylesheet {
  const cleaned = stripComments(source)
  const rules: StylesheetRule[] = []

  let pos = 0

  while (pos < cleaned.length) {
    // Skip leading whitespace
    while (pos < cleaned.length && /\s/.test(cleaned[pos]!)) pos++
    if (pos >= cleaned.length) break

    // Find the opening brace for this rule
    const braceOpenPos = cleaned.indexOf('{', pos)
    if (braceOpenPos === -1) {
      // Remaining content has no opening brace — it's an error if non-empty
      const remaining = cleaned.slice(pos).trim()
      if (remaining !== '') {
        throw new StylesheetParseError(
          `Unexpected content without opening brace '{': '${remaining}'`
        )
      }
      break
    }

    // Extract and validate the selector token
    const selectorToken = cleaned.slice(pos, braceOpenPos).trim()
    if (selectorToken === '') {
      throw new StylesheetParseError(`Empty selector before '{'`)
    }

    // Find the matching closing brace
    const braceClosePos = cleaned.indexOf('}', braceOpenPos + 1)
    if (braceClosePos === -1) {
      throw new StylesheetParseError(`Missing closing brace '}' for selector '${selectorToken}'`)
    }

    // The block content between { and }
    const blockContent = cleaned.slice(braceOpenPos + 1, braceClosePos)

    // Reject nested braces (unbalanced — inner '{' inside block)
    if (blockContent.includes('{')) {
      throw new StylesheetParseError(
        `Unexpected '{' inside declaration block for selector '${selectorToken}'; nested rules are not supported`
      )
    }

    const selector = parseSelector(selectorToken)
    const declarations = parseDeclarations(blockContent, selectorToken)

    rules.push({ selector, declarations })

    pos = braceClosePos + 1
  }

  return rules
}
