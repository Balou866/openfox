// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RateLimitEditor, RATE_LIMIT_DEFAULTS } from './RateLimitEditor'

afterEach(() => {
  cleanup()
})

describe('RateLimitEditor', () => {
  it('renders the default values and toggles enable', () => {
    const onChange = vi.fn()
    render(<RateLimitEditor value={RATE_LIMIT_DEFAULTS} onChange={onChange} />)

    expect(screen.getByText('Enable RPM throttle')).toBeTruthy()
    const switches = screen.getAllByRole('switch')
    const enableSwitch = switches.find((s) => s.getAttribute('aria-checked') === 'false')
    fireEvent.click(enableSwitch!)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }))
  })

  it('toggles retry on 429', () => {
    const onChange = vi.fn()
    render(<RateLimitEditor value={RATE_LIMIT_DEFAULTS} onChange={onChange} />)

    const switches = screen.getAllByRole('switch')
    const retrySwitch = switches.find((s) => s.getAttribute('aria-checked') === 'true')
    expect(retrySwitch).toBeTruthy()
    fireEvent.click(retrySwitch!)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ retryOn429: false }))
  })

  it('clamps RPM input to valid bounds', () => {
    const onChange = vi.fn()
    const value = { ...RATE_LIMIT_DEFAULTS, enabled: true }
    const { container } = render(<RateLimitEditor value={value} onChange={onChange} />)

    const rpmInput = container.querySelector('input[type="number"][min="1"]') as HTMLInputElement
    fireEvent.change(rpmInput, { target: { value: '50000' } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ rpm: 1000 }))

    fireEvent.change(rpmInput, { target: { value: '0' } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ rpm: 1 }))
  })

  it('clamps max retries to bounds', () => {
    const onChange = vi.fn()
    const { container } = render(<RateLimitEditor value={RATE_LIMIT_DEFAULTS} onChange={onChange} />)

    const inputs = container.querySelectorAll('input[type="number"]')
    const retriesInput = Array.from(inputs).find(
      (i) => (i as HTMLInputElement).min === '1' && (i as HTMLInputElement).max === '20',
    ) as HTMLInputElement
    fireEvent.change(retriesInput, { target: { value: '100' } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ maxRetries: 20 }))
  })

  it('clamps initial backoff to bounds', () => {
    const onChange = vi.fn()
    const { container } = render(<RateLimitEditor value={RATE_LIMIT_DEFAULTS} onChange={onChange} />)

    const inputs = container.querySelectorAll('input[type="number"]')
    const backoffInput = Array.from(inputs).find((i) => (i as HTMLInputElement).min === '100') as HTMLInputElement
    fireEvent.change(backoffInput, { target: { value: '10' } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ initialBackoffMs: 100 }))
  })
})
