/**
 * Acceptance Gate — per-project acceptance contract (story A1.1).
 *
 * Substrate is language-agnostic by standing constraint: it cannot know how
 * to boot arbitrary products. The project DECLARES how its user-facing
 * surfaces render — an `acceptance:` block in `.substrate/project-profile.yaml`,
 * authored at solutioning time exactly like `testCommand`. Substrate
 * orchestrates; it never guesses.
 *
 * INJECTION SAFETY (the v0.21.0 ultra-review command-injection lesson,
 * applied in advance): render commands are split into argv BEFORE placeholder
 * substitution and executed with no shell. A hostile value in `{fixtures}` /
 * `{artifacts}` / `{port}` stays a single literal argv token — `;`, backticks
 * and `$(…)` are just bytes in an argument. The cost: no shell features in
 * render commands (no pipes/redirects/quoting) — wrap complex renders in a
 * script file and declare that.
 */

import { load as loadYaml, YAMLException } from 'js-yaml'
import { z } from 'zod'
import type { RegistryValidationIssue } from './types.js'

/** The acceptance contract lives inside the project profile. */
export const ACCEPTANCE_CONTRACT_PROFILE_PATH = '.substrate/project-profile.yaml'

const RenderSurfaceSchema = z
  .object({
    /** Command producing the surface's artifacts. Argv-split; `{fixtures}` `{artifacts}` placeholders. */
    render: z.string().min(1),
  })
  .strict()

const WebSurfaceSchema = z
  .object({
    /** Long-running serve command (web driver is out of program scope — schema registered for forward-compat). */
    serve: z.string().min(1),
    /** Readiness URL polled before walking; `{port}` placeholder. */
    ready: z.string().optional(),
  })
  .strict()

export const AcceptanceContractSchema = z
  .object({
    /** Repo-relative path of fixture data the renders consume. */
    fixtures: z.string().optional(),
    surfaces: z
      .object({
        email: RenderSurfaceSchema.optional(),
        cli: RenderSurfaceSchema.optional(),
        file: RenderSurfaceSchema.optional(),
        web: WebSurfaceSchema.optional(),
      })
      .strict(),
  })
  .strict()

export type AcceptanceContract = z.infer<typeof AcceptanceContractSchema>

/** Surfaces the render executor can produce today (web = serve-based, A-later). */
export type RenderableSurface = 'email' | 'cli' | 'file'

export type ContractParseResult =
  | { status: 'ok'; contract: AcceptanceContract }
  | { status: 'absent' }
  | { status: 'invalid'; issues: RegistryValidationIssue[] }

/**
 * Extract + validate the `acceptance:` block from project-profile YAML
 * content. `absent` when the profile has no block (legal — the coverage
 * audit escalates registry-present+contract-absent as acceptance-unrunnable
 * in blocking mode; pure accounting still works without one).
 */
export function parseAcceptanceContract(profileYamlContent: string): ContractParseResult {
  let doc: unknown
  try {
    doc = loadYaml(profileYamlContent)
  } catch (err) {
    const message = err instanceof YAMLException ? err.message : String(err)
    return { status: 'invalid', issues: [{ path: '(root)', message: `malformed profile YAML: ${message}` }] }
  }
  if (doc === null || doc === undefined || typeof doc !== 'object') return { status: 'absent' }
  const block = (doc as Record<string, unknown>)['acceptance']
  if (block === undefined || block === null) return { status: 'absent' }
  const result = AcceptanceContractSchema.safeParse(block)
  if (!result.success) {
    return {
      status: 'invalid',
      issues: result.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? `acceptance.${issue.path.map(String).join('.')}` : 'acceptance',
        message: issue.message,
      })),
    }
  }
  return { status: 'ok', contract: result.data }
}

// ---------------------------------------------------------------------------
// Render argv builder — split FIRST, substitute SECOND (injection-safe)
// ---------------------------------------------------------------------------

export interface RenderPlaceholderValues {
  /** Absolute fixtures dir (resolved by the caller). */
  fixtures?: string
  /** Absolute artifacts output dir (external, substrate-managed). */
  artifacts: string
  /** Port for web surfaces. */
  port?: number
}

export type RenderArgvResult = { ok: true; argv: string[] } | { ok: false; error: string }

const PLACEHOLDER_RE = /\{([a-z]+)\}/g

/**
 * Build the argv for a render command template.
 *
 * The template is whitespace-split into tokens BEFORE `{placeholder}`
 * substitution, and the result is executed with `spawn(argv[0], argv.slice(1))`
 * — no shell, ever. Substituted values cannot change the token count or
 * introduce shell metacharacter evaluation by construction.
 *
 * Unknown placeholders and placeholders without a value are HARD errors —
 * a typo'd `{fixtrues}` reaching the product as a literal string is a silent
 * misconfiguration this gate exists to make loud.
 */
export function buildRenderArgv(template: string, values: RenderPlaceholderValues): RenderArgvResult {
  const tokens = template.trim().split(/\s+/)
  if (tokens.length === 0 || tokens[0] === '') {
    return { ok: false, error: 'render command is empty' }
  }
  const valueMap = new Map<string, string>()
  if (values.fixtures !== undefined) valueMap.set('fixtures', values.fixtures)
  valueMap.set('artifacts', values.artifacts)
  if (values.port !== undefined) valueMap.set('port', String(values.port))

  const argv: string[] = []
  for (const token of tokens) {
    let error: string | undefined
    const substituted = token.replace(PLACEHOLDER_RE, (_match, name: string) => {
      const value = valueMap.get(name)
      if (value === undefined) {
        error = `unknown or unavailable placeholder {${name}} in render command (known: ${[...valueMap.keys()].map((k) => `{${k}}`).join(', ')})`
        return ''
      }
      return value
    })
    if (error !== undefined) return { ok: false, error }
    argv.push(substituted)
  }
  return { ok: true, argv }
}
