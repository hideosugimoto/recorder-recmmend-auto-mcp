import { describe, it, expect } from 'vitest'
import { isOnline } from './network.js'

describe('isOnline', () => {
  it('returns a boolean', async () => {
    const result = await isOnline()
    expect(typeof result).toBe('boolean')
  })

  // Note: actual connectivity depends on environment
  // In CI, this may return false if no network is available
  it('resolves within a reasonable time', async () => {
    const start = Date.now()
    await isOnline()
    const elapsed = Date.now() - start
    // Should resolve within 2 seconds (500ms timeout + overhead)
    expect(elapsed).toBeLessThan(2000)
  })
})
