import { describe, expect, it } from 'vitest'
import {
  InvalidPhaseTransitionError,
  LLMError,
  OpenFoxError,
  RateLimitError,
  SessionNotFoundError,
  ToolExecutionError,
  ValidationError,
  isRateLimitError,
  isRetryableError,
} from './errors.js'

describe('error utilities', () => {
  it('builds typed error classes with stable metadata', () => {
    const base = new OpenFoxError('base', 'BASE', { detail: true })
    const missing = new SessionNotFoundError('session-1')
    const transition = new InvalidPhaseTransitionError('plan', 'done')
    const tool = new ToolExecutionError('edit_file', 'failed badly', { reason: 'oops' })
    const llm = new LLMError('timeout', { attempt: 2 })
    const validation = new ValidationError('bad input', { field: 'mode' })

    expect(base).toMatchObject({ name: 'OpenFoxError', code: 'BASE', details: { detail: true } })
    expect(missing).toMatchObject({
      name: 'SessionNotFoundError',
      code: 'SESSION_NOT_FOUND',
      details: { sessionId: 'session-1' },
    })
    expect(transition.message).toBe('Invalid phase transition: plan -> done')
    expect(tool).toMatchObject({ code: 'TOOL_EXECUTION_ERROR', details: { tool: 'edit_file', reason: 'oops' } })
    expect(llm.code).toBe('LLM_ERROR')
    expect(validation.code).toBe('VALIDATION_ERROR')
  })

  it('identifies retryable and non-retryable errors', () => {
    expect(isRetryableError(new LLMError('timeout'))).toBe(true)
    expect(isRetryableError(new ToolExecutionError('read_file', 'bad'))).toBe(true)
    expect(isRetryableError(new ValidationError('nope'))).toBe(false)
    expect(isRetryableError(new Error('plain error'))).toBe(false)
  })

  it('builds RateLimitError carrying status, retry-after and attempt', () => {
    const rl = new RateLimitError('Too Many Requests', 429, 5000, 2)
    expect(rl).toBeInstanceOf(LLMError)
    expect(rl).toBeInstanceOf(OpenFoxError)
    expect(rl.name).toBe('RateLimitError')
    expect(rl.statusCode).toBe(429)
    expect(rl.retryAfterMs).toBe(5000)
    expect(rl.attempt).toBe(2)
    expect(isRateLimitError(rl)).toBe(true)
  })

  it('treats RateLimitError as retryable', () => {
    expect(isRetryableError(new RateLimitError('slow down', 429))).toBe(true)
  })

  it('does not classify generic LLMError as a rate limit error', () => {
    expect(isRateLimitError(new LLMError('timeout'))).toBe(false)
    expect(isRateLimitError(new Error('plain'))).toBe(false)
  })
})
