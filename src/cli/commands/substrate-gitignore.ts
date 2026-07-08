/**
 * Compute the `.gitignore` content substrate should write so that everything
 * under `.substrate/` is ignored EXCEPT the operator-shared `config.yaml`,
 * consistent with the AGENTS.md/CLAUDE.md/GEMINI.md guidance.
 *
 * The previous init writer enumerated individual runtime files, which both
 * (a) diverged from the documented negation pattern and (b) left a pre-existing
 * wholesale `.substrate/` dir-ignore in place. A dir-ignore (`.substrate/` or
 * `.substrate`) makes git skip the directory entirely, so `!.substrate/config.yaml`
 * can NEVER re-include the file — the fix MUST convert it to `.substrate/*`
 * (ignore the contents, not the directory) before the negation can work.
 *
 * Pure + exported for unit testing; init.ts is the only caller.
 */

/** Wholesale `.substrate` dir-ignore forms that block `!config.yaml` re-inclusion. */
const WHOLESALE_SUBSTRATE_IGNORES = new Set([
  '.substrate',
  '.substrate/',
  '/.substrate',
  '/.substrate/',
])

const STAR = '.substrate/*'
const CONFIG_NEGATION = '!.substrate/config.yaml'
// H1.1 (hardening program): the project profile is the single source of truth
// for language/build/test commands, and per-story worktrees only carry
// git-TRACKED files — a gitignored profile silently vanishes from every
// worktree, so all profile consumers (build gates, verify_command, install
// hints) fall back to Node-leaning defaults exactly where dispatch and
// verification actually run (income-sources findings #6/#11/#12/#18).
const PROFILE_NEGATION = '!.substrate/project-profile.yaml'
// A0.1 (acceptance-gate program): the journey registry is authored at planning
// time and read from the TRUSTED COMMITTED tree (`git show`) — a gitignored
// registry can never be committed, so the trusted-tree loader would report
// `absent` forever and the acceptance gate would silently never fire (the
// same silent-vanish class H1.1 fixed for the project profile). `.substrate/*`
// only matches direct children, so re-including the directory suffices to make
// files beneath it trackable.
const ACCEPTANCE_NEGATION = '!.substrate/acceptance/'
// A6 (acceptance-gate): the auto-demotion overlay and precision/recall tallies
// are OPERATOR-LOCAL runtime state (like .substrate/runs/), NOT planning
// artifacts — they must stay untracked even though the acceptance/ dir is
// re-included above for journeys.yaml/deferrals.yaml. Re-ignore the two files
// AFTER the dir negation (git last-match-wins).
const ACCEPTANCE_LOCAL_IGNORES = ['.substrate/acceptance/gate-state.json', '.substrate/acceptance/metrics.json']
const CODEX_PROMPTS = '.codex/prompts/'
const CODEX_SKILLS = '.codex/skills/'

export interface GitignoreUpdate {
  /** The full new `.gitignore` content. */
  content: string
  /** True when `content` differs from the input (caller should write it). */
  changed: boolean
}

/**
 * Returns the updated `.gitignore` content. Idempotent: running it on its own
 * output returns `changed: false`.
 */
export function computeSubstrateGitignore(existing: string): GitignoreUpdate {
  // 1. Convert any wholesale `.substrate` / `.substrate/` dir-ignore to the
  //    contents-ignore form so the config.yaml negation can take effect.
  const lines = existing.split('\n').map((line) =>
    WHOLESALE_SUBSTRATE_IGNORES.has(line.trim()) ? STAR : line,
  )

  const trimmed = lines.map((l) => l.trim())
  const append: string[] = []

  if (!trimmed.includes(STAR)) append.push(STAR)

  // The negation must be the LAST line matching config.yaml (git is
  // last-match-wins). Append it when missing, or when a `.substrate/*` currently
  // sits after the existing negation (which would re-ignore config.yaml).
  const starIdx = trimmed.lastIndexOf(STAR)
  const negIdx = trimmed.lastIndexOf(CONFIG_NEGATION)
  const negationEffective = negIdx !== -1 && negIdx > starIdx
  if (!negationEffective) append.push(CONFIG_NEGATION)

  // Same last-match-wins rule for the project profile negation (H1.1).
  const profileNegIdx = trimmed.lastIndexOf(PROFILE_NEGATION)
  const profileNegationEffective = profileNegIdx !== -1 && profileNegIdx > starIdx
  if (!profileNegationEffective) append.push(PROFILE_NEGATION)

  // Same rule for the acceptance dir negation (A0.1 — journey registry).
  const acceptanceNegIdx = trimmed.lastIndexOf(ACCEPTANCE_NEGATION)
  const acceptanceNegationEffective = acceptanceNegIdx !== -1 && acceptanceNegIdx > starIdx
  if (!acceptanceNegationEffective) append.push(ACCEPTANCE_NEGATION)

  if (!trimmed.includes(CODEX_PROMPTS)) append.push(CODEX_PROMPTS)
  if (!trimmed.includes(CODEX_SKILLS)) append.push(CODEX_SKILLS)

  // A6: re-ignore the operator-local acceptance runtime files. Appended at the
  // end (after the acceptance dir negation) so last-match-wins keeps them
  // untracked while journeys.yaml/deferrals.yaml stay tracked.
  for (const localIgnore of ACCEPTANCE_LOCAL_IGNORES) {
    const li = trimmed.lastIndexOf(localIgnore)
    if (li === -1 || li < acceptanceNegIdx) append.push(localIgnore)
  }

  let content = lines.join('\n')
  if (append.length > 0) {
    const needsNewline = content.length > 0 && !content.endsWith('\n')
    content +=
      (needsNewline ? '\n' : '') +
      '\n# Substrate state — track only the operator config\n' +
      append.join('\n') +
      '\n'
  }

  return { content, changed: content !== existing }
}
