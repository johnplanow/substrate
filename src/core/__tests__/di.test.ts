/**
 * Unit tests for the ServiceRegistry DI container.
 *
 * Covers:
 *  - register/get/has lifecycle
 *  - initializeAll in registration order
 *  - shutdownAll in reverse registration order
 *  - Error collection during shutdown
 *  - Duplicate registration error
 *  - Get unknown service error
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ServiceRegistry } from '../di.js'
import type { BaseService } from '../di.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService(name: string): BaseService & { name: string } {
  return {
    name,
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
}

// ---------------------------------------------------------------------------
// ServiceRegistry tests
// ---------------------------------------------------------------------------

describe('ServiceRegistry', () => {
  let registry: ServiceRegistry

  beforeEach(() => {
    registry = new ServiceRegistry()
  })

  // -------------------------------------------------------------------------
  // register / get / has
  // -------------------------------------------------------------------------

  it('registers and retrieves a service by name', () => {
    const svc = makeService('db')
    registry.register('db', svc)
    expect(registry.get('db')).toBe(svc)
  })

  it('has() returns true for a registered service', () => {
    const svc = makeService('cache')
    registry.register('cache', svc)
    expect(registry.has('cache')).toBe(true)
  })

  it('has() returns false for an unregistered service', () => {
    expect(registry.has('nonexistent')).toBe(false)
  })

  it('get() throws when service is not registered', () => {
    expect(() => registry.get('missing')).toThrow('Service "missing" is not registered')
  })

  it('register() throws on duplicate service name', () => {
    registry.register('db', makeService('db'))
    expect(() => registry.register('db', makeService('db2'))).toThrow(
      'Service "db" is already registered'
    )
  })

  // -------------------------------------------------------------------------
  // serviceNames
  // -------------------------------------------------------------------------

  it('serviceNames returns names in registration order', () => {
    registry.register('a', makeService('a'))
    registry.register('b', makeService('b'))
    registry.register('c', makeService('c'))
    expect(registry.serviceNames).toEqual(['a', 'b', 'c'])
  })

  it('serviceNames returns empty array when nothing registered', () => {
    expect(registry.serviceNames).toEqual([])
  })

  // -------------------------------------------------------------------------
  // initializeAll
  // -------------------------------------------------------------------------

  it('initializeAll calls initialize() on all services in order', async () => {
    const order: string[] = []
    const svcA = makeService('a')
    ;(svcA.initialize as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('a')
    })
    const svcB = makeService('b')
    ;(svcB.initialize as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('b')
    })

    registry.register('a', svcA)
    registry.register('b', svcB)

    await registry.initializeAll()

    expect(order).toEqual(['a', 'b'])
    expect(svcA.initialize).toHaveBeenCalledOnce()
    expect(svcB.initialize).toHaveBeenCalledOnce()
  })

  it('initializeAll with empty registry resolves without error', async () => {
    await expect(registry.initializeAll()).resolves.not.toThrow()
  })

  // -------------------------------------------------------------------------
  // shutdownAll
  // -------------------------------------------------------------------------

  it('shutdownAll calls shutdown() on all services in reverse order', async () => {
    const order: string[] = []
    const svcA = makeService('a')
    ;(svcA.shutdown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('a')
    })
    const svcB = makeService('b')
    ;(svcB.shutdown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('b')
    })
    const svcC = makeService('c')
    ;(svcC.shutdown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('c')
    })

    registry.register('a', svcA)
    registry.register('b', svcB)
    registry.register('c', svcC)

    await registry.shutdownAll()

    expect(order).toEqual(['c', 'b', 'a'])
  })

  it('shutdownAll with empty registry resolves without error', async () => {
    await expect(registry.shutdownAll()).resolves.not.toThrow()
  })

  it('shutdownAll collects errors and throws AggregateError after all services shut down', async () => {
    const svcA = makeService('a')
    ;(svcA.shutdown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('shutdown error A')
    )
    const svcB = makeService('b')
    ;(svcB.shutdown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    const svcC = makeService('c')
    ;(svcC.shutdown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('shutdown error C')
    )

    registry.register('a', svcA)
    registry.register('b', svcB)
    registry.register('c', svcC)

    // Despite errors in A and C, B should still be called
    await expect(registry.shutdownAll()).rejects.toThrow(AggregateError)

    // All three were called (including the ones that errored)
    expect(svcA.shutdown).toHaveBeenCalledOnce()
    expect(svcB.shutdown).toHaveBeenCalledOnce()
    expect(svcC.shutdown).toHaveBeenCalledOnce()
  })

  it('shutdownAll AggregateError contains all failure errors', async () => {
    const errA = new Error('error in A')
    const svcA = makeService('a')
    ;(svcA.shutdown as ReturnType<typeof vi.fn>).mockRejectedValue(errA)
    const svcB = makeService('b')

    registry.register('a', svcA)
    registry.register('b', svcB)

    let thrownError: unknown
    try {
      await registry.shutdownAll()
    } catch (err) {
      thrownError = err
    }

    expect(thrownError).toBeInstanceOf(AggregateError)
    const ae = thrownError as AggregateError
    expect(ae.errors).toHaveLength(1)
    expect(ae.errors[0]).toBe(errA)
  })

  it('shutdownAll wraps non-Error throws in an Error object', async () => {
    const svc = makeService('a')
    ;(svc.shutdown as ReturnType<typeof vi.fn>).mockRejectedValue('string error')
    registry.register('a', svc)

    let thrownError: unknown
    try {
      await registry.shutdownAll()
    } catch (err) {
      thrownError = err
    }

    expect(thrownError).toBeInstanceOf(AggregateError)
    const ae = thrownError as AggregateError
    expect(ae.errors[0]).toBeInstanceOf(Error)
    expect((ae.errors[0] as Error).message).toBe('string error')
  })
})
