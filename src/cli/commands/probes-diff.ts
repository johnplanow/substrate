/**
 * substrate probes diff — diff `## Runtime Probes` sections across two
 * story-artifact files (Story 60-14b).
 *
 * Powers the A/B validation harness: dispatch the same story under two
 * arms (probe-author enabled vs disabled) and compare the resulting probe
 * sets to see which arm authored richer/different probes.
 *
 * The CLI takes two artifact PATHS rather than two run IDs because
 * substrate doesn't currently snapshot artifacts per-run (artifacts are
 * per-project, mutated in place across dispatches). For A/B comparison,
 * the operator copies/snapshots each artifact OUT of the project before
 * dispatching the next arm. The eval script (`scripts/eval-probe-author.mjs`)
 * automates this per-corpus-entry.
 */

import { readFileSync, existsSync } from 'node:fs'
import { basename } from 'node:path'

import type { Command } from 'commander'

import { parseRuntimeProbes, type RuntimeProbe } from '@substrate-ai/sdlc'

// ---------------------------------------------------------------------------
// Public diff API
// ---------------------------------------------------------------------------

export interface ProbesDiff {
  onlyInA: RuntimeProbe[]
  onlyInB: RuntimeProbe[]
  inBoth: { name: string; a: RuntimeProbe; b: RuntimeProbe }[]
}

/**
 * Diff two probe sets by `name` (the canonical identity of a probe per
 * `RuntimeProbeListSchema`). Differences in command/timeout/assertion
 * shape between same-named probes appear in `inBoth` for downstream
 * shape-comparison; this function does NOT diff probe internals.
 */
export function computeProbesDiff(probesA: RuntimeProbe[], probesB: RuntimeProbe[]): ProbesDiff {
  const byNameA = new Map(probesA.map((p) => [p.name, p]))
  const byNameB = new Map(probesB.map((p) => [p.name, p]))

  const onlyInA: RuntimeProbe[] = []
  const onlyInB: RuntimeProbe[] = []
  const inBoth: { name: string; a: RuntimeProbe; b: RuntimeProbe }[] = []

  for (const [name, a] of byNameA) {
    const b = byNameB.get(name)
    if (b === undefined) {
      onlyInA.push(a)
    } else {
      inBoth.push({ name, a, b })
    }
  }
  for (const [name, b] of byNameB) {
    if (!byNameA.has(name)) onlyInB.push(b)
  }

  return { onlyInA, onlyInB, inBoth }
}

/**
 * Read an artifact file and extract its `## Runtime Probes` probe set.
 * Returns an empty array (not error) when the file has no probes section —
 * an artifact without probes is a valid input to the diff (e.g., the
 * disabled-arm output when probe-author was off).
 *
 * Throws when the file is unreadable OR when the probes block is present
 * but malformed (parse errors). Callers who want to tolerate parse errors
 * should catch.
 */
export function extractProbesFromArtifact(artifactPath: string): RuntimeProbe[] {
  if (!existsSync(artifactPath)) {
    throw new Error(`probes-diff: artifact file not found: ${artifactPath}`)
  }
  const content = readFileSync(artifactPath, 'utf-8')
  const result = parseRuntimeProbes(content)
  // Treat "no section" as "empty probe set" rather than error — the
  // disabled arm of an A/B run legitimately has no probes.
  if (result.kind === 'absent') {
    return []
  }
  if (result.kind === 'invalid') {
    throw new Error(
      `probes-diff: artifact has malformed ## Runtime Probes section: ${artifactPath}\n${result.error}`,
    )
  }
  return result.probes
}

// ---------------------------------------------------------------------------
// CLI registration
// ---------------------------------------------------------------------------

interface ProbesDiffOptions {
  outputFormat: string
  storyKey?: string
}

export function registerProbesCommand(program: Command): void {
  const probes = program
    .command('probes')
    .description('Inspect runtime-probe sections across story artifacts (Story 60-14)')

  probes
    .command('diff <artifactA> <artifactB>')
    .description('Diff `## Runtime Probes` sections across two story-artifact files')
    .option('--output-format <format>', 'Output format: human (default) or json', 'human')
    .option('--story-key <key>', 'Optional story key for output context (informational)')
    .action(async (artifactA: string, artifactB: string, options: ProbesDiffOptions) => {
      const format = options.outputFormat === 'json' ? 'json' : 'human'

      let probesA: RuntimeProbe[]
      let probesB: RuntimeProbe[]
      try {
        probesA = extractProbesFromArtifact(artifactA)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        emitError(format, `failed to read artifact A: ${msg}`)
        process.exitCode = 1
        return
      }
      try {
        probesB = extractProbesFromArtifact(artifactB)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        emitError(format, `failed to read artifact B: ${msg}`)
        process.exitCode = 1
        return
      }

      const diff = computeProbesDiff(probesA, probesB)
      emitDiff(diff, {
        artifactA,
        artifactB,
        storyKey: options.storyKey,
        format,
        countsA: probesA.length,
        countsB: probesB.length,
      })
    })
}

// ---------------------------------------------------------------------------
// Output formatters
// ---------------------------------------------------------------------------

function emitError(format: 'human' | 'json', message: string): void {
  if (format === 'json') {
    process.stdout.write(JSON.stringify({ success: false, error: message }) + '\n')
  } else {
    process.stderr.write(`probes diff error: ${message}\n`)
  }
}

function emitDiff(
  diff: ProbesDiff,
  ctx: {
    artifactA: string
    artifactB: string
    storyKey?: string
    format: 'human' | 'json'
    countsA: number
    countsB: number
  },
): void {
  if (ctx.format === 'json') {
    process.stdout.write(
      JSON.stringify(
        {
          success: true,
          storyKey: ctx.storyKey,
          artifactA: ctx.artifactA,
          artifactB: ctx.artifactB,
          counts: { a: ctx.countsA, b: ctx.countsB, inBoth: diff.inBoth.length },
          onlyInA: diff.onlyInA.map((p) => ({ name: p.name, sandbox: p.sandbox, command: p.command })),
          onlyInB: diff.onlyInB.map((p) => ({ name: p.name, sandbox: p.sandbox, command: p.command })),
          inBoth: diff.inBoth.map((m) => ({ name: m.name })),
        },
        null,
        2,
      ) + '\n',
    )
    return
  }

  // Human format
  const aLabel = basename(ctx.artifactA)
  const bLabel = basename(ctx.artifactB)
  process.stdout.write(`\nprobes diff${ctx.storyKey ? ` (story ${ctx.storyKey})` : ''}\n`)
  process.stdout.write(`  A: ${ctx.artifactA} — ${ctx.countsA} probe(s)\n`)
  process.stdout.write(`  B: ${ctx.artifactB} — ${ctx.countsB} probe(s)\n\n`)

  process.stdout.write(`Probes only in A (${aLabel}): ${diff.onlyInA.length}\n`)
  for (const p of diff.onlyInA) {
    process.stdout.write(`  - ${p.name} [${p.sandbox}]\n`)
  }
  process.stdout.write(`\nProbes only in B (${bLabel}): ${diff.onlyInB.length}\n`)
  for (const p of diff.onlyInB) {
    process.stdout.write(`  - ${p.name} [${p.sandbox}]\n`)
  }
  process.stdout.write(`\nProbes in both: ${diff.inBoth.length}\n`)
  for (const m of diff.inBoth) {
    process.stdout.write(`  - ${m.name}\n`)
  }
  process.stdout.write('\n')
}
