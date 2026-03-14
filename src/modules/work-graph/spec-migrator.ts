/**
 * spec-migrator — utilities for migrating story spec files away from the
 * deprecated `Status:` frontmatter field.
 *
 * Story 31-8: Deprecate Status Field in Story Spec Frontmatter
 *
 * Story status is now exclusively managed in the Dolt work graph
 * (`wg_stories.status`). These pure functions strip the deprecated field from
 * spec content before it is injected into agent prompts.
 */

/**
 * Remove the deprecated `Status:` line from story spec content.
 * Also removes the blank line immediately following the Status line.
 * Returns the original content unchanged if no Status line is present.
 *
 * The regex is anchored at the start of a line (`^` with multiline flag) so
 * it does NOT strip lines like `## Status Notes` or `The status is good`.
 */
export function stripDeprecatedStatusField(content: string): string {
  // Match `Status: <anything>` anchored at line start, followed by its newline
  // and an optional blank line.
  return content.replace(/^Status:[^\n]*\n?(\n)?/m, '')
}

/**
 * Detect whether a story spec contains the deprecated Status field.
 * Returns the status value string (e.g. `'ready-for-dev'`) if found, or
 * `null` if absent.
 *
 * The regex is anchored at line start so incidental uses of the word "Status"
 * (e.g. in section headings) are not matched.
 */
export function detectDeprecatedStatusField(content: string): string | null {
  const match = /^Status:\s*(.+)$/m.exec(content)
  return match !== null ? match[1].trim() : null
}
