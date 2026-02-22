/**
 * Unit tests for UpdateChecker.
 *
 * Mocks the built-in `https` module to avoid real network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { UpdateChecker, UpdateCheckError } from '../update-checker.js'

// ---------------------------------------------------------------------------
// Helpers to build mock IncomingMessage-like objects
// ---------------------------------------------------------------------------

function buildMockResponse(statusCode: number, body: string) {
  const res = new EventEmitter() as EventEmitter & {
    statusCode: number
    headers: Record<string, string>
    resume: () => void
  }
  res.statusCode = statusCode
  res.headers = {}
  res.resume = vi.fn()

  // Emit data and end asynchronously
  setImmediate(() => {
    res.emit('data', Buffer.from(body))
    res.emit('end')
  })

  return res
}

function buildMockRequest() {
  const req = new EventEmitter() as EventEmitter & { destroy: () => void }
  req.destroy = vi.fn()
  return req
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UpdateChecker', () => {
  let checker: UpdateChecker

  beforeEach(() => {
    checker = new UpdateChecker(5000)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // fetchLatestVersion
  // -------------------------------------------------------------------------

  describe('fetchLatestVersion', () => {
    it('returns version string on successful 200 response', async () => {
      const { default: https } = await import('https')
      const mockRes = buildMockResponse(200, JSON.stringify({ version: '1.2.3' }))
      const mockReq = buildMockRequest()
      vi.spyOn(https, 'get').mockImplementation((_url, callback) => {
        if (typeof callback === 'function') {
          callback(mockRes as Parameters<typeof callback>[0])
        }
        return mockReq as ReturnType<typeof https.get>
      })

      const version = await checker.fetchLatestVersion('substrate')
      expect(version).toBe('1.2.3')
    })

    it('throws UpdateCheckError on non-200 HTTP response', async () => {
      const { default: https } = await import('https')
      vi.spyOn(https, 'get').mockImplementation((_url, callback) => {
        if (typeof callback === 'function') {
          const mockRes = buildMockResponse(404, 'Not Found')
          callback(mockRes as Parameters<typeof callback>[0])
        }
        return buildMockRequest() as ReturnType<typeof https.get>
      })

      await expect(checker.fetchLatestVersion('substrate')).rejects.toThrow(UpdateCheckError)
    })

    it('throws UpdateCheckError on network error', async () => {
      const { default: https } = await import('https')

      vi.spyOn(https, 'get').mockImplementation((_url, _callback) => {
        const mockReq = new EventEmitter() as EventEmitter & { destroy: () => void }
        mockReq.destroy = vi.fn()
        setImmediate(() => {
          mockReq.emit('error', new Error('ECONNREFUSED'))
        })
        return mockReq as ReturnType<typeof https.get>
      })

      await expect(checker.fetchLatestVersion('substrate')).rejects.toThrow(UpdateCheckError)
    })

    it('throws UpdateCheckError when response has no version field', async () => {
      const { default: https } = await import('https')
      vi.spyOn(https, 'get').mockImplementation((_url, callback) => {
        if (typeof callback === 'function') {
          const mockRes = buildMockResponse(200, JSON.stringify({ name: 'substrate' }))
          callback(mockRes as Parameters<typeof callback>[0])
        }
        return buildMockRequest() as ReturnType<typeof https.get>
      })

      await expect(checker.fetchLatestVersion('substrate')).rejects.toThrow(/missing version/i)
    })

    it('throws UpdateCheckError on network timeout', async () => {
      // Use a very short timeout to trigger
      const shortChecker = new UpdateChecker(1)
      const { default: https } = await import('https')
      const mockReq = buildMockRequest()

      vi.spyOn(https, 'get').mockImplementation((_url, _callback) => {
        // Never respond — let timeout fire
        return mockReq as ReturnType<typeof https.get>
      })

      await expect(shortChecker.fetchLatestVersion('substrate')).rejects.toThrow(UpdateCheckError)
      await expect(shortChecker.fetchLatestVersion('substrate')).rejects.toThrow(/timed out/i)
    }, 3000)
  })

  // -------------------------------------------------------------------------
  // isBreaking
  // -------------------------------------------------------------------------

  describe('isBreaking', () => {
    it('returns true when major version increases (1.0.0 → 2.0.0)', () => {
      expect(checker.isBreaking('1.0.0', '2.0.0')).toBe(true)
    })

    it('returns false for minor version bump (1.0.0 → 1.1.0)', () => {
      expect(checker.isBreaking('1.0.0', '1.1.0')).toBe(false)
    })

    it('returns false for patch version bump (1.0.0 → 1.0.1)', () => {
      expect(checker.isBreaking('1.0.0', '1.0.1')).toBe(false)
    })

    it('returns false for invalid semver strings', () => {
      expect(checker.isBreaking('not-semver', '2.0.0')).toBe(false)
      expect(checker.isBreaking('1.0.0', 'also-not-semver')).toBe(false)
      expect(checker.isBreaking('bad', 'bad')).toBe(false)
    })

    it('returns false when versions are equal', () => {
      expect(checker.isBreaking('1.0.0', '1.0.0')).toBe(false)
    })

    it('returns true for multi-major bump (1.0.0 → 3.0.0)', () => {
      expect(checker.isBreaking('1.0.0', '3.0.0')).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // getChangelog
  // -------------------------------------------------------------------------

  describe('getChangelog', () => {
    it('returns a URL referencing the given version', () => {
      const url = checker.getChangelog('1.2.3')
      expect(url).toContain('v1.2.3')
      expect(url).toContain('https://')
    })
  })
})
