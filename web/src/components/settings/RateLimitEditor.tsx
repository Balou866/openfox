import { Toggle } from '../shared/Toggle'

export interface RateLimitValue {
  enabled: boolean
  rpm: number
  retryOn429: boolean
  maxRetries: number
  initialBackoffMs: number
}

interface RateLimitEditorProps {
  value: RateLimitValue
  onChange: (value: RateLimitValue) => void
}

const RPM_MIN = 1
const RPM_MAX = 1000
const RETRIES_MIN = 1
const RETRIES_MAX = 20
const BACKOFF_MIN = 100
const BACKOFF_MAX = 60_000

function clampNumber(raw: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(raw)) return fallback
  return Math.min(Math.max(Math.floor(raw), min), max)
}

export function RateLimitEditor({ value, onChange }: RateLimitEditorProps) {
  const update = (updates: Partial<RateLimitValue>) => {
    onChange({ ...value, ...updates })
  }

  return (
    <div className="space-y-4">
      <label className="flex items-start justify-between gap-3 cursor-pointer">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-text-primary">Enable RPM throttle</div>
          <div className="text-sm text-text-muted mt-0.5">
            Hold requests in a queue so OpenFox never sends more than the configured number per minute.
          </div>
        </div>
        <div className="flex-shrink-0">
          <Toggle enabled={value.enabled} onClick={() => update({ enabled: !value.enabled })} />
        </div>
      </label>

      <div>
        <label className="text-sm font-medium text-text-primary">Limit (RPM)</label>
        <input
          type="number"
          min={RPM_MIN}
          max={RPM_MAX}
          value={value.rpm}
          onChange={(e) => update({ rpm: clampNumber(parseInt(e.target.value, 10), RPM_MIN, RPM_MAX, 40) })}
          disabled={!value.enabled}
          className="mt-1 block w-24 px-2 py-1 text-sm bg-bg-secondary border border-border rounded disabled:opacity-50"
        />
        <p className="text-xs text-text-muted mt-1">Maximum requests per minute sent to the provider.</p>
      </div>

      <hr className="border-border" />

      <label className="flex items-start justify-between gap-3 cursor-pointer">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-text-primary">Retry on 429 (exponential backoff)</div>
          <div className="text-sm text-text-muted mt-0.5">
            When the provider returns a rate-limit error, wait and retry automatically. Respects the Retry-After header
            when present.
          </div>
        </div>
        <div className="flex-shrink-0">
          <Toggle enabled={value.retryOn429} onClick={() => update({ retryOn429: !value.retryOn429 })} />
        </div>
      </label>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-sm font-medium text-text-primary">Max retries</label>
          <input
            type="number"
            min={RETRIES_MIN}
            max={RETRIES_MAX}
            value={value.maxRetries}
            onChange={(e) =>
              update({ maxRetries: clampNumber(parseInt(e.target.value, 10), RETRIES_MIN, RETRIES_MAX, 5) })
            }
            disabled={!value.retryOn429}
            className="mt-1 block w-24 px-2 py-1 text-sm bg-bg-secondary border border-border rounded disabled:opacity-50"
          />
          <p className="text-xs text-text-muted mt-1">Attempts before surfacing the error.</p>
        </div>
        <div>
          <label className="text-sm font-medium text-text-primary">Initial backoff (ms)</label>
          <input
            type="number"
            min={BACKOFF_MIN}
            max={BACKOFF_MAX}
            step={100}
            value={value.initialBackoffMs}
            onChange={(e) =>
              update({
                initialBackoffMs: clampNumber(parseInt(e.target.value, 10), BACKOFF_MIN, BACKOFF_MAX, 2000),
              })
            }
            disabled={!value.retryOn429}
            className="mt-1 block w-32 px-2 py-1 text-sm bg-bg-secondary border border-border rounded disabled:opacity-50"
          />
          <p className="text-xs text-text-muted mt-1">Doubles each attempt, capped at 32s + jitter.</p>
        </div>
      </div>
    </div>
  )
}

export const RATE_LIMIT_DEFAULTS: RateLimitValue = {
  enabled: false,
  rpm: 40,
  retryOn429: true,
  maxRetries: 5,
  initialBackoffMs: 2000,
}
