// packages/factory/src/llm/model-registry.ts
// Pure logic — zero runtime imports.

const DEFAULT_PATTERNS: Array<{ pattern: RegExp; provider: string }> = [
  { pattern: /^claude-/i, provider: 'anthropic' },
  { pattern: /^gpt-/i, provider: 'openai' },
  { pattern: /^o\d(-|$)/i, provider: 'openai' }, // o1, o3, o4-mini, etc.
  { pattern: /^gemini-/i, provider: 'gemini' },
]

export class ModelRegistry {
  private patterns: Array<{ pattern: RegExp; provider: string }> = [...DEFAULT_PATTERNS]

  /**
   * Register a glob-style pattern (supports `*` wildcard) mapped to a provider name.
   * Custom patterns are prepended so they override defaults.
   */
  register(globPattern: string, provider: string): void {
    // Escape regex special chars, then replace glob * with .*
    const escaped = globPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    this.patterns.unshift({ pattern: new RegExp(`^${escaped}$`, 'i'), provider })
  }

  /**
   * Resolve a model string to a provider name.
   * Returns `null` if no pattern matches.
   */
  resolve(model: string): string | null {
    for (const { pattern, provider } of this.patterns) {
      if (pattern.test(model)) return provider
    }
    return null
  }
}
