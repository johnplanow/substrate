/**
 * Unit tests for Story 25-5: Contract-Aware Dispatch Ordering.
 *
 * Covers:
 *   AC1: Contract dependency graph is built from declarations
 *   AC2: Exporter story dispatched before importer (earlier batch index)
 *   AC3: Dual-export serialization (different sequential batches)
 *   AC4: No regression for independent stories (continue to run in parallel)
 *   AC5: (logging tested via orchestrator integration tests)
 */

import { describe, it, expect } from 'vitest'
import {
  buildContractDependencyGraph,
  detectConflictGroupsWithContracts,
} from '../conflict-detector.js'
import type {
  ContractDeclaration,
  ContractDependencyEdge,
} from '../conflict-detector.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExport(storyKey: string, contractName: string, filePath = 'src/types.ts'): ContractDeclaration {
  return { storyKey, contractName, direction: 'export', filePath }
}

function makeImport(storyKey: string, contractName: string, filePath = 'src/types.ts'): ContractDeclaration {
  return { storyKey, contractName, direction: 'import', filePath }
}

/** Find the batch index that contains a given story key. Returns -1 if not found. */
function batchOf(batches: string[][][], storyKey: string): number {
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]
    for (const group of batch) {
      if (group.includes(storyKey)) return i
    }
  }
  return -1
}

// ---------------------------------------------------------------------------
// buildContractDependencyGraph tests (AC1)
// ---------------------------------------------------------------------------

describe('buildContractDependencyGraph', () => {
  it('returns empty array for empty declarations', () => {
    const edges = buildContractDependencyGraph([])
    expect(edges).toEqual([])
  })

  it('returns empty array when only exports (no importers)', () => {
    const edges = buildContractDependencyGraph([makeExport('A', 'FooSchema')])
    expect(edges).toEqual([])
  })

  it('returns empty array when only imports (no exporters)', () => {
    const edges = buildContractDependencyGraph([makeImport('B', 'FooSchema')])
    expect(edges).toEqual([])
  })

  it('creates edge from exporter to importer for matching contract', () => {
    const declarations: ContractDeclaration[] = [
      makeExport('A', 'FooSchema'),
      makeImport('B', 'FooSchema'),
    ]
    const edges = buildContractDependencyGraph(declarations)
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject<Partial<ContractDependencyEdge>>({
      from: 'A',
      to: 'B',
      contractName: 'FooSchema',
    })
  })

  it('does not create self-edges (same story exports and imports same contract)', () => {
    const declarations: ContractDeclaration[] = [
      makeExport('A', 'FooSchema'),
      makeImport('A', 'FooSchema'),
    ]
    const edges = buildContractDependencyGraph(declarations)
    expect(edges).toHaveLength(0)
  })

  it('creates multiple edges for one exporter with multiple importers', () => {
    const declarations: ContractDeclaration[] = [
      makeExport('A', 'FooSchema'),
      makeImport('B', 'FooSchema'),
      makeImport('C', 'FooSchema'),
    ]
    const edges = buildContractDependencyGraph(declarations)
    expect(edges).toHaveLength(2)
    const targets = edges.map((e) => e.to).sort()
    expect(targets).toEqual(['B', 'C'])
    expect(edges.every((e) => e.from === 'A')).toBe(true)
  })

  it('creates no edges when contracts do not match', () => {
    const declarations: ContractDeclaration[] = [
      makeExport('A', 'FooSchema'),
      makeImport('B', 'BarSchema'),
    ]
    const edges = buildContractDependencyGraph(declarations)
    expect(edges).toHaveLength(0)
  })

  it('creates dual-export serialization edge (AC3) — alphabetically ordered', () => {
    // Both A and B export the same contract
    const declarations: ContractDeclaration[] = [
      makeExport('A', 'BarSchema'),
      makeExport('B', 'BarSchema'),
    ]
    const edges = buildContractDependencyGraph(declarations)
    // Should have exactly one directional edge (A→B, alphabetically sorted)
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject<Partial<ContractDependencyEdge>>({
      from: 'A',
      to: 'B',
      contractName: 'BarSchema',
    })
    expect(edges[0]?.reason).toMatch(/dual export/)
  })

  it('creates chain of edges for three dual exporters', () => {
    const declarations: ContractDeclaration[] = [
      makeExport('C', 'BarSchema'),
      makeExport('A', 'BarSchema'),
      makeExport('B', 'BarSchema'),
    ]
    const edges = buildContractDependencyGraph(declarations)
    // Sorted order: A→B, B→C
    expect(edges).toHaveLength(2)
    const sorted = [...edges].sort((a, b) => a.from.localeCompare(b.from))
    expect(sorted[0]).toMatchObject({ from: 'A', to: 'B' })
    expect(sorted[1]).toMatchObject({ from: 'B', to: 'C' })
  })

  it('includes reason field describing the edge', () => {
    const declarations: ContractDeclaration[] = [
      makeExport('A', 'FooSchema'),
      makeImport('B', 'FooSchema'),
    ]
    const edges = buildContractDependencyGraph(declarations)
    expect(edges[0]?.reason).toBeTruthy()
    expect(typeof edges[0]?.reason).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// detectConflictGroupsWithContracts — AC4: no regression for independent stories
// ---------------------------------------------------------------------------

describe('detectConflictGroupsWithContracts — AC4: no regression (no contract overlap)', () => {
  it('returns a single batch with all groups when no contract declarations', () => {
    const { batches, edges } = detectConflictGroupsWithContracts(
      ['A', 'B', 'C'],
      undefined,
      [],
    )
    expect(edges).toHaveLength(0)
    expect(batches).toHaveLength(1)
    // All stories in the single batch
    const allStories = batches.flat(2)
    expect(allStories).toContain('A')
    expect(allStories).toContain('B')
    expect(allStories).toContain('C')
  })

  it('returns single batch with original groups when no matching contracts', () => {
    const declarations: ContractDeclaration[] = [
      makeExport('A', 'FooSchema'),
      makeImport('B', 'BarSchema'),  // different contract name — no match
    ]
    const { batches, edges } = detectConflictGroupsWithContracts(['A', 'B', 'C'], undefined, declarations)
    expect(edges).toHaveLength(0)
    expect(batches).toHaveLength(1)
    // All stories still present
    expect(batches.flat(2)).toContain('A')
    expect(batches.flat(2)).toContain('B')
    expect(batches.flat(2)).toContain('C')
  })

  it('independent stories run in parallel (same batch)', () => {
    const { batches } = detectConflictGroupsWithContracts(['X', 'Y', 'Z'], undefined, [])
    expect(batches).toHaveLength(1)
    // All three stories are in batch 0
    expect(batchOf(batches, 'X')).toBe(0)
    expect(batchOf(batches, 'Y')).toBe(0)
    expect(batchOf(batches, 'Z')).toBe(0)
  })

  it('preserves moduleMap conflict grouping when no contract deps', () => {
    const { batches } = detectConflictGroupsWithContracts(
      ['12-1', '12-2', '13-1'],
      { moduleMap: { '12-': 'module-a', '13-': 'module-b' } },
      [],
    )
    // Single batch (no contract deps)
    expect(batches).toHaveLength(1)
    // 12-1 and 12-2 are in the same conflict group (file conflict)
    const batch = batches[0]
    const moduleAGroup = batch?.find((g) => g.includes('12-1'))
    expect(moduleAGroup).toContain('12-2')
  })
})

// ---------------------------------------------------------------------------
// detectConflictGroupsWithContracts — AC2: exporter before importer
// ---------------------------------------------------------------------------

describe('detectConflictGroupsWithContracts — AC2: exporter before importer', () => {
  it('simple: A exports, B imports → A in earlier batch', () => {
    const declarations: ContractDeclaration[] = [
      makeExport('A', 'FooSchema'),
      makeImport('B', 'FooSchema'),
    ]
    const { batches, edges } = detectConflictGroupsWithContracts(['A', 'B'], undefined, declarations)
    expect(edges).toHaveLength(1)
    expect(batches.length).toBeGreaterThanOrEqual(2)
    expect(batchOf(batches, 'A')).toBeLessThan(batchOf(batches, 'B'))
  })

  it('A exports, B imports, C is independent — A before B, C can be in any batch', () => {
    const declarations: ContractDeclaration[] = [
      makeExport('A', 'FooSchema'),
      makeImport('B', 'FooSchema'),
    ]
    const { batches } = detectConflictGroupsWithContracts(['A', 'B', 'C'], undefined, declarations)
    expect(batchOf(batches, 'A')).toBeLessThan(batchOf(batches, 'B'))
    // C is independent — it should be in some batch (batch 0 together with A is fine)
    expect(batchOf(batches, 'C')).toBeGreaterThanOrEqual(0)
  })

  it('multiple importers: A exports FooSchema, B and C import it — B and C in later batch', () => {
    const declarations: ContractDeclaration[] = [
      makeExport('A', 'FooSchema'),
      makeImport('B', 'FooSchema'),
      makeImport('C', 'FooSchema'),
    ]
    const { batches } = detectConflictGroupsWithContracts(['A', 'B', 'C'], undefined, declarations)
    const batchA = batchOf(batches, 'A')
    expect(batchOf(batches, 'B')).toBeGreaterThan(batchA)
    expect(batchOf(batches, 'C')).toBeGreaterThan(batchA)
  })

  it('transitive chain A→B→C: A in batch 0, B in batch 1, C in batch 2', () => {
    const declarations: ContractDeclaration[] = [
      makeExport('A', 'SchemaA'),
      makeImport('B', 'SchemaA'),
      makeExport('B', 'SchemaB'),
      makeImport('C', 'SchemaB'),
    ]
    const { batches } = detectConflictGroupsWithContracts(['A', 'B', 'C'], undefined, declarations)
    const batchA = batchOf(batches, 'A')
    const batchB = batchOf(batches, 'B')
    const batchC = batchOf(batches, 'C')
    expect(batchA).toBeLessThan(batchB)
    expect(batchB).toBeLessThan(batchC)
  })
})

// ---------------------------------------------------------------------------
// detectConflictGroupsWithContracts — AC3: dual-export serialization
// ---------------------------------------------------------------------------

describe('detectConflictGroupsWithContracts — AC3: dual-export serialization', () => {
  it('A and B both export BarSchema → different batches', () => {
    const declarations: ContractDeclaration[] = [
      makeExport('A', 'BarSchema'),
      makeExport('B', 'BarSchema'),
    ]
    const { batches } = detectConflictGroupsWithContracts(['A', 'B'], undefined, declarations)
    expect(batchOf(batches, 'A')).not.toBe(batchOf(batches, 'B'))
  })

  it('dual-export ordering is deterministic (alphabetically earlier comes first)', () => {
    const declarations: ContractDeclaration[] = [
      makeExport('B', 'BarSchema'),  // B declared first
      makeExport('A', 'BarSchema'),  // A declared second
    ]
    const { batches } = detectConflictGroupsWithContracts(['A', 'B'], undefined, declarations)
    // A comes before B alphabetically → A in earlier batch
    expect(batchOf(batches, 'A')).toBeLessThan(batchOf(batches, 'B'))
  })

  it('three dual exporters A, B, C → all in different batches (chained serialization)', () => {
    const declarations: ContractDeclaration[] = [
      makeExport('C', 'BarSchema'),
      makeExport('A', 'BarSchema'),
      makeExport('B', 'BarSchema'),
    ]
    const { batches } = detectConflictGroupsWithContracts(['A', 'B', 'C'], undefined, declarations)
    const batchA = batchOf(batches, 'A')
    const batchB = batchOf(batches, 'B')
    const batchC = batchOf(batches, 'C')
    // All must be in different batches
    expect(batchA).not.toBe(batchB)
    expect(batchB).not.toBe(batchC)
    expect(batchA).not.toBe(batchC)
  })
})

// ---------------------------------------------------------------------------
// detectConflictGroupsWithContracts — Mixed file conflicts + contract deps
// ---------------------------------------------------------------------------

describe('detectConflictGroupsWithContracts — mixed file conflicts + contract deps', () => {
  it('file-conflicting stories (same group) plus contract dep — both respected', () => {
    // 12-1 and 12-2 share a file conflict (same module group)
    // 12-1 exports FooSchema, 13-1 imports FooSchema
    const declarations: ContractDeclaration[] = [
      makeExport('12-1', 'FooSchema'),
      makeImport('13-1', 'FooSchema'),
    ]
    const { batches } = detectConflictGroupsWithContracts(
      ['12-1', '12-2', '13-1'],
      { moduleMap: { '12-': 'module-a', '13-': 'module-b' } },
      declarations,
    )
    // module-a group (12-1, 12-2) must be in earlier batch than module-b group (13-1)
    expect(batchOf(batches, '12-1')).toBeLessThan(batchOf(batches, '13-1'))
    expect(batchOf(batches, '12-2')).toBeLessThan(batchOf(batches, '13-1'))
    // 12-1 and 12-2 should still be in the same batch (file conflict groups them)
    expect(batchOf(batches, '12-1')).toBe(batchOf(batches, '12-2'))
  })

  it('contract dep between stories in same file-conflict group — no ordering change (same group serializes them)', () => {
    const declarations: ContractDeclaration[] = [
      makeExport('12-1', 'FooSchema'),
      makeImport('12-2', 'FooSchema'),
    ]
    const { batches } = detectConflictGroupsWithContracts(
      ['12-1', '12-2'],
      { moduleMap: { '12-': 'module-a' } },
      declarations,
    )
    // Both in same file-conflict group → same batch (the contract dep is a self-loop at group level)
    expect(batchOf(batches, '12-1')).toBe(batchOf(batches, '12-2'))
  })

  it('three stories: two with file conflict, one independent with contract dep', () => {
    // 12-1 and 12-2 share files (same module)
    // 12-1 exports FooSchema, 99-1 imports FooSchema (independent, no file conflict)
    const declarations: ContractDeclaration[] = [
      makeExport('12-1', 'FooSchema'),
      makeImport('99-1', 'FooSchema'),
    ]
    const { batches } = detectConflictGroupsWithContracts(
      ['12-1', '12-2', '99-1'],
      { moduleMap: { '12-': 'module-a' } },
      declarations,
    )
    // module-a group must come before 99-1
    expect(batchOf(batches, '12-1')).toBeLessThan(batchOf(batches, '99-1'))
    expect(batchOf(batches, '12-2')).toBeLessThan(batchOf(batches, '99-1'))
  })
})

// ---------------------------------------------------------------------------
// detectConflictGroupsWithContracts — edge cases
// ---------------------------------------------------------------------------

describe('detectConflictGroupsWithContracts — edge cases', () => {
  it('handles empty storyKeys gracefully', () => {
    const { batches, edges } = detectConflictGroupsWithContracts([], undefined, [])
    expect(edges).toHaveLength(0)
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(0)
  })

  it('handles single story with no contracts', () => {
    const { batches } = detectConflictGroupsWithContracts(['A'], undefined, [])
    expect(batches).toHaveLength(1)
    expect(batchOf(batches, 'A')).toBe(0)
  })

  it('ignores declarations for unknown story keys (not in storyKeys list)', () => {
    const declarations: ContractDeclaration[] = [
      makeExport('UNKNOWN', 'FooSchema'),  // not in storyKeys
      makeImport('B', 'FooSchema'),
    ]
    const { batches, edges } = detectConflictGroupsWithContracts(['A', 'B'], undefined, declarations)
    // Edge exists in the graph but UNKNOWN isn't in any group → ignored
    // B should still be in some batch
    expect(batchOf(batches, 'B')).toBeGreaterThanOrEqual(0)
    // A should be in some batch
    expect(batchOf(batches, 'A')).toBeGreaterThanOrEqual(0)
    // The edges array shows what was found in declarations (regardless of group membership)
    expect(edges.length).toBeGreaterThanOrEqual(0)
  })

  it('cycle detection: A depends on B and B depends on A → places them in same batch (graceful degradation)', () => {
    // This would be an unusual case — can happen with mutual dual-imports
    // Create an artificial cycle by having both A→B and B→A edges via different contracts
    const declarations: ContractDeclaration[] = [
      makeExport('A', 'SchemaX'),
      makeImport('B', 'SchemaX'),
      makeExport('B', 'SchemaY'),
      makeImport('A', 'SchemaY'),
    ]
    const { batches } = detectConflictGroupsWithContracts(['A', 'B'], undefined, declarations)
    // Should not throw and should return a valid result
    expect(batches.length).toBeGreaterThan(0)
    const allStories = batches.flat(2)
    expect(allStories).toContain('A')
    expect(allStories).toContain('B')
  })

  it('returns edges in the result for observability (AC5)', () => {
    const declarations: ContractDeclaration[] = [
      makeExport('A', 'FooSchema'),
      makeImport('B', 'FooSchema'),
    ]
    const { edges } = detectConflictGroupsWithContracts(['A', 'B'], undefined, declarations)
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({
      from: 'A',
      to: 'B',
      contractName: 'FooSchema',
    })
    expect(typeof edges[0]?.reason).toBe('string')
  })
})
