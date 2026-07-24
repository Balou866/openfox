import { logger } from '../utils/logger.js'
import { isRateLimitError, RateLimitError } from '../utils/errors.js'
import { computeRetryDelay, sleep, type BackoffOptions } from '../utils/async.js'
import type { RateLimiter } from './rate-limiter.js'

export interface RateLimitRetryOptions extends BackoffOptions {
  retryOn429: boolean
}

export interface RateLimitCallbacks {
  onWaiting?: (info: { currentRpm: number; maxRpm: number; waitMs: number; messageId?: string }) => void
  onRetry?: (info: {
    attempt: number
    maxAttempts: number
    waitMs: number
    reason: 'retry-after' | 'backoff'
    messageId?: string
  }) => void
}

export interface RateLimitControllerOptions {
  rateLimiter: RateLimiter
  retryOptions: RateLimitRetryOptions
  callbacks?: RateLimitCallbacks
  signal?: AbortSignal | null
  /** Associated message id for the current request (forwarded to callbacks). */
  messageId?: string
}

export async function runWithRateLimit<T>(
  operation: () => Promise<T>,
  controller: RateLimitControllerOptions,
): Promise<T> {
  const { rateLimiter, retryOptions, callbacks, signal } = controller

  const acquireResult = await rateLimiter.acquire()
  if (acquireResult.waitedMs > 0) {
    callbacks?.onWaiting?.({
      currentRpm: acquireResult.currentRpm,
      maxRpm: rateLimiter.getConfig().rpm,
      waitMs: acquireResult.waitedMs,
      ...(controller.messageId !== undefined ? { messageId: controller.messageId } : {}),
    })
  }

  let lastError: unknown

  for (let attempt = 0; attempt <= retryOptions.maxRetries; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error

      if (signal?.aborted) {
        throw error
      }

      if (!retryOptions.retryOn429 || !isRateLimitError(error)) {
        throw error
      }

      if (attempt >= retryOptions.maxRetries) {
        logger.warn('Rate limit retries exhausted', { attempt, maxRetries: retryOptions.maxRetries })
        throw error
      }

      const rateLimitError = error as RateLimitError
      const nextAttempt = attempt + 1
      const { delayMs, reason } = computeRetryDelay(attempt, retryOptions, rateLimitError.retryAfterMs)

      callbacks?.onRetry?.({
        attempt: nextAttempt,
        maxAttempts: retryOptions.maxRetries,
        waitMs: Math.round(delayMs),
        reason,
        ...(controller.messageId !== undefined ? { messageId: controller.messageId } : {}),
      })

      logger.warn('Retrying after rate limit error', {
        attempt: nextAttempt,
        maxRetries: retryOptions.maxRetries,
        delayMs,
        reason,
      })

      await sleep(delayMs)
    }
  }

  throw lastError
}
