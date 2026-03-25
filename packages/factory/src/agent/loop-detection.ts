// packages/factory/src/agent/loop-detection.ts
// LoopDetector: tracks tool call signatures via rolling window and detects repeating patterns.
// Story 48-8: Loop Detection and Steering Injection

import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// LoopDetectionConfig
// ---------------------------------------------------------------------------

export interface LoopDetectionConfig {
  windowSize: number
  enabled: boolean
}

// ---------------------------------------------------------------------------
// LoopDetector
// ---------------------------------------------------------------------------

export class LoopDetector {
  private readonly _config: LoopDetectionConfig
  private readonly _window: string[] = []

  constructor(config: LoopDetectionConfig) {
    this._config = config
  }

  /**
   * Record a tool call and check for a repeating pattern.
   * Returns true if a loop is detected (window is full and a repeating pattern found).
   * Returns false if detection is disabled, window is not yet full, or no pattern is found.
   */
  record(toolName: string, toolArgs: Record<string, unknown>): boolean {
    if (!this._config.enabled) return false

    const sig = createHash('sha256')
      .update(`${toolName}:${JSON.stringify(toolArgs)}`)
      .digest('hex')

    this._window.push(sig)
    if (this._window.length > this._config.windowSize) {
      this._window.shift()
    }

    if (this._window.length < this._config.windowSize) return false
    return this._detectPattern()
  }

  /**
   * Check whether the current window contains a repeating pattern of length 1, 2, or 3.
   * Pattern length N is only checked if windowSize % N === 0.
   */
  private _detectPattern(): boolean {
    const w = this._window
    const n = this._config.windowSize

    for (const patternLen of [1, 2, 3]) {
      if (n % patternLen !== 0) continue

      const pattern = w.slice(0, patternLen)
      let allMatch = true

      for (let i = patternLen; i < n; i += patternLen) {
        for (let j = 0; j < patternLen; j++) {
          if (w[i + j] !== pattern[j]) {
            allMatch = false
            break
          }
        }
        if (!allMatch) break
      }

      if (allMatch) return true
    }

    return false
  }
}
