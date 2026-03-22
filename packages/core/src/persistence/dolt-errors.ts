/**
 * Typed Dolt error classes for low-level persistence operations.
 * Extracted here so downstream packages can import from @substrate-ai/core.
 */

export class DoltQueryError extends Error {
  sql: string
  detail: string

  constructor(sql: string, detail: string) {
    super(`Dolt query failed: ${detail}`)
    this.name = 'DoltQueryError'
    this.sql = sql
    this.detail = detail
  }
}
