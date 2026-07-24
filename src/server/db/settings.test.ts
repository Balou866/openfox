import { beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { closeDatabase, initDatabase } from './index.js'
import {
  RATE_LIMIT_DEFAULTS,
  SETTINGS_KEYS,
  deleteSetting,
  getAllSettings,
  getRateLimitConfig,
  getSetting,
  setSetting,
} from './settings.js'

describe('db settings', () => {
  beforeEach(() => {
    closeDatabase()
    const config = loadConfig()
    config.database.path = ':memory:'
    initDatabase(config)
  })

  it('gets, sets, updates, deletes, and lists settings', () => {
    expect(getSetting(SETTINGS_KEYS.GLOBAL_INSTRUCTIONS)).toBeNull()

    setSetting(SETTINGS_KEYS.GLOBAL_INSTRUCTIONS, 'Always test first')
    setSetting('theme', 'dark')
    expect(getSetting(SETTINGS_KEYS.GLOBAL_INSTRUCTIONS)).toBe('Always test first')
    expect(getAllSettings()).toEqual({
      [SETTINGS_KEYS.GLOBAL_INSTRUCTIONS]: 'Always test first',
      theme: 'dark',
    })

    setSetting('theme', 'light')
    expect(getSetting('theme')).toBe('light')

    deleteSetting('theme')
    expect(getSetting('theme')).toBeNull()
    expect(getAllSettings()).toEqual({
      [SETTINGS_KEYS.GLOBAL_INSTRUCTIONS]: 'Always test first',
    })
  })

  describe('search engine settings', () => {
    it('sets and gets SEARCH_ENGINE', () => {
      setSetting(SETTINGS_KEYS.SEARCH_ENGINE, 'tavily')
      expect(getSetting(SETTINGS_KEYS.SEARCH_ENGINE)).toBe('tavily')

      setSetting(SETTINGS_KEYS.SEARCH_ENGINE, 'searxng')
      expect(getSetting(SETTINGS_KEYS.SEARCH_ENGINE)).toBe('searxng')

      setSetting(SETTINGS_KEYS.SEARCH_ENGINE, '')
      expect(getSetting(SETTINGS_KEYS.SEARCH_ENGINE)).toBe('')
    })

    it('sets and gets SEARCH_TAVILY_API_KEY', () => {
      setSetting(SETTINGS_KEYS.SEARCH_TAVILY_API_KEY, 'tvly-test-key-123')
      expect(getSetting(SETTINGS_KEYS.SEARCH_TAVILY_API_KEY)).toBe('tvly-test-key-123')
    })

    it('sets and gets SEARCH_SEARXNG_URL', () => {
      setSetting(SETTINGS_KEYS.SEARCH_SEARXNG_URL, 'http://localhost:4000')
      expect(getSetting(SETTINGS_KEYS.SEARCH_SEARXNG_URL)).toBe('http://localhost:4000')
    })

    it('sets and gets SEARCH_SEARXNG_API_KEY', () => {
      setSetting(SETTINGS_KEYS.SEARCH_SEARXNG_API_KEY, 'sx-secret')
      expect(getSetting(SETTINGS_KEYS.SEARCH_SEARXNG_API_KEY)).toBe('sx-secret')
    })

    it('all four keys are independent', () => {
      setSetting(SETTINGS_KEYS.SEARCH_ENGINE, 'tavily')
      setSetting(SETTINGS_KEYS.SEARCH_TAVILY_API_KEY, 'tvly-key')
      setSetting(SETTINGS_KEYS.SEARCH_SEARXNG_URL, 'http://searxng:4000')
      setSetting(SETTINGS_KEYS.SEARCH_SEARXNG_API_KEY, 'sx-key')

      expect(getSetting(SETTINGS_KEYS.SEARCH_ENGINE)).toBe('tavily')
      expect(getSetting(SETTINGS_KEYS.SEARCH_TAVILY_API_KEY)).toBe('tvly-key')
      expect(getSetting(SETTINGS_KEYS.SEARCH_SEARXNG_URL)).toBe('http://searxng:4000')
      expect(getSetting(SETTINGS_KEYS.SEARCH_SEARXNG_API_KEY)).toBe('sx-key')
    })

    it('returns null for unset keys', () => {
      expect(getSetting(SETTINGS_KEYS.SEARCH_ENGINE)).toBeNull()
      expect(getSetting(SETTINGS_KEYS.SEARCH_TAVILY_API_KEY)).toBeNull()
      expect(getSetting(SETTINGS_KEYS.SEARCH_SEARXNG_URL)).toBeNull()
      expect(getSetting(SETTINGS_KEYS.SEARCH_SEARXNG_API_KEY)).toBeNull()
    })

    it('deletes search engine keys', () => {
      setSetting(SETTINGS_KEYS.SEARCH_ENGINE, 'tavily')
      deleteSetting(SETTINGS_KEYS.SEARCH_ENGINE)
      expect(getSetting(SETTINGS_KEYS.SEARCH_ENGINE)).toBeNull()
    })
  })

  describe('rate limit config', () => {
    it('returns defaults when setting is missing', () => {
      deleteSetting(SETTINGS_KEYS.LLM_RATE_LIMIT)
      expect(getRateLimitConfig()).toEqual(RATE_LIMIT_DEFAULTS)
    })

    it('returns defaults when JSON is invalid', () => {
      setSetting(SETTINGS_KEYS.LLM_RATE_LIMIT, '{not json')
      expect(getRateLimitConfig()).toEqual(RATE_LIMIT_DEFAULTS)
    })

    it('returns defaults when value is not an object', () => {
      setSetting(SETTINGS_KEYS.LLM_RATE_LIMIT, '"a string"')
      expect(getRateLimitConfig()).toEqual(RATE_LIMIT_DEFAULTS)
    })

    it('parses valid config and applies defaults for missing fields', () => {
      setSetting(SETTINGS_KEYS.LLM_RATE_LIMIT, JSON.stringify({ enabled: true, rpm: 100 }))
      const config = getRateLimitConfig()
      expect(config.enabled).toBe(true)
      expect(config.rpm).toBe(100)
      expect(config.retryOn429).toBe(RATE_LIMIT_DEFAULTS.retryOn429)
      expect(config.maxRetries).toBe(RATE_LIMIT_DEFAULTS.maxRetries)
      expect(config.initialBackoffMs).toBe(RATE_LIMIT_DEFAULTS.initialBackoffMs)
    })

    it('clamps out-of-range values', () => {
      setSetting(SETTINGS_KEYS.LLM_RATE_LIMIT, JSON.stringify({ rpm: 50_000, maxRetries: 100, initialBackoffMs: 0 }))
      const config = getRateLimitConfig()
      expect(config.rpm).toBe(1000)
      expect(config.maxRetries).toBe(20)
      expect(config.initialBackoffMs).toBe(100)
    })

    it('falls back to defaults for non-boolean enabled/retryOn429', () => {
      setSetting(SETTINGS_KEYS.LLM_RATE_LIMIT, JSON.stringify({ enabled: 'yes', retryOn429: 1 }))
      const config = getRateLimitConfig()
      expect(config.enabled).toBe(RATE_LIMIT_DEFAULTS.enabled)
      expect(config.retryOn429).toBe(RATE_LIMIT_DEFAULTS.retryOn429)
    })
  })
})
