// @vitest-environment node
/**
 * Unit tests for detectCycles().
 *
 * Story 31-7: Cycle Detection in Work Graph (AC1–AC4)
 */

import { describe, it, expect } from 'vitest'
import { detectCycles } from '../cycle-detector.js'

describe('detectCycles()', () => {
  // -------------------------------------------------------------------------
  // AC1: Returns null for acyclic graphs
  // -------------------------------------------------------------------------

  describe('AC1: returns null for acyclic graphs', () => {
    it('returns null for an empty edge list', () => {
      expect(detectCycles([])).toBeNull()
    })

    it('returns null for a linear chain (A→B→C)', () => {
      const edges = [
        { story_key: '31-1', depends_on: '31-2' },
        { story_key: '31-2', depends_on: '31-3' },
      ]
      expect(detectCycles(edges)).toBeNull()
    })

    it('returns null for a fan-in DAG (B and C both depend on A)', () => {
      const edges = [
        { story_key: '31-2', depends_on: '31-1' },
        { story_key: '31-3', depends_on: '31-1' },
      ]
      expect(detectCycles(edges)).toBeNull()
    })

    it('returns null for a fan-out DAG (A blocks both B and C)', () => {
      const edges = [
        { story_key: '31-B', depends_on: '31-A' },
        { story_key: '31-C', depends_on: '31-A' },
        { story_key: '31-D', depends_on: '31-B' },
        { story_key: '31-D', depends_on: '31-C' },
      ]
      expect(detectCycles(edges)).toBeNull()
    })

    it('returns null for a diamond DAG (A→B→D, A→C→D)', () => {
      const edges = [
        { story_key: '31-B', depends_on: '31-A' },
        { story_key: '31-C', depends_on: '31-A' },
        { story_key: '31-D', depends_on: '31-B' },
        { story_key: '31-D', depends_on: '31-C' },
      ]
      expect(detectCycles(edges)).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // AC2: Detects 2-node mutual dependency cycle
  // -------------------------------------------------------------------------

  describe('AC2: detects 2-node mutual dependency cycle', () => {
    it('returns non-null array for mutual dep (A depends_on B, B depends_on A)', () => {
      const edges = [
        { story_key: '31-B', depends_on: '31-A' },
        { story_key: '31-A', depends_on: '31-B' },
      ]
      const result = detectCycles(edges)
      expect(result).not.toBeNull()
      expect(result).toBeInstanceOf(Array)
    })

    it('cycle path has the same first and last element', () => {
      const edges = [
        { story_key: '31-B', depends_on: '31-A' },
        { story_key: '31-A', depends_on: '31-B' },
      ]
      const result = detectCycles(edges)!
      expect(result[0]).toBe(result[result.length - 1])
    })

    it('cycle path contains both story keys', () => {
      const edges = [
        { story_key: '31-B', depends_on: '31-A' },
        { story_key: '31-A', depends_on: '31-B' },
      ]
      const result = detectCycles(edges)!
      expect(result).toContain('31-A')
      expect(result).toContain('31-B')
    })
  })

  // -------------------------------------------------------------------------
  // AC3: Detects 3-node transitive cycle
  // -------------------------------------------------------------------------

  describe('AC3: detects 3-node transitive cycle', () => {
    it('returns non-null for C→B→A→C cycle', () => {
      const edges = [
        { story_key: '31-C', depends_on: '31-B' },
        { story_key: '31-B', depends_on: '31-A' },
        { story_key: '31-A', depends_on: '31-C' },
      ]
      const result = detectCycles(edges)
      expect(result).not.toBeNull()
    })

    it('cycle path has length >= 4 (3 unique + closing repeat)', () => {
      const edges = [
        { story_key: '31-C', depends_on: '31-B' },
        { story_key: '31-B', depends_on: '31-A' },
        { story_key: '31-A', depends_on: '31-C' },
      ]
      const result = detectCycles(edges)!
      expect(result.length).toBeGreaterThanOrEqual(4)
    })

    it('cycle path contains all three story keys', () => {
      const edges = [
        { story_key: '31-C', depends_on: '31-B' },
        { story_key: '31-B', depends_on: '31-A' },
        { story_key: '31-A', depends_on: '31-C' },
      ]
      const result = detectCycles(edges)!
      expect(result).toContain('31-A')
      expect(result).toContain('31-B')
      expect(result).toContain('31-C')
    })

    it('cycle path first and last elements match', () => {
      const edges = [
        { story_key: '31-C', depends_on: '31-B' },
        { story_key: '31-B', depends_on: '31-A' },
        { story_key: '31-A', depends_on: '31-C' },
      ]
      const result = detectCycles(edges)!
      expect(result[0]).toBe(result[result.length - 1])
    })
  })

  // -------------------------------------------------------------------------
  // AC4: Detects self-loops
  // -------------------------------------------------------------------------

  describe('AC4: detects self-loops', () => {
    it('returns non-null for a self-referencing story (A depends_on A)', () => {
      const edges = [{ story_key: '31-A', depends_on: '31-A' }]
      const result = detectCycles(edges)
      expect(result).not.toBeNull()
    })

    it('self-loop cycle path is non-empty', () => {
      const edges = [{ story_key: '31-A', depends_on: '31-A' }]
      const result = detectCycles(edges)!
      expect(result.length).toBeGreaterThan(0)
    })

    it('self-loop cycle path contains the self-referencing story key', () => {
      const edges = [{ story_key: '31-A', depends_on: '31-A' }]
      const result = detectCycles(edges)!
      expect(result).toContain('31-A')
    })
  })
})
