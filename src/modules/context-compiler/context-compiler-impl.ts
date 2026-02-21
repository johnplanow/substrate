/**
 * ContextCompilerImpl — implements the ContextCompiler interface.
 *
 * Builds minimal prompts by:
 *  1. Looking up the registered template for the task type
 *  2. Running each section's query against the decision store
 *  3. Formatting the raw rows into text via the section's format function
 *  4. Assembling sections under the token budget using priority ordering
 *     (required → important → optional)
 *  5. Returning a CompileResult with the full prompt and per-section reports
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import type { ContextCompiler } from './context-compiler.js'
import type {
  TaskDescriptor,
  ContextTemplate,
  TemplateSection,
  CompileResult,
  SectionReport,
  StoreQuery,
} from './types.js'
import { countTokens, truncateToTokens } from './token-counter.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('context-compiler')

// ---------------------------------------------------------------------------
// Optional sections threshold
// ---------------------------------------------------------------------------

/**
 * Fraction of the original token budget that must remain (after required +
 * important sections) before an optional section is included.
 */
const OPTIONAL_BUDGET_THRESHOLD = 0.3

// ---------------------------------------------------------------------------
// Query execution helpers
// ---------------------------------------------------------------------------

/**
 * Execute a StoreQuery against the SQLite database and return the raw rows.
 */
function executeQuery(db: BetterSqlite3Database, query: StoreQuery): unknown[] {
  const { table, filters } = query
  const conditions: string[] = []
  const values: unknown[] = []

  for (const [column, filterValue] of Object.entries(filters)) {
    if (Array.isArray(filterValue)) {
      if (filterValue.length === 0) continue
      const placeholders = filterValue.map(() => '?').join(', ')
      conditions.push(`${column} IN (${placeholders})`)
      values.push(...filterValue)
    } else {
      conditions.push(`${column} = ?`)
      values.push(filterValue)
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const sql = `SELECT * FROM ${table} ${where} ORDER BY created_at ASC`
  const stmt = db.prepare(sql)
  return stmt.all(...values) as unknown[]
}

// ---------------------------------------------------------------------------
// Section assembly helpers
// ---------------------------------------------------------------------------

/**
 * Process a single template section:
 *  - Execute its query
 *  - Format the results
 *  - Return the text and token count
 */
function processSection(
  db: BetterSqlite3Database,
  section: TemplateSection,
): { text: string; tokens: number } {
  const rows = executeQuery(db, section.query)
  const text = section.format(rows)
  const tokens = countTokens(text)
  return { text, tokens }
}

// ---------------------------------------------------------------------------
// ContextCompilerImpl
// ---------------------------------------------------------------------------

export class ContextCompilerImpl implements ContextCompiler {
  private readonly _db: BetterSqlite3Database
  private readonly _templates: Map<string, ContextTemplate>

  constructor(options: { db: BetterSqlite3Database; templates?: Map<string, ContextTemplate> }) {
    this._db = options.db
    this._templates = options.templates ? new Map(options.templates) : new Map()
  }

  // -------------------------------------------------------------------------
  // Template management
  // -------------------------------------------------------------------------

  registerTemplate(template: ContextTemplate): void {
    this._templates.set(template.taskType, template)
  }

  getTemplate(taskType: string): ContextTemplate | undefined {
    return this._templates.get(taskType)
  }

  // -------------------------------------------------------------------------
  // compile
  // -------------------------------------------------------------------------

  compile(descriptor: TaskDescriptor): CompileResult {
    const template = this._templates.get(descriptor.taskType)
    if (template === undefined) {
      throw new Error(
        `ContextCompiler: no template registered for task type "${descriptor.taskType}"`,
      )
    }

    const budget = descriptor.tokenBudget
    let remainingBudget = budget
    let anyTruncated = false

    const includedParts: string[] = []
    const sectionReports: SectionReport[] = []

    // Sort sections by priority: required first, then important, then optional
    const ordered = sortByPriority(template.sections)

    for (const section of ordered) {
      const { text, tokens } = processSection(this._db, section)

      if (section.priority === 'required') {
        // Required sections are always included; never truncated
        includedParts.push(text)
        remainingBudget -= tokens
        sectionReports.push({
          name: section.name,
          priority: section.priority,
          tokens,
          included: true,
          truncated: false,
        })
      } else if (section.priority === 'important') {
        if (tokens <= remainingBudget) {
          // Fits in budget — include as-is
          includedParts.push(text)
          remainingBudget -= tokens
          sectionReports.push({
            name: section.name,
            priority: section.priority,
            tokens,
            included: true,
            truncated: false,
          })
        } else if (remainingBudget > 0) {
          // Truncate to fit remaining budget
          const truncated = truncateToTokens(text, remainingBudget)
          const truncatedTokens = countTokens(truncated)
          includedParts.push(truncated)
          remainingBudget -= truncatedTokens
          anyTruncated = true
          logger.warn(
            { section: section.name, originalTokens: tokens, budgetTokens: truncatedTokens },
            'Context compiler: truncated "important" section to fit token budget',
          )
          sectionReports.push({
            name: section.name,
            priority: section.priority,
            tokens: truncatedTokens,
            included: true,
            truncated: true,
          })
        } else {
          // No budget left — omit
          anyTruncated = true
          logger.warn(
            { section: section.name, tokens },
            'Context compiler: omitted "important" section — no budget remaining',
          )
          sectionReports.push({
            name: section.name,
            priority: section.priority,
            tokens: 0,
            included: false,
            truncated: true,
          })
        }
      } else {
        // optional — include only if >30% budget remains
        const budgetFractionRemaining = remainingBudget / budget
        if (budgetFractionRemaining > OPTIONAL_BUDGET_THRESHOLD && tokens <= remainingBudget) {
          includedParts.push(text)
          remainingBudget -= tokens
          sectionReports.push({
            name: section.name,
            priority: section.priority,
            tokens,
            included: true,
            truncated: false,
          })
        } else {
          if (tokens > 0) {
            anyTruncated = true
            logger.warn(
              {
                section: section.name,
                tokens,
                budgetFractionRemaining: budgetFractionRemaining.toFixed(2),
              },
              'Context compiler: omitted "optional" section — insufficient budget',
            )
          }
          sectionReports.push({
            name: section.name,
            priority: section.priority,
            tokens: 0,
            included: false,
            truncated: false,
          })
        }
      }
    }

    const prompt = includedParts.filter((p) => p.length > 0).join('\n')
    const totalTokens = countTokens(prompt)

    return {
      prompt,
      tokenCount: totalTokens,
      sections: sectionReports,
      truncated: anyTruncated,
    }
  }
}

// ---------------------------------------------------------------------------
// Priority sort helper
// ---------------------------------------------------------------------------

const PRIORITY_ORDER: Record<string, number> = {
  required: 0,
  important: 1,
  optional: 2,
}

function sortByPriority(sections: TemplateSection[]): TemplateSection[] {
  return [...sections].sort(
    (a, b) => (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99),
  )
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface ContextCompilerOptions {
  db: BetterSqlite3Database
  templates?: Map<string, ContextTemplate>
}

/**
 * Create a new ContextCompiler backed by the given SQLite database.
 * Optionally pre-populate with a map of templates.
 */
export function createContextCompiler(options: ContextCompilerOptions): ContextCompiler {
  return new ContextCompilerImpl(options)
}
