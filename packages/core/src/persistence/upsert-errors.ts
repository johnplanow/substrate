/**
 * Shared helper for detecting UNIQUE constraint violations across adapter
 * backends. Used by the G10 atomic INSERT-catch-UPDATE upsert pattern in
 * `queries/decisions.ts` and `queries/phase-outputs.ts` to recognize the
 * violation and recover via UPDATE instead of re-throwing.
 *
 * Adapter error formats supported:
 *
 *   - InMemoryDatabaseAdapter
 *     "UNIQUE constraint failed: <table> (<cols>)"
 *
 *   - MySQL classic (ER_DUP_ENTRY / ER_DUP_KEYNAME)
 *     "Duplicate entry 'x' for key 'y'"
 *     "Duplicate key name 'y'"
 *
 *   - Dolt (observed 2026-04-12 on a live pipeline run crash)
 *     "duplicate unique key given: [<val1>,<val2>,<val3>]"
 *
 * If a new adapter is added, append its error format here with a
 * regression test in `src/persistence/__tests__/upsert-errors.test.ts`
 * so the helper keeps up and upsert correctness is preserved.
 */
export function isUniqueConstraintViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()

  // InMemoryDatabaseAdapter — "UNIQUE constraint failed: ..."
  if (msg.includes('unique constraint')) return true

  // MySQL ER_DUP_ENTRY — "Duplicate entry 'x' for key 'y'"
  if (msg.includes('duplicate entry')) return true

  // Dolt, MySQL ER_DUP_KEYNAME, and related variants. Match "duplicate"
  // followed by anything, then "key" on a word boundary. Captures:
  //   - "duplicate key"             (MySQL ER_DUP_KEYNAME)
  //   - "duplicate unique key"      (Dolt, the regression that got us)
  //   - "duplicate for key 'x'"     (MySQL compound form)
  // Rejects:
  //   - "duplicate work detected"   (no "key")
  //   - "This is a unique situation" (no "duplicate")
  if (/\bduplicate\b.*?\bkey\b/.test(msg)) return true

  return false
}
