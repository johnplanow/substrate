/**
 * codebase-scanner.ts — Codebase Context Extraction
 *
 * Scans a project directory and extracts structured metadata for inclusion
 * in planning prompts. Pure function module — no classes, no event bus.
 *
 * Architecture: ADR-001 (Modular Monolith), FR47 (codebase-aware planning)
 */

import {
  readdirSync,
  statSync,
  readFileSync,
  existsSync,
} from 'fs'
import { join, relative } from 'path'

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Typed error for codebase scanning failures.
 */
export class ScanError extends Error {
  constructor(
    message: string,
    public readonly code: 'SCAN_PATH_NOT_FOUND' | 'SCAN_PATH_NOT_DIR',
  ) {
    super(message)
    this.name = 'ScanError'
  }
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface TechStackItem {
  /** e.g. "TypeScript", "Node.js", "React" */
  name: string
  /** if detectable */
  version?: string
  /** which file revealed this (e.g. "package.json") */
  source: string
}

export interface KeyFile {
  relativePath: string
  /** extracted subset or truncated content */
  contentSummary: string
  /** true if file exceeded 50KB limit */
  skipped: boolean
}

export interface DependencySummary {
  /** name -> version from package.json dependencies */
  runtime: Record<string, string>
  /** name -> version from devDependencies */
  development: Record<string, string>
}

export interface CodebaseContext {
  rootPath: string
  detectedLanguages: string[]
  techStack: TechStackItem[]
  /** top-level and sub-directories (up to contextDepth) — excludes node_modules etc. */
  topLevelDirs: string[]
  keyFiles: KeyFile[]
  dependencies: DependencySummary
}

export interface ScanOptions {
  /** default 2 */
  contextDepth?: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.substrate-worktrees',
  'dist',
  'build',
  '.cache',
  '__pycache__',
  'target',
])

const MAX_FILE_SIZE = 50 * 1024 // 50KB

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan the given directory and extract structured codebase context
 * for inclusion in a planning prompt.
 *
 * @param dirPath - Absolute or relative path to the project root
 * @param options - Scan options (depth, etc.)
 * @returns CodebaseContext
 */
export async function scanCodebase(dirPath: string, options?: ScanOptions): Promise<CodebaseContext> {
  const contextDepth = options?.contextDepth ?? 2

  // Validate path exists
  if (!existsSync(dirPath)) {
    throw new ScanError(`Codebase path not found: ${dirPath}`, 'SCAN_PATH_NOT_FOUND')
  }

  // Validate it is a directory
  let stat
  try {
    stat = statSync(dirPath)
  } catch {
    throw new ScanError(`Codebase path not found: ${dirPath}`, 'SCAN_PATH_NOT_FOUND')
  }

  if (!stat.isDirectory()) {
    throw new ScanError(`Codebase path is not a directory: ${dirPath}`, 'SCAN_PATH_NOT_DIR')
  }

  const techStack: TechStackItem[] = []
  const keyFiles: KeyFile[] = []
  const dependencies: DependencySummary = { runtime: {}, development: {} }
  const topLevelDirs: string[] = []

  // Collect directory names up to contextDepth levels.
  // contextDepth=0 → no dirs listed; contextDepth=1 → only immediate children;
  // contextDepth=2 → immediate children and their children (etc.)
  if (contextDepth > 0) {
    collectDirs(dirPath, dirPath, 1, contextDepth, topLevelDirs)
  }

  // Process well-known config files for tech stack detection
  processPackageJson(dirPath, techStack, dependencies, keyFiles)
  processTsConfig(dirPath, techStack, keyFiles)
  processPyprojectToml(dirPath, techStack, keyFiles)
  processGoMod(dirPath, techStack, keyFiles)
  processCargoToml(dirPath, techStack, keyFiles)
  processPomXml(dirPath, techStack, keyFiles)
  processBuildGradle(dirPath, techStack, keyFiles)

  // Read README.md (first 500 chars)
  processReadme(dirPath, keyFiles)

  // Read .substrate/substrate.yaml if present
  processSubstrateYaml(dirPath, keyFiles)

  // Derive detected languages from tech stack
  const detectedLanguages = deriveLanguages(techStack)

  return {
    rootPath: dirPath,
    detectedLanguages,
    techStack,
    topLevelDirs,
    keyFiles,
    dependencies,
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collect directory names relative to rootPath.
 * Called with currentDepth=1 for the first level of directories.
 * Only adds directories when currentDepth <= maxDepth.
 * Recurses deeper when currentDepth < maxDepth.
 */
function collectDirs(
  rootPath: string,
  currentPath: string,
  currentDepth: number,
  maxDepth: number,
  result: string[],
): void {
  let entries
  try {
    entries = readdirSync(currentPath, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (EXCLUDED_DIRS.has(entry.name)) continue

    const fullPath = join(currentPath, entry.name)
    const relPath = relative(rootPath, fullPath)

    // Add to result if within depth limit
    if (currentDepth <= maxDepth) {
      result.push(relPath)
    }

    // Recurse deeper if not yet at maxDepth
    if (currentDepth < maxDepth) {
      collectDirs(rootPath, fullPath, currentDepth + 1, maxDepth, result)
    }
  }
}

/**
 * Read a key file, enforcing the 50KB size limit.
 * Returns { content, skipped }.
 */
function readKeyFile(filePath: string, maxChars?: number): { content: string; skipped: boolean } {
  try {
    const stat = statSync(filePath)
    if (stat.size > MAX_FILE_SIZE) {
      return {
        content: `[File skipped: exceeds 50KB limit (${String(stat.size)} bytes)]`,
        skipped: true,
      }
    }
    const raw = readFileSync(filePath, 'utf-8')
    const content = maxChars !== undefined ? raw.slice(0, maxChars) : raw
    return { content, skipped: false }
  } catch {
    return { content: '', skipped: false }
  }
}

/**
 * Process package.json to detect Node.js, TypeScript, and frameworks.
 */
function processPackageJson(
  dirPath: string,
  techStack: TechStackItem[],
  dependencies: DependencySummary,
  keyFiles: KeyFile[],
): void {
  const filePath = join(dirPath, 'package.json')
  if (!existsSync(filePath)) return

  const { content, skipped } = readKeyFile(filePath)
  if (skipped) {
    keyFiles.push({ relativePath: 'package.json', contentSummary: content, skipped: true })
    return
  }
  if (!content) return

  let pkg: {
    name?: string
    version?: string
    description?: string
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    scripts?: Record<string, string>
    engines?: { node?: string }
  }

  try {
    pkg = JSON.parse(content) as typeof pkg
  } catch {
    return
  }

  // Node.js always detected from package.json
  techStack.push({
    name: 'Node.js',
    version: pkg.engines?.node,
    source: 'package.json',
  })

  // Check devDependencies for TypeScript
  const devDeps = pkg.devDependencies ?? {}
  const deps = pkg.dependencies ?? {}

  if (devDeps['typescript'] !== undefined || deps['typescript'] !== undefined) {
    const tsVersion = devDeps['typescript'] ?? deps['typescript']
    techStack.push({ name: 'TypeScript', version: tsVersion, source: 'package.json' })
  }

  // Frontend frameworks
  if (deps['react'] !== undefined || deps['react-dom'] !== undefined) {
    techStack.push({ name: 'React', version: deps['react'], source: 'package.json' })
  }
  if (deps['vue'] !== undefined) {
    techStack.push({ name: 'Vue', version: deps['vue'], source: 'package.json' })
  }
  if (deps['next'] !== undefined) {
    techStack.push({ name: 'Next.js', version: deps['next'], source: 'package.json' })
  }
  if (deps['express'] !== undefined) {
    techStack.push({ name: 'Express', version: deps['express'], source: 'package.json' })
  }
  if (deps['fastify'] !== undefined) {
    techStack.push({ name: 'Fastify', version: deps['fastify'], source: 'package.json' })
  }

  // Record dependencies
  dependencies.runtime = deps
  dependencies.development = devDeps

  // Build a structured subset of package.json for keyFiles
  const summary = JSON.stringify({
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    scripts: pkg.scripts ? Object.keys(pkg.scripts) : [],
    dependencyCount: Object.keys(deps).length,
    devDependencyCount: Object.keys(devDeps).length,
  }, null, 2)

  keyFiles.push({ relativePath: 'package.json', contentSummary: summary, skipped: false })
}

/**
 * Process tsconfig.json.
 */
function processTsConfig(
  dirPath: string,
  techStack: TechStackItem[],
  keyFiles: KeyFile[],
): void {
  const filePath = join(dirPath, 'tsconfig.json')
  if (!existsSync(filePath)) return

  const { content, skipped } = readKeyFile(filePath)
  if (skipped) {
    keyFiles.push({ relativePath: 'tsconfig.json', contentSummary: content, skipped: true })
    return
  }
  if (!content) return

  // Only add TypeScript to techStack if not already there from package.json
  const alreadyHasTs = techStack.some((item) => item.name === 'TypeScript')
  if (!alreadyHasTs) {
    techStack.push({ name: 'TypeScript', source: 'tsconfig.json' })
  }

  let parsed: {
    compilerOptions?: { target?: string; module?: string; strict?: boolean }
  } = {}
  try {
    parsed = JSON.parse(content) as typeof parsed
  } catch {
    // tsconfig can have comments — just record raw content if parse fails
  }

  const summary = JSON.stringify({
    compilerOptions: {
      target: parsed.compilerOptions?.target,
      module: parsed.compilerOptions?.module,
      strict: parsed.compilerOptions?.strict,
    },
  }, null, 2)

  keyFiles.push({ relativePath: 'tsconfig.json', contentSummary: summary, skipped: false })
}

/**
 * Process pyproject.toml or setup.py.
 */
function processPyprojectToml(
  dirPath: string,
  techStack: TechStackItem[],
  keyFiles: KeyFile[],
): void {
  const pyprojectPath = join(dirPath, 'pyproject.toml')
  const setupPath = join(dirPath, 'setup.py')

  if (existsSync(pyprojectPath)) {
    const { content, skipped } = readKeyFile(pyprojectPath)
    if (skipped) {
      keyFiles.push({ relativePath: 'pyproject.toml', contentSummary: content, skipped: true })
      return
    }
    techStack.push({ name: 'Python', source: 'pyproject.toml' })
    keyFiles.push({
      relativePath: 'pyproject.toml',
      contentSummary: content.slice(0, 500),
      skipped: false,
    })
  } else if (existsSync(setupPath)) {
    const { content, skipped } = readKeyFile(setupPath)
    if (skipped) {
      keyFiles.push({ relativePath: 'setup.py', contentSummary: content, skipped: true })
      return
    }
    techStack.push({ name: 'Python', source: 'setup.py' })
    keyFiles.push({
      relativePath: 'setup.py',
      contentSummary: content.slice(0, 500),
      skipped: false,
    })
  }
}

/**
 * Process go.mod.
 */
function processGoMod(
  dirPath: string,
  techStack: TechStackItem[],
  keyFiles: KeyFile[],
): void {
  const filePath = join(dirPath, 'go.mod')
  if (!existsSync(filePath)) return

  const { content, skipped } = readKeyFile(filePath)
  if (skipped) {
    keyFiles.push({ relativePath: 'go.mod', contentSummary: content, skipped: true })
    return
  }

  // Extract Go version from "go X.Y" line
  const versionMatch = /^go\s+(\S+)/m.exec(content)
  const version = versionMatch?.[1]

  techStack.push({ name: 'Go', version, source: 'go.mod' })
  keyFiles.push({
    relativePath: 'go.mod',
    contentSummary: content.slice(0, 500),
    skipped: false,
  })
}

/**
 * Process Cargo.toml.
 */
function processCargoToml(
  dirPath: string,
  techStack: TechStackItem[],
  keyFiles: KeyFile[],
): void {
  const filePath = join(dirPath, 'Cargo.toml')
  if (!existsSync(filePath)) return

  const { content, skipped } = readKeyFile(filePath)
  if (skipped) {
    keyFiles.push({ relativePath: 'Cargo.toml', contentSummary: content, skipped: true })
    return
  }

  techStack.push({ name: 'Rust', source: 'Cargo.toml' })
  keyFiles.push({
    relativePath: 'Cargo.toml',
    contentSummary: content.slice(0, 500),
    skipped: false,
  })
}

/**
 * Process pom.xml (Java/Maven).
 */
function processPomXml(
  dirPath: string,
  techStack: TechStackItem[],
  keyFiles: KeyFile[],
): void {
  const filePath = join(dirPath, 'pom.xml')
  if (!existsSync(filePath)) return

  const { content, skipped } = readKeyFile(filePath)
  if (skipped) {
    keyFiles.push({ relativePath: 'pom.xml', contentSummary: content, skipped: true })
    return
  }

  techStack.push({ name: 'Java', source: 'pom.xml' })
  keyFiles.push({
    relativePath: 'pom.xml',
    contentSummary: content.slice(0, 500),
    skipped: false,
  })
}

/**
 * Process build.gradle (Java/Kotlin/JVM).
 */
function processBuildGradle(
  dirPath: string,
  techStack: TechStackItem[],
  keyFiles: KeyFile[],
): void {
  const filePath = join(dirPath, 'build.gradle')
  const kotlinPath = join(dirPath, 'build.gradle.kts')

  const targetPath = existsSync(filePath) ? filePath : existsSync(kotlinPath) ? kotlinPath : null
  if (targetPath === null) return

  const relPath = targetPath === filePath ? 'build.gradle' : 'build.gradle.kts'
  const { content, skipped } = readKeyFile(targetPath)
  if (skipped) {
    keyFiles.push({ relativePath: relPath, contentSummary: content, skipped: true })
    return
  }

  techStack.push({ name: 'Java', source: relPath })
  keyFiles.push({
    relativePath: relPath,
    contentSummary: content.slice(0, 500),
    skipped: false,
  })
}

/**
 * Process README.md (first 500 chars).
 */
function processReadme(dirPath: string, keyFiles: KeyFile[]): void {
  const filePath = join(dirPath, 'README.md')
  if (!existsSync(filePath)) return

  const { content, skipped } = readKeyFile(filePath, 500)
  if (skipped) {
    keyFiles.push({ relativePath: 'README.md', contentSummary: content, skipped: true })
    return
  }

  keyFiles.push({
    relativePath: 'README.md',
    contentSummary: content,
    skipped: false,
  })
}

/**
 * Process .substrate/substrate.yaml.
 */
function processSubstrateYaml(dirPath: string, keyFiles: KeyFile[]): void {
  const filePath = join(dirPath, '.substrate', 'substrate.yaml')
  if (!existsSync(filePath)) return

  const { content, skipped } = readKeyFile(filePath)
  if (skipped) {
    keyFiles.push({ relativePath: '.substrate/substrate.yaml', contentSummary: content, skipped: true })
    return
  }

  keyFiles.push({
    relativePath: '.substrate/substrate.yaml',
    contentSummary: content.slice(0, 1000),
    skipped: false,
  })
}

/**
 * Derive human-readable language names from detected tech stack.
 */
function deriveLanguages(techStack: TechStackItem[]): string[] {
  const languages = new Set<string>()

  for (const item of techStack) {
    switch (item.name) {
      case 'TypeScript':
        languages.add('TypeScript')
        languages.add('JavaScript')
        break
      case 'Node.js':
        languages.add('JavaScript')
        break
      case 'Python':
        languages.add('Python')
        break
      case 'Go':
        languages.add('Go')
        break
      case 'Rust':
        languages.add('Rust')
        break
      case 'Java':
        languages.add('Java')
        break
      default:
        break
    }
  }

  return [...languages]
}
