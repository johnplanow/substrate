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

  if (!trimmed.includes(CODEX_PROMPTS)) append.push(CODEX_PROMPTS)
  if (!trimmed.includes(CODEX_SKILLS)) append.push(CODEX_SKILLS)

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
