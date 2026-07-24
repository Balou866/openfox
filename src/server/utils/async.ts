export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface RetryOptions {
  maxRetries: number
  backoffMs: number[]
  shouldRetry?: (error: unknown) => boolean
}

export async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  let lastError: unknown

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error

      if (options.shouldRetry && !options.shouldRetry(error)) {
        throw error
      }

      if (attempt < options.maxRetries) {
        const backoff = options.backoffMs[attempt] ?? options.backoffMs[options.backoffMs.length - 1]!
        await sleep(backoff)
      }
    }
  }

  throw lastError
}

// ----------------------------------------------------------------------------
// Exponential backoff with jitter (for HTTP 429 retries)
// ----------------------------------------------------------------------------

export interface BackoffOptions {
  maxRetries: number
  initialBackoffMs: number
  capMs?: number
  jitterMs?: number
}

export interface BackoffDelayResult {
  delayMs: number
  reason: 'retry-after' | 'backoff'
}

const DEFAULT_BACKOFF_CAP_MS = 32_000
const DEFAULT_BACKOFF_JITTER_MS = 500

export function computeExponentialBackoff(
  attempt: number,
  initialBackoffMs: number,
  capMs: number = DEFAULT_BACKOFF_CAP_MS,
  jitterMs: number = DEFAULT_BACKOFF_JITTER_MS,
): number {
  const raw = initialBackoffMs * Math.pow(2, attempt)
  const capped = Math.min(raw, capMs)
  const jitter = jitterMs > 0 ? Math.random() * jitterMs : 0
  return capped + jitter
}

export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  if (value === null || value === undefined || value.trim() === '') {
    return null
  }
  const trimmed = value.trim()

  const seconds = Number(trimmed)
  if (!Number.isNaN(seconds) && trimmed !== '') {
    if (seconds < 0) return 0
    return Math.round(seconds * 1000)
  }

  const parsed = Date.parse(trimmed)
  if (!Number.isNaN(parsed)) {
    const diff = parsed - now
    return diff > 0 ? diff : 0
  }

  return null
}

export function computeRetryDelay(
  attempt: number,
  options: BackoffOptions,
  retryAfterMs?: number | null,
): BackoffDelayResult {
  if (retryAfterMs !== undefined && retryAfterMs !== null) {
    const cap = options.capMs ?? DEFAULT_BACKOFF_CAP_MS
    const clamped = Math.min(Math.max(0, retryAfterMs), cap)
    return { delayMs: clamped, reason: 'retry-after' }
  }
  const jitter = options.jitterMs ?? DEFAULT_BACKOFF_JITTER_MS
  const delayMs = computeExponentialBackoff(
    attempt,
    options.initialBackoffMs,
    options.capMs ?? DEFAULT_BACKOFF_CAP_MS,
    jitter,
  )
  return { delayMs, reason: 'backoff' }
}

export function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void

  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

export type Unsubscribe = () => void

export class EventEmitter<T extends Record<string, unknown[]>> {
  private listeners = new Map<keyof T, Set<(...args: unknown[]) => void>>()

  on<K extends keyof T>(event: K, listener: (...args: T[K]) => void): Unsubscribe {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }

    const listeners = this.listeners.get(event)!
    listeners.add(listener as (...args: unknown[]) => void)

    return () => {
      listeners.delete(listener as (...args: unknown[]) => void)
    }
  }

  emit<K extends keyof T>(event: K, ...args: T[K]): void {
    const listeners = this.listeners.get(event)
    if (listeners) {
      for (const listener of listeners) {
        listener(...args)
      }
    }
  }

  removeAllListeners(): void {
    this.listeners.clear()
  }
}
