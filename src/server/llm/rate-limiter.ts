import { logger } from '../utils/logger.js'

export interface RateLimiterConfig {
  enabled: boolean
  rpm: number
}

export interface AcquireResult {
  waitedMs: number
  currentRpm: number
}

export interface RateLimiter {
  acquire(): Promise<AcquireResult>
  getCurrentRpm(): number
  getConfig(): RateLimiterConfig
}

const WINDOW_MS = 60_000

export function createRateLimiter(config: RateLimiterConfig): RateLimiter {
  const rpm = Math.max(1, Math.floor(config.rpm))
  const enabled = config.enabled
  const timestamps: number[] = []

  function prune(now: number): void {
    const cutoff = now - WINDOW_MS
    while (timestamps.length > 0 && timestamps[0]! <= cutoff) {
      timestamps.shift()
    }
  }

  function getCurrentRpm(): number {
    prune(Date.now())
    return timestamps.length
  }

  async function acquire(): Promise<AcquireResult> {
    if (!enabled) {
      return { waitedMs: 0, currentRpm: 0 }
    }

    const start = Date.now()
    let currentRpm = getCurrentRpm()

    while (currentRpm >= rpm) {
      const oldest = timestamps[0]
      if (oldest === undefined) break
      const releaseAt = oldest + WINDOW_MS
      const waitMs = Math.max(0, releaseAt - Date.now())
      if (waitMs > 0) {
        logger.debug('Rate limiter waiting for slot', { currentRpm, maxRpm: rpm, waitMs })
        await sleep(waitMs)
      }
      currentRpm = getCurrentRpm()
    }

    const waitedMs = Date.now() - start
    timestamps.push(Date.now())
    return { waitedMs, currentRpm: timestamps.length }
  }

  return {
    acquire,
    getCurrentRpm,
    getConfig: () => ({ enabled, rpm }),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
