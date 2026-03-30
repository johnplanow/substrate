/**
 * Validation Level 1 — Build Verification.
 *
 * Runs `npx tsc --noEmit` followed by `npm run build` as pluggable
 * ValidationLevel in the cascade.  TypeScript compiler errors are parsed
 * into structured FailureDetail / LevelFailure objects and a precise
 * RemediationContext (with surgical vs partial scope) is returned so the
 * retry loop can feed targeted fix instructions back to the agent.
 */

import { spawnSync } from 'node:child_process'
import { relative } from 'node:path'
import type {
  FailureDetail,
  LevelResult,
  RemediationContext,
  ValidationContext,
  ValidationLevel,
} from '../types.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Configuration for BuildValidationLevel.
 */
export interface BuildValidatorConfig {
  /**
   * Maximum milliseconds to allow for a single build step (tsc or npm run
   * build).  Defaults to 30 000 ms.
   */
  timeoutMs?: number
  /**
   * Absolute path to the project root.  When omitted the level uses
   * `ValidationContext.projectRoot` at runtime.
   */
  projectRoot?: string
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * A parsed TypeScript compiler diagnostic.
 */
export interface TscDiagnostic {
  /** Path of the file (relative to projectRoot) */
  file: string
  /** 1-based line number */
  line: number
  /** Full error message text */
  message: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse `tsc --noEmit` stdout/stderr into structured diagnostics.
 *
 * Matches lines of the form:
 *   <file>(<line>,<col>): error TS<code>: <message>
 *
 * Multi-line supplement lines (indented context / caret lines) are ignored.
 */
export function parseTscDiagnostics(
  output: string,
  projectRoot: string,
): TscDiagnostic[] {
  const diagnostics: TscDiagnostic[] = []

  // Regex: path(line,col): error TSxxx: message
  const diagPattern = /^(.+?)\((\d+),\d+\):\s+error\s+TS\d+:\s+(.+)$/

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    const match = diagPattern.exec(line)
    if (!match) continue

    const [, filePath, lineStr, message] = match
    const fp = filePath ?? ''
    // Normalize to relative path — only call relative() when the path is
    // absolute; if it is already relative, use it as-is to avoid incorrect
    // resolution against process.cwd().
    let relFile: string
    try {
      relFile = fp.startsWith('/') ? relative(projectRoot, fp) : fp
    } catch {
      relFile = fp
    }

    diagnostics.push({
      file: relFile,
      line: parseInt(lineStr ?? '0', 10),
      message: message ?? '',
    })
  }

  return diagnostics
}

/**
 * Determine the remediation scope based on how many distinct files are affected.
 *
 * - ≤2 distinct files → `'surgical'`
 * - >2 distinct files → `'partial'`
 */
export function determineBuildScope(
  diagnostics: TscDiagnostic[],
): 'surgical' | 'partial' {
  const distinctFiles = new Set(diagnostics.map((d) => d.file))
  return distinctFiles.size <= 2 ? 'surgical' : 'partial'
}

// ---------------------------------------------------------------------------
// BuildValidationLevel
// ---------------------------------------------------------------------------

/**
 * Cascade ValidationLevel that verifies the project builds successfully.
 *
 * Level number: 1  (runs after structural validation at level 0)
 *
 * Execution order:
 *  1. `npx tsc --noEmit`  — if this fails (or times out), skip step 2
 *  2. `npm run build`     — if this fails, capture its output
 */
export class BuildValidationLevel implements ValidationLevel {
  readonly level = 1
  readonly name = 'build'

  private readonly config: BuildValidatorConfig

  constructor(config: BuildValidatorConfig = {}) {
    this.config = config
  }

  async run(context: ValidationContext): Promise<LevelResult> {
    const projectRoot = this.config.projectRoot ?? context.projectRoot
    const timeoutMs = this.config.timeoutMs ?? 30_000

    // -----------------------------------------------------------------------
    // Step 1: tsc --noEmit
    // -----------------------------------------------------------------------
    const tscResult = spawnSync('npx', ['tsc', '--noEmit'], {
      cwd: projectRoot,
      timeout: timeoutMs,
      encoding: 'utf8',
    })

    if (tscResult.signal === 'SIGTERM' || tscResult.error?.message?.includes('ETIMEDOUT')) {
      return this._timeoutResult(projectRoot, timeoutMs)
    }

    if (tscResult.status !== 0) {
      const combinedOutput = [
        tscResult.stdout ?? '',
        tscResult.stderr ?? '',
      ].join('\n')
      return this._buildTscFailureResult(combinedOutput, projectRoot, timeoutMs)
    }

    // -----------------------------------------------------------------------
    // Step 2: npm run build (only if tsc passed)
    // -----------------------------------------------------------------------
    const buildResult = spawnSync('npm', ['run', 'build'], {
      cwd: projectRoot,
      timeout: timeoutMs,
      encoding: 'utf8',
    })

    if (buildResult.signal === 'SIGTERM' || buildResult.error?.message?.includes('ETIMEDOUT')) {
      return this._timeoutResult(projectRoot, timeoutMs)
    }

    if (buildResult.status !== 0) {
      const combinedOutput = [
        buildResult.stdout ?? '',
        buildResult.stderr ?? '',
      ].join('\n')
      return this._buildNpmFailureResult(combinedOutput, projectRoot, timeoutMs)
    }

    // All clear
    return {
      passed: true,
      failures: [],
      canAutoRemediate: false,
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _timeoutResult(projectRoot: string, timeoutMs: number): LevelResult {
    const evidence = `Build step timed out after ${timeoutMs}ms`
    const failure: FailureDetail = {
      category: 'build',
      description: 'Build step timed out',
      evidence,
    }
    const remediationContext: RemediationContext = {
      level: this.level,
      failures: [failure],
      retryBudget: { spent: 0, remaining: 3 },
      scope: 'partial',
      canAutoRemediate: false,
    }
    return {
      passed: false,
      failures: [failure],
      canAutoRemediate: false,
      remediationContext,
    }
  }

  private _buildTscFailureResult(
    output: string,
    projectRoot: string,
    timeoutMs: number,
  ): LevelResult {
    const diagnostics = parseTscDiagnostics(output, projectRoot)
    return this._buildFailureResult(diagnostics, output, projectRoot, timeoutMs, 'tsc')
  }

  private _buildNpmFailureResult(
    output: string,
    projectRoot: string,
    timeoutMs: number,
  ): LevelResult {
    // npm run build may emit tsc diagnostics too; parse them if present
    const diagnostics = parseTscDiagnostics(output, projectRoot)
    return this._buildFailureResult(diagnostics, output, projectRoot, timeoutMs, 'npm-build')
  }

  private _buildFailureResult(
    diagnostics: TscDiagnostic[],
    evidence: string,
    projectRoot: string,
    _timeoutMs: number,
    _source: string,
  ): LevelResult {
    let failures: FailureDetail[]

    if (diagnostics.length > 0) {
      failures = diagnostics.map((d): FailureDetail => ({
        category: 'build',
        description: d.message,
        location: `${d.file}:${d.line}`,
        evidence,
        suggestedAction: 'Fix type errors',
      }))
    } else {
      // No parseable diagnostics — generic build failure
      failures = [
        {
          category: 'build',
          description: 'Build failed with non-zero exit code',
          evidence,
          suggestedAction: 'Fix type errors',
        },
      ]
    }

    const scope = diagnostics.length > 0
      ? determineBuildScope(diagnostics)
      : 'partial'

    const remediationContext: RemediationContext = {
      level: this.level,
      failures,
      retryBudget: { spent: 0, remaining: 3 },
      scope,
      canAutoRemediate: true,
    }

    return {
      passed: false,
      failures,
      canAutoRemediate: true,
      remediationContext,
    }
  }
}
