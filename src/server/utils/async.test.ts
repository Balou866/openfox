import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EventEmitter,
  createDeferred,
  sleep,
  withRetry,
  computeExponentialBackoff,
  computeRetryDelay,
  parseRetryAfter,
} from './async.js'

describe('async utilities', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sleeps and resolves deferred promises', async () => {
    const sleeper = sleep(50)
    vi.advanceTimersByTime(50)
    await expect(sleeper).resolves.toBeUndefined()

    const deferred = createDeferred<string>()
    deferred.resolve('done')
    await expect(deferred.promise).resolves.toBe('done')
  })

  it('retries operations with backoff and stops when shouldRetry says no', async () => {
    let attempts = 0
    const successPromise = withRetry(
      async () => {
        attempts++
        if (attempts < 3) {
          throw new Error(`fail-${attempts}`)
        }
        return 'ok'
      },
      { maxRetries: 3, backoffMs: [10, 20] },
    )

    await vi.runAllTimersAsync()
    await expect(successPromise).resolves.toBe('ok')
    expect(attempts).toBe(3)

    const stopEarly = withRetry(
      async () => {
        throw new Error('fatal')
      },
      {
        maxRetries: 3,
        backoffMs: [10],
        shouldRetry: () => false,
      },
    )

    await expect(stopEarly).rejects.toThrow('fatal')
  })

  it('rethrows the last error after exhausting retries and supports event subscriptions', async () => {
    const failed = withRetry(
      async () => {
        throw new Error('still failing')
      },
      { maxRetries: 2, backoffMs: [5] },
    )
    const failedAssertion = expect(failed).rejects.toThrow('still failing')

    await vi.runAllTimersAsync()
    await failedAssertion

    const emitter = new EventEmitter<{ event: [string]; other: [number] }>()
    const events: string[] = []
    const unsubscribe = emitter.on('event', (value) => {
      events.push(value)
    })
    emitter.emit('event', 'first')
    unsubscribe()
    emitter.emit('event', 'second')
    emitter.on('other', () => {})
    emitter.removeAllListeners()
    emitter.emit('event', 'third')

    expect(events).toEqual(['first'])
  })
})

describe('computeExponentialBackoff', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('grows exponentially with the attempt number', () => {
    expect(computeExponentialBackoff(0, 2000, 32_000, 0)).toBe(2000)
    expect(computeExponentialBackoff(1, 2000, 32_000, 0)).toBe(4000)
    expect(computeExponentialBackoff(2, 2000, 32_000, 0)).toBe(8000)
    expect(computeExponentialBackoff(3, 2000, 32_000, 0)).toBe(16_000)
    expect(computeExponentialBackoff(4, 2000, 32_000, 0)).toBe(32_000)
  })

  it('enforces the cap', () => {
    expect(computeExponentialBackoff(10, 2000, 32_000, 0)).toBe(32_000)
  })

  it('adds jitter within bounds', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1)
    const withJitter = computeExponentialBackoff(0, 2000, 32_000, 500)
    expect(withJitter).toBe(2500)
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const withoutJitter = computeExponentialBackoff(0, 2000, 32_000, 500)
    expect(withoutJitter).toBe(2000)
  })
})

describe('parseRetryAfter', () => {
  it('parses numeric seconds', () => {
    expect(parseRetryAfter('5')).toBe(5000)
    expect(parseRetryAfter('0')).toBe(0)
  })

  it('parses HTTP-date format', () => {
    const now = Date.parse('2026-01-01T00:00:00Z')
    const future = 'Wed, 01 Jan 2026 00:00:10 GMT'
    expect(parseRetryAfter(future, now)).toBe(10_000)
  })

  it('clamps negative HTTP-date diff to zero', () => {
    const now = Date.parse('2026-01-01T00:00:10Z')
    const past = 'Wed, 01 Jan 2026 00:00:00 GMT'
    expect(parseRetryAfter(past, now)).toBe(0)
  })

  it('returns null for missing or invalid values', () => {
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter(undefined)).toBeNull()
    expect(parseRetryAfter('')).toBeNull()
    expect(parseRetryAfter('   ')).toBeNull()
  })
})

describe('computeRetryDelay', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prefers Retry-After when provided', () => {
    const result = computeRetryDelay(0, { maxRetries: 5, initialBackoffMs: 2000 }, 12_000)
    expect(result).toEqual({ delayMs: 12_000, reason: 'retry-after' })
  })

  it('clamps Retry-After to the cap', () => {
    const result = computeRetryDelay(0, { maxRetries: 5, initialBackoffMs: 2000, capMs: 32_000 }, 60_000)
    expect(result).toEqual({ delayMs: 32_000, reason: 'retry-after' })
  })

  it('uses backoff when Retry-After is null', () => {
    const result = computeRetryDelay(2, { maxRetries: 5, initialBackoffMs: 2000 }, null)
    expect(result).toEqual({ delayMs: 8000, reason: 'backoff' })
  })

  it('uses backoff when Retry-After is undefined', () => {
    const result = computeRetryDelay(3, { maxRetries: 5, initialBackoffMs: 1000 })
    expect(result).toEqual({ delayMs: 8000, reason: 'backoff' })
  })
})
