import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from './openai-types.js'
import { logger } from '../utils/logger.js'
import { LLMError, RateLimitError } from '../utils/errors.js'
import { parseRetryAfter } from '../utils/async.js'
import { proxyFetch } from './proxy.js'

export interface HttpClientOptions {
  baseURL: string
  apiKey: string
}

export interface RequestOptions {
  signal?: AbortSignal | null | undefined
}

export class OpenAIHttpClient {
  private baseURL: string
  private apiKey: string

  constructor(options: HttpClientOptions) {
    this.baseURL = options.baseURL
    this.apiKey = options.apiKey
  }

  private async fetchChatCompletion(
    params: ChatCompletionCreateParamsNonStreaming | ChatCompletionCreateParamsStreaming,
    options?: RequestOptions,
  ): Promise<Response> {
    const url = `${this.baseURL}/chat/completions`
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    }

    const bodyStr = JSON.stringify(params)
    logger.debug('HTTP request to LLM', { url, bodyKeys: Object.keys(params) })

    const response = await proxyFetch(url, {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: options?.signal ?? null,
    })

    if (response.status === 429) {
      const errorText = await response.text().catch(() => '')
      const retryAfterRaw = response.headers.get('retry-after')
      const retryAfterMs = parseRetryAfter(retryAfterRaw)
      logger.warn('LLM rate limit (429)', { retryAfterRaw, retryAfterMs, body: errorText.slice(0, 200) })
      throw new RateLimitError(`HTTP 429: ${errorText || 'Too Many Requests'}`, 429, retryAfterMs ?? undefined)
    }

    if (!response.ok) {
      const errorText = await response.text()
      throw new LLMError(`HTTP ${response.status}: ${errorText}`)
    }

    return response
  }

  async createChatCompletion(
    params: ChatCompletionCreateParamsNonStreaming,
    options?: RequestOptions,
    returnRaw?: boolean,
  ): Promise<ChatCompletionResponse & { raw?: string }> {
    const response = await this.fetchChatCompletion(params, options)
    const rawText = await response.text()
    try {
      const data = JSON.parse(rawText) as ChatCompletionResponse
      if (returnRaw) {
        return { ...data, raw: rawText }
      }
      return data
    } catch (error) {
      throw new LLMError(`Failed to parse response: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  createChatCompletionStream(
    params: ChatCompletionCreateParamsStreaming,
    options?: RequestOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const responsePromise = this.fetchChatCompletion(params, options)

    async function* generate(): AsyncGenerator<ChatCompletionChunk> {
      const response = await responsePromise

      if (!response.body) {
        throw new LLMError('No response body for streaming')
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue

            if (trimmed.startsWith('data: ')) {
              const data = trimmed.slice(6)
              if (data === '[DONE]') {
                return
              }

              try {
                const chunk = JSON.parse(data) as ChatCompletionChunk
                yield chunk
              } catch (error) {
                logger.warn('Failed to parse SSE chunk', { data, error })
              }
            }
          }
        }
      } finally {
        reader.releaseLock()
      }
    }

    return generate()
  }
}
