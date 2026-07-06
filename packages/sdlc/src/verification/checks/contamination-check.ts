/**
 * ContaminationCheck — Tier A verification check that fails stories whose diff
 * introduces a foreign toolchain or build droppings (H1.5, hardening program).
 *
 * Field findings #12/#16/#18 (income-sources, 2026-07-04): on a Python/uv
 * project, stories repeatedly emitted TypeScript sources, scaffolded a full JS
 * toolchain (package.json, tsc/vite → dist/, npm install → node_modules), and
 * one merge landed 1,885 tracked node_modules/dist files on main. The stray
 * package.json then flipped build detection to `npm run build`, producing a
 * false build failure that masked a genuinely-successful story. Substrate had
 * no signal for "this story writes in a language the project doesn't use."
 *
 * What fails the check:
 *   (a) NEW source files whose language is not among the project profile's
 *       declared languages (single-project `language:` + monorepo package
 *       languages — legit polyglot repos therefore pass naturally);
 *   (b) foreign TOOLCHAIN MANIFESTS (package.json / tsconfig / vite.config /
 *       package-lock / pnpm-lock / yarn.lock) on a project whose profile does
 *       not include typescript/javascript — the exact finding-#12 flip trigger;
 *   (c) build/dependency droppings in the diff: `node_modules/`, `.venv/`,
 *       `__pycache__/` always; `dist/` when the profile is non-JS.
 *
 * No profile → the check warn-skips (it cannot know the project's languages).
 * FR-V9: no LLM; pure file-list + profile inspection.
 */

import type {
  VerificationCheck,
  VerificationContext,
  VerificationResult,
  VerificationFinding,
} from '../types.js'
import { renderFindings } from '../findings.js'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Map of language → source extensions used for foreign-language detection. */
const LANGUAGE_EXTENSIONS: Record<string, string[]> = {
  typescript: ['.ts', '.tsx', '.mts', '.cts'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs'],
  python: ['.py'],
  go: ['.go'],
  rust: ['.rs'],
  java: ['.java'],
  kotlin: ['.kt', '.kts'],
}

/** JS-family toolchain manifests whose appearance flips build detection. */
const JS_TOOLCHAIN_MANIFESTS = [
  'package.json',
  'tsconfig.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'vite.config.ts',
  'vite.config.js',
]

/** Droppings that must never appear in a story diff, regardless of language. */
const ALWAYS_DENY_SEGMENTS = ['node_modules', '.venv', '__pycache__']

/**
 * Collect every `language: <x>` declaration in the profile (single-project
 * `project.language` plus monorepo `packages[].language`). Line-based parse —
 * no yaml dependency. Returns [] when the profile is absent/unreadable.
 */
export function readProfileLanguages(workingDir: string): string[] {
  const profilePath = join(workingDir, '.substrate', 'project-profile.yaml')
  if (!existsSync(profilePath)) return []
  try {
    const content = readFileSync(profilePath, 'utf-8')
    const langs = new Set<string>()
    for (const m of content.matchAll(/^\s*(?:-\s+)?language:\s*['"]?([a-z]+)['"]?\s*$/gm)) {
      if (m[1] !== undefined) langs.add(m[1])
    }
    return [...langs]
  } catch {
    return []
  }
}

/** Language of a file per LANGUAGE_EXTENSIONS, or undefined for neutral files. */
function fileLanguage(file: string): string | undefined {
  const lower = file.toLowerCase()
  for (const [lang, exts] of Object.entries(LANGUAGE_EXTENSIONS)) {
    if (exts.some((e) => lower.endsWith(e))) return lang
  }
  return undefined
}

export interface ContaminationVerdict {
  foreignSourceFiles: Array<{ file: string; language: string }>
  foreignToolchainManifests: string[]
  droppings: string[]
}

/**
 * Pure classification of a changed-file list against the project's declared
 * languages. Exported for unit testing.
 */
export function classifyContamination(
  changedFiles: readonly string[],
  allowedLanguages: readonly string[],
): ContaminationVerdict {
  const allowJs =
    allowedLanguages.includes('typescript') || allowedLanguages.includes('javascript')
  const foreignSourceFiles: Array<{ file: string; language: string }> = []
  const foreignToolchainManifests: string[] = []
  const droppings: string[] = []

  for (const raw of changedFiles) {
    const file = raw.replace(/\\/g, '/').replace(/^\.\//, '')
    const segments = file.split('/')

    if (segments.some((s) => ALWAYS_DENY_SEGMENTS.includes(s))) {
      droppings.push(file)
      continue
    }
    if (!allowJs && segments.includes('dist')) {
      droppings.push(file)
      continue
    }
    const base = segments[segments.length - 1] ?? ''
    if (!allowJs && JS_TOOLCHAIN_MANIFESTS.includes(base)) {
      foreignToolchainManifests.push(file)
      continue
    }
    const lang = fileLanguage(file)
    if (lang !== undefined && !allowedLanguages.includes(lang)) {
      // typescript/javascript are one family for containment purposes: a
      // TS project's .js config files are not contamination.
      if (allowJs && (lang === 'typescript' || lang === 'javascript')) continue
      foreignSourceFiles.push({ file, language: lang })
    }
  }

  return { foreignSourceFiles, foreignToolchainManifests, droppings }
}

export class ContaminationCheck implements VerificationCheck {
  readonly name = 'scope-contamination'
  readonly tier = 'A' as const

  async run(context: VerificationContext): Promise<VerificationResult> {
    const start = Date.now()

    const changedFiles = context.changedFiles ?? []
    if (changedFiles.length === 0) {
      return {
        status: 'pass',
        details: 'no changed files to inspect',
        duration_ms: Date.now() - start,
        findings: [],
      }
    }

    const allowedLanguages = readProfileLanguages(context.workingDir)
    if (allowedLanguages.length === 0) {
      const findings: VerificationFinding[] = [
        {
          category: 'contamination-skip',
          severity: 'warn',
          message:
            `no project profile with declared languages at ${context.workingDir} — ` +
            `cannot check for foreign-toolchain contamination (run substrate init to generate one)`,
        },
      ]
      return {
        status: 'warn',
        details: renderFindings(findings),
        duration_ms: Date.now() - start,
        findings,
      }
    }

    const verdict = classifyContamination(changedFiles, allowedLanguages)
    const findings: VerificationFinding[] = []

    if (verdict.droppings.length > 0) {
      findings.push({
        category: 'contamination-droppings',
        severity: 'error',
        message:
          `story diff contains build/dependency droppings that must never be committed: ` +
          `${verdict.droppings.slice(0, 10).join(', ')}` +
          (verdict.droppings.length > 10 ? ` (+${String(verdict.droppings.length - 10)} more)` : ''),
      })
    }
    if (verdict.foreignToolchainManifests.length > 0) {
      findings.push({
        category: 'contamination-toolchain',
        severity: 'error',
        message:
          `story introduces a JS toolchain on a ${allowedLanguages.join('/')} project: ` +
          `${verdict.foreignToolchainManifests.join(', ')}. This is the exact trigger that ` +
          `flips build detection to npm and masks real story outcomes (field finding #12).`,
      })
    }
    if (verdict.foreignSourceFiles.length > 0) {
      findings.push({
        category: 'contamination-language',
        severity: 'error',
        message:
          `story writes source files in language(s) the project does not use ` +
          `(declared: ${allowedLanguages.join(', ')}): ` +
          verdict.foreignSourceFiles
            .slice(0, 10)
            .map((f) => `${f.file} [${f.language}]`)
            .join(', '),
      })
    }

    if (findings.length === 0) {
      return {
        status: 'pass',
        details: `no contamination across ${String(changedFiles.length)} changed file(s)`,
        duration_ms: Date.now() - start,
        findings: [],
      }
    }
    return {
      status: 'fail',
      details: renderFindings(findings),
      duration_ms: Date.now() - start,
      findings,
    }
  }
}
