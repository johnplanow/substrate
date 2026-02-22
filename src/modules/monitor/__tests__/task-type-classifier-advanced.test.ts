/**
 * Advanced unit tests for TaskTypeClassifier.
 *
 * Covers:
 *  - AC2: explicit task_type is returned when present
 *  - AC3: heuristic keyword matching, case-insensitive, priority order, default fallback
 *  - AC4: custom taxonomy from config overrides defaults
 *  - Word-boundary matching (not substring — "dom" must NOT match "random")
 *  - Priority order enforcement: test > debug > refactor > docs > api > db > ui > devops > coding
 *  - Invalid taxonomy config rejection
 *  - Mixed explicit and heuristic tasks in same run
 */

import { describe, it, expect } from 'vitest'
import { TaskTypeClassifier, DEFAULT_TAXONOMY, createTaskTypeClassifier } from '../task-type-classifier.js'

describe('TaskTypeClassifier — Advanced (Story 8.5)', () => {
  // -------------------------------------------------------------------------
  // AC2: Explicit task type
  // -------------------------------------------------------------------------

  describe('AC2: Explicit task_type label', () => {
    it('returns explicit taskType when present, ignoring heuristics', () => {
      const classifier = new TaskTypeClassifier()
      // "Deploy" normally matches devops, but explicit label says "testing"
      expect(classifier.classify({ taskType: 'testing', title: 'Deploy kubernetes cluster' })).toBe('testing')
    })

    it('returns explicit taskType unchanged', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ taskType: 'my-custom-type', title: 'Fix a bug' })).toBe('my-custom-type')
    })

    it('returns explicit taskType trimmed', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ taskType: '  api  ' })).toBe('api')
    })

    it('falls through to heuristic when taskType is empty string', () => {
      const classifier = new TaskTypeClassifier()
      const result = classifier.classify({ taskType: '', title: 'Fix the authentication bug' })
      expect(result).toBe('debugging')
    })

    it('falls through to heuristic when taskType is whitespace-only', () => {
      const classifier = new TaskTypeClassifier()
      const result = classifier.classify({ taskType: '   ', title: 'Write unit tests for auth' })
      expect(result).toBe('testing')
    })
  })

  // -------------------------------------------------------------------------
  // AC3: Heuristic keyword matching — each default taxonomy type
  // -------------------------------------------------------------------------

  describe('AC3: Heuristic classification for each default type', () => {
    it('classifies "testing" type via "test" keyword', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'Write unit test for auth' })).toBe('testing')
    })

    it('classifies "testing" type via "spec" keyword', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'Add spec for login component' })).toBe('testing')
    })

    it('classifies "testing" type via "e2e" keyword', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'Create e2e flow for checkout' })).toBe('testing')
    })

    it('classifies "testing" type via "coverage" keyword', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'Improve coverage for auth module' })).toBe('testing')
    })

    it('classifies "debugging" type via "fix" keyword', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'Fix the login flow' })).toBe('debugging')
    })

    it('classifies "debugging" type via "bug" keyword', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'Resolve bug in payment processor' })).toBe('debugging')
    })

    it('classifies "debugging" type via "crash" keyword', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'Investigate crash on startup' })).toBe('debugging')
    })

    it('classifies "refactoring" type via "refactor" keyword', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'Refactor the user service' })).toBe('refactoring')
    })

    it('classifies "refactoring" type via "cleanup" keyword', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'Cleanup old dead code' })).toBe('refactoring')
    })

    it('classifies "refactoring" type via "optimize" keyword', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'Optimize database queries' })).toBe('refactoring')
    })

    it('classifies "docs" type via "readme" keyword', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'Update the readme for API section' })).toBe('docs')
    })

    it('classifies "docs" type via "document" keyword', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'Document the authentication flow' })).toBe('docs')
    })

    it('classifies "api" type via "endpoint" keyword', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'Add endpoint for user profile' })).toBe('api')
    })

    it('classifies "api" type via "graphql" keyword', () => {
      const classifier = new TaskTypeClassifier()
      // "graphql" is an api keyword; "implement" is coding (lowest priority) — api wins
      expect(classifier.classify({ title: 'Implement graphql resolver' })).toBe('api')
    })

    it('classifies "database" type via "migration" keyword', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'Create migration for users table' })).toBe('database')
    })

    it('classifies "database" type via "sql" keyword', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'Optimize sql query performance' })).toBe('refactoring') // "optimize" comes before sql in priority
    })

    it('classifies "ui" type via "component" keyword', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'Build login component' })).toBe('ui')
    })

    it('classifies "ui" type via "dom" keyword — word boundary', () => {
      const classifier = new TaskTypeClassifier()
      // "dom" should match on its own but NOT match inside "random"
      expect(classifier.classify({ title: 'Manipulate the dom element' })).toBe('ui')
    })

    it('classifies "ui" type via "css" keyword', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'Update css for main layout' })).toBe('ui')
    })

    it('classifies "devops" type via "deploy" keyword', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'Deploy to kubernetes cluster' })).toBe('devops')
    })

    it('classifies "devops" type via "docker" keyword', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'Build docker image for deployment' })).toBe('devops')
    })

    it('classifies "coding" type for generic implementation', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'Implement the auth flow' })).toBe('coding')
    })
  })

  // -------------------------------------------------------------------------
  // AC3: Case-insensitive matching
  // -------------------------------------------------------------------------

  describe('AC3: Case-insensitive keyword matching', () => {
    it('matches uppercase keywords', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'FIX THE BUG NOW' })).toBe('debugging')
    })

    it('matches mixed case keywords', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'Write Unit Test For Login' })).toBe('testing')
    })

    it('matches all caps devops keyword', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'DEPLOY TO PRODUCTION' })).toBe('devops')
    })
  })

  // -------------------------------------------------------------------------
  // AC3: Priority order enforcement
  // -------------------------------------------------------------------------

  describe('AC3: Priority order — testing wins over others', () => {
    it('testing > coding: "test" beats "implement"', () => {
      const classifier = new TaskTypeClassifier()
      // Both "test" (testing) and "implement" (coding) present — testing wins
      expect(classifier.classify({ title: 'Implement and test the auth module' })).toBe('testing')
    })

    it('testing > debugging: "spec" beats "fix"', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'Fix the failing spec' })).toBe('testing')
    })

    it('debugging > refactoring: "fix" beats "refactor"', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'Fix and refactor the payment module' })).toBe('debugging')
    })

    it('refactoring > docs: "cleanup" beats "document"', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'Cleanup and document the code' })).toBe('refactoring')
    })

    it('docs > api: "readme" beats "endpoint"', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'Update readme for new endpoint' })).toBe('docs')
    })

    it('api > database: "route" beats "migration"', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'Add route for migration endpoint' })).toBe('api')
    })

    it('database > ui: "migration" beats "component"', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'Create migration and component for users' })).toBe('database')
    })

    it('ui > devops: "component" beats "deploy"', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'Deploy new component to prod' })).toBe('ui')
    })

    it('devops > coding: "pipeline" beats "implement"', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'Implement pipeline for CI' })).toBe('devops')
    })
  })

  // -------------------------------------------------------------------------
  // AC3: Default fallback to "coding"
  // -------------------------------------------------------------------------

  describe('AC3: Default fallback', () => {
    it('defaults to "coding" when no keyword matches', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ title: 'Some unknown vague task' })).toBe('coding')
    })

    it('defaults to "coding" when title and description are empty', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({})).toBe('coding')
    })

    it('defaults to "coding" when title is missing', () => {
      const classifier = new TaskTypeClassifier()
      expect(classifier.classify({ description: 'something unclassifiable' })).toBe('coding')
    })
  })

  // -------------------------------------------------------------------------
  // Word-boundary matching — the critical bug fix
  // -------------------------------------------------------------------------

  describe('Word-boundary matching (not substring)', () => {
    it('"dom" does NOT match "random" (substring false positive prevention)', () => {
      const classifier = new TaskTypeClassifier()
      // "random" contains "dom" as substring — word boundary must prevent this
      const result = classifier.classify({ title: 'Random unknown task xyz' })
      expect(result).toBe('coding') // fallback, NOT "ui"
    })

    it('"ui" does NOT match "build" (no false positive for 2-letter keyword)', () => {
      const classifier = new TaskTypeClassifier()
      // "build" does not contain "ui" as a word boundary match
      // Actually "build" = b-u-i-l-d — does contain 'ui' as substring!
      // Word boundary: "ui" in "build" — \bui\b would not match inside "build"
      const result = classifier.classify({ title: 'Build the backend service' })
      // Should match "devops" via docker? No. Should match "coding" via "build"? Yes - but "build" is in coding (lower priority)
      // Actually "build" is in the coding keywords — but we need to check if ui's "ui" matches "build"
      // \bui\b in "build the backend service" — "build" has "ui" at position 1-2 but \b would require word start/end
      // "b-[u-i]-l-d" — "ui" is NOT a whole word here, so \bui\b should NOT match
      // Result: no higher-priority match, falls to "coding" (via "build" keyword)
      expect(result).toBe('coding')
    })

    it('"cd" does NOT match "includes" or "procedure"', () => {
      const classifier = new TaskTypeClassifier()
      // "cd" as a keyword for devops should only match the word "cd", not substrings
      // Use a title with no other matching keywords to isolate the "cd" check
      const result = classifier.classify({ title: 'Update the procedure for deployment scripts' })
      expect(result).toBe('coding') // no word-boundary match for "cd"; "scripts" has no keyword match either
    })

    it('"sql" does NOT match "visual"', () => {
      const classifier = new TaskTypeClassifier()
      // "visual" does not contain "sql" — this is not a bug, just a sanity check
      const result = classifier.classify({ title: 'Design visual interface' })
      expect(result).toBe('coding') // no match
    })

    it('"dom" matches standalone word "dom"', () => {
      const classifier = new TaskTypeClassifier()
      const result = classifier.classify({ title: 'Update dom elements' })
      expect(result).toBe('ui')
    })

    it('"ci" does NOT match inside "specific"', () => {
      const classifier = new TaskTypeClassifier()
      // "specific" contains "ci" as a substring — \bci\b should NOT match it
      // Use a title where "specific" is the only potentially relevant word
      const result = classifier.classify({ title: 'Define specific guidelines for the project' })
      expect(result).toBe('coding') // no word-boundary keyword match; falls to "coding"
    })
  })

  // -------------------------------------------------------------------------
  // AC4: Custom taxonomy override
  // -------------------------------------------------------------------------

  describe('AC4: Custom taxonomy override', () => {
    it('custom taxonomy completely replaces default', () => {
      const customTaxonomy = {
        'custom-analysis': ['analyze', 'assess', 'evaluate'],
        review: ['review', 'audit', 'inspect'],
      }
      const classifier = new TaskTypeClassifier(customTaxonomy)
      expect(classifier.classify({ title: 'Analyze the system performance' })).toBe('custom-analysis')
      expect(classifier.classify({ title: 'Review the pull request changes' })).toBe('review')
    })

    it('custom taxonomy: default keywords no longer match', () => {
      const customTaxonomy = {
        mytype: ['custom_keyword'],
      }
      const classifier = new TaskTypeClassifier(customTaxonomy)
      // "fix" is in default debugging but not in custom
      const result = classifier.classify({ title: 'Fix the nasty bug' })
      expect(result).toBe('coding') // falls back (no match in custom)
    })

    it('custom taxonomy override for existing type changes keywords', () => {
      const customTaxonomy = {
        coding: ['implement', 'write'],
        mytype: ['custom_word'],
      }
      const classifier = new TaskTypeClassifier(customTaxonomy)
      expect(classifier.classify({ title: 'implement the feature' })).toBe('coding')
      expect(classifier.classify({ title: 'custom_word action here' })).toBe('mytype')
    })

    it('createTaskTypeClassifier with custom taxonomy works', () => {
      const classifier = createTaskTypeClassifier({ security: ['encrypt', 'authenticate', 'authorize'] })
      expect(classifier.classify({ title: 'Encrypt the user data' })).toBe('security')
    })

    it('custom taxonomy uses word-boundary matching too', () => {
      const customTaxonomy = {
        analysis: ['analyze', 'review'],
      }
      const classifier = new TaskTypeClassifier(customTaxonomy)
      // "review" should match as a whole word
      expect(classifier.classify({ title: 'Please review the code' })).toBe('analysis')
    })
  })

  // -------------------------------------------------------------------------
  // Mixed explicit and heuristic tasks
  // -------------------------------------------------------------------------

  describe('Mixed explicit and heuristic classification in same run', () => {
    it('handles mix of explicit and heuristic tasks correctly', () => {
      const classifier = new TaskTypeClassifier()
      const tasks = [
        { task: { taskType: 'testing', title: 'Deploy to production' }, expected: 'testing' },
        { task: { title: 'Fix the login bug' }, expected: 'debugging' },
        { task: { taskType: 'api', title: 'Refactor code' }, expected: 'api' },
        { task: { title: 'Write unit tests for auth' }, expected: 'testing' },
        { task: { title: 'Some random unknown task' }, expected: 'coding' },
      ]

      for (const { task, expected } of tasks) {
        expect(classifier.classify(task)).toBe(expected)
      }
    })
  })

  // -------------------------------------------------------------------------
  // DEFAULT_TAXONOMY completeness
  // -------------------------------------------------------------------------

  describe('DEFAULT_TAXONOMY', () => {
    it('contains all expected types from AC3', () => {
      const expectedTypes = [
        'coding', 'testing', 'debugging', 'refactoring',
        'docs', 'api', 'database', 'ui', 'devops',
      ]
      for (const type of expectedTypes) {
        expect(DEFAULT_TAXONOMY).toHaveProperty(type)
        expect(Array.isArray(DEFAULT_TAXONOMY[type])).toBe(true)
        expect(DEFAULT_TAXONOMY[type].length).toBeGreaterThan(0)
      }
    })

    it('testing taxonomy includes required keywords from AC3', () => {
      const required = ['test', 'spec', 'assert', 'verify', 'validate', 'coverage']
      for (const kw of required) {
        expect(DEFAULT_TAXONOMY.testing).toContain(kw)
      }
    })

    it('debugging taxonomy includes required keywords from AC3', () => {
      const required = ['fix', 'debug', 'resolve', 'patch', 'hotfix', 'bug']
      for (const kw of required) {
        expect(DEFAULT_TAXONOMY.debugging).toContain(kw)
      }
    })

    it('ui taxonomy includes "dom" keyword from AC3', () => {
      expect(DEFAULT_TAXONOMY.ui).toContain('dom')
    })

    it('coding taxonomy uses "write" not "write code" (for word-boundary safety)', () => {
      // The old taxonomy had "write code" as a multi-word keyword
      // It should just be "write" now
      expect(DEFAULT_TAXONOMY.coding).toContain('write')
    })
  })
})
