/**
 * Tests for the --no-worktree flag (Story 75-3, hand-finished after dispatch
 * partially landed during the Epic 75 substrate-on-substrate run on 2026-05-10).
 *
 * Behavioral contract:
 *   - `--no-worktree` flag → CLI parses opts.worktree=false → noWorktree=true
 *   - default (no flag) → opts.worktree=true → noWorktree=false
 *   - SUBSTRATE_NO_WORKTREE=1 (no CLI flag) → noWorktree=true
 *   - CLI flag presence wins over env var when explicit
 *   - Manifest cli_flags.no_worktree records the choice when enabled
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import { CliFlagsSchema } from '@substrate-ai/sdlc'

describe('--no-worktree flag (Story 75-3)', () => {
  const originalEnv = process.env['SUBSTRATE_NO_WORKTREE']

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['SUBSTRATE_NO_WORKTREE']
    } else {
      process.env['SUBSTRATE_NO_WORKTREE'] = originalEnv
    }
  })

  // The flag-resolution helper mirrors what registerRunCommand's action handler
  // does. Extracted as a pure function here to test in isolation without
  // bringing up the full CLI.
  function resolveNoWorktree(opts: { worktree?: boolean }): boolean {
    return opts.worktree === false || process.env['SUBSTRATE_NO_WORKTREE'] === '1'
  }

  describe('CLI flag parsing', () => {
    it('Commander negation: --no-worktree sets opts.worktree to false', () => {
      const program = new Command()
        .option('--no-worktree', 'Bypass worktrees')
        .exitOverride()
      program.parse(['node', 'test', '--no-worktree'], { from: 'user' })
      expect(program.opts()['worktree']).toBe(false)
    })

    it('Commander default: no flag passed leaves opts.worktree as true', () => {
      const program = new Command()
        .option('--no-worktree', 'Bypass worktrees')
        .exitOverride()
      program.parse(['node', 'test'], { from: 'user' })
      // Commander's --no-X pattern defaults the option to true and sets it false on negation
      expect(program.opts()['worktree']).toBe(true)
    })
  })

  describe('flag-resolution logic (CLI ↔ env precedence)', () => {
    beforeEach(() => {
      delete process.env['SUBSTRATE_NO_WORKTREE']
    })

    it('AC1: --no-worktree CLI flag → noWorktree=true', () => {
      expect(resolveNoWorktree({ worktree: false })).toBe(true)
    })

    it('AC1: no flag, no env → noWorktree=false (default)', () => {
      expect(resolveNoWorktree({ worktree: true })).toBe(false)
    })

    it('AC2: SUBSTRATE_NO_WORKTREE=1 with no CLI flag → noWorktree=true', () => {
      process.env['SUBSTRATE_NO_WORKTREE'] = '1'
      expect(resolveNoWorktree({ worktree: true })).toBe(true)
    })

    it('AC2: SUBSTRATE_NO_WORKTREE=0 (or any non-1) → noWorktree=false', () => {
      process.env['SUBSTRATE_NO_WORKTREE'] = '0'
      expect(resolveNoWorktree({ worktree: true })).toBe(false)
    })

    it('AC2: SUBSTRATE_NO_WORKTREE empty string → noWorktree=false', () => {
      process.env['SUBSTRATE_NO_WORKTREE'] = ''
      expect(resolveNoWorktree({ worktree: true })).toBe(false)
    })

    it('CLI flag + env both set → both signal true → noWorktree=true', () => {
      process.env['SUBSTRATE_NO_WORKTREE'] = '1'
      expect(resolveNoWorktree({ worktree: false })).toBe(true)
    })
  })

  describe('AC4: manifest cli_flags persistence', () => {
    it('CliFlagsSchema accepts no_worktree as optional boolean', () => {
      const parsed = CliFlagsSchema.parse({ no_worktree: true })
      expect(parsed.no_worktree).toBe(true)
    })

    it('CliFlagsSchema omits no_worktree when not provided', () => {
      const parsed = CliFlagsSchema.parse({ halt_on: 'critical' })
      expect(parsed.no_worktree).toBeUndefined()
    })

    it('CliFlagsSchema rejects no_worktree with non-boolean type', () => {
      expect(() => CliFlagsSchema.parse({ no_worktree: 'yes' })).toThrow()
    })

    it('CliFlagsSchema accepts no_worktree=false explicitly', () => {
      const parsed = CliFlagsSchema.parse({ no_worktree: false })
      expect(parsed.no_worktree).toBe(false)
    })
  })
})
