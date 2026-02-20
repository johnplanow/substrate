/**
 * General utility helpers for Substrate
 */

import { randomUUID } from 'crypto'

/**
 * Sleep for a given number of milliseconds
 * @param ms - Milliseconds to sleep
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Assert that a value is defined (not null or undefined)
 * @param value - Value to check
 * @param message - Error message if undefined
 */
export function assertDefined<T>(
  value: T | null | undefined,
  message: string
): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error(message)
  }
}

/**
 * Format a duration in milliseconds to a human-readable string
 * @param ms - Duration in milliseconds
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3600000) {
    const minutes = Math.floor(ms / 60000)
    const seconds = Math.floor((ms % 60000) / 1000)
    return `${String(minutes)}m ${String(seconds)}s`
  }
  const hours = Math.floor(ms / 3600000)
  const minutes = Math.floor((ms % 3600000) / 60000)
  return `${String(hours)}h ${String(minutes)}m`
}

/**
 * Generate a unique identifier using crypto.randomUUID()
 * @param prefix - Optional prefix for the ID
 */
export function generateId(prefix = ''): string {
  const uuid = randomUUID()
  return prefix ? `${prefix}-${uuid}` : uuid
}

/**
 * Deep clone an object using structuredClone.
 * Supports most built-in types (Date, Map, Set, ArrayBuffer, etc.)
 * but does NOT support functions, DOM nodes, or symbols as keys.
 * @param obj - Object to clone
 */
export function deepClone<T>(obj: T): T {
  return structuredClone(obj)
}

/**
 * Check if a value is a plain object (not an array, Date, or other special object)
 * @param value - Value to check
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

/**
 * Retry an async operation with exponential backoff
 * @param fn - Async function to retry
 * @param maxRetries - Maximum number of retries
 * @param baseDelayMs - Base delay in milliseconds (doubles each retry)
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 100
): Promise<T> {
  let lastError: Error | undefined
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt < maxRetries) {
        await sleep(baseDelayMs * Math.pow(2, attempt))
      }
    }
  }
  throw lastError ?? new Error('Operation failed after retries')
}
