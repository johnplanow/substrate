import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { swallowDebug } from '../debug-swallow.js'

describe('swallowDebug', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let stderrCaptured: string

  beforeEach(() => {
    stderrCaptured = ''
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
      stderrCaptured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8')
      return true
    })
    delete process.env['SUBSTRATE_DEBUG']
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    delete process.env['SUBSTRATE_DEBUG']
  })

  it('silently swallows when SUBSTRATE_DEBUG is unset', async () => {
    const handler = swallowDebug('advisory')
    await Promise.reject(new Error('boom')).catch(handler)
    expect(stderrCaptured).toBe('')
  })

  it('silently swallows when SUBSTRATE_DEBUG is empty string', async () => {
    process.env['SUBSTRATE_DEBUG'] = ''
    const handler = swallowDebug('advisory')
    await Promise.reject(new Error('boom')).catch(handler)
    expect(stderrCaptured).toBe('')
  })

  it('silently swallows when SUBSTRATE_DEBUG names a different label', async () => {
    process.env['SUBSTRATE_DEBUG'] = 'mesh'
    const handler = swallowDebug('advisory')
    await Promise.reject(new Error('boom')).catch(handler)
    expect(stderrCaptured).toBe('')
  })

  it('writes to stderr when SUBSTRATE_DEBUG matches the label exactly', async () => {
    process.env['SUBSTRATE_DEBUG'] = 'advisory'
    const handler = swallowDebug('advisory')
    await Promise.reject(new Error('boom')).catch(handler)
    expect(stderrCaptured).toContain('[debug:advisory] swallowed:')
    expect(stderrCaptured).toContain('Error: boom')
  })

  it("writes to stderr when SUBSTRATE_DEBUG is '*' (enable all)", async () => {
    process.env['SUBSTRATE_DEBUG'] = '*'
    const handler = swallowDebug('advisory')
    await Promise.reject(new Error('boom')).catch(handler)
    expect(stderrCaptured).toContain('[debug:advisory]')
    expect(stderrCaptured).toContain('Error: boom')
  })

  it('matches one label out of a comma-separated list', async () => {
    process.env['SUBSTRATE_DEBUG'] = 'mesh, advisory, dolt'
    const handler = swallowDebug('advisory')
    await Promise.reject(new Error('boom')).catch(handler)
    expect(stderrCaptured).toContain('[debug:advisory]')
  })

  it('handles non-Error rejection values (string, number)', async () => {
    process.env['SUBSTRATE_DEBUG'] = 'foo'
    const handler = swallowDebug('foo')
    await Promise.reject('plain string').catch(handler)
    await Promise.reject(42).catch(handler)
    expect(stderrCaptured).toContain('[debug:foo] swallowed: plain string')
    expect(stderrCaptured).toContain('[debug:foo] swallowed: 42')
  })

  it('includes stack when error has one', async () => {
    process.env['SUBSTRATE_DEBUG'] = '*'
    const handler = swallowDebug('any')
    const err = new Error('with-stack')
    await Promise.reject(err).catch(handler)
    expect(stderrCaptured).toContain('with-stack')
    expect(stderrCaptured).toMatch(/at\s+/) // stack frame indicator
  })
})
