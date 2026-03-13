import { describe, it, expect } from 'vitest'
import type { KnowledgeItem } from './types.js'

describe('KnowledgeItem type', () => {
  it('accepts trigger_phrases as optional field', () => {
    // KnowledgeItem without trigger_phrases should be valid
    const itemWithout: KnowledgeItem = {
      category: 'skills',
      title: 'Test',
      content: 'Test content',
      tags: ['test'],
    }
    expect(itemWithout.trigger_phrases).toBeUndefined()
  })

  it('accepts trigger_phrases as string array', () => {
    const itemWith: KnowledgeItem = {
      category: 'debug',
      title: 'Fix Memory Leak',
      content: 'Steps to fix memory leaks',
      tags: ['memory', 'debug'],
      trigger_phrases: ['how to fix memory leak', 'memory usage too high'],
    }
    expect(itemWith.trigger_phrases).toEqual(['how to fix memory leak', 'memory usage too high'])
  })

  it('allows empty trigger_phrases array', () => {
    const item: KnowledgeItem = {
      category: 'workflow',
      title: 'CI Setup',
      content: 'Setting up CI pipeline',
      tags: ['ci'],
      trigger_phrases: [],
    }
    expect(item.trigger_phrases).toEqual([])
  })
})
