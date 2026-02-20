/**
 * `substrate init` command
 *
 * Creates a `.substrate/` directory in the current project with:
 *   - config.yaml  (sensible defaults + detected provider settings)
 *   - routing-policy.yaml  (default routing policy)
 *
 * Runs adapter discovery and prompts for per-provider subscription routing.
 */

import type { Command } from 'commander'
import { mkdir, writeFile, access } from 'fs/promises'
import { join, resolve } from 'path'
import yaml from 'js-yaml'
import { AdapterRegistry } from '../../adapters/adapter-registry.js'
import { DEFAULT_CONFIG, DEFAULT_ROUTING_POLICY } from '../../modules/config/defaults.js'
import type {
  ProviderConfig,
  SubscriptionRouting,
  SubstrateConfig,
  RoutingPolicy,
} from '../../modules/config/config-schema.js'
import { CURRENT_CONFIG_FORMAT_VERSION, CURRENT_TASK_GRAPH_VERSION } from '../../modules/config/config-schema.js'
import { createLogger } from '../../utils/logger.js'
import { ConfigError } from '../../core/errors.js'

const logger = createLogger('init')

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

export const INIT_EXIT_SUCCESS = 0
export const INIT_EXIT_ERROR = 1
export const INIT_EXIT_ALREADY_EXISTS = 2

// ---------------------------------------------------------------------------
// Provider config builder
// ---------------------------------------------------------------------------

const PROVIDER_DEFAULTS = DEFAULT_CONFIG.providers

/**
 * Map from AdapterRegistry adapter ID to provider key in config.
 */
const ADAPTER_TO_PROVIDER: Record<string, keyof typeof PROVIDER_DEFAULTS> = {
  'claude-code': 'claude',
  codex: 'codex',
  gemini: 'gemini',
}

/**
 * Map of provider → which env var holds its API key.
 */
const PROVIDER_KEY_ENV: Record<string, string> = {
  claude: 'ANTHROPIC_API_KEY',
  codex: 'OPENAI_API_KEY',
  gemini: 'GOOGLE_API_KEY',
}

/**
 * Build provider config for a discovered adapter.
 * Uses detected CLI path and billing mode from health check.
 */
function buildProviderConfig(
  adapterId: string,
  cliPath: string | undefined,
  subscriptionRouting: SubscriptionRouting
): ProviderConfig {
  const providerKey = ADAPTER_TO_PROVIDER[adapterId] ?? adapterId
  const defaults = (PROVIDER_DEFAULTS as Record<string, ProviderConfig>)[providerKey]
  if (!defaults) throw new ConfigError(`Unknown provider: ${providerKey}`, { adapterId })

  return {
    ...defaults,
    enabled: true,
    cli_path: cliPath,
    subscription_routing: subscriptionRouting,
  }
}

// ---------------------------------------------------------------------------
// Interactive prompting (non-interactive uses defaults)
// ---------------------------------------------------------------------------

/**
 * Prompt for subscription routing for a single provider.
 * In non-interactive mode (CI / piped stdin), returns 'auto'.
 */
async function promptSubscriptionRouting(
  providerName: string,
  nonInteractive: boolean
): Promise<SubscriptionRouting> {
  if (nonInteractive) return 'auto'

  const readline = await import('readline')
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise<SubscriptionRouting>((resolve) => {
    rl.question(
      `\n  ${providerName} subscription routing [auto/subscription/api/disabled] (default: auto): `,
      (answer) => {
        rl.close()
        const trimmed = answer.trim().toLowerCase()
        if (
          trimmed === 'auto' ||
          trimmed === 'subscription' ||
          trimmed === 'api' ||
          trimmed === 'disabled'
        ) {
          resolve(trimmed)
        } else {
          resolve('auto')
        }
      }
    )
  })
}

/**
 * Prompt for confirmation (y/n). Returns true for yes.
 */
async function promptYesNo(question: string, nonInteractive: boolean): Promise<boolean> {
  if (nonInteractive) return false

  const readline = await import('readline')
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise<boolean>((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim().toLowerCase() === 'y')
    })
  })
}

// ---------------------------------------------------------------------------
// Directory existence check
// ---------------------------------------------------------------------------

async function directoryExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Main init logic
// ---------------------------------------------------------------------------

export interface InitOptions {
  /** Target directory (defaults to cwd) */
  directory?: string
  /** Skip interactive prompts and use defaults */
  yes?: boolean
  /** AdapterRegistry to use (injectable for testing) */
  registry?: AdapterRegistry
}

/**
 * Core init logic — separated from Commander action for testability.
 *
 * @returns exit code (0 = success, 1 = error, 2 = already exists + skipped)
 */
export async function runInit(options: InitOptions = {}): Promise<number> {
  const targetDir = options.directory
    ? resolve(options.directory)
    : resolve(process.cwd())
  const nonInteractive = options.yes ?? false
  const substrateDir = join(targetDir, '.substrate')
  const configPath = join(substrateDir, 'config.yaml')
  const routingPolicyPath = join(substrateDir, 'routing-policy.yaml')

  // ------------------------------------------------------------------
  // Check if .substrate/ already exists
  // ------------------------------------------------------------------
  if (await directoryExists(substrateDir)) {
    if (!nonInteractive) {
      process.stdout.write(
        `\n  .substrate/ directory already exists at ${substrateDir}\n`
      )
      const overwrite = await promptYesNo(
        '  Overwrite existing configuration? [y/N]: ',
        false
      )
      if (!overwrite) {
        process.stdout.write('  Init cancelled — existing configuration preserved.\n')
        return INIT_EXIT_ALREADY_EXISTS
      }
    } else {
      // Non-interactive: skip silently
      process.stdout.write(
        `  .substrate/ already exists — skipping init (use --yes to force overwrite in interactive mode)\n`
      )
      return INIT_EXIT_ALREADY_EXISTS
    }
  }

  // ------------------------------------------------------------------
  // Run adapter discovery
  // ------------------------------------------------------------------
  process.stdout.write('\n  Discovering installed AI agents...\n')
  const registry = options.registry ?? new AdapterRegistry()

  let discoveryReport
  try {
    discoveryReport = await registry.discoverAndRegister()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ err }, 'Adapter discovery failed')
    process.stderr.write(`  Error: adapter discovery failed — ${message}\n`)
    return INIT_EXIT_ERROR
  }

  const detectedAdapters = discoveryReport.results.filter((r) => r.registered)
  if (detectedAdapters.length > 0) {
    process.stdout.write(
      `  Detected ${String(detectedAdapters.length)} provider(s): ` +
        detectedAdapters.map((a) => a.displayName).join(', ') +
        '\n'
    )
  } else {
    process.stdout.write('  No AI agents detected. You can configure them manually later.\n')
  }

  // ------------------------------------------------------------------
  // Build provider configuration (with optional prompts)
  // ------------------------------------------------------------------
  const providers: SubstrateConfig['providers'] = {}

  for (const adapterResult of discoveryReport.results) {
    const providerKey = ADAPTER_TO_PROVIDER[adapterResult.adapterId]
    if (!providerKey) continue

    if (adapterResult.registered) {
      const routing = await promptSubscriptionRouting(
        adapterResult.displayName,
        nonInteractive
      )
      providers[providerKey] = buildProviderConfig(
        adapterResult.adapterId,
        adapterResult.healthResult.cliPath,
        routing
      )
    } else {
      // Include disabled provider entry with defaults
      const defaults = (PROVIDER_DEFAULTS as Record<string, ProviderConfig>)[providerKey]
      if (defaults) {
        providers[providerKey] = { ...defaults, enabled: false }
      }
    }
  }

  // If no adapters found at all, use full defaults
  const configProviders =
    Object.keys(providers).length > 0 ? providers : DEFAULT_CONFIG.providers

  // ------------------------------------------------------------------
  // Build full config document
  // ------------------------------------------------------------------
  const config: SubstrateConfig = {
    config_format_version: CURRENT_CONFIG_FORMAT_VERSION,
    task_graph_version: CURRENT_TASK_GRAPH_VERSION,
    global: DEFAULT_CONFIG.global,
    providers: configProviders,
  }

  const routingPolicy: RoutingPolicy = structuredClone(DEFAULT_ROUTING_POLICY)

  // ------------------------------------------------------------------
  // Write files
  // ------------------------------------------------------------------
  try {
    await mkdir(substrateDir, { recursive: true })

    const configHeader =
      `# Substrate Configuration\n` +
      `# Generated by \`substrate init\`\n` +
      `# Edit this file to customize your AI agent orchestration settings.\n` +
      `# API keys must be set as environment variables — never stored here.\n` +
      `#\n` +
      `# Provider API key env vars:\n` +
      Object.entries(PROVIDER_KEY_ENV)
        .map(([p, env]) => `#   ${p}: ${env}`)
        .join('\n') +
      '\n\n'

    await writeFile(configPath, configHeader + yaml.dump(config), 'utf-8')

    const routingHeader =
      `# Substrate Routing Policy\n` +
      `# Defines how tasks are routed to AI providers.\n` +
      `# Customize rules to match your workflow and available agents.\n\n`

    await writeFile(routingPolicyPath, routingHeader + yaml.dump(routingPolicy), 'utf-8')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ err }, 'Failed to write config files')
    process.stderr.write(`  Error: failed to write configuration — ${message}\n`)
    return INIT_EXIT_ERROR
  }

  // ------------------------------------------------------------------
  // Success output
  // ------------------------------------------------------------------
  process.stdout.write(
    `\n  Substrate initialized successfully!\n` +
      `\n  Created:\n` +
      `    ${configPath}\n` +
      `    ${routingPolicyPath}\n` +
      `\n  Next steps:\n` +
      `    1. Set your API keys as environment variables:\n` +
      Object.entries(PROVIDER_KEY_ENV)
        .map(([, env]) => `       export ${env}="your-key-here"`)
        .join('\n') +
      '\n' +
      `    2. Run \`substrate adapters check\` to verify your setup\n` +
      `    3. Run \`substrate config show\` to review your configuration\n`
  )

  return INIT_EXIT_SUCCESS
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

/**
 * Register the `init` command on a Commander program.
 */
export function registerInitCommand(
  program: Command,
  _version: string,
  registry?: AdapterRegistry
): void {
  program
    .command('init')
    .description(
      'Initialize Substrate in the current directory — creates .substrate/config.yaml with sensible defaults'
    )
    .option('-y, --yes', 'Skip all interactive prompts and use defaults', false)
    .option(
      '-d, --directory <path>',
      'Target directory (defaults to current working directory)'
    )
    .action(async (opts: { yes: boolean; directory?: string }) => {
      const exitCode = await runInit({
        ...(opts.directory !== undefined && { directory: opts.directory }),
        yes: opts.yes,
        ...(registry !== undefined && { registry }),
      })
      process.exit(exitCode)
    })
}
