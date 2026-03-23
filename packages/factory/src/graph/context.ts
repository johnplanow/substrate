/**
 * GraphContext — concrete key-value store for graph node execution state.
 *
 * Implements `IGraphContext` using a private `Map<string, unknown>` as the
 * backing store. Each `clone()` call produces a fully independent instance
 * so mutations never propagate between parent and child contexts.
 *
 * Story 42-8.
 */

import type { IGraphContext } from './types.js'

export class GraphContext implements IGraphContext {
  /** Internal backing store. Never exposed directly to callers. */
  private readonly _store: Map<string, unknown>

  /**
   * @param initial Optional seed values loaded into the store on construction.
   */
  constructor(initial?: Record<string, unknown>) {
    this._store = new Map<string, unknown>()
    if (initial) {
      for (const [key, value] of Object.entries(initial)) {
        this._store.set(key, value)
      }
    }
  }

  /** Return stored value, or `undefined` if the key is absent. */
  get(key: string): unknown {
    return this._store.get(key)
  }

  /** Store value; overwrites if the key already exists. */
  set(key: string, value: unknown): void {
    this._store.set(key, value)
  }

  /**
   * Return String-coerced value, or `defaultValue` (defaults to `""`) if the
   * key is absent.
   */
  getString(key: string, defaultValue?: string): string {
    if (!this._store.has(key)) {
      return defaultValue ?? ''
    }
    return String(this._store.get(key))
  }

  /**
   * Return Number-coerced value, or `defaultValue` (defaults to `0`) if the
   * key is absent or the coerced result is NaN.
   */
  getNumber(key: string, defaultValue?: number): number {
    if (!this._store.has(key)) {
      return defaultValue ?? 0
    }
    const n = Number(this._store.get(key))
    if (Number.isNaN(n)) {
      return defaultValue ?? 0
    }
    return n
  }

  /**
   * Return Boolean-coerced value, or `defaultValue` (defaults to `false`) if
   * the key is absent.
   */
  getBoolean(key: string, defaultValue?: boolean): boolean {
    if (!this._store.has(key)) {
      return defaultValue ?? false
    }
    return Boolean(this._store.get(key))
  }

  /**
   * Merge all entries from `updates` into the store.
   * Pre-existing keys not in `updates` are left unchanged.
   */
  applyUpdates(updates: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(updates)) {
      this._store.set(key, value)
    }
  }

  /**
   * Return a shallow-copied plain object of all current key-value pairs.
   * Modifying the returned object does not affect the internal store.
   */
  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this._store)
  }

  /**
   * Return a completely independent copy backed by its own `Map`.
   * Mutations on the clone do not affect this instance, and vice-versa.
   */
  clone(): IGraphContext {
    return new GraphContext(this.snapshot())
  }
}
