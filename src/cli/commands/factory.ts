/**
 * `substrate factory` command group — factory pipeline and scenario management.
 *
 * Composition root: injects DoltClient-capable adapter factory into the
 * factory command so persistence uses Dolt when available.
 *
 * Story 44-8.
 */

import type { Command } from 'commander'
import { registerFactoryCommand as _registerFactoryCommand } from '@substrate-ai/factory'
import { createDatabaseAdapter } from '../../persistence/adapter.js'

export function registerFactoryCommand(program: Command): void {
  _registerFactoryCommand(program, {
    createAdapter: (basePath: string) => createDatabaseAdapter({ backend: 'auto', basePath }),
  })
}
