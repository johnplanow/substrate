/**
 * Task graph file and string parser.
 *
 * Reads YAML or JSON task graph files/strings and returns raw parsed objects
 * (before Zod validation). Format is determined by file extension for file-based
 * loading, or explicitly specified for string-based loading.
 */

import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { load as parse } from 'js-yaml'
import type { RawTaskGraph } from './schemas.js'

// ---------------------------------------------------------------------------
// ParseError
// ---------------------------------------------------------------------------

export class ParseError extends Error {
  public readonly filePath?: string
  public readonly format?: string
  public readonly originalError?: Error

  constructor(
    message: string,
    options: {
      filePath?: string
      format?: string
      originalError?: Error
    } = {},
  ) {
    super(message)
    this.name = 'ParseError'
    this.filePath = options.filePath
    this.format = options.format
    this.originalError = options.originalError
  }
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

export type GraphFormat = 'yaml' | 'json'

function detectFormat(filePath: string): GraphFormat {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.json') {
    return 'json'
  }
  // .yaml and .yml both map to yaml (ADR-008)
  return 'yaml'
}

// ---------------------------------------------------------------------------
// parseGraphString
// ---------------------------------------------------------------------------

/**
 * Parse a task graph from a string (YAML or JSON).
 * Returns the raw parsed object before Zod validation.
 *
 * @param content - String content to parse
 * @param format - 'yaml' or 'json'
 * @throws {ParseError} on syntax errors
 */
export function parseGraphString(content: string, format: GraphFormat): RawTaskGraph {
  if (format === 'json') {
    try {
      return JSON.parse(content) as RawTaskGraph
    } catch (err) {
      const original = err instanceof Error ? err : new Error(String(err))
      throw new ParseError(`JSON parse error: ${original.message}`, {
        format: 'json',
        originalError: original,
      })
    }
  }

  // YAML
  try {
    const parsed = parse(content)
    return parsed as RawTaskGraph
  } catch (err) {
    const original = err instanceof Error ? err : new Error(String(err))
    throw new ParseError(`YAML parse error: ${original.message}`, {
      format: 'yaml',
      originalError: original,
    })
  }
}

// ---------------------------------------------------------------------------
// parseGraphFile
// ---------------------------------------------------------------------------

/**
 * Read a task graph file and parse its contents.
 * Format is determined by file extension (.json vs .yaml/.yml).
 * Returns the raw parsed object before Zod validation.
 *
 * @param filePath - Absolute or relative path to the task graph file
 * @throws {ParseError} on file read errors or syntax errors
 */
export function parseGraphFile(filePath: string): RawTaskGraph {
  let content: string

  try {
    content = readFileSync(filePath, 'utf-8')
  } catch (err) {
    const original = err instanceof Error ? err : new Error(String(err))
    throw new ParseError(`Failed to read file: ${original.message}`, {
      filePath,
      originalError: original,
    })
  }

  const format = detectFormat(filePath)

  try {
    return parseGraphString(content, format)
  } catch (err) {
    if (err instanceof ParseError) {
      // Re-throw with file path context added
      throw new ParseError(err.message, {
        filePath,
        format: err.format,
        originalError: err.originalError,
      })
    }
    throw err
  }
}
