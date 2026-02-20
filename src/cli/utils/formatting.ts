/**
 * CLI output formatting utilities
 *
 * Provides human-readable table formatting for adapter list and health check commands.
 */

import type { AdapterHealthResult } from '../../adapters/types.js'
import type { AdapterDiscoveryResult } from '../../adapters/adapter-registry.js'

/**
 * A row in the adapter list table.
 */
export interface AdapterListRow {
  name: string
  displayName: string
  status: 'available' | 'unavailable'
  cliPath: string
  version: string
}

/**
 * A row in the adapter health check table.
 */
export interface AdapterHealthRow {
  adapter: string
  status: 'healthy' | 'unhealthy'
  billingMode: string
  headless: string
  version: string
  error?: string
}

/**
 * Build adapter list rows from discovery results.
 * Maps adapter discovery info to the display format for `substrate adapters list`.
 */
export function buildAdapterListRows(results: AdapterDiscoveryResult[]): AdapterListRow[] {
  return results.map((result) => {
    const health = result.healthResult
    return {
      name: result.adapterId,
      displayName: result.displayName,
      status: health.healthy ? 'available' : 'unavailable',
      cliPath: health.cliPath ?? '-',
      version: health.version ?? '-',
    }
  })
}

/**
 * Build adapter health rows from discovery results.
 * Maps adapter health info to the display format for `substrate adapters check`.
 */
export function buildAdapterHealthRows(results: AdapterDiscoveryResult[]): AdapterHealthRow[] {
  return results.map((result) => {
    const health = result.healthResult
    const billingModes = health.detectedBillingModes
    return {
      adapter: result.displayName,
      status: health.healthy ? 'healthy' : 'unhealthy',
      billingMode: billingModes && billingModes.length > 0 ? billingModes.join(', ') : '-',
      headless: health.supportsHeadless ? 'yes' : 'no',
      version: health.version ?? '-',
      ...(health.error !== undefined ? { error: health.error } : {}),
    }
  })
}

/**
 * Format a table from an array of row objects.
 *
 * Computes column widths from headers + data, then renders aligned columns
 * separated by ` | ` with a header separator row.
 *
 * @param headers - Column header names (in order)
 * @param rows    - Array of row objects (values indexed by header name)
 * @param keys    - Object keys to read from each row (in column order)
 * @returns Formatted string ready for console output
 */
export function formatTable(
  headers: string[],
  rows: Record<string, string>[],
  keys: string[]
): string {
  // Compute column widths as max of header and data lengths
  const widths = headers.map((header, i) => {
    const key = keys[i] ?? header
    const dataMax = rows.reduce((max, row) => {
      const val = row[key] ?? ''
      return Math.max(max, val.length)
    }, 0)
    return Math.max(header.length, dataMax)
  })

  const separator = widths.map((w) => '-'.repeat(w)).join('-+-')
  const headerRow = headers.map((h, i) => h.padEnd(widths[i] ?? h.length)).join(' | ')

  const dataRows = rows.map((row) =>
    keys.map((key, i) => {
      const val = row[key] ?? ''
      return val.padEnd(widths[i] ?? val.length)
    }).join(' | ')
  )

  return [headerRow, separator, ...dataRows].join('\n')
}

/**
 * Format adapter list rows as a human-readable table.
 */
export function formatAdapterListTable(rows: AdapterListRow[]): string {
  const headers = ['Name', 'Display Name', 'Status', 'Path', 'Version']
  const keys = ['name', 'displayName', 'status', 'cliPath', 'version']
  const tableRows: Record<string, string>[] = rows.map((r) => ({
    name: r.name,
    displayName: r.displayName,
    status: r.status,
    cliPath: r.cliPath,
    version: r.version,
  }))
  return formatTable(headers, tableRows, keys)
}

/**
 * Format adapter health rows as a human-readable table.
 */
export function formatAdapterHealthTable(rows: AdapterHealthRow[]): string {
  const headers = ['Adapter', 'Status', 'Billing Mode', 'Headless', 'Version']
  const keys = ['adapter', 'status', 'billingMode', 'headless', 'version']
  const tableRows: Record<string, string>[] = rows.map((r) => ({
    adapter: r.adapter,
    status: r.status,
    billingMode: r.billingMode,
    headless: r.headless,
    version: r.version,
  }))
  return formatTable(headers, tableRows, keys)
}

/**
 * CLIJsonOutput wrapper type for machine-consumable JSON responses.
 * Consistent with the pattern established in story 1.2.
 */
export interface CLIJsonOutput<T> {
  /** ISO timestamp of when the command was executed */
  timestamp: string
  /** Substrate version string */
  version: string
  /** The CLI command that was executed */
  command: string
  /** The actual data payload */
  data: T
}

/**
 * Build a CLIJsonOutput wrapper around data.
 */
export function buildJsonOutput<T>(command: string, data: T, version: string): CLIJsonOutput<T> {
  return {
    timestamp: new Date().toISOString(),
    version,
    command,
    data,
  }
}

/**
 * Format an AdapterHealthResult as a JSON-serializable object.
 */
export function healthResultToJson(
  adapterId: string,
  displayName: string,
  healthResult: AdapterHealthResult
): Record<string, unknown> {
  return {
    adapterId,
    displayName,
    healthy: healthResult.healthy,
    version: healthResult.version ?? null,
    cliPath: healthResult.cliPath ?? null,
    detectedBillingModes: healthResult.detectedBillingModes ?? [],
    supportsHeadless: healthResult.supportsHeadless,
    error: healthResult.error ?? null,
  }
}
