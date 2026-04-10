/**
 * Unit tests for packages/core/src/dispatch/output-quality.ts
 *
 * Tests the estimateOutputQuality function which analyzes raw agent stdout
 * for quality signals before YAML extraction and schema validation.
 */

import { describe, it, expect } from 'vitest'
import { estimateOutputQuality } from '../dispatch/output-quality.js'

describe('estimateOutputQuality', () => {
  // -------------------------------------------------------------------------
  // Empty / null input
  // -------------------------------------------------------------------------

  describe('empty input', () => {
    it('returns score 0 for empty string', () => {
      const result = estimateOutputQuality('')
      expect(result.qualityScore).toBe(0)
      expect(result.outputLength).toBe(0)
    })

    it('returns score 0 for whitespace-only string', () => {
      const result = estimateOutputQuality('   \n\n  ')
      expect(result.qualityScore).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // Hedging detection
  // -------------------------------------------------------------------------

  describe('hedging detection', () => {
    it('detects "I couldn\'t" hedging', () => {
      const result = estimateOutputQuality("I couldn't figure out how to implement the TLA+ spec.")
      expect(result.hedgingCount).toBeGreaterThanOrEqual(1)
      expect(result.hedgingPhrases.length).toBeGreaterThanOrEqual(1)
    })

    it('detects "I was unable to" hedging', () => {
      const result = estimateOutputQuality('I was unable to resolve the import error.')
      expect(result.hedgingCount).toBeGreaterThanOrEqual(1)
    })

    it('detects TODO markers as hedging', () => {
      const result = estimateOutputQuality('TODO: implement the circuit breaker logic')
      expect(result.hedgingCount).toBeGreaterThanOrEqual(1)
    })

    it('multiple hedging phrases reduce score', () => {
      const output =
        "I couldn't run the tests. I was unable to find the config. I skipped the integration tests."
      const result = estimateOutputQuality(output)
      expect(result.hedgingCount).toBeGreaterThanOrEqual(2)
      expect(result.qualityScore).toBeLessThan(30)
    })

    it('reports no hedging for clean output', () => {
      const output = 'Implemented the payment idempotency spec.\n\n```yaml\nresult: success\n```'
      const result = estimateOutputQuality(output)
      expect(result.hedgingCount).toBe(0)
      expect(result.hedgingPhrases).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // Test execution / results detection
  // -------------------------------------------------------------------------

  describe('test detection', () => {
    it('detects test execution mentions', () => {
      const result = estimateOutputQuality('Running the tests with npm test...')
      expect(result.mentionsTestExecution).toBe(true)
    })

    it('detects vitest execution', () => {
      const result = estimateOutputQuality('npx vitest run src/foo.test.ts')
      expect(result.mentionsTestExecution).toBe(true)
    })

    it('detects test pass', () => {
      const result = estimateOutputQuality('All tests passed. 42 passing.')
      expect(result.mentionsTestPass).toBe(true)
    })

    it('detects test failure', () => {
      const result = estimateOutputQuality('3 tests failed in foo.test.ts')
      expect(result.mentionsTestFailure).toBe(true)
    })

    it('test pass boosts score', () => {
      const withPass = estimateOutputQuality('Tests passed.\n\n```yaml\nresult: success\n```')
      const without = estimateOutputQuality('Done.\n\n```yaml\nresult: success\n```')
      expect(withPass.qualityScore).toBeGreaterThan(without.qualityScore)
    })

    it('test failure reduces score', () => {
      const withFail = estimateOutputQuality('Tests failed.\n\n```yaml\nresult: success\n```')
      const without = estimateOutputQuality('Done.\n\n```yaml\nresult: success\n```')
      expect(withFail.qualityScore).toBeLessThan(without.qualityScore)
    })
  })

  // -------------------------------------------------------------------------
  // YAML block detection
  // -------------------------------------------------------------------------

  describe('YAML block detection', () => {
    it('boosts score significantly when YAML block is present', () => {
      const withYaml = estimateOutputQuality(
        'Done.\n\n```yaml\nresult: success\nac_met:\n  - AC1\n```'
      )
      const without = estimateOutputQuality('Done. I implemented everything successfully.')
      expect(withYaml.qualityScore).toBeGreaterThan(without.qualityScore + 10)
    })

    it('detects unfenced YAML starting with result:', () => {
      // Short output triggers length penalty (-20), but YAML detection (+20) offsets it
      const result = estimateOutputQuality('Some output...\nresult: success\nac_met:\n  - AC1')
      // Base 30 + YAML +20 - short -20 = 30
      expect(result.qualityScore).toBeGreaterThanOrEqual(25)
    })

    it('penalizes long output without YAML block', () => {
      const longNoYaml = estimateOutputQuality('x'.repeat(2000))
      expect(longNoYaml.qualityScore).toBeLessThan(30)
    })
  })

  // -------------------------------------------------------------------------
  // File modification detection
  // -------------------------------------------------------------------------

  describe('file modification detection', () => {
    it('counts file modification mentions', () => {
      const output =
        'Created file src/specs/payment.tla\nModified file package.json\nUpdated src/index.ts'
      const result = estimateOutputQuality(output)
      expect(result.fileModificationMentions).toBeGreaterThanOrEqual(2)
    })
  })

  // -------------------------------------------------------------------------
  // Error detection
  // -------------------------------------------------------------------------

  describe('error detection', () => {
    it('detects TypeError mentions', () => {
      const result = estimateOutputQuality('TypeError: Cannot read property of undefined')
      expect(result.mentionsErrors).toBe(true)
    })

    it('detects compilation errors', () => {
      const result = estimateOutputQuality('compilation failed: missing semicolon at line 42')
      expect(result.mentionsErrors).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Score calibration
  // -------------------------------------------------------------------------

  describe('score calibration', () => {
    it('ideal output (YAML + tests pass + file mods) scores high', () => {
      const output = [
        'Implemented the spec. Created file specs/tla/Payment.tla.',
        'Running the tests... All tests passed.',
        '```yaml',
        'result: success',
        'ac_met:',
        '  - AC1',
        '  - AC2',
        'files_modified:',
        '  - specs/tla/Payment.tla',
        'tests: pass',
        '```',
      ].join('\n')
      const result = estimateOutputQuality(output)
      expect(result.qualityScore).toBeGreaterThanOrEqual(70)
    })

    it('bad output (hedging + no YAML + errors) scores low', () => {
      const output =
        "I couldn't implement the spec. TypeError: module not found. I was unable to run the tests."
      const result = estimateOutputQuality(output)
      expect(result.qualityScore).toBeLessThanOrEqual(20)
    })

    it('score is clamped to 0-100 range', () => {
      // Extremely bad output
      const bad = estimateOutputQuality("I couldn't. I was unable. I skipped. TODO: everything.")
      expect(bad.qualityScore).toBeGreaterThanOrEqual(0)
      expect(bad.qualityScore).toBeLessThanOrEqual(100)
    })

    it('short output is penalized', () => {
      const short = estimateOutputQuality('ok')
      expect(short.qualityScore).toBeLessThan(20)
    })
  })
})
