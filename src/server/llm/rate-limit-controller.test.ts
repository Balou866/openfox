import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createRateLimiter } from './rate-limiter.js'
import { runWithRateLimit } from './rate-limit-controller.js'
import { RateLimitError } from '../utils/errors.js'

describe('rate-limit-controller integration', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  it('retries on RateLimitError then succeeds, invoking callbacks', async () => {
    const { result, calls, retry, waiting } = await runLimitFailOnce({
      callbacks: true,
      initialBackoffMs: 100,
    })

    expect(result).toBe('ok')
    expect(calls).toBe(2)
    expect(retry!).toHaveBeenCalledTimes(1)
    expect(retry!).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, maxAttempts: 5, reason: 'retry-after' }))
    expect(waiting).not.toHaveBeenCalled()
  })

  it('uses backoff when no Retry-After is set', async () => {
    const rateLimiter = createRateLimiter({ enabled: false, rpm: 0 })

    let calls = 0
    const operation = async (): Promise<string> => {
      calls++
      if (calls <= 2) {
        throw new RateLimitError('slow down', 429)
      }
      return 'ok'
    }

    vi.useFakeTimers()
    const promise = runWithRateLimit(operation, {
      rateLimiter,
      retryOptions: { maxRetries: 5, initialBackoffMs: 200, retryOn429: true },
    })
    await vi.advanceTimersByTimeAsync(200 + 400)
    const result = await promise
    vi.useRealTimers()

    expect(result).toBe('ok')
    expect(calls).toBe(3)
  })

  it('throws after exhausting retries', async () => {
    const rateLimiter = createRateLimiter({ enabled: false, rpm: 0 })

    const operation = async (): Promise<string> => {
      throw new RateLimitError('still slow', 429, 0)
    }

    vi.useFakeTimers()
    const promise = runWithRateLimit(operation, {
      rateLimiter,
      retryOptions: { maxRetries: 2, initialBackoffMs: 10, retryOn429: true },
    })
    // Attach rejection handler immediately to avoid unhandled rejection
    const assertion = expect(promise).rejects.toBeInstanceOf(RateLimitError)
    await vi.advanceTimersByTimeAsync(10 + 20)
    await assertion
    vi.useRealTimers()
  })

  it('does not retry non-rate-limit errors', async () => {
    await expectRunWithLimitThrows(
      async () => {
        throw new Error('boom')
      },
      { retryOn429: true },
      'boom',
    )
  })

  it('forwards messageId to callbacks when provided', async () => {
    const { retry } = await runLimitFailOnce({
      callbacks: true,
      initialBackoffMs: 100,
      messageId: 'msg-42',
    })
    expect(retry!).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'msg-42' }))
  })

  it('does not retry rate-limit errors when retryOn429 is false', async () => {
    let calls = 0
    await expectRunWithLimitThrows(
      async () => {
        calls++
        throw new RateLimitError('slow', 429)
      },
      { retryOn429: false },
    )
    expect(calls).toBe(1)
  })
})

async function expectRunWithLimitThrows(
  operation: () => Promise<string>,
  overrides: { retryOn429: boolean },
  message?: string,
): Promise<void> {
  const rateLimiter = createRateLimiter({ enabled: false, rpm: 0 })
  const expectation = expect(
    runWithRateLimit(operation, {
      rateLimiter,
      retryOptions: { maxRetries: 5, initialBackoffMs: 10, ...overrides },
    }),
  ).rejects
  if (message) {
    await expectation.toThrow(message)
  } else {
    await expectation.toBeInstanceOf(RateLimitError)
  }
}

async function runLimitFailOnce(options: {
  callbacks?: boolean
  initialBackoffMs: number
  messageId?: string
}): Promise<{
  result: string
  calls: number
  retry: ReturnType<typeof vi.fn> | undefined
  waiting: ReturnType<typeof vi.fn> | undefined
}> {
  const rateLimiter = createRateLimiter({ enabled: false, rpm: 0 })
  const waiting = options.callbacks ? vi.fn() : undefined
  const retry = options.callbacks ? vi.fn() : undefined

  let calls = 0
  const operation = async (): Promise<string> => {
    calls++
    if (calls === 1) {
      throw new RateLimitError('slow down', 429, 0)
    }
    return 'ok'
  }

  vi.useFakeTimers()
  const promise = runWithRateLimit(operation, {
    rateLimiter,
    retryOptions: { maxRetries: 5, initialBackoffMs: options.initialBackoffMs, retryOn429: true },
    ...(retry || waiting
      ? { callbacks: { ...(waiting ? { onWaiting: waiting } : {}), ...(retry ? { onRetry: retry } : {}) } }
      : {}),
    ...(options.messageId ? { messageId: options.messageId } : {}),
  })
  await vi.advanceTimersByTimeAsync(options.initialBackoffMs)
  const result = await promise
  vi.useRealTimers()

  return { result, calls, retry, waiting }
}
