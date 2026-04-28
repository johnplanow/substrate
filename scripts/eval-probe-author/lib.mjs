/**
 * Pure functions powering eval-probe-author (Story 60-14d).
 *
 * Separated into a library module so unit tests can exercise the logic
 * without LLM dispatch or file I/O.
 *
 * Three exports:
 *   - parseMachineCorpus(markdown): extracts the machine corpus YAML
 *     block from a defect-replay corpus markdown file
 *   - evaluateSignature(probes, signatureRegexes): returns whether any
 *     single probe matches all regex constraints (the "caught" predicate)
 *   - computeCatchRate(perDefect): aggregates entry-level caught flags
 *     into the overall catch-rate metric
 */

import yaml from 'js-yaml'

// ---------------------------------------------------------------------------
// parseMachineCorpus
// ---------------------------------------------------------------------------

/**
 * Extract the YAML block under the "## Machine corpus" heading from a
 * defect-replay corpus markdown document. Throws when the section or
 * fenced YAML is missing — corpus integrity is required for the eval
 * to produce a meaningful catch rate.
 */
export function parseMachineCorpus(markdownContent) {
  const sectionMatch = markdownContent.match(
    /## Machine corpus[^\n]*\n[\s\S]*?```yaml\n([\s\S]*?)\n```/,
  )
  if (sectionMatch === null) {
    throw new Error(
      'parseMachineCorpus: corpus markdown lacks a "## Machine corpus" section with a yaml-fenced block',
    )
  }
  const yamlBody = sectionMatch[1]
  let parsed
  try {
    parsed = yaml.load(yamlBody)
  } catch (err) {
    throw new Error(
      `parseMachineCorpus: yaml block parse error: ${err.message ?? err}`,
    )
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      'parseMachineCorpus: corpus root must be a mapping with applicable_entries and excluded_entries',
    )
  }

  const applicable = Array.isArray(parsed.applicable_entries)
    ? parsed.applicable_entries
    : []
  const excluded = Array.isArray(parsed.excluded_entries)
    ? parsed.excluded_entries
    : []

  for (const entry of applicable) {
    if (typeof entry.id !== 'string' || entry.id === '') {
      throw new Error('parseMachineCorpus: every applicable entry needs a non-empty id')
    }
    if (!Array.isArray(entry.signature) || entry.signature.length === 0) {
      throw new Error(
        `parseMachineCorpus: entry ${entry.id} needs a non-empty signature list`,
      )
    }
    for (const sig of entry.signature) {
      if (typeof sig !== 'string') {
        throw new Error(
          `parseMachineCorpus: entry ${entry.id} signature entries must be regex strings`,
        )
      }
    }
  }

  return { applicable_entries: applicable, excluded_entries: excluded }
}

// ---------------------------------------------------------------------------
// evaluateSignature
// ---------------------------------------------------------------------------

/**
 * Determine whether at least one probe in `probes` matches ALL regex
 * constraints in `signatureRegexes`. Returns the matching probe's name
 * for diagnostic output.
 *
 * Matching is performed against `JSON.stringify(probe)` of each probe —
 * the regex applies to any field of the probe (name, command,
 * expect_stdout_*, etc.). This is intentionally loose — the corpus
 * regexes are designed by humans to identify the load-bearing shape
 * of a "good" probe, and over-precise field-targeting would couple
 * the eval to internal probe-schema details that may evolve.
 */
export function evaluateSignature(probes, signatureRegexes) {
  if (!Array.isArray(probes) || probes.length === 0) {
    return { matched: false, matchingProbeName: null }
  }
  const compiled = signatureRegexes.map((s) => new RegExp(s))
  for (const probe of probes) {
    const serialized = JSON.stringify(probe)
    if (compiled.every((r) => r.test(serialized))) {
      return { matched: true, matchingProbeName: probe.name ?? '<unnamed>' }
    }
  }
  return { matched: false, matchingProbeName: null }
}

// ---------------------------------------------------------------------------
// computeCatchRate
// ---------------------------------------------------------------------------

/**
 * Aggregate entry-level caught flags into the overall catch rate.
 * Returns { catchRate, caught, total } where catchRate is in [0, 1].
 * Empty perDefect array returns rate 0 (sentinel — eval has no signal).
 */
export function computeCatchRate(perDefect) {
  const total = perDefect.length
  if (total === 0) return { catchRate: 0, caught: 0, total: 0 }
  const caught = perDefect.filter((d) => d.caught === true).length
  return { catchRate: caught / total, caught, total }
}
