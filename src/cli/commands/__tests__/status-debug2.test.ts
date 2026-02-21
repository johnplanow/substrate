import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockOpen = vi.fn()

vi.mock('../../../persistence/database.js', () => ({
  DatabaseWrapper: vi.fn().mockImplementation(() => ({
    open: mockOpen,
  })),
}))

import { DatabaseWrapper } from '../../../persistence/database.js'

describe('debug restore', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })
  
  it('test 1 - should work', () => {
    const w = new DatabaseWrapper('/path')
    expect(w.open).toBe(mockOpen)
  })
  
  it('test 2 - after restoreAllMocks', () => {
    const w = new DatabaseWrapper('/path')
    console.log('DatabaseWrapper constructor:', DatabaseWrapper)
    console.log('Instance:', w)
    console.log('open:', w.open)
    expect(w.open).toBe(mockOpen)
  })
})
