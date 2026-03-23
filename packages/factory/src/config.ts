/**
 * FactoryConfigSchema — Zod schema for the `factory:` section of config.yaml.
 *
 * Defines and validates all factory pipeline settings with defaults per
 * architecture Section 10.1.
 *
 * Story 44-9.
 */

import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import { SubstrateConfigSchema, DEFAULT_GLOBAL_SETTINGS } from '@substrate-ai/core'

// ---------------------------------------------------------------------------
// FactoryConfigSchema
// ---------------------------------------------------------------------------

/**
 * Zod schema for the `factory:` section of `config.yaml`.
 *
 * All fields except `graph` have defaults so an empty `factory: {}` block is
 * fully valid and produces the documented defaults.
 */
export const FactoryConfigSchema = z
  .object({
    /** Path to the DOT graph file defining the factory pipeline */
    graph: z.string().optional(),
    /** Directory for scenario YAML files (default: '.substrate/scenarios/') */
    scenario_dir: z.string().default('.substrate/scenarios/'),
    /** Minimum satisfaction score to consider the pipeline converged (0–1) */
    satisfaction_threshold: z.number().min(0).max(1).default(0.8),
    /** Maximum USD budget for the factory run (0 = unlimited) */
    budget_cap_usd: z.number().min(0).default(0),
    /** Maximum wall-clock seconds for the factory run (default: 3600 = 1 hour; 0 = unlimited) */
    wall_clock_cap_seconds: z.number().min(0).default(3600),
    /** Number of consecutive iterations to consider for plateau detection (≥2) */
    plateau_window: z.number().int().min(2).default(3),
    /** Minimum score improvement required to avoid plateau detection (0–1) */
    plateau_threshold: z.number().min(0).max(1).default(0.05),
    /** Backend to use for factory execution */
    backend: z.enum(['cli', 'direct']).default('cli'),
    /**
     * Quality mode determines which signal is authoritative for goal gate decisions.
     * Story 46-6.
     *   'code-review'      — code review verdict drives the gate (legacy Phase 2)
     *   'dual-signal'      — both signals required; default
     *   'scenario-primary' — satisfaction score is authoritative; code review is advisory
     *   'scenario-only'    — satisfaction score only; code review skipped entirely
     */
    quality_mode: z.enum(['code-review', 'dual-signal', 'scenario-primary', 'scenario-only']).default('dual-signal'),
  })
  .strict()

export type FactoryConfig = z.infer<typeof FactoryConfigSchema>

// ---------------------------------------------------------------------------
// FactoryExtendedConfigSchema
// ---------------------------------------------------------------------------

/**
 * Extends SubstrateConfigSchema with an optional `factory:` section.
 *
 * Use this schema to parse the full `config.yaml` file in a factory context.
 */
export const FactoryExtendedConfigSchema = SubstrateConfigSchema.extend({
  factory: FactoryConfigSchema.optional(),
})

export type FactoryExtendedConfig = z.infer<typeof FactoryExtendedConfigSchema>

// ---------------------------------------------------------------------------
// loadFactoryConfig
// ---------------------------------------------------------------------------

/**
 * Load and parse the factory configuration from `config.yaml`.
 *
 * Search order (architecture Section 11.3):
 *   1. `explicitConfigPath` if provided (bypasses auto-detection)
 *   2. `<projectDir>/.substrate/config.yaml`
 *   3. `<projectDir>/config.yaml`
 *   4. Return all-defaults config if neither file exists
 *
 * @param projectDir - Absolute path to the project root directory.
 * @param explicitConfigPath - Optional explicit path to the config file (e.g. from `--config` flag).
 * @returns Parsed and validated `FactoryExtendedConfig` with all defaults applied.
 */
export async function loadFactoryConfig(
  projectDir: string,
  explicitConfigPath?: string,
): Promise<FactoryExtendedConfig> {
  const configPaths = explicitConfigPath
    ? [explicitConfigPath]
    : [
        path.join(projectDir, '.substrate', 'config.yaml'),
        path.join(projectDir, 'config.yaml'),
      ]

  for (const configPath of configPaths) {
    try {
      const content = await readFile(configPath, 'utf-8')
      const parsed = yaml.load(content)
      return FactoryExtendedConfigSchema.parse(parsed)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // File not found — try next path
        continue
      }
      // Re-throw validation or other errors
      throw err
    }
  }

  // No config file found — return all-defaults config
  return FactoryExtendedConfigSchema.parse({
    config_format_version: '1',
    global: DEFAULT_GLOBAL_SETTINGS,
    providers: {},
  })
}
