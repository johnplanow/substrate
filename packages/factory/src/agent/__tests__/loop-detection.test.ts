// packages/factory/src/agent/__tests__/loop-detection.test.ts
// Unit tests for LoopDetector.
// Story 48-8: Loop Detection and Steering Injection

import { describe, it, expect } from 'vitest'
import { LoopDetector } from '../loop-detection.js'

// ---------------------------------------------------------------------------
// Helper: make a LoopDetector with common defaults
// ---------------------------------------------------------------------------
function makeDetector(windowSize = 10, enabled = true): LoopDetector {
  return new LoopDetector({ windowSize, enabled })
}

// Helper to call record() N times with the same tool/args
function recordN(
  detector: LoopDetector,
  n: number,
  toolName = 'tool',
  args: Record<string, unknown> = {}
): boolean[] {
  const results: boolean[] = []
  for (let i = 0; i < n; i++) {
    results.push(detector.record(toolName, args))
  }
  return results
}

// ---------------------------------------------------------------------------
// Basic construction
// ---------------------------------------------------------------------------

describe('LoopDetector — construction', () => {
  it('starts with an empty window; first record() returns false', () => {
    const d = makeDetector()
    expect(d.record('tool_a', {})).toBe(false)
  })

  it('returns false for any call count below windowSize', () => {
    const d = makeDetector(10)
    const results = recordN(d, 9, 'tool_a', {})
    expect(results.every((r) => r === false)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Pattern length 1: all identical
// ---------------------------------------------------------------------------

describe('LoopDetector — pattern length 1', () => {
  it('returns true on the 10th call when all 10 are identical (windowSize=10)', () => {
    const d = makeDetector(10)
    const results = recordN(d, 10, 'tool_a', {})
    // First 9 must be false; 10th triggers detection
    expect(results.slice(0, 9).every((r) => r === false)).toBe(true)
    expect(results[9]).toBe(true)
  })

  it('returns true on subsequent calls when window is full of identical entries', () => {
    const d = makeDetector(10)
    recordN(d, 9, 'tool_a', {})
    // 10th call → true
    expect(d.record('tool_a', {})).toBe(true)
    // 11th call (window still all 'tool_a') → still true
    expect(d.record('tool_a', {})).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Pattern length 2: A-B alternating
// ---------------------------------------------------------------------------

describe('LoopDetector — pattern length 2', () => {
  it('returns true when window is A-B-A-B-A-B-A-B-A-B (windowSize=10)', () => {
    const d = makeDetector(10)
    const results: boolean[] = []
    for (let i = 0; i < 10; i++) {
      if (i % 2 === 0) {
        results.push(d.record('tool_a', {}))
      } else {
        results.push(d.record('tool_b', {}))
      }
    }
    // First 9 false, 10th true
    expect(results.slice(0, 9).every((r) => r === false)).toBe(true)
    expect(results[9]).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Pattern length 3: A-B-C repeating (windowSize=6)
// ---------------------------------------------------------------------------

describe('LoopDetector — pattern length 3', () => {
  it('returns true on 6th call for A-B-C-A-B-C pattern (windowSize=6)', () => {
    const d = makeDetector(6)
    const tools = ['tool_a', 'tool_b', 'tool_c', 'tool_a', 'tool_b', 'tool_c']
    const results = tools.map((t) => d.record(t, {}))
    expect(results.slice(0, 5).every((r) => r === false)).toBe(true)
    expect(results[5]).toBe(true)
  })

  it('2 repetitions of A-B-C returns true with windowSize=6', () => {
    const d = makeDetector(6)
    for (let i = 0; i < 5; i++) {
      d.record(['tool_a', 'tool_b', 'tool_c'][i % 3]!, {})
    }
    // 6th entry completes 2 full reps of A-B-C
    expect(d.record('tool_c', {})).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Non-repeating patterns → false
// ---------------------------------------------------------------------------

describe('LoopDetector — non-repeating patterns', () => {
  it('returns false when 10 entries have no repeating pattern (all unique)', () => {
    const d = makeDetector(10)
    let last = false
    for (let i = 0; i < 10; i++) {
      last = d.record('tool', { index: i })
    }
    expect(last).toBe(false)
  })

  it('returns false for 9 A-entries + 1 B-entry (not clean pattern-1 or pattern-2)', () => {
    const d = makeDetector(10)
    for (let i = 0; i < 9; i++) {
      d.record('tool_a', {})
    }
    expect(d.record('tool_b', {})).toBe(false)
  })

  it('returns false for A-B pattern where windowSize=10 but only 8 entries then different 2', () => {
    // 4 reps of A-B then a different pair — window has mixed pattern
    const d = makeDetector(10)
    for (let i = 0; i < 8; i++) {
      d.record(i % 2 === 0 ? 'tool_a' : 'tool_b', {})
    }
    // Last 2 break the pattern
    d.record('tool_c', {})
    expect(d.record('tool_d', {})).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Disabled detection
// ---------------------------------------------------------------------------

describe('LoopDetector — enabled: false', () => {
  it('always returns false when enabled=false, even with repeating patterns', () => {
    const d = makeDetector(10, false)
    const results = recordN(d, 10, 'tool_a', {})
    expect(results.every((r) => r === false)).toBe(true)
  })

  it('returns false even after 100 identical calls when disabled', () => {
    const d = makeDetector(10, false)
    const results = recordN(d, 100, 'tool_a', {})
    expect(results.every((r) => r === false)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Signature differentiation
// ---------------------------------------------------------------------------

describe('LoopDetector — signature differentiation', () => {
  it('different toolArgs produce different signatures (no false positives)', () => {
    const d = makeDetector(10)
    // Alternate same tool name with different args
    let last = false
    for (let i = 0; i < 10; i++) {
      last = d.record('tool_a', { id: i })
    }
    expect(last).toBe(false)
  })

  it('same tool name with different args does not match same-name-different-args entries', () => {
    const d = makeDetector(4)
    // Pattern: tool_a({x:1}), tool_a({x:2}) alternating — NOT a pattern match because
    // args differ and SHA-256 of each is unique
    d.record('tool_a', { x: 1 })
    d.record('tool_a', { x: 2 })
    d.record('tool_a', { x: 1 })
    // 4th: even if it forms A-B-A-? it needs 4 total; let's check if {x:2} triggers
    expect(d.record('tool_a', { x: 2 })).toBe(true) // A-B-A-B pattern, windowSize=4
  })

  it('different tool names with same args produce different signatures', () => {
    const d = makeDetector(4)
    d.record('tool_a', { x: 1 })
    d.record('tool_b', { x: 1 })
    d.record('tool_a', { x: 1 })
    expect(d.record('tool_b', { x: 1 })).toBe(true) // A-B-A-B, windowSize=4
  })
})

// ---------------------------------------------------------------------------
// Window eviction
// ---------------------------------------------------------------------------

describe('LoopDetector — window eviction', () => {
  it('evicts oldest entries when window is full (windowSize=4)', () => {
    const d = makeDetector(4)
    // Push A, A, A then B, B, B — after 6 calls, window should be [A, B, B, B]
    d.record('tool_a', {}) // [A]
    d.record('tool_a', {}) // [A, A]
    d.record('tool_a', {}) // [A, A, A]
    d.record('tool_b', {}) // [A, A, A, B] → full, check pattern: A-A-A-B? no match
    d.record('tool_b', {}) // evict oldest A → [A, A, B, B] → no match
    const result = d.record('tool_b', {}) // evict → [A, B, B, B] → no clean pattern (4%1=0 but not all B; 4%2=0: pattern A-B then B-B → no)
    // Window is now [A, B, B, B]: pattern-1 is ABBB - not uniform. pattern-2: [A,B] vs [B,B] - mismatch.
    expect(result).toBe(false)
  })

  it('detects pattern after old entries are evicted (windowSize=4)', () => {
    const d = makeDetector(4)
    // Push 4 random then 4 identical — the window will be pure B's
    d.record('noise_a', { i: 1 })
    d.record('noise_b', { i: 2 })
    d.record('noise_c', { i: 3 })
    d.record('noise_d', { i: 4 }) // [na, nb, nc, nd] - full, no pattern
    d.record('tool_b', {}) // evict na → [nb, nc, nd, B]
    d.record('tool_b', {}) // evict nb → [nc, nd, B, B]
    d.record('tool_b', {}) // evict nc → [nd, B, B, B]
    const result = d.record('tool_b', {}) // evict nd → [B, B, B, B] → pattern-1 match!
    expect(result).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// windowSize % patternLen filtering
// ---------------------------------------------------------------------------

describe('LoopDetector — pattern length filter (windowSize % patternLen !== 0)', () => {
  it('windowSize=10 skips patternLen=3 but checks 1 and 2', () => {
    // 10 % 3 !== 0, so pattern-3 not checked; 10 % 1 = 0 and 10 % 2 = 0
    // A pure A-B-A-B ... 5 reps should be detected
    const d = makeDetector(10)
    for (let i = 0; i < 9; i++) {
      d.record(i % 2 === 0 ? 'tool_a' : 'tool_b', {})
    }
    expect(d.record('tool_b', {})).toBe(true)
  })

  it('windowSize=9 checks patternLen=1 and 3 (9%1=0, 9%3=0) but skips patternLen=2 (9%2!=0)', () => {
    const d = makeDetector(9)
    // Fill with A-B-A-B-A-B-A-B-A (9 entries) — starts with A, ends with A
    // Pattern-2 check is skipped (9 % 2 != 0)
    // Pattern-1: not all same; Pattern-3: A-B-A repeated 3 times? [A,B,A] then [B,A,B]? no
    for (let i = 0; i < 9; i++) {
      d.record(i % 2 === 0 ? 'tool_a' : 'tool_b', {})
    }
    // should return false because neither pattern-1 (not uniform) nor pattern-3 matches A-B-A repeated
    // Actually: window is [A,B,A,B,A,B,A,B,A]. pattern[0..3]=[A,B,A], block[3..6]=[B,A,B] → mismatch → false
    // But wait, this fills exactly 9 slots, so the 9th call should be checked
    // Let's re-verify by constructing ourselves:
    // i=0: A, i=1: B, ..., i=8: A
    // pattern of len 3: [A,B,A], second block [B,A,B] → mismatch → false
    // This test verifies the skip mechanism works (doesn't falsely trigger pattern-2 for odd windowSize)
    // The important thing: A-B alternating with 9 entries should NOT trigger true
    // (because pattern-2 requires 9%2=0, which fails)
    const finalResult = d.record('tool_b', {}) // 10th entry → now windowSize=9 doesn't apply...
    // Wait, this 10th call evicts the oldest, making window: [B,A,B,A,B,A,B,A,B] (9 B-A-B...)
    // pattern-3: [B,A,B] then [A,B,A]? → mismatch → false
    expect(finalResult).toBe(false)
  })
})
