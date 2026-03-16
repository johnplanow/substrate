/**
 * build-dev-notes.ts — Stack-aware dev workflow section generator for CLAUDE.md.
 *
 * Generates a human-readable "Dev Workflow" section for CLAUDE.md based on
 * a project's detected profile. This is a pure function — no filesystem I/O,
 * no YAML parsing, no async. Accepts a `ProjectProfile | null` and returns
 * a `string`.
 *
 * Wrapped in `<!-- dev-workflow:start -->` / `<!-- dev-workflow:end -->` markers
 * for idempotent re-runs (analogous to the substrate section markers).
 */

import type { ProjectProfile, PackageEntry } from '../../modules/project-profile/types.js'

export const DEV_WORKFLOW_START_MARKER = '<!-- dev-workflow:start -->'
export const DEV_WORKFLOW_END_MARKER = '<!-- dev-workflow:end -->'

// ---------------------------------------------------------------------------
// Package manager detection helpers
// ---------------------------------------------------------------------------

type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm'

function detectPackageManager(buildCommand: string): PackageManager {
  if (buildCommand.includes('pnpm')) return 'pnpm'
  if (buildCommand.includes('yarn')) return 'yarn'
  if (buildCommand.includes('bun')) return 'bun'
  return 'npm'
}

function getBuildCmd(pm: PackageManager): string {
  switch (pm) {
    case 'pnpm':
      return 'pnpm run build'
    case 'yarn':
      return 'yarn build'
    case 'bun':
      return 'bun run build'
    default:
      return 'npm run build'
  }
}

function getTestCmd(pm: PackageManager): string {
  switch (pm) {
    case 'pnpm':
      return 'pnpm test'
    case 'yarn':
      return 'yarn test'
    case 'bun':
      return 'bun test'
    default:
      return 'npm test'
  }
}

// ---------------------------------------------------------------------------
// Per-stack default test command (used in monorepo package table fallback)
// ---------------------------------------------------------------------------

function stackDefaultTestCommand(pkg: PackageEntry): string {
  if (pkg.testCommand) return pkg.testCommand
  switch (pkg.language) {
    case 'go':
      return 'go test ./...'
    case 'rust':
      return 'cargo test'
    case 'java':
    case 'kotlin':
      if (pkg.buildTool === 'maven') return 'mvn test'
      return './gradlew test'
    case 'python':
      return 'pytest'
    default: {
      // TypeScript/JavaScript — infer package manager from buildTool or buildCommand
      const buildToolPm = pkg.buildTool as PackageManager | undefined
      if (buildToolPm === 'pnpm') return 'pnpm test'
      if (buildToolPm === 'yarn') return 'yarn test'
      if (buildToolPm === 'bun') return 'bun test'
      return 'npm test'
    }
  }
}

// ---------------------------------------------------------------------------
// Per-stack section builders
// ---------------------------------------------------------------------------

function buildNodeSection(buildCommand: string): string {
  const pm = detectPackageManager(buildCommand)
  const buildCmd = getBuildCmd(pm)
  const testCmd = getTestCmd(pm)

  return [
    '## Dev Workflow',
    '',
    '**Build:** `' + buildCmd + '`',
    '**Test:** `' + testCmd + '`',
    '',
    '### Testing Notes',
    '- Run targeted tests during development to avoid slow feedback loops',
    '- Run the full suite before merging',
  ].join('\n')
}

function buildGoSection(): string {
  return [
    '## Dev Workflow',
    '',
    '**Build:** `go build ./...`',
    '**Test:** `go test ./...`',
    '',
    '### Testing Notes',
    '- Run targeted tests: `go test ./pkg/... -v -run TestFunctionName`',
    '- Run with short flag to skip long-running tests: `go test ./... -short`',
    '- Verbose output: `go test ./... -v`',
  ].join('\n')
}

function buildGradleSection(): string {
  return [
    '## Dev Workflow',
    '',
    '**Build:** `./gradlew build`',
    '**Test:** `./gradlew test`',
    '',
    '### Testing Notes',
    '- Run a specific test class: `./gradlew test --tests "com.example.ClassName"`',
    '- Run a specific method: `./gradlew test --tests "com.example.ClassName.methodName"`',
  ].join('\n')
}

function buildMavenSection(): string {
  return [
    '## Dev Workflow',
    '',
    '**Build:** `mvn compile`',
    '**Test:** `mvn test`',
    '',
    '### Testing Notes',
    '- Run a specific test class: `mvn test -Dtest=ClassName`',
    '- Run a specific method: `mvn test -Dtest="ClassName#methodName"`',
  ].join('\n')
}

function buildCargoSection(): string {
  return [
    '## Dev Workflow',
    '',
    '**Build:** `cargo build`',
    '**Test:** `cargo test`',
    '',
    '### Testing Notes',
    '- Show test output: `cargo test -- --nocapture`',
    '- Run a specific test: `cargo test test_function_name`',
    '- Run tests in a module: `cargo test --lib test_module`',
  ].join('\n')
}

function buildPythonSection(buildCommand: string): string {
  // Derive install command from buildCommand
  let installCmd: string
  if (buildCommand.includes('poetry')) {
    installCmd = 'poetry install'
  } else {
    installCmd = 'pip install -e .'
  }

  return [
    '## Dev Workflow',
    '',
    '**Install:** `' + installCmd + '`',
    '**Test:** `pytest -v`',
    '',
    '### Testing Notes',
    '- Run targeted tests: `pytest -k "test_name" -v`',
    '- Run a specific file and test: `pytest tests/test_foo.py::test_bar -v`',
  ].join('\n')
}

function buildMonorepoSection(profile: ProjectProfile): string {
  const { project } = profile
  const lines: string[] = [
    '## Dev Workflow',
    '',
    `**Root build:** \`${project.buildCommand}\``,
    `**Root test:** \`${project.testCommand}\``,
  ]

  const packages = project.packages ?? []
  if (packages.length > 0) {
    lines.push('')
    lines.push('### Package Structure')
    lines.push('')
    lines.push('| Package | Language | Framework | Test Command |')
    lines.push('|---------|----------|-----------|--------------|')
    for (const pkg of packages) {
      const lang = pkg.language
      const framework = pkg.framework ?? '—'
      const testCmd = stackDefaultTestCommand(pkg)
      lines.push(`| ${pkg.path} | ${lang} | ${framework} | ${testCmd} |`)
    }
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates a stack-aware "Dev Workflow" section for inclusion in CLAUDE.md.
 *
 * Returns an empty string when `profile` is null (backward-compatible — the
 * caller should skip prepending the dev workflow block in that case).
 *
 * When a profile is present, returns a string wrapped in
 * `<!-- dev-workflow:start -->` / `<!-- dev-workflow:end -->` markers.
 */
export function buildStackAwareDevNotes(profile: ProjectProfile | null): string {
  if (!profile) return ''

  const { project } = profile

  let body: string

  if (project.type === 'monorepo') {
    body = buildMonorepoSection(profile)
  } else {
    // Single-stack project — dispatch on language / buildTool
    const buildTool = project.buildTool
    const language = project.language

    if (buildTool === 'go' || language === 'go') {
      body = buildGoSection()
    } else if (buildTool === 'gradle') {
      body = buildGradleSection()
    } else if (buildTool === 'maven') {
      body = buildMavenSection()
    } else if (buildTool === 'cargo' || language === 'rust') {
      body = buildCargoSection()
    } else if (language === 'python') {
      body = buildPythonSection(project.buildCommand)
    } else {
      // TypeScript / JavaScript / default Node.js
      body = buildNodeSection(project.buildCommand)
    }
  }

  return [
    DEV_WORKFLOW_START_MARKER,
    body,
    DEV_WORKFLOW_END_MARKER,
  ].join('\n')
}
