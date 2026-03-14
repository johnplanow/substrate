/**
 * Work-graph error types.
 *
 * Story 31-7: Cycle Detection in Work Graph
 */

/**
 * Thrown by `EpicIngester.ingest()` when the provided dependency list
 * contains a cycle.  The `cycle` field contains the path of story keys
 * that form the cycle (first and last element are the same).
 */
export class CyclicDependencyError extends Error {
  constructor(public readonly cycle: string[]) {
    super(`Cyclic dependency detected: ${cycle.join(' → ')}`)
    this.name = 'CyclicDependencyError'
  }
}
