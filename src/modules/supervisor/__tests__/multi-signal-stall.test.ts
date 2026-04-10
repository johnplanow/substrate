import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  OutputGrowthTracker,
  CpuSampler,
  MultiSignalStallDetector,
  type CpuSamplerResult,
} from '../multi-signal-stall.js'

// ---------------------------------------------------------------------------
// OutputGrowthTracker
// ---------------------------------------------------------------------------

describe('OutputGrowthTracker', () => {
  let tracker: OutputGrowthTracker

  beforeEach(() => {
    tracker = new OutputGrowthTracker()
  })

  it('isStagnant returns false with fewer than minConsecutivePolls entries', () => {
    tracker.recordSnapshot('story-1', 100)
    // 1 snapshot < 2 required
    expect(tracker.isStagnant('story-1', 2)).toBe(false)
  })

  it('isStagnant returns false when bytes increase between polls', () => {
    tracker.recordSnapshot('story-1', 100)
    tracker.recordSnapshot('story-1', 200)
    expect(tracker.isStagnant('story-1', 2)).toBe(false)
  })

  it('isStagnant returns true when bytes are unchanged for exactly minConsecutivePolls', () => {
    tracker.recordSnapshot('story-1', 100)
    tracker.recordSnapshot('story-1', 100)
    expect(tracker.isStagnant('story-1', 2)).toBe(true)
  })

  it('isStagnant returns false when key has no history', () => {
    expect(tracker.isStagnant('unknown-story', 1)).toBe(false)
  })

  it('isStagnant uses only the last minConsecutivePolls snapshots', () => {
    // older snapshots are different, but last 2 are equal
    tracker.recordSnapshot('story-1', 50)
    tracker.recordSnapshot('story-1', 75)
    tracker.recordSnapshot('story-1', 100)
    tracker.recordSnapshot('story-1', 100)
    expect(tracker.isStagnant('story-1', 2)).toBe(true)
    // but not stagnant for 3 consecutive (75 ≠ 100)
    expect(tracker.isStagnant('story-1', 3)).toBe(false)
  })

  it('clear resets history; subsequent isStagnant returns false', () => {
    tracker.recordSnapshot('story-1', 100)
    tracker.recordSnapshot('story-1', 100)
    expect(tracker.isStagnant('story-1', 2)).toBe(true)
    tracker.clear('story-1')
    expect(tracker.isStagnant('story-1', 2)).toBe(false)
  })

  it('clearAll wipes all stories', () => {
    tracker.recordSnapshot('story-1', 100)
    tracker.recordSnapshot('story-1', 100)
    tracker.recordSnapshot('story-2', 200)
    tracker.recordSnapshot('story-2', 200)
    tracker.clearAll()
    expect(tracker.isStagnant('story-1', 2)).toBe(false)
    expect(tracker.isStagnant('story-2', 2)).toBe(false)
  })

  it('respects maxHistoryPerStory trim', () => {
    const small = new OutputGrowthTracker(3)
    // Add 5 snapshots — oldest 2 should be trimmed
    small.recordSnapshot('s', 10)
    small.recordSnapshot('s', 20)
    small.recordSnapshot('s', 30)
    small.recordSnapshot('s', 40)
    small.recordSnapshot('s', 40)
    // last 3 are [30, 40, 40] → not stagnant for 3 (30 ≠ 40)
    expect(small.isStagnant('s', 3)).toBe(false)
    // but stagnant for 2
    expect(small.isStagnant('s', 2)).toBe(true)
  })

  it('isStagnant requires minConsecutivePolls=3 when exactly 3 equal entries', () => {
    tracker.recordSnapshot('story-1', 100)
    tracker.recordSnapshot('story-1', 100)
    tracker.recordSnapshot('story-1', 100)
    expect(tracker.isStagnant('story-1', 3)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// CpuSampler
// ---------------------------------------------------------------------------

describe('CpuSampler', () => {
  describe('Linux path', () => {
    it('first sample: stores ticks, returns available:true cpuPercent:null', async () => {
      // /proc stat content: field 13=10, field 14=5 → ticks=15
      const statContent = '1234 (node) S 1 1 1 0 -1 0 0 0 0 0 10 5 0 0 20 0 1 0 0 0 0'
      const mockReadFile = vi.fn().mockResolvedValue(statContent)
      const sampler = new CpuSampler({ readFile: mockReadFile }, 'linux')

      const result = await sampler.sample(1234)
      expect(result).toEqual({ cpuPercent: null, available: true })
    })

    it('second sample, same ticks: returns cpuPercent:0, available:true', async () => {
      const statContent = '1234 (node) S 1 1 1 0 -1 0 0 0 0 0 10 5 0 0 20 0 1 0 0 0 0'
      const mockReadFile = vi.fn().mockResolvedValue(statContent)
      const sampler = new CpuSampler({ readFile: mockReadFile }, 'linux')

      await sampler.sample(1234) // first — stores ticks=15
      const result = await sampler.sample(1234) // second — same ticks
      expect(result).toEqual({ cpuPercent: 0, available: true })
    })

    it('second sample, increased ticks: returns cpuPercent:1, available:true', async () => {
      const statContent1 = '1234 (node) S 1 1 1 0 -1 0 0 0 0 0 10 5 0 0 20 0 1 0 0 0 0'
      const statContent2 = '1234 (node) S 1 1 1 0 -1 0 0 0 0 0 20 10 0 0 20 0 1 0 0 0 0'
      const mockReadFile = vi
        .fn()
        .mockResolvedValueOnce(statContent1)
        .mockResolvedValueOnce(statContent2)
      const sampler = new CpuSampler({ readFile: mockReadFile }, 'linux')

      await sampler.sample(1234) // first — ticks=15
      const result = await sampler.sample(1234) // second — ticks=30 → delta=15 > 0
      expect(result).toEqual({ cpuPercent: 1, available: true })
    })

    it('returns available:false when readFile throws EACCES', async () => {
      const mockReadFile = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
      const mockExecLine = vi.fn().mockRejectedValue(new Error('failed'))
      const sampler = new CpuSampler({ readFile: mockReadFile, execLine: mockExecLine }, 'linux')

      const result = await sampler.sample(9999)
      expect(result).toEqual({ cpuPercent: null, available: false })
    })
  })

  describe('macOS path', () => {
    it('execLine returns float string → parsed cpuPercent, available:true', async () => {
      const mockExecLine = vi.fn().mockResolvedValue('12.5\n')
      const sampler = new CpuSampler({ execLine: mockExecLine }, 'darwin')

      const result = await sampler.sample(5678)
      expect(result).toEqual({ cpuPercent: 12.5, available: true })
    })

    it('execLine returns 0.0 → cpuPercent:0, available:true', async () => {
      const mockExecLine = vi.fn().mockResolvedValue(' 0.0 ')
      const sampler = new CpuSampler({ execLine: mockExecLine }, 'darwin')

      const result = await sampler.sample(5678)
      expect(result).toEqual({ cpuPercent: 0, available: true })
    })

    it('execLine throws → available:false', async () => {
      const mockExecLine = vi.fn().mockRejectedValue(new Error('ps failed'))
      const sampler = new CpuSampler({ execLine: mockExecLine }, 'darwin')

      const result = await sampler.sample(5678)
      expect(result).toEqual({ cpuPercent: null, available: false })
    })

    it('execLine returns non-numeric → available:false', async () => {
      const mockExecLine = vi.fn().mockResolvedValue('error\n')
      const sampler = new CpuSampler({ execLine: mockExecLine }, 'darwin')

      const result = await sampler.sample(5678)
      expect(result).toEqual({ cpuPercent: null, available: false })
    })
  })

  describe('unavailable path (both readFile and execLine fail)', () => {
    it('returns cpuPercent:null, available:false without throwing', async () => {
      const mockReadFile = vi.fn().mockRejectedValue(new Error('ENOENT'))
      const mockExecLine = vi.fn().mockRejectedValue(new Error('ps error'))
      const sampler = new CpuSampler({ readFile: mockReadFile, execLine: mockExecLine }, 'linux')

      await expect(sampler.sample(1111)).resolves.toEqual({ cpuPercent: null, available: false })
    })
  })
})

// ---------------------------------------------------------------------------
// MultiSignalStallDetector
// ---------------------------------------------------------------------------

describe('MultiSignalStallDetector', () => {
  let detector: MultiSignalStallDetector
  let logWarning: ReturnType<typeof vi.fn>
  const cpuAvailable: CpuSamplerResult = { cpuPercent: 50, available: true }
  const cpuUnavailable: CpuSamplerResult = { cpuPercent: null, available: false }
  const cpuZero: CpuSamplerResult = { cpuPercent: 0, available: true }

  beforeEach(() => {
    detector = new MultiSignalStallDetector()
    logWarning = vi.fn()
  })

  it('AC1: timer exceeded + output growing → isStall:false, suppressedBySingleSignal:true', () => {
    const result = detector.evaluate(
      {
        stallTimerExceeded: true,
        outputStagnant2: false,
        outputStagnant3: false,
        cpuResult: cpuAvailable,
        processAlive: true,
      },
      logWarning
    )
    expect(result.isStall).toBe(false)
    expect(result.isZombie).toBe(false)
    expect(result.suppressedBySingleSignal).toBe(true)
    expect(logWarning).not.toHaveBeenCalled()
  })

  it('AC2: timer exceeded + output stagnant 2 polls + CPU available → isStall:true', () => {
    const result = detector.evaluate(
      {
        stallTimerExceeded: true,
        outputStagnant2: true,
        outputStagnant3: true,
        cpuResult: cpuAvailable,
        processAlive: true,
      },
      logWarning
    )
    expect(result.isStall).toBe(true)
    expect(result.suppressedBySingleSignal).toBe(false)
  })

  it('AC3: CPU unavailable + output stagnant 2 polls → isStall:true, warning logged', () => {
    const result = detector.evaluate(
      {
        stallTimerExceeded: true,
        outputStagnant2: true,
        outputStagnant3: false,
        cpuResult: cpuUnavailable,
        processAlive: true,
      },
      logWarning
    )
    expect(result.isStall).toBe(true)
    expect(logWarning).toHaveBeenCalledWith(
      'CPU sampling unavailable — using output growth as second stall signal'
    )
  })

  it('AC3: CPU unavailable + output growing + process alive → isStall:false, suppressedBySingleSignal:true', () => {
    const result = detector.evaluate(
      {
        stallTimerExceeded: true,
        outputStagnant2: false,
        outputStagnant3: false,
        cpuResult: cpuUnavailable,
        processAlive: true,
      },
      logWarning
    )
    expect(result.isStall).toBe(false)
    expect(result.suppressedBySingleSignal).toBe(true)
    expect(logWarning).toHaveBeenCalled()
  })

  it('AC3: CPU unavailable + output growing + process dead → isStall:false, suppressedBySingleSignal:true (spec: outputStagnant2 is the sole second signal when CPU unavailable)', () => {
    const result = detector.evaluate(
      {
        stallTimerExceeded: true,
        outputStagnant2: false,
        outputStagnant3: false,
        cpuResult: cpuUnavailable,
        processAlive: false,
      },
      logWarning
    )
    expect(result.isStall).toBe(false)
    expect(result.suppressedBySingleSignal).toBe(true)
    expect(logWarning).toHaveBeenCalled()
  })

  it('AC4: zombie — processAlive + CPU=0 + output stagnant 3 polls + timer NOT exceeded → isZombie:true, isStall:false', () => {
    const result = detector.evaluate(
      {
        stallTimerExceeded: false,
        outputStagnant2: true,
        outputStagnant3: true,
        cpuResult: cpuZero,
        processAlive: true,
      },
      logWarning
    )
    expect(result.isZombie).toBe(true)
    expect(result.isStall).toBe(false)
    expect(result.suppressedBySingleSignal).toBe(false)
  })

  it('no zombie when CPU sampling unavailable (cannot confirm CPU=0)', () => {
    const result = detector.evaluate(
      {
        stallTimerExceeded: false,
        outputStagnant2: true,
        outputStagnant3: true,
        cpuResult: cpuUnavailable,
        processAlive: true,
      },
      logWarning
    )
    expect(result.isZombie).toBe(false)
    expect(result.isStall).toBe(false)
  })

  it('no zombie when process is not alive (cannot confirm alive condition)', () => {
    const result = detector.evaluate(
      {
        stallTimerExceeded: false,
        outputStagnant2: true,
        outputStagnant3: true,
        cpuResult: cpuZero,
        processAlive: false,
      },
      logWarning
    )
    expect(result.isZombie).toBe(false)
  })

  it('no zombie when output is not stagnant for 3 polls', () => {
    const result = detector.evaluate(
      {
        stallTimerExceeded: false,
        outputStagnant2: true,
        outputStagnant3: false,
        cpuResult: cpuZero,
        processAlive: true,
      },
      logWarning
    )
    expect(result.isZombie).toBe(false)
  })

  it('timer not exceeded + no zombie → no stall (reason: no stall)', () => {
    const result = detector.evaluate(
      {
        stallTimerExceeded: false,
        outputStagnant2: false,
        outputStagnant3: false,
        cpuResult: cpuAvailable,
        processAlive: true,
      },
      logWarning
    )
    expect(result.isStall).toBe(false)
    expect(result.isZombie).toBe(false)
    expect(result.suppressedBySingleSignal).toBe(false)
    expect(result.reason).toBe('no stall')
  })

  it('stall when timer exceeded + process dead (CPU available)', () => {
    const result = detector.evaluate(
      {
        stallTimerExceeded: true,
        outputStagnant2: false,
        outputStagnant3: false,
        cpuResult: cpuAvailable,
        processAlive: false,
      },
      logWarning
    )
    expect(result.isStall).toBe(true)
  })

  it('stall when timer exceeded + CPU=0 (even without output stagnation)', () => {
    const result = detector.evaluate(
      {
        stallTimerExceeded: true,
        outputStagnant2: false,
        outputStagnant3: false,
        cpuResult: cpuZero,
        processAlive: true,
      },
      logWarning
    )
    expect(result.isStall).toBe(true)
  })

  it('reason string includes cpu and outputStagnant for stall', () => {
    const result = detector.evaluate(
      {
        stallTimerExceeded: true,
        outputStagnant2: true,
        outputStagnant3: false,
        cpuResult: cpuAvailable,
        processAlive: true,
      },
      logWarning
    )
    expect(result.reason).toContain('stall:')
    expect(result.reason).toContain('cpu=')
    expect(result.reason).toContain('outputStagnant=')
  })

  it('reason string is "zombie: ..." for zombie verdict', () => {
    const result = detector.evaluate(
      {
        stallTimerExceeded: false,
        outputStagnant2: true,
        outputStagnant3: true,
        cpuResult: cpuZero,
        processAlive: true,
      },
      logWarning
    )
    expect(result.reason).toContain('zombie:')
  })
})
