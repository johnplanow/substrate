/**
 * Unit tests for TaskTypeClassifier.
 *
 * Covers:
 *  - Explicit task_type is returned when present
 *  - Heuristic matching finds correct type
 *  - Default fallback to "coding" when no match
 *  - Custom taxonomy from config overrides defaults
 *  - Case-insensitive matching
 */

import { describe, it, expect } from 'vitest'
import { TaskTypeClassifier, DEFAULT_TAXONOMY, createTaskTypeClassifier } from '../task-type-classifier.js'

describe('TaskTypeClassifier', () => {
  // -------------------------------------------------------------------------
  // Explicit task type
  // -------------------------------------------------------------------------

  it('returns explicit taskType when present', () => {
    const classifier = new TaskTypeClassifier()
    const result = classifier.classify({ taskType: 'testing', title: 'Fix a bug' })
    expect(result).toBe('testing')
  })

  it('returns explicit taskType even when keywords match differently', () => {
    const classifier = new TaskTypeClassifier()
    const result = classifier.classify({ taskType: 'api', title: 'Deploy kubernetes cluster' })
    expect(result).toBe('api')
  })

  it('returns explicit taskType trimmed', () => {
    const classifier = new TaskTypeClassifier()
    const result = classifier.classify({ taskType: '  docs  ' })
    expect(result).toBe('docs')
  })

  // -------------------------------------------------------------------------
  // Heuristic matching
  // -------------------------------------------------------------------------

  it('matches "testing" type for a test-related title', () => {
    const classifier = new TaskTypeClassifier()
    const result = classifier.classify({ title: 'Write unit test for auth module' })
    expect(result).toBe('testing')
  })

  it('matches "debugging" type for bug-fix title', () => {
    const classifier = new TaskTypeClassifier()
    const result = classifier.classify({ title: 'Fix the login bug' })
    expect(result).toBe('debugging')
  })

  it('matches "refactoring" type for refactor title', () => {
    const classifier = new TaskTypeClassifier()
    const result = classifier.classify({ title: 'Refactor user service' })
    expect(result).toBe('refactoring')
  })

  it('matches "docs" type for documentation title', () => {
    const classifier = new TaskTypeClassifier()
    const result = classifier.classify({ title: 'Update README file' })
    expect(result).toBe('docs')
  })

  it('matches "api" type for api endpoint task', () => {
    const classifier = new TaskTypeClassifier()
    const result = classifier.classify({ title: 'Add REST endpoint for users' })
    expect(result).toBe('api')
  })

  it('matches "database" type for migration task', () => {
    const classifier = new TaskTypeClassifier()
    const result = classifier.classify({ title: 'Create database migration for tasks table' })
    expect(result).toBe('database')
  })

  it('matches "ui" type for frontend component task', () => {
    const classifier = new TaskTypeClassifier()
    const result = classifier.classify({ title: 'Build login component' })
    expect(result).toBe('ui')
  })

  it('matches "devops" type for deployment task', () => {
    const classifier = new TaskTypeClassifier()
    const result = classifier.classify({ title: 'Deploy to kubernetes' })
    expect(result).toBe('devops')
  })

  it('matches "coding" type for implement keyword', () => {
    const classifier = new TaskTypeClassifier()
    const result = classifier.classify({ title: 'Implement the auth flow' })
    expect(result).toBe('coding')
  })

  it('performs case-insensitive matching', () => {
    const classifier = new TaskTypeClassifier()
    expect(classifier.classify({ title: 'FIX THE BUG NOW' })).toBe('debugging')
    expect(classifier.classify({ title: 'TEST ALL THE THINGS' })).toBe('testing')
    expect(classifier.classify({ title: 'DEPLOY TO PROD' })).toBe('devops')
  })

  it('uses description field for matching when title is absent', () => {
    const classifier = new TaskTypeClassifier()
    const result = classifier.classify({ description: 'This task requires writing a test spec' })
    expect(result).toBe('testing')
  })

  it('combines title and description for matching', () => {
    const classifier = new TaskTypeClassifier()
    // Title matches nothing; description has keyword
    const result = classifier.classify({
      title: 'Main task',
      description: 'Should debug the issue',
    })
    expect(result).toBe('debugging')
  })

  // -------------------------------------------------------------------------
  // Default fallback
  // -------------------------------------------------------------------------

  it('defaults to "coding" when no keyword matches', () => {
    const classifier = new TaskTypeClassifier()
    const result = classifier.classify({ title: 'Random unknown task xyz' })
    expect(result).toBe('coding')
  })

  it('defaults to "coding" when title and description are empty', () => {
    const classifier = new TaskTypeClassifier()
    const result = classifier.classify({})
    expect(result).toBe('coding')
  })

  it('defaults to "coding" when taskType is empty string', () => {
    const classifier = new TaskTypeClassifier()
    const result = classifier.classify({ taskType: '', title: 'Unknown task' })
    expect(result).toBe('coding')
  })

  it('defaults to "coding" when taskType is whitespace only', () => {
    const classifier = new TaskTypeClassifier()
    const result = classifier.classify({ taskType: '   ', title: 'Unknown task' })
    expect(result).toBe('coding')
  })

  // -------------------------------------------------------------------------
  // Custom taxonomy
  // -------------------------------------------------------------------------

  it('uses custom taxonomy when provided', () => {
    const customTaxonomy = {
      analysis: ['analyze', 'investigate', 'research', 'explore'],
      review: ['review', 'audit', 'inspect', 'check'],
    }
    const classifier = new TaskTypeClassifier(customTaxonomy)
    expect(classifier.classify({ title: 'Analyze the performance data' })).toBe('analysis')
    expect(classifier.classify({ title: 'Review the pull request' })).toBe('review')
  })

  it('custom taxonomy overrides default taxonomy completely', () => {
    const customTaxonomy = {
      mytype: ['custom_keyword'],
    }
    const classifier = new TaskTypeClassifier(customTaxonomy)
    // "fix" is in default taxonomy but not in custom
    const result = classifier.classify({ title: 'Fix the bug' })
    // Should NOT match debugging since custom taxonomy is used
    expect(result).toBe('coding') // fallback
  })

  it('createTaskTypeClassifier factory creates classifier correctly', () => {
    const classifier = createTaskTypeClassifier()
    expect(classifier).toBeInstanceOf(TaskTypeClassifier)
    expect(classifier.classify({ title: 'Fix the bug' })).toBe('debugging')
  })

  it('createTaskTypeClassifier factory creates classifier with custom taxonomy', () => {
    const classifier = createTaskTypeClassifier({ custom: ['custom_keyword'] })
    expect(classifier.classify({ title: 'Trigger custom_keyword flow' })).toBe('custom')
  })

  // -------------------------------------------------------------------------
  // DEFAULT_TAXONOMY exported correctly
  // -------------------------------------------------------------------------

  it('DEFAULT_TAXONOMY contains all expected types', () => {
    const expectedTypes = ['coding', 'testing', 'debugging', 'refactoring', 'docs', 'api', 'database', 'ui', 'devops']
    for (const type of expectedTypes) {
      expect(DEFAULT_TAXONOMY).toHaveProperty(type)
      expect(Array.isArray(DEFAULT_TAXONOMY[type])).toBe(true)
      expect(DEFAULT_TAXONOMY[type].length).toBeGreaterThan(0)
    }
  })
})
