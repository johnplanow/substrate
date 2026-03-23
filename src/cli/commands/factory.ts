/**
 * `substrate factory` command group — factory pipeline and scenario management.
 *
 * Delegates to `registerFactoryCommand` from @substrate-ai/factory, which
 * registers the `factory scenarios list` and `factory scenarios run [--format json|text]`
 * subcommands.
 *
 * Story 44-8.
 */

export { registerFactoryCommand } from '@substrate-ai/factory'
