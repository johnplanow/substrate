/**
 * `substrate init` command
 *
 * Combined initialization:
 *   1. Creates .substrate/ directory with config.yaml + routing-policy.yaml
 *   2. Scaffolds BMAD framework, CLAUDE.md, statusline, settings, commands
 *   3. Initializes database + runs migrations
 *
 * Usage:
 *   substrate init                             Initialize with defaults
 *   substrate init --pack bmad                Specify methodology pack
 *   substrate init --project-root <path>      Target directory
 *   substrate init -y                          Skip interactive prompts
 *   substrate init --force                    Force overwrite of existing files
 *   substrate init --output-format json       JSON output
 *
 * Exit codes:
 *   0 - Success
 *   1 - Error
 */

import type { Command } from 'commander'
import { mkdir, writeFile, access, readFile } from 'fs/promises'
import { mkdirSync, writeFileSync, existsSync, readFileSync, cpSync, chmodSync, readdirSync, unlinkSync } from 'fs'
import { join, resolve, dirname } from 'path'
import yaml from 'js-yaml'
import { createRequire } from 'node:module'
import type { AdapterRegistry } from '../../adapters/adapter-registry.js'
import { buildAdapterHealthRows, formatAdapterHealthTable } from '../utils/formatting.js'
import { DEFAULT_CONFIG, DEFAULT_ROUTING_POLICY } from '../../modules/config/defaults.js'
import type {
  ProviderConfig,
  SubscriptionRouting,
  SubstrateConfig,
  RoutingPolicy,
} from '../../modules/config/config-schema.js'
import { CURRENT_CONFIG_FORMAT_VERSION, CURRENT_TASK_GRAPH_VERSION } from '../../modules/config/config-schema.js'
import { resolveMainRepoRoot } from '../../utils/git-root.js'
import { createDatabaseAdapter } from '../../persistence/adapter.js'
import { initSchema } from '../../persistence/schema.js'
import { createPackLoader } from '../../modules/methodology-pack/pack-loader.js'
import { createLogger } from '../../utils/logger.js'
import { ConfigError } from '../../core/errors.js'
import { initializeDolt, checkDoltInstalled, DoltNotInstalled } from '../../modules/state/dolt-init.js'
import type { OutputFormat } from './pipeline-shared.js'
import {
  findPackageRoot,
  resolveBmadMethodSrcPath,
  resolveBmadMethodVersion,
  SUBSTRATE_OWNED_SETTINGS_KEYS,
  getSubstrateDefaultSettings,
  formatOutput,
} from './pipeline-shared.js'
import { detectProjectProfile } from '../../modules/project-profile/detect.js'
import { writeProjectProfile } from '../../modules/project-profile/writer.js'
import type { ProjectProfile } from '../../modules/project-profile/project-profile.js'
import {
  buildStackAwareDevNotes,
  DEV_WORKFLOW_START_MARKER,
  DEV_WORKFLOW_END_MARKER,
} from '../templates/build-dev-notes.js'

const logger = createLogger('init')
const __dirname = dirname(new URL(import.meta.url).pathname)

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

export const INIT_EXIT_SUCCESS = 0
export const INIT_EXIT_ERROR = 1

// ---------------------------------------------------------------------------
// BMAD framework scaffolding
// ---------------------------------------------------------------------------

const BMAD_FRAMEWORK_DIRS = ['core', 'bmm', 'tea'] as const

export async function scaffoldBmadFramework(
  projectRoot: string,
  force: boolean,
  outputFormat: OutputFormat,
): Promise<void> {
  const bmadDest = join(projectRoot, '_bmad')
  const bmadExists = existsSync(bmadDest)

  if (bmadExists && !force) {
    return
  }

  const bmadSrc = resolveBmadMethodSrcPath()
  if (!bmadSrc) {
    if (outputFormat !== 'json') {
      process.stderr.write(
        'Warning: bmad-method is not installed. BMAD framework not scaffolded. Run: npm install bmad-method\n',
      )
    }
    return
  }

  const version = resolveBmadMethodVersion()

  if (force && bmadExists) {
    process.stderr.write(
      `Warning: Replacing existing _bmad/ framework with bmad-method@${version}\n`,
    )
  }

  process.stdout.write(`Scaffolding BMAD framework from bmad-method@${version}\n`)
  logger.info({ version, dest: bmadDest }, 'Scaffolding BMAD framework')

  for (const dir of BMAD_FRAMEWORK_DIRS) {
    const srcDir = join(bmadSrc, dir)
    if (existsSync(srcDir)) {
      const destDir = join(bmadDest, dir)
      mkdirSync(destDir, { recursive: true })
      cpSync(srcDir, destDir, { recursive: true })
      logger.info({ dir, dest: destDir }, 'Scaffolded BMAD framework directory')
    }
  }

  const configDir = join(bmadDest, '_config')
  const configFile = join(configDir, 'config.yaml')
  if (!existsSync(configFile)) {
    mkdirSync(configDir, { recursive: true })
    const configStub = [
      '# BMAD framework configuration',
      `# Scaffolded from bmad-method@${version} by substrate init`,
      '# This file is project-specific — customize as needed.',
      'user_name: Human',
      'communication_language: English',
      'document_output_language: English',
    ].join('\n') + '\n'
    await writeFile(configFile, configStub, 'utf8')
    logger.info({ configFile }, 'Generated _bmad/_config/config.yaml stub')
  }
}

// ---------------------------------------------------------------------------
// CLAUDE.md scaffold
// ---------------------------------------------------------------------------

export const CLAUDE_MD_START_MARKER = '<!-- substrate:start -->'
export const CLAUDE_MD_END_MARKER = '<!-- substrate:end -->'

export const DEV_WORKFLOW_CLAUDE_MD_START = DEV_WORKFLOW_START_MARKER
export const DEV_WORKFLOW_CLAUDE_MD_END = DEV_WORKFLOW_END_MARKER

export async function scaffoldClaudeMd(
  projectRoot: string,
  profile?: ProjectProfile | null,
): Promise<void> {
  const claudeMdPath = join(projectRoot, 'CLAUDE.md')
  const pkgRoot = findPackageRoot(__dirname)
  const templateName = 'claude-md-substrate-section.md'
  let templatePath = join(pkgRoot, 'dist', 'cli', 'templates', templateName)
  if (!existsSync(templatePath)) {
    templatePath = join(pkgRoot, 'src', 'cli', 'templates', templateName)
  }

  let sectionContent: string
  try {
    sectionContent = await readFile(templatePath, 'utf8')
  } catch {
    logger.warn({ templatePath }, 'CLAUDE.md substrate section template not found; skipping')
    return
  }

  if (!sectionContent.endsWith('\n')) {
    sectionContent += '\n'
  }

  // Build the stack-aware dev workflow section (empty string if no profile)
  const devNotesSection = buildStackAwareDevNotes(profile ?? null)

  let existingContent = ''
  let claudeMdExists = false

  try {
    existingContent = await readFile(claudeMdPath, 'utf8')
    claudeMdExists = true
  } catch {
    // File does not exist — will create it
  }

  // Determine final substrate section content (unchanged logic)
  let newContent: string

  if (!claudeMdExists) {
    // New file: prepend dev workflow section if present, then substrate section
    if (devNotesSection) {
      newContent = devNotesSection + '\n\n' + sectionContent
    } else {
      newContent = sectionContent
    }
  } else {
    // Existing file: update substrate section in place
    let updatedExisting: string
    if (existingContent.includes(CLAUDE_MD_START_MARKER)) {
      updatedExisting = existingContent.replace(
        new RegExp(
          `${CLAUDE_MD_START_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${CLAUDE_MD_END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
        ),
        sectionContent.trimEnd(),
      )
    } else {
      const separator = existingContent.endsWith('\n') ? '\n' : '\n\n'
      updatedExisting = existingContent + separator + sectionContent
    }

    // Now handle dev workflow section in the (potentially updated) content
    if (devNotesSection) {
      if (updatedExisting.includes(DEV_WORKFLOW_START_MARKER)) {
        // Replace existing dev workflow block
        newContent = updatedExisting.replace(
          new RegExp(
            `${DEV_WORKFLOW_START_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${DEV_WORKFLOW_END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
          ),
          devNotesSection,
        )
      } else {
        // Prepend dev workflow section before substrate section
        if (updatedExisting.includes(CLAUDE_MD_START_MARKER)) {
          newContent = updatedExisting.replace(
            CLAUDE_MD_START_MARKER,
            devNotesSection + '\n\n' + CLAUDE_MD_START_MARKER,
          )
        } else {
          // Append at the front (or use separator)
          const sep = updatedExisting.endsWith('\n') ? '\n' : '\n\n'
          newContent = devNotesSection + sep + updatedExisting
        }
      }
    } else if (updatedExisting.includes(DEV_WORKFLOW_START_MARKER)) {
      // Profile is null but dev workflow block exists — remove it
      newContent = updatedExisting.replace(
        new RegExp(
          `${DEV_WORKFLOW_START_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${DEV_WORKFLOW_END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`,
        ),
        '',
      )
    } else {
      newContent = updatedExisting
    }
  }

  await writeFile(claudeMdPath, newContent, 'utf8')
  logger.info({ claudeMdPath }, 'Wrote substrate section to CLAUDE.md')
}

// ---------------------------------------------------------------------------
// .claude/statusline.sh scaffold
// ---------------------------------------------------------------------------

export async function scaffoldStatuslineScript(projectRoot: string): Promise<void> {
  const pkgRoot = findPackageRoot(__dirname)
  const templateName = 'statusline.sh'
  let templatePath = join(pkgRoot, 'dist', 'cli', 'templates', templateName)
  if (!existsSync(templatePath)) {
    templatePath = join(pkgRoot, 'src', 'cli', 'templates', templateName)
  }

  let content: string
  try {
    content = await readFile(templatePath, 'utf8')
  } catch {
    logger.warn({ templatePath }, 'statusline.sh template not found; skipping')
    return
  }

  const claudeDir = join(projectRoot, '.claude')
  const statuslinePath = join(claudeDir, 'statusline.sh')
  mkdirSync(claudeDir, { recursive: true })
  await writeFile(statuslinePath, content, 'utf8')
  chmodSync(statuslinePath, 0o755)
  logger.info({ statuslinePath }, 'Wrote .claude/statusline.sh')
}

// ---------------------------------------------------------------------------
// .claude/settings.json scaffold (upgrade-safe merge)
// ---------------------------------------------------------------------------

export async function scaffoldClaudeSettings(projectRoot: string): Promise<void> {
  const claudeDir = join(projectRoot, '.claude')
  const settingsPath = join(claudeDir, 'settings.json')

  let existing: Record<string, unknown> = {}
  try {
    const raw = await readFile(settingsPath, 'utf8')
    existing = JSON.parse(raw)
  } catch {
    // File doesn't exist or invalid JSON — start fresh
  }

  const defaults = getSubstrateDefaultSettings()
  const merged = { ...existing }

  for (const key of SUBSTRATE_OWNED_SETTINGS_KEYS) {
    merged[key] = defaults[key]
  }

  if (!merged['$schema']) {
    merged['$schema'] = 'https://json.schemastore.org/claude-code-settings.json'
  }

  mkdirSync(claudeDir, { recursive: true })
  await writeFile(settingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf8')
  logger.info({ settingsPath }, 'Wrote substrate settings to .claude/settings.json')
}

// ---------------------------------------------------------------------------
// .claude/commands/ scaffold (bmad slash commands)
// ---------------------------------------------------------------------------

export function resolveBmadMethodInstallerLibPath(fromDir: string = __dirname): string | null {
  try {
    const _require = createRequire(join(fromDir, 'synthetic.js'))
    const pkgJsonPath = _require.resolve('bmad-method/package.json')
    return join(dirname(pkgJsonPath), 'tools', 'cli', 'installers', 'lib')
  } catch {
    return null
  }
}

export function scanBmadModules(bmadDir: string): string[] {
  const modules: string[] = []
  try {
    const entries = readdirSync(bmadDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_') || entry.name === 'core') continue
      const modPath = join(bmadDir, entry.name)
      const hasAgents = existsSync(join(modPath, 'agents'))
      const hasWorkflows = existsSync(join(modPath, 'workflows'))
      const hasTasks = existsSync(join(modPath, 'tasks'))
      if (hasAgents || hasWorkflows || hasTasks) {
        modules.push(entry.name)
      }
    }
  } catch {
    // _bmad/ not accessible
  }
  return modules
}

function clearBmadCommandFiles(commandsDir: string): void {
  try {
    const entries = readdirSync(commandsDir)
    for (const entry of entries) {
      if (entry.startsWith('bmad-') && entry.endsWith('.md')) {
        try {
          unlinkSync(join(commandsDir, entry))
        } catch {
          // ignore individual file errors
        }
      }
    }
  } catch {
    // directory didn't exist or couldn't be read — fine
  }
}

async function compileBmadAgents(bmadDir: string): Promise<number> {
  const _require = createRequire(join(__dirname, 'synthetic.js'))

  let compilerPath: string
  try {
    const pkgJsonPath = _require.resolve('bmad-method/package.json')
    compilerPath = join(dirname(pkgJsonPath), 'tools', 'cli', 'lib', 'agent', 'compiler.js')
  } catch {
    return 0
  }

  const { compileAgent } = _require(compilerPath) as {
    compileAgent: (yaml: string, answers?: Record<string, unknown>, name?: string, path?: string) => Promise<{ xml: string }>
  }

  const agentDirs: string[] = []
  const coreAgentsDir = join(bmadDir, 'core', 'agents')
  if (existsSync(coreAgentsDir)) agentDirs.push(coreAgentsDir)

  try {
    const entries = readdirSync(bmadDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'core' || entry.name.startsWith('.') || entry.name.startsWith('_')) continue
      const modAgentsDir = join(bmadDir, entry.name, 'agents')
      if (existsSync(modAgentsDir)) agentDirs.push(modAgentsDir)
    }
  } catch {
    // ignore
  }

  let compiled = 0
  for (const agentDir of agentDirs) {
    try {
      const files = readdirSync(agentDir)
      for (const file of files) {
        if (!file.endsWith('.agent.yaml')) continue
        const yamlPath = join(agentDir, file)
        const mdPath = join(agentDir, file.replace('.agent.yaml', '.md'))

        if (existsSync(mdPath)) continue

        try {
          const yamlContent = readFileSync(yamlPath, 'utf-8')
          const agentName = file.replace('.agent.yaml', '')
          const result = await compileAgent(yamlContent, {}, agentName, mdPath)
          writeFileSync(mdPath, result.xml, 'utf-8')
          compiled++
        } catch (compileErr) {
          logger.debug({ err: compileErr, file }, 'Failed to compile agent YAML')
        }
      }
    } catch {
      // ignore dir read errors
    }
  }

  return compiled
}

// Minimal type interfaces for bmad-method CJS generators
interface BmadArtifact { type: string; name: string; [key: string]: unknown }
interface BmadAgentGenerator {
  collectAgentArtifacts(bmadDir: string, modules: string[]): Promise<{ artifacts: BmadArtifact[] }>
  writeDashArtifacts(dir: string, artifacts: BmadArtifact[]): Promise<number>
}
interface BmadWorkflowGenerator {
  collectWorkflowArtifacts(bmadDir: string): Promise<{ artifacts: BmadArtifact[] }>
  writeDashArtifacts(dir: string, artifacts: BmadArtifact[]): Promise<number>
}
interface BmadTaskToolGenerator {
  collectTaskToolArtifacts(bmadDir: string): Promise<{ artifacts: BmadArtifact[] }>
  writeDashArtifacts(dir: string, artifacts: BmadArtifact[]): Promise<number>
}
interface BmadManifestGenerator {
  generateManifests(
    bmadDir: string,
    modules: string[],
    files: unknown[],
    options: { ides: string[] },
  ): Promise<unknown>
}

export async function scaffoldClaudeCommands(
  projectRoot: string,
  outputFormat: OutputFormat,
): Promise<void> {
  const bmadDir = join(projectRoot, '_bmad')

  if (!existsSync(bmadDir)) {
    return
  }

  const installerLibPath = resolveBmadMethodInstallerLibPath()

  if (!installerLibPath) {
    if (outputFormat !== 'json') {
      process.stderr.write('Warning: bmad-method not found. Skipping .claude/commands/ generation.\n')
    }
    return
  }

  try {
    const _require = createRequire(join(__dirname, 'synthetic.js'))

    try {
      const compiledCount = await compileBmadAgents(bmadDir)
      if (compiledCount > 0) {
        logger.info({ compiledCount }, 'Compiled agent YAML files to MD')
      }
    } catch (compileErr) {
      logger.warn({ err: compileErr }, 'Agent compilation failed; agent commands may be incomplete')
    }

    // CJS/ESM interop: some environments (e.g. vitest) wrap CJS exports
    // in a default property. Try named export first, fall back to .default.
    const resolveExport = <T>(mod: Record<string, unknown>, name: string): T => {
      if (typeof mod[name] === 'function') return mod[name] as T
      const def = mod.default as Record<string, unknown> | undefined
      if (def && typeof def[name] === 'function') return def[name] as T
      throw new Error(`${name} is not a constructor`)
    }

    const agentMod = _require(join(installerLibPath, 'ide', 'shared', 'agent-command-generator.js')) as Record<string, unknown>
    const AgentCommandGenerator = resolveExport<new (bmadFolderName: string) => BmadAgentGenerator>(agentMod, 'AgentCommandGenerator')

    const workflowMod = _require(join(installerLibPath, 'ide', 'shared', 'workflow-command-generator.js')) as Record<string, unknown>
    const WorkflowCommandGenerator = resolveExport<new (bmadFolderName: string) => BmadWorkflowGenerator>(workflowMod, 'WorkflowCommandGenerator')

    const taskToolMod = _require(join(installerLibPath, 'ide', 'shared', 'task-tool-command-generator.js')) as Record<string, unknown>
    const TaskToolCommandGenerator = resolveExport<new (bmadFolderName: string) => BmadTaskToolGenerator>(taskToolMod, 'TaskToolCommandGenerator')

    const manifestMod = _require(join(installerLibPath, 'core', 'manifest-generator.js')) as Record<string, unknown>
    const ManifestGenerator = resolveExport<new () => BmadManifestGenerator>(manifestMod, 'ManifestGenerator')

    const nonCoreModules = scanBmadModules(bmadDir)
    const allModules = ['core', ...nonCoreModules]

    try {
      const manifestGen = new ManifestGenerator()
      await manifestGen.generateManifests(bmadDir, allModules, [], { ides: ['claude-code'] })
    } catch (manifestErr) {
      logger.warn({ err: manifestErr }, 'ManifestGenerator failed; workflow/task commands may be incomplete')
    }

    const commandsDir = join(projectRoot, '.claude', 'commands')
    mkdirSync(commandsDir, { recursive: true })
    clearBmadCommandFiles(commandsDir)

    const agentGen = new AgentCommandGenerator('_bmad')
    const { artifacts: agentArtifacts } = await agentGen.collectAgentArtifacts(bmadDir, nonCoreModules)
    const agentCount = await agentGen.writeDashArtifacts(commandsDir, agentArtifacts)

    const workflowGen = new WorkflowCommandGenerator('_bmad')
    const { artifacts: workflowArtifacts } = await workflowGen.collectWorkflowArtifacts(bmadDir)
    const workflowCount = await workflowGen.writeDashArtifacts(commandsDir, workflowArtifacts)

    const taskToolGen = new TaskToolCommandGenerator('_bmad')
    const { artifacts: taskToolArtifacts } = await taskToolGen.collectTaskToolArtifacts(bmadDir)
    const taskToolCount = await taskToolGen.writeDashArtifacts(commandsDir, taskToolArtifacts)

    const total = agentCount + workflowCount + taskToolCount
    if (outputFormat !== 'json') {
      process.stdout.write(
        `Generated ${String(total)} Claude Code commands (${String(agentCount)} agents, ${String(workflowCount)} workflows, ${String(taskToolCount)} tasks/tools)\n`,
      )
    }
    logger.info({ agentCount, workflowCount, taskToolCount, total, commandsDir }, 'Generated .claude/commands/')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (outputFormat !== 'json') {
      process.stderr.write(`Warning: .claude/commands/ generation failed: ${msg}\n`)
    }
    logger.warn({ err }, 'scaffoldClaudeCommands failed; init continues')
  }
}

// ---------------------------------------------------------------------------
// Provider config builder (from old init.ts)
// ---------------------------------------------------------------------------

const PROVIDER_DEFAULTS = DEFAULT_CONFIG.providers

const ADAPTER_TO_PROVIDER: Record<string, keyof typeof PROVIDER_DEFAULTS> = {
  'claude-code': 'claude',
  codex: 'codex',
  gemini: 'gemini',
}

const PROVIDER_KEY_ENV: Record<string, string> = {
  claude: 'ANTHROPIC_API_KEY',
  codex: 'OPENAI_API_KEY',
  gemini: 'GOOGLE_API_KEY',
}

function buildProviderConfig(
  adapterId: string,
  cliPath: string | undefined,
  subscriptionRouting: SubscriptionRouting,
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
// Profile display + prompting helpers
// ---------------------------------------------------------------------------

/**
 * Formats a detected project profile as a human-readable string.
 * For single projects: shows stack, build, and test commands.
 * For monorepos: shows the tool, root commands, and per-package breakdown.
 */
function formatProjectProfile(profile: ProjectProfile): string {
  const lines: string[] = ['', '  Detected project profile:']
  const { project } = profile

  if (project.type === 'monorepo') {
    lines.push(`  Type:  monorepo (${project.tool ?? 'unknown'})`)
    lines.push(`  Build: ${project.buildCommand}`)
    lines.push(`  Test:  ${project.testCommand}`)
    if (project.packages && project.packages.length > 0) {
      lines.push('  Packages:')
      for (const pkg of project.packages) {
        lines.push(`    ${pkg.path}  ${pkg.language}`)
      }
    }
  } else {
    const lang = project.language ?? 'unknown'
    const stackStr = project.framework ? `${lang} (${project.framework})` : lang
    lines.push(`  Stack: ${stackStr}`)
    lines.push(`  Build: ${project.buildCommand}`)
    lines.push(`  Test:  ${project.testCommand}`)
  }

  return lines.join('\n')
}

/**
 * Prompts the user to accept or decline the detected project profile.
 * In non-interactive mode, always returns true (auto-accept).
 */
async function promptProfileConfirmation(nonInteractive: boolean): Promise<boolean> {
  if (nonInteractive) return true

  const readline = await import('readline')
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise<boolean>((resolve) => {
    rl.question('\n  Accept detected project profile? [Y/n]: ', (answer) => {
      rl.close()
      const trimmed = answer.trim().toLowerCase()
      if (trimmed === '' || trimmed === 'y' || trimmed === 'yes') {
        resolve(true)
      } else {
        resolve(false)
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Interactive prompting
// ---------------------------------------------------------------------------

async function promptSubscriptionRouting(
  providerName: string,
  nonInteractive: boolean,
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
      },
    )
  })
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Combined init action
// ---------------------------------------------------------------------------

export interface InitOptions {
  /** Methodology pack name */
  pack: string
  /** Target directory (defaults to cwd) */
  projectRoot: string
  /** Output format */
  outputFormat: OutputFormat
  /** Force overwrite of existing files */
  force?: boolean
  /** Skip interactive prompts */
  yes?: boolean
  /** AdapterRegistry to use (injectable for testing) */
  registry?: AdapterRegistry
  /**
   * Dolt bootstrapping mode:
   *   'auto'  — detect Dolt on PATH; init if present, silently skip if absent (default)
   *   'force' — always init Dolt; error if Dolt is not installed
   *   'skip'  — skip Dolt bootstrapping entirely
   */
  doltMode?: 'auto' | 'force' | 'skip'
}

/**
 * Core init logic — combines old init (config files) + auto init (pack scaffolding).
 *
 * @returns exit code (0 = success, 1 = error)
 */
export async function runInitAction(options: InitOptions): Promise<number> {
  const {
    pack: packName,
    projectRoot,
    outputFormat,
    force = false,
    yes: nonInteractive = false,
  } = options

  const dbRoot = await resolveMainRepoRoot(projectRoot)
  const packPath = join(dbRoot, 'packs', packName)
  const substrateDir = join(dbRoot, '.substrate')
  const dbPath = join(substrateDir, 'substrate.db')
  const configPath = join(substrateDir, 'config.yaml')
  const routingPolicyPath = join(substrateDir, 'routing-policy.yaml')

  try {
    // ---------------------------------------------------------------
    // Step 1: Create .substrate/ directory + config files
    // ---------------------------------------------------------------
    const substrateExists = await directoryExists(substrateDir)

    if (substrateExists && !force && !nonInteractive) {
      // Interactive: warn but continue (config files are idempotent)
      if (outputFormat !== 'json') {
        process.stdout.write(`  .substrate/ directory already exists at ${substrateDir}\n`)
      }
    }

    // Adapter discovery
    if (outputFormat !== 'json') {
      process.stdout.write('\n  Discovering installed AI agents...\n')
    }
    const registry = options.registry
    if (!registry) {
      throw new Error('AdapterRegistry is required — must be initialized at CLI startup')
    }

    let discoveryReport
    try {
      discoveryReport = await registry.discoverAndRegister()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ err }, 'Adapter discovery failed')
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput(null, 'json', false, `Adapter discovery failed: ${message}`) + '\n')
      } else {
        process.stderr.write(`  Error: adapter discovery failed — ${message}\n`)
      }
      return INIT_EXIT_ERROR
    }

    const detectedAdapters = discoveryReport.results.filter((r) => r.registered)
    if (outputFormat !== 'json') {
      if (detectedAdapters.length > 0) {
        process.stdout.write(
          `  Detected ${String(detectedAdapters.length)} provider(s): ` +
            detectedAdapters.map((a) => a.displayName).join(', ') +
            '\n',
        )
      } else {
        process.stdout.write('  No AI agents detected. You can configure them manually later.\n')
      }
    }

    // Build provider configuration
    const providers: SubstrateConfig['providers'] = {}
    for (const adapterResult of discoveryReport.results) {
      const providerKey = ADAPTER_TO_PROVIDER[adapterResult.adapterId]
      if (!providerKey) continue

      if (adapterResult.registered) {
        const routing = await promptSubscriptionRouting(
          adapterResult.displayName,
          nonInteractive,
        )
        providers[providerKey] = buildProviderConfig(
          adapterResult.adapterId,
          adapterResult.healthResult.cliPath,
          routing,
        )
      } else {
        const defaults = (PROVIDER_DEFAULTS as Record<string, ProviderConfig>)[providerKey]
        if (defaults) {
          providers[providerKey] = { ...defaults, enabled: false }
        }
      }
    }

    const configProviders =
      Object.keys(providers).length > 0 ? providers : DEFAULT_CONFIG.providers

    const config: SubstrateConfig = {
      config_format_version: CURRENT_CONFIG_FORMAT_VERSION,
      task_graph_version: CURRENT_TASK_GRAPH_VERSION,
      global: DEFAULT_CONFIG.global,
      providers: configProviders,
      telemetry: DEFAULT_CONFIG.telemetry,
    }

    const routingPolicy: RoutingPolicy = structuredClone(DEFAULT_ROUTING_POLICY)

    // Write config files
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

    // ---------------------------------------------------------------
    // Step 1b: Detect and write project profile
    // ---------------------------------------------------------------
    const projectProfilePath = join(substrateDir, 'project-profile.yaml')
    let detectedProfile: ProjectProfile | null = null
    let projectProfileWritten = false

    try {
      detectedProfile = await detectProjectProfile(dbRoot)
    } catch (err) {
      logger.warn({ err }, 'Project profile detection failed; skipping')
    }

    if (detectedProfile === null) {
      if (outputFormat !== 'json') {
        process.stdout.write(
          '  No project stack detected. Create .substrate/project-profile.yaml manually to enable polyglot support.\n',
        )
      }
    } else {
      if (outputFormat !== 'json') {
        process.stdout.write(formatProjectProfile(detectedProfile) + '\n')
      }

      // Check if profile already exists (and no --force)
      let profileExists = false
      try {
        await access(projectProfilePath)
        profileExists = true
      } catch {
        // file does not exist — will write
      }

      if (profileExists && !force) {
        if (outputFormat !== 'json') {
          process.stdout.write(
            '  .substrate/project-profile.yaml already exists — skipping (use --force to overwrite)\n',
          )
        }
      } else {
        const accepted = await promptProfileConfirmation(nonInteractive)
        if (accepted) {
          await writeProjectProfile(projectProfilePath, detectedProfile)
          projectProfileWritten = true
        } else {
          if (outputFormat !== 'json') {
            process.stdout.write(
              '  Profile not written. Create .substrate/project-profile.yaml manually to enable polyglot support.\n',
            )
          }
        }
      }
    }

    // ---------------------------------------------------------------
    // Step 2: Scaffold BMAD framework
    // ---------------------------------------------------------------
    await scaffoldBmadFramework(projectRoot, force, outputFormat)

    // ---------------------------------------------------------------
    // Step 3: Scaffold pack
    // ---------------------------------------------------------------
    const localManifest = join(packPath, 'manifest.yaml')
    let scaffolded = false
    if (!existsSync(localManifest) || force) {
      const packageRoot = findPackageRoot(__dirname)
      const bundledPackPath = join(packageRoot, 'packs', packName)
      if (!existsSync(join(bundledPackPath, 'manifest.yaml'))) {
        const errorMsg = `Pack '${packName}' not found locally or in bundled packs. Try reinstalling Substrate.`
        if (outputFormat === 'json') {
          process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
        } else {
          process.stderr.write(`Error: ${errorMsg}\n`)
        }
        return INIT_EXIT_ERROR
      }
      if (force && existsSync(localManifest)) {
        logger.info({ pack: packName }, 'Replacing existing pack with bundled version')
        process.stderr.write(`Warning: Replacing existing pack '${packName}' with bundled version\n`)
      }
      mkdirSync(dirname(packPath), { recursive: true })
      cpSync(bundledPackPath, packPath, { recursive: true })
      logger.info({ pack: packName, dest: packPath }, 'Scaffolded methodology pack')
      if (outputFormat !== 'json') {
        process.stdout.write(`Scaffolding methodology pack '${packName}' into packs/${packName}/\n`)
      }
      scaffolded = true
    }

    // Validate the pack
    const packLoader = createPackLoader()
    try {
      await packLoader.load(packPath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const errorMsg = `Methodology pack '${packName}' not found. Check that packs/${packName}/manifest.yaml exists or try reinstalling Substrate.\n${msg}`
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
      } else {
        process.stderr.write(`Error: ${errorMsg}\n`)
      }
      return INIT_EXIT_ERROR
    }

    // ---------------------------------------------------------------
    // Step 4: Initialize database
    // ---------------------------------------------------------------
    const dbAdapter = createDatabaseAdapter({ backend: 'auto', basePath: projectRoot })
    await initSchema(dbAdapter)
    await dbAdapter.close()

    // ---------------------------------------------------------------
    // Step 5: Scaffold CLAUDE.md, statusline, settings, commands
    // ---------------------------------------------------------------
    await scaffoldClaudeMd(projectRoot, detectedProfile)
    await scaffoldStatuslineScript(projectRoot)
    await scaffoldClaudeSettings(projectRoot)
    await scaffoldClaudeCommands(projectRoot, outputFormat)

    // ---------------------------------------------------------------
    // Step 7: Dolt bootstrapping
    // ---------------------------------------------------------------
    const doltMode = options.doltMode ?? 'auto'
    let doltInitialized = false
    if (doltMode !== 'skip') {
      try {
        if (doltMode === 'auto') {
          await checkDoltInstalled() // throws DoltNotInstalled if absent
        }
        await initializeDolt({ projectRoot })
        doltInitialized = true
      } catch (err) {
        if (err instanceof DoltNotInstalled) {
          if (doltMode === 'force') {
            process.stderr.write(`${err.message}\n`)
            return INIT_EXIT_ERROR
          }
          // auto mode: silently skip
          logger.debug('Dolt not installed, skipping auto-init')
        } else {
          const msg = err instanceof Error ? err.message : String(err)
          if (doltMode === 'force') {
            process.stderr.write(`✗ Dolt initialization failed: ${msg}\n`)
            return INIT_EXIT_ERROR
          }
          // auto mode: warn but don't fail
          logger.warn({ error: msg }, 'Dolt auto-init failed (non-blocking)')
        }
      }
    } else {
      logger.debug('Dolt step was skipped (--no-dolt)')
    }

    // ---------------------------------------------------------------
    // Step 6: Success output
    // ---------------------------------------------------------------
    const successMsg = `Pack '${packName}' and database initialized successfully at ${dbPath}`
    if (outputFormat === 'json') {
      process.stdout.write(
        formatOutput({
          pack: packName,
          dbPath,
          scaffolded,
          configPath,
          routingPolicyPath,
          doltInitialized,
          projectProfile: detectedProfile ?? null,
          projectProfileWritten,
        }, 'json', true) + '\n',
      )
    } else {
      process.stdout.write(`\n  Substrate initialized successfully!\n\n`)

      // Adapter health table (reuse discovery results already in scope)
      const healthRows = buildAdapterHealthRows(discoveryReport.results)
      if (healthRows.length > 0) {
        process.stdout.write(`  Agents:\n`)
        const table = formatAdapterHealthTable(healthRows)
        for (const line of table.split('\n')) {
          process.stdout.write(`  ${line}\n`)
        }
        process.stdout.write('\n')
      }

      process.stdout.write(`  Scaffolded:\n`)
      process.stdout.write(`    CLAUDE.md             pipeline instructions for Claude Code\n`)
      process.stdout.write(`    .claude/commands/     /substrate-run, /substrate-supervisor, /substrate-metrics\n`)
      process.stdout.write(`    .substrate/           config, database, routing policy\n`)

      if (doltInitialized) {
        process.stdout.write(`✓ Dolt state store initialized at .substrate/state/\n`)
      } else if (doltMode !== 'skip') {
        process.stdout.write(
          `ℹ  Dolt not detected — install Dolt for versioned state, \`substrate diff\`, and observability persistence. See: https://docs.dolthub.com/introduction/installation\n`,
        )
      }

      process.stdout.write(
        `\n  Next steps:\n` +
          `    1. Start a Claude Code session in this project\n` +
          `    2. Tell Claude: "Run the substrate pipeline"\n` +
          `    3. Or use the /substrate-run slash command for a guided run\n`,
      )
    }

    return INIT_EXIT_SUCCESS
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput(null, 'json', false, msg) + '\n')
    } else {
      process.stderr.write(`Error: ${msg}\n`)
    }
    logger.error({ err }, 'init failed')
    return INIT_EXIT_ERROR
  }
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function registerInitCommand(
  program: Command,
  _version: string,
  registry?: AdapterRegistry,
): void {
  program
    .command('init')
    .description(
      'Initialize Substrate — creates config, scaffolds methodology pack, and sets up database',
    )
    .option('--pack <name>', 'Methodology pack name', 'bmad')
    .option('--project-root <path>', 'Project root directory', process.cwd())
    .option('-y, --yes', 'Skip all interactive prompts and use defaults', false)
    .option('--force', 'Overwrite existing files and packs', false)
    .option(
      '--output-format <format>',
      'Output format: human (default) or json',
      'human',
    )
    .option('--dolt', 'Initialize Dolt state database as part of init (forces Dolt bootstrapping)', false)
    .option('--no-dolt', 'Skip Dolt state store initialization even if Dolt is installed')
    .action(async (opts: {
      pack: string
      projectRoot: string
      yes: boolean
      force: boolean
      outputFormat: string
      dolt: boolean
      noDolt: boolean
    }) => {
      const outputFormat: OutputFormat = opts.outputFormat === 'json' ? 'json' : 'human'

      const doltMode = opts.noDolt ? 'skip' : opts.dolt ? 'force' : 'auto'

      const exitCode = await runInitAction({
        pack: opts.pack,
        projectRoot: opts.projectRoot,
        outputFormat,
        force: opts.force,
        yes: opts.yes,
        doltMode,
        ...(registry !== undefined && { registry }),
      })
      process.exitCode = exitCode
    })
}
