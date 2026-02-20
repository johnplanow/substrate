/**
 * Logger utility for AI Dev Toolkit
 * Uses pino for structured JSON logging with pretty printing in development
 */

import pino from 'pino'
import { PINO_REDACT_PATHS } from '../cli/utils/masking.js'

/** Logger configuration options */
export interface LoggerOptions {
  level?: string
  name?: string
  pretty?: boolean
}

/** Default log level based on environment */
function getDefaultLogLevel(): string {
  const envLevel = process.env.LOG_LEVEL
  if (envLevel) return envLevel
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug'
}

/** Whether to use pretty printing (development mode) */
function isPrettyMode(): boolean {
  if (process.env.LOG_PRETTY !== undefined) {
    return process.env.LOG_PRETTY === 'true'
  }
  return process.env.NODE_ENV !== 'production'
}

/**
 * Create a named logger instance
 * @param name - Logger name (module identifier)
 * @param options - Optional logger configuration overrides
 */
export function createLogger(
  name: string,
  options: LoggerOptions = {}
): pino.Logger {
  const level = options.level ?? getDefaultLogLevel()
  const pretty = options.pretty ?? isPrettyMode()

  const baseOptions: pino.LoggerOptions = {
    name: options.name ?? name,
    level,
    redact: PINO_REDACT_PATHS,
    formatters: {
      level(label) {
        return { level: label }
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: {
      pid: process.pid,
    },
  }

  if (pretty) {
    // Note: pino transport errors are asynchronous and cannot be caught here.
    // pino-pretty is a devDependency; only use in non-production environments.
    return pino({
      ...baseOptions,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
    })
  }

  return pino(baseOptions)
}

/** Root application logger */
export const logger = createLogger('adt')

/** Create a child logger with additional context */
export function childLogger(
  parent: pino.Logger,
  bindings: Record<string, unknown>
): pino.Logger {
  return parent.child(bindings)
}
