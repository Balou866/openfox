import { describe, expect, it, vi, beforeEach } from 'vitest'

const { proxyFetchMock } = vi.hoisted(() => ({
  proxyFetchMock: vi.fn(),
}))

vi.mock('./proxy.js', () => ({
  proxyFetch: (...args: unknown[]) => proxyFetchMock(...args),
}))

vi.mock('../utils/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

import { OpenAIHttpClient } from './http-client.js'
import { RateLimitError, LLMError, isRateLimitError } from '../utils/errors.js'

function mockResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    text: () => Promise.resolve(body),
  } as unknown as Response
}

describe('OpenAIHttpClient 429 handling', () => {
  let client: OpenAIHttpClient

  beforeEach(() => {
    proxyFetchMock.mockReset()
    client = new OpenAIHttpClient({ baseURL: 'http://localhost:8000/v1', apiKey: 'key' })
  })

  it('throws RateLimitError on 429 with Retry-After in seconds', async () => {
    proxyFetchMock.mockResolvedValueOnce(mockResponse(429, 'Too Many Requests', { 'retry-after': '5' }))

    await expect(client.createChatCompletion({ model: 'm', messages: [] } as never)).rejects.toSatisfy(
      (err: unknown) => err instanceof RateLimitError && err.retryAfterMs === 5000,
    )
  })

  it('parses Retry-After HTTP-date format', async () => {
    const future = new Date(Date.now() + 10_000).toUTCString()
    proxyFetchMock.mockResolvedValueOnce(mockResponse(429, 'busy', { 'retry-after': future }))

    let caught: unknown
    try {
      await client.createChatCompletion({ model: 'm', messages: [] } as never)
    } catch (e) {
      caught = e
    }
    const error = caught as RateLimitError
    expect(error).toBeInstanceOf(RateLimitError)
    expect(error.retryAfterMs).toBeGreaterThanOrEqual(8_000)
    expect(error.retryAfterMs).toBeLessThanOrEqual(12_000)
  })

  it('exposes undefined retryAfterMs when header is absent', async () => {
    proxyFetchMock.mockResolvedValueOnce(mockResponse(429, 'slow down', {}))

    let caught: unknown
    try {
      await client.createChatCompletion({ model: 'm', messages: [] } as never)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(RateLimitError)
    expect((caught as RateLimitError).retryAfterMs).toBeUndefined()
  })

  it('does not classify non-429 errors as rate limit errors', async () => {
    proxyFetchMock.mockResolvedValueOnce(mockResponse(500, 'Internal Server Error'))

    let caught: unknown
    try {
      await client.createChatCompletion({ model: 'm', messages: [] } as never)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(LLMError)
    expect(isRateLimitError(caught)).toBe(false)
  })

  it('sets statusCode to 429', async () => {
    proxyFetchMock.mockResolvedValueOnce(mockResponse(429, 'nope', { 'retry-after': '1' }))

    let caught: unknown
    try {
      await client.createChatCompletion({ model: 'm', messages: [] } as never)
    } catch (e) {
      caught = e
    }
    expect((caught as RateLimitError).statusCode).toBe(429)
  })
})
