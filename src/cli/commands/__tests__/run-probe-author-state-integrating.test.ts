/**
 * Unit tests for the `resolveProbeAuthorStateIntegrating` helper — Story 65-2.
 *
 * Covers:
 *  1. CLI `on` + env `off` → resolves `true` (CLI wins)
 *  2. CLI `off` + env `on` → resolves `false` (CLI wins)
 *  3. CLI absent, env `off` → resolves `false`
 *  4. CLI absent, env `on` → resolves `true`
 *  5. CLI absent, env absent → resolves `true` (default)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolveProbeAuthorStateIntegrating } from '../run.js'

const ENV_KEY = 'SUBSTRATE_PROBE_AUTHOR_STATE_INTEGRATING'

describe('resolveProbeAuthorStateIntegrating — flag/env-var resolution semantics', () => {
  let originalEnvValue: string | undefined

  beforeEach(() => {
    originalEnvValue = process.env[ENV_KEY]
    delete process.env[ENV_KEY]
  })

  afterEach(() => {
    if (originalEnvValue === undefined) {
      delete process.env[ENV_KEY]
    } else {
      process.env[ENV_KEY] = originalEnvValue
    }
  })

  it('CLI on + env off → resolves true (CLI wins)', () => {
    process.env[ENV_KEY] = 'off'
    expect(resolveProbeAuthorStateIntegrating('on')).toBe(true)
  })

  it('CLI off + env on → resolves false (CLI wins)', () => {
    process.env[ENV_KEY] = 'on'
    expect(resolveProbeAuthorStateIntegrating('off')).toBe(false)
  })

  it('CLI absent, env off → resolves false', () => {
    process.env[ENV_KEY] = 'off'
    expect(resolveProbeAuthorStateIntegrating(undefined)).toBe(false)
  })

  it('CLI absent, env on → resolves true', () => {
    process.env[ENV_KEY] = 'on'
    expect(resolveProbeAuthorStateIntegrating(undefined)).toBe(true)
  })

  it('CLI absent, env absent → resolves true (default)', () => {
    // ENV_KEY already deleted in beforeEach
    expect(resolveProbeAuthorStateIntegrating(undefined)).toBe(true)
  })
})
