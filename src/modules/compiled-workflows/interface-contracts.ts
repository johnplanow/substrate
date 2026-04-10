/**
 * Interface Contracts parser — Story 25-4.
 *
 * Parses the optional `## Interface Contracts` section from a story file,
 * extracting typed contract declarations for the pipeline's cross-story
 * dependency graph (used by Story 25-5 dispatch ordering and 25-6 verification).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single contract declaration extracted from a story's Interface Contracts section.
 * Matches AC4: includes name, direction, file path, story key, and optional transport.
 */
export interface ContractDeclaration {
  /** TypeScript interface or Zod schema name (e.g., "JudgeResult") */
  contractName: string
  /** Whether this story creates (export) or consumes (import) the contract */
  direction: 'export' | 'import'
  /** Source file path relative to project root (e.g., "src/modules/judge/types.ts") */
  filePath: string
  /** Story key that owns this declaration (e.g., "25-4") */
  storyKey: string
  /** Optional transport annotation (e.g., "queue: judge-results", "from story 25-5") */
  transport?: string
}

// ---------------------------------------------------------------------------
// parseInterfaceContracts
// ---------------------------------------------------------------------------

/**
 * Parse the `## Interface Contracts` section from a story file.
 *
 * Looks for lines matching the format:
 *   - **Export**: SchemaName @ src/path/to/file.ts (optional transport)
 *   - **Import**: SchemaName @ src/path/to/file.ts (optional transport)
 *
 * The section is optional — returns empty array when not found or malformed.
 * Parsing stops at the next `##` heading to avoid false positives in other sections.
 *
 * @param storyContent - Full text content of the story markdown file
 * @param storyKey - Story key to associate with each declaration (e.g., "25-4")
 * @returns Array of typed contract declarations (may be empty)
 */
export function parseInterfaceContracts(
  storyContent: string,
  storyKey: string
): ContractDeclaration[] {
  if (!storyContent || !storyKey) return []

  // Find the ## Interface Contracts heading
  const sectionMatch = /^##\s+Interface\s+Contracts\s*$/im.exec(storyContent)
  if (!sectionMatch) return []

  const sectionStart = sectionMatch.index + sectionMatch[0].length

  // Find the next ## heading to delimit the section boundary
  const afterSection = storyContent.slice(sectionStart)
  const nextHeading = /^##\s+/m.exec(afterSection)
  const sectionContent = nextHeading ? afterSection.slice(0, nextHeading.index) : afterSection

  // Parse bullet items:
  //   - **Export**: SchemaName @ src/path/to/file.ts (queue: some-queue)
  //   - **Import**: SchemaName @ src/path/to/file.ts (from story 25-X)
  const linePattern = /^\s*-\s+\*\*(Export|Import)\*\*:\s+(\S+)\s+@\s+(\S+)(?:\s+\(([^)]+)\))?/gim

  const declarations: ContractDeclaration[] = []
  let match: RegExpExecArray | null

  while ((match = linePattern.exec(sectionContent)) !== null) {
    const [, directionRaw, contractName, filePath, transport] = match
    declarations.push({
      contractName,
      direction: directionRaw.toLowerCase() as 'export' | 'import',
      filePath,
      storyKey,
      ...(transport !== undefined ? { transport } : {}),
    })
  }

  return declarations
}
