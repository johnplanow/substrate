// @vitest-environment node
/**
 * Unit tests for `src/cli/commands/contracts.ts`.
 *
 * Mocks createStateStore so no real storage backend is needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ContractRecord, ContractVerificationRecord } from '../../../modules/state/types.js'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockInitialize = vi.fn().mockResolvedValue(undefined)
const mockClose = vi.fn().mockResolvedValue(undefined)
const mockQueryContracts = vi.fn()
const mockGetContractVerification = vi.fn()

vi.mock('../../../modules/state/index.js', () => ({
  createStateStore: vi.fn(() => ({
    initialize: mockInitialize,
    close: mockClose,
    queryContracts: mockQueryContracts,
    getContractVerification: mockGetContractVerification,
  })),
}))

import { Command } from 'commander'
import { registerContractsCommand } from '../contracts.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContract(overrides: Partial<ContractRecord> = {}): ContractRecord {
  return {
    storyKey: '26-1',
    contractName: 'StateStore',
    direction: 'export',
    schemaPath: 'src/modules/state/types.ts',
    ...overrides,
  }
}

function makeVerification(
  overrides: Partial<ContractVerificationRecord> = {}
): ContractVerificationRecord {
  return {
    storyKey: '26-1',
    contractName: 'StateStore',
    verdict: 'pass',
    verifiedAt: '2026-03-08T10:00:00.000Z',
    ...overrides,
  }
}

function createProgram(): Command {
  const program = new Command()
  program.exitOverride() // Prevent process.exit during tests
  registerContractsCommand(program)
  return program
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('contracts command', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleSpy.mockRestore()
  })

  describe('empty state', () => {
    it('prints "No contracts stored" when no contracts exist', async () => {
      mockQueryContracts.mockResolvedValue([])

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'contracts'])

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No contracts stored'))
    })
  })

  describe('table output (default)', () => {
    it('prints table with headers and contract rows for two contracts', async () => {
      const contracts: ContractRecord[] = [
        makeContract({ storyKey: '26-1', contractName: 'StateStore', direction: 'export' }),
        makeContract({
          storyKey: '26-2',
          contractName: 'DoltClient',
          direction: 'import',
          schemaPath: 'src/modules/state/dolt-client.ts',
        }),
      ]
      mockQueryContracts.mockResolvedValue(contracts)
      mockGetContractVerification
        .mockResolvedValueOnce([makeVerification({ contractName: 'StateStore', verdict: 'pass' })])
        .mockResolvedValueOnce([
          makeVerification({ storyKey: '26-2', contractName: 'DoltClient', verdict: 'fail' }),
        ])

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'contracts'])

      const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n')

      // Headers
      expect(output).toContain('Story Key')
      expect(output).toContain('Contract Name')
      expect(output).toContain('Direction')
      expect(output).toContain('Status')

      // Data rows
      expect(output).toContain('StateStore')
      expect(output).toContain('DoltClient')
      expect(output).toContain('pass')
      expect(output).toContain('fail')
    })

    it('shows pending status for contracts without verification', async () => {
      const contracts: ContractRecord[] = [makeContract({ contractName: 'UnverifiedContract' })]
      mockQueryContracts.mockResolvedValue(contracts)
      mockGetContractVerification.mockResolvedValue([]) // No verifications

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'contracts'])

      const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(output).toContain('pending')
    })
  })

  describe('JSON output', () => {
    it('outputs valid JSON array when --output-format json is specified', async () => {
      const contracts: ContractRecord[] = [
        makeContract({ contractName: 'StateStore', direction: 'export' }),
        makeContract({
          contractName: 'MetricRecord',
          direction: 'import',
          schemaPath: 'metrics.ts',
        }),
      ]
      mockQueryContracts.mockResolvedValue(contracts)
      mockGetContractVerification.mockResolvedValue([
        makeVerification({ contractName: 'StateStore', verdict: 'pass' }),
        makeVerification({ contractName: 'MetricRecord', verdict: 'pass' }),
      ])

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'contracts', '--output-format', 'json'])

      const calls = consoleSpy.mock.calls
      expect(calls).toHaveLength(1)

      const parsed = JSON.parse(calls[0][0]) as unknown[]
      expect(Array.isArray(parsed)).toBe(true)
      expect(parsed).toHaveLength(2)

      const first = parsed[0] as Record<string, unknown>
      expect(first.storyKey).toBe('26-1')
      expect(first.contractName).toBe('StateStore')
      expect(first.direction).toBe('export')
      expect(first.verdict).toBe('pass')
    })

    it('includes verdict field in JSON output', async () => {
      const contracts: ContractRecord[] = [makeContract({ contractName: 'BrokenContract' })]
      mockQueryContracts.mockResolvedValue(contracts)
      mockGetContractVerification.mockResolvedValue([
        makeVerification({
          contractName: 'BrokenContract',
          verdict: 'fail',
          mismatchDescription: 'Type mismatch',
        }),
      ])

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'contracts', '--output-format', 'json'])

      const parsed = JSON.parse(consoleSpy.mock.calls[0][0]) as unknown[]
      const first = parsed[0] as Record<string, unknown>
      expect(first.verdict).toBe('fail')
    })
  })

  describe('lifecycle', () => {
    it('calls store.initialize() and store.close()', async () => {
      mockQueryContracts.mockResolvedValue([])

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'contracts'])

      expect(mockInitialize).toHaveBeenCalledOnce()
      expect(mockClose).toHaveBeenCalledOnce()
    })
  })
})
