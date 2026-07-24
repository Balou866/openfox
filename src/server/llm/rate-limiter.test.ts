import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRateLimiter } from './rate-limiter.js'

describe('createRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('passes through immediately when under the limit', async () => {
    const limiter = createRateLimiter({ enabled: true, rpm: 40 })
    const result = await limiter.acquire()
    expect(result.waitedMs).toBe(0)
    expect(result.currentRpm).toBe(1)
  })

  it('passes through when disabled', async () => {
    const limiter = createRateLimiter({ enabled: false, rpm: 40 })
    const result = await limiter.acquire()
    expect(result.waitedMs).toBe(0)
    expect(result.currentRpm).toBe(0)
  })

  it('blocks at limit then releases after window expires', async () => {
    const limiter = createRateLimiter({ enabled: true, rpm: 2 })
    await limiter.acquire()
    await limiter.acquire()
    expect(limiter.getCurrentRpm()).toBe(2)

    const acquirePromise = limiter.acquire()
    const resolved = vi.fn()
    acquirePromise.then(resolved)
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(60_001)
    await acquirePromise
    expect(resolved).toHaveBeenCalled()
  })

  it('expires old timestamps from the sliding window', async () => {
    const limiter = createRateLimiter({ enabled: true, rpm: 40 })
    await limiter.acquire()
    vi.advanceTimersByTime(30_000)
    await limiter.acquire()
    expect(limiter.getCurrentRpm()).toBe(2)
    vi.advanceTimersByTime(31_000)
    expect(limiter.getCurrentRpm()).toBe(1)
    vi.advanceTimersByTime(30_000)
    expect(limiter.getCurrentRpm()).toBe(0)
  })

  it('handles concurrent acquire calls without exceeding the limit', async () => {
    const limiter = createRateLimiter({ enabled: true, rpm: 3 })
    const results: number[] = []
    const tasks = Array.from({ length: 5 }, () => limiter.acquire().then((r) => results.push(r.currentRpm)))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(60_001)
    await Promise.all(tasks)
    const maxObserved = Math.max(...results)
    expect(maxObserved).toBeLessThanOrEqual(3)
  })

  it('exposes config', () => {
    const limiter = createRateLimiter({ enabled: true, rpm: 40 })
    expect(limiter.getConfig()).toEqual({ enabled: true, rpm: 40 })
  })
})
