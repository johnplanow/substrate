/**
 * Per-adapter CLI version compatibility check.
 *
 * Each adapter declares a `TestedVersionRange` — the lowest and highest CLI
 * binary versions substrate's `buildCommand` has been empirically verified
 * against. At healthCheck time, the adapter compares the live binary's
 * reported version to that range and emits a human-readable warning when the
 * live version sits outside it.
 *
 * The lesson this addresses (v0.20.131→137 Codex arc): a string-presence
 * unit test on the args array proves only that substrate constructs the args
 * it intends to. It does NOT prove that the live CLI binary still accepts or
 * honors those args. CLI flag forms drift between versions: deprecations,
 * renames, silent-acceptance-then-ignore, and harness overrides that beat
 * `-c` config flags. When substrate's tested version range and the live
 * version diverge, operators should see a noisy first-dispatch warning
 * pointing at the right place — not a seven-ship arc of fix-shaped
 * iteration on substrate when the bug actually lives in Codex (or wherever).
 *
 * Pure + exported for unit testing; each adapter's healthCheck is the caller.
 */

import { compare, coerce, valid } from 'semver'

/**
 * The range of CLI binary versions substrate's adapter has been verified
 * against. Bumped whenever an adapter author confirms the buildCommand args
 * still parse and behave correctly on a newer CLI release.
 */
export interface TestedVersionRange {
  /** Lowest CLI version substrate has verified against. Inclusive. */
  min: string
  /** Highest CLI version substrate has verified against. Inclusive. */
  max: string
  /**
   * Optional informational note about known caveats *within* the tested range
   * (e.g. "Claude Code 2.x silently ignores --max-turns; substrate's
   * options.maxTurns has no effect"). Surfaced even when compatible.
   */
  note?: string
}

export interface CompatibilityCheck {
  /** True iff `actual` parses as semver AND sits within [min, max] inclusive. */
  compatible: boolean
  /**
   * Actionable warning when `compatible` is false — names the adapter, the
   * version drift, and what the operator should consider (upgrade substrate,
   * report dispatch failures, etc.). Set only when not compatible.
   */
  warning?: string
}

function normalize(version: string): string | null {
  // valid() rejects strings like "0.135.0" if they have a leading "v" or a
  // suffix like "0.135.0-beta.1" we don't want to special-case. coerce()
  // extracts the first X.Y.Z it finds, which is good enough for the
  // "compare to a known range" use case.
  return valid(version) ?? valid(coerce(version) ?? '') ?? null
}

/**
 * Compare a live CLI binary's reported version against the tested range. Pure.
 *
 * Three outcomes:
 *   - actual within range  → `{ compatible: true }`
 *   - actual outside range → `{ compatible: false, warning }` with a message
 *     naming the adapter + drift + suggested operator action
 *   - actual unparseable   → `{ compatible: false, warning }` flagging that
 *     the version couldn't be compared (degrade gracefully; never throw)
 */
export function checkAdapterVersionCompat(
  adapterName: string,
  actualVersion: string,
  tested: TestedVersionRange,
): CompatibilityCheck {
  const actual = normalize(actualVersion)
  const min = normalize(tested.min)
  const max = normalize(tested.max)

  if (actual === null || min === null || max === null) {
    return {
      compatible: false,
      warning:
        `${adapterName}: CLI version '${actualVersion}' could not be parsed for ` +
        `comparison against substrate's tested range (${tested.min}–${tested.max}). ` +
        `Flag behavior may differ; report any dispatch failures.`,
    }
  }

  if (compare(actual, min) < 0) {
    return {
      compatible: false,
      warning:
        `${adapterName}: CLI version ${actualVersion} is below substrate's tested range ` +
        `(${tested.min}–${tested.max}). Older flag forms may be required; ` +
        `consider upgrading the CLI to a version within range, or upgrading substrate.` +
        (tested.note !== undefined ? ` Range note: ${tested.note}` : ''),
    }
  }

  if (compare(actual, max) > 0) {
    return {
      compatible: false,
      warning:
        `${adapterName}: CLI version ${actualVersion} is newer than substrate's tested range ` +
        `(${tested.min}–${tested.max}). Flag behavior may have changed since substrate ` +
        `was tested; consider upgrading substrate or reporting any dispatch failures.` +
        (tested.note !== undefined ? ` Range note: ${tested.note}` : ''),
    }
  }

  // Compatible. Note is informational only — return it via the `warning`
  // field so callers have one channel to forward; consumers can distinguish
  // by the `compatible: true` flag.
  return tested.note !== undefined
    ? { compatible: true, warning: `${adapterName}: ${tested.note}` }
    : { compatible: true }
}
