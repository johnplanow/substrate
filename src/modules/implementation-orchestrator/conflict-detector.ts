/**
 * Conflict detector for the Implementation Orchestrator.
 *
 * Groups story keys by module prefix to identify which stories may modify
 * the same files and must therefore be serialized within a conflict group.
 */

// ---------------------------------------------------------------------------
// ConflictDetectorConfig
// ---------------------------------------------------------------------------

/**
 * Optional configuration for the conflict detector.
 */
export interface ConflictDetectorConfig {
  /**
   * Prefix → module mappings that control conflict grouping.
   *
   * When provided, stories whose keys start with the same prefix (and map to
   * the same module name) are placed in the same conflict group and serialized.
   *
   * When omitted (or empty), every story key is treated as its own group,
   * maximizing parallelism for cross-project runs.
   *
   * Format: prefix (e.g. "12-") → module name (e.g. "my-module")
   */
  moduleMap?: Record<string, string>
}

// ---------------------------------------------------------------------------
// detectConflictGroups
// ---------------------------------------------------------------------------

/**
 * Determine the module prefix for a story key.
 *
 * Checks most-specific prefix first (e.g., "10-1" before "10-"), then falls
 * back to single-digit prefix (e.g., "9-"), and finally uses the story key
 * itself for unknown stories so each gets its own group.
 *
 * @param storyKey - e.g. "10-1", "10-2-dev-story", "5-3-something"
 * @param effectiveMap - The resolved prefix-to-module map
 * @returns module name string used for conflict grouping
 */
function resolveModulePrefix(storyKey: string, effectiveMap: Record<string, string>): string {
  // If no map provided, every story is isolated
  if (Object.keys(effectiveMap).length === 0) {
    return storyKey
  }
  // Try longest matches first (e.g., "10-1" before "10-")
  const sortedKeys = Object.keys(effectiveMap).sort((a, b) => b.length - a.length)
  for (const prefix of sortedKeys) {
    if (storyKey.startsWith(prefix)) {
      return effectiveMap[prefix] as string
    }
  }
  // Unknown story — isolated group
  return storyKey
}

/**
 * Group story keys by potential file conflicts.
 *
 * Stories that map to the same module prefix are placed in the same conflict
 * group and will be serialized. Stories with different prefixes can run in
 * parallel.
 *
 * When no `moduleMap` is configured, every story key is placed in its own
 * conflict group (maximum parallelism). This is the default for cross-project
 * runs where the story key prefixes are not known in advance.
 *
 * @param storyKeys - Array of story key strings
 * @param config - Optional configuration; supply `moduleMap` to define
 *                 prefix-to-module mappings. Without this config, each story
 *                 gets its own group (maximum parallelism).
 * @returns Array of conflict groups; each inner array is a list of story keys
 *          that must be processed sequentially
 *
 * @example
 * // Without a moduleMap, all stories run in parallel
 * detectConflictGroups(['4-1', '4-2', '4-3'])
 * // => [['4-1'], ['4-2'], ['4-3']]
 *
 * @example
 * // With a moduleMap, matching stories are serialized
 * detectConflictGroups(['10-1', '10-2', '10-4'], { moduleMap: { '10-1': 'compiled-workflows', '10-2': 'compiled-workflows', '10-4': 'implementation-orchestrator' } })
 * // => [['10-1', '10-2'], ['10-4']]
 *
 * @example
 * detectConflictGroups(['12-1', '12-2'], { moduleMap: { '12-': 'my-module' } })
 * // => [['12-1', '12-2']]
 */
export function detectConflictGroups(
  storyKeys: string[],
  config?: ConflictDetectorConfig
): string[][] {
  const effectiveMap: Record<string, string> = {
    ...(config?.moduleMap ?? {}),
  }

  const moduleToStories = new Map<string, string[]>()

  for (const key of storyKeys) {
    const module = resolveModulePrefix(key, effectiveMap)
    const existing = moduleToStories.get(module)
    if (existing !== undefined) {
      existing.push(key)
    } else {
      moduleToStories.set(module, [key])
    }
  }

  // Auto-split: when all stories land in a single conflict group with 4+ stories,
  // split by epic number to enable cross-epic parallelism. This handles the common
  // case where the methodology pack maps all prefixes to a single module (e.g., "core")
  // — without this, maxConcurrency is wasted since all stories serialize.
  if (moduleToStories.size === 1 && storyKeys.length >= 4) {
    const epicGroups = new Map<string, string[]>()
    for (const key of storyKeys) {
      const epicNum = key.split('-')[0] ?? key
      const existing = epicGroups.get(epicNum)
      if (existing !== undefined) {
        existing.push(key)
      } else {
        epicGroups.set(epicNum, [key])
      }
    }
    // Only split if there are actually multiple epics
    if (epicGroups.size > 1) {
      return Array.from(epicGroups.values())
    }
  }

  return Array.from(moduleToStories.values())
}

// ---------------------------------------------------------------------------
// ContractDeclaration
// ---------------------------------------------------------------------------

/**
 * A contract declaration extracted from a story's Interface Contracts section.
 *
 * Mirrors the ContractDeclaration type in compiled-workflows/interface-contracts.ts.
 * Defined here to avoid coupling the conflict detector to the compiled-workflows module.
 */
export interface ContractDeclaration {
  /** Story key that owns this declaration (e.g., "25-4") */
  storyKey: string
  /** TypeScript interface or Zod schema name (e.g., "JudgeResult") */
  contractName: string
  /** Whether this story creates (export) or consumes (import) the contract */
  direction: 'export' | 'import'
  /** Source file path relative to project root (e.g., "src/modules/judge/types.ts") */
  filePath: string
  /** Optional transport annotation (e.g., "queue: judge-results", "from story 25-5") */
  transport?: string
}

// ---------------------------------------------------------------------------
// ContractDependencyEdge
// ---------------------------------------------------------------------------

/**
 * A directed dependency edge between two stories based on contract declarations.
 *
 * An edge from→to means the `from` story (exporter) must be dispatched before
 * the `to` story (importer) to avoid interface mismatches.
 */
export interface ContractDependencyEdge {
  /** Story key that must be dispatched first (the exporter) */
  from: string
  /** Story key that must be dispatched after (the importer, or dual-export serialization target) */
  to: string
  /** Contract name that creates this dependency */
  contractName: string
  /** Human-readable description of why this edge exists */
  reason: string
}

// ---------------------------------------------------------------------------
// buildContractDependencyGraph
// ---------------------------------------------------------------------------

/**
 * Build a contract dependency graph from a list of contract declarations.
 *
 * Rules:
 *   1. If story A exports contract "FooSchema" and story B imports "FooSchema",
 *      add a directed edge A→B (A must dispatch before B).
 *   2. If story A and story B both export the same contract (dual export),
 *      add a one-way edge between them (alphabetically sorted, to avoid cycles)
 *      so they are serialized and cannot produce conflicting definitions in parallel.
 *
 * @param declarations - Array of contract declarations from all stories
 * @returns List of directed dependency edges
 */
export function buildContractDependencyGraph(
  declarations: ContractDeclaration[]
): ContractDependencyEdge[] {
  const edges: ContractDependencyEdge[] = []
  const exportsByName = new Map<string, string[]>() // contractName → [storyKeys that export]
  const importsByName = new Map<string, string[]>() // contractName → [storyKeys that import]

  for (const decl of declarations) {
    if (decl.direction === 'export') {
      const arr = exportsByName.get(decl.contractName) ?? []
      arr.push(decl.storyKey)
      exportsByName.set(decl.contractName, arr)
    } else {
      const arr = importsByName.get(decl.contractName) ?? []
      arr.push(decl.storyKey)
      importsByName.set(decl.contractName, arr)
    }
  }

  // Rule 1: exporter → importer edges
  for (const [contractName, importerKeys] of importsByName) {
    const exporterKeys = exportsByName.get(contractName) ?? []
    for (const from of exporterKeys) {
      for (const to of importerKeys) {
        if (from === to) continue // skip self-edges
        edges.push({
          from,
          to,
          contractName,
          reason: `${from} exports ${contractName}, ${to} imports it`,
        })
      }
    }
  }

  // Rule 2: dual-export serialization — alphabetically sorted to avoid cycles
  for (const [contractName, exporterKeys] of exportsByName) {
    if (exporterKeys.length < 2) continue
    const sorted = [...exporterKeys].sort()
    for (let i = 0; i < sorted.length - 1; i++) {
      edges.push({
        from: sorted[i] as string,
        to: sorted[i + 1] as string,
        contractName,
        reason: `dual export: ${sorted[i]} and ${sorted[i + 1]} both export ${contractName} — serialized to prevent conflicting definitions`,
      })
    }
  }

  return edges
}

// ---------------------------------------------------------------------------
// ContractAwareConflictResult
// ---------------------------------------------------------------------------

/**
 * Result from contract-aware conflict group detection.
 */
export interface ContractAwareConflictResult {
  /**
   * Ordered batches of conflict groups.
   *
   * Each batch must complete entirely before the next batch begins.
   * Within a batch, conflict groups run in parallel (up to maxConcurrency).
   * Within each conflict group, stories run sequentially.
   *
   * When no contract dependencies exist, this contains a single batch
   * with all the original conflict groups (no behavioral change).
   */
  batches: string[][][]
  /**
   * Contract dependency edges that influenced the ordering.
   * Empty when no contract declarations were provided or no edges were found.
   */
  edges: ContractDependencyEdge[]
}

// ---------------------------------------------------------------------------
// detectConflictGroupsWithContracts
// ---------------------------------------------------------------------------

/**
 * Detect conflict groups with contract-aware dispatch ordering.
 *
 * Combines file-based conflict grouping (via moduleMap) with semantic
 * contract dependency ordering (via ContractDeclaration[]).
 *
 * Ordering rules:
 *   - If story A exports a contract that story B imports, A's conflict group
 *     is placed in an earlier batch than B's conflict group.
 *   - If story A and story B both export the same contract (dual export),
 *     they are serialized into different batches.
 *   - Stories with no contract overlap keep their original grouping
 *     (no regression — all placed in the same single batch).
 *
 * Cycle detection: if contract edges form a cycle at the group level
 * (e.g., A→B and B→A), the affected groups are placed in a single
 * batch together (graceful degradation — serialization within the group
 * still applies via the file-conflict mechanism).
 *
 * @param storyKeys - Array of story key strings
 * @param config - Optional conflict detector configuration (moduleMap)
 * @param declarations - Array of contract declarations from all stories
 * @returns Ordered batches of conflict groups and the edges found
 */
export function detectConflictGroupsWithContracts(
  storyKeys: string[],
  config: ConflictDetectorConfig | undefined,
  declarations: ContractDeclaration[]
): ContractAwareConflictResult {
  // Step 1: Build file-based conflict groups (existing logic, unchanged behavior)
  const groups = detectConflictGroups(storyKeys, config)

  // Step 2: Build contract dependency graph
  const edges = buildContractDependencyGraph(declarations)

  if (edges.length === 0) {
    // No contract deps → single batch containing all groups (original behavior)
    return { batches: [groups], edges: [] }
  }

  // Step 3: Map story key → group index
  const storyToGroupIdx = new Map<string, number>()
  for (let i = 0; i < groups.length; i++) {
    for (const key of groups[i]) {
      storyToGroupIdx.set(key, i)
    }
  }

  // Step 4: Build group-level dependency edges using an adjacency list.
  // successors[i] = set of group indices that must come AFTER group i
  const successors = new Map<number, Set<number>>()
  const inDegree = new Array(groups.length).fill(0) as number[]

  for (let i = 0; i < groups.length; i++) {
    successors.set(i, new Set())
  }

  for (const edge of edges) {
    const fromGroup = storyToGroupIdx.get(edge.from)
    const toGroup = storyToGroupIdx.get(edge.to)
    // Skip edges involving unknown story keys (not in this pipeline run)
    if (fromGroup === undefined || toGroup === undefined) continue
    // Skip self-loops (both stories are in the same conflict group — already serialized)
    if (fromGroup === toGroup) continue
    // Avoid duplicate group-level edges
    if (!successors.get(fromGroup)!.has(toGroup)) {
      successors.get(fromGroup)!.add(toGroup)
      inDegree[toGroup]++
    }
  }

  // Step 5: Kahn's algorithm — topological sort producing waves (batches).
  // Wave 0 = groups with no dependencies (can run first).
  // Wave 1 = groups whose only dependencies are in wave 0. Etc.
  const waves: number[][] = []
  const processed = new Set<number>()

  while (processed.size < groups.length) {
    const wave: number[] = []
    for (let i = 0; i < groups.length; i++) {
      if (!processed.has(i) && inDegree[i] === 0) {
        wave.push(i)
      }
    }

    if (wave.length === 0) {
      // Cycle detected — place all remaining groups in one final wave
      const remaining: number[] = []
      for (let i = 0; i < groups.length; i++) {
        if (!processed.has(i)) remaining.push(i)
      }
      waves.push(remaining)
      break
    }

    waves.push(wave)
    for (const idx of wave) {
      processed.add(idx)
      for (const successor of successors.get(idx)!) {
        inDegree[successor]--
      }
    }
  }

  // Convert wave indices back to the actual conflict groups
  const batches = waves.map((wave) => wave.map((idx) => groups[idx]))

  return { batches, edges }
}
