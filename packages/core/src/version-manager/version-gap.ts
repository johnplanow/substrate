/**
 * Version-gap classification for the pre-dispatch advisory (obs_2026-05-02_019).
 *
 * Background: when a consumer's locally-installed substrate binary lags the
 * published version by more than a single patch, dispatching produces work
 * that may rely on prompt content / behavior the running binary does not yet
 * implement — leading to false-alarm reopens (canonical incident: a strata
 * reopen claimed "dispatched under v0.20.42" when the binary was v0.20.41).
 *
 * The existing background notification (`Update available: X → Y` to stderr
 * on every CLI invocation) is easy to miss — buried under NDJSON event
 * streams, scrolled out of the terminal before dispatch starts. The
 * pre-dispatch advisory uses this classifier to decide when to escalate
 * the warning into a prominent block at `substrate run` startup.
 *
 * Threshold: > 1 patch hop. Same major + same minor + (latest.patch -
 * current.patch) <= 1 is `'none'` or `'patch-1'`. Anything larger is
 * `'significant'` and warrants the prominent advisory.
 */

import * as semver from 'semver'

export type VersionGap = 'none' | 'patch-1' | 'significant'

/**
 * Classify the gap between the running version and the latest published version.
 *
 * @returns
 *   - `'none'` — versions equal, or current is ahead of latest (e.g., dev build)
 *   - `'patch-1'` — single patch hop (e.g., 0.20.71 → 0.20.72) — non-prominent
 *   - `'significant'` — > 1 patch hop, or any minor/major gap — prominent advisory
 */
export function classifyVersionGap(current: string, latest: string): VersionGap {
  const c = semver.coerce(current)
  const l = semver.coerce(latest)
  if (c === null || l === null) return 'none'

  // semver.lte covers "equal" and "current ahead of latest"
  if (semver.lte(l, c)) return 'none'

  // Different major or minor → always significant
  if (l.major !== c.major || l.minor !== c.minor) return 'significant'

  // Same major.minor — measure patch gap
  const patchDelta = l.patch - c.patch
  if (patchDelta <= 1) return 'patch-1'
  return 'significant'
}
