/**
 * Ynab cross-project fixture — Story 43-12.
 *
 * Provides five representative story scenarios from the ynab validation project
 * for fixture-based cross-project behavioral parity testing.
 *
 * IMPORTANT: No actual ynab project files are read at runtime.
 * The fixture path '/fixtures/ynab' is a symbolic string, not a real filesystem path.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface YnabFixtureStory {
  storyKey: string
  storyContent: string
  expectedStatus: 'complete' | 'escalated'
  conflictGroup?: string
  phases: Array<{ nodeId: string; outcomeStatus: 'SUCCESS' | 'FAIL' }>
}

// ---------------------------------------------------------------------------
// Story content template
// ---------------------------------------------------------------------------

export const STORY_CONTENT_TEMPLATE = (storyKey: string): string =>
  `# Story ${storyKey}: Test Story\n\n## Story\nAs a developer, I want to implement story ${storyKey}.\n\n## Acceptance Criteria\n\n### AC1:\n**Given** context\n**When** action\n**Then** outcome\n`

// ---------------------------------------------------------------------------
// Fixture stories
// ---------------------------------------------------------------------------

/**
 * Five representative ynab story scenarios:
 * - '1-1': happy-path (all SUCCESS)
 * - '1-2': rework-cycle (code_review FAIL then SUCCESS)
 * - '1-3': escalation (code_review always FAIL, maxReviewCycles=2 → 3 attempts)
 * - '1-4': conflict-group ordering hint (conflictGroup: 'contracts-g1')
 * - '1-5': conflict-group ordering hint (conflictGroup: 'contracts-g1')
 *
 * NOTE (Story 75-4): With worktrees enabled (Story 75-1+), per-story git worktrees
 * are the primary concurrency-safety mechanism — each story runs in its own
 * isolated `.substrate-worktrees/story-<key>` worktree on a dedicated branch,
 * preventing file-system races regardless of conflict-group membership.
 * `conflictGroup` is still useful as an ordering hint (stories in the same
 * group are serialised for logical sequencing) but is no longer the safety
 * backstop against concurrent file-system mutations.
 */
export const YNAB_FIXTURE_STORIES: YnabFixtureStory[] = [
  {
    storyKey: '1-1',
    storyContent: STORY_CONTENT_TEMPLATE('1-1'),
    expectedStatus: 'complete',
    phases: [
      { nodeId: 'create_story', outcomeStatus: 'SUCCESS' },
      { nodeId: 'dev_story', outcomeStatus: 'SUCCESS' },
      { nodeId: 'code_review', outcomeStatus: 'SUCCESS' },
    ],
  },
  {
    storyKey: '1-2',
    storyContent: STORY_CONTENT_TEMPLATE('1-2'),
    expectedStatus: 'complete',
    phases: [
      { nodeId: 'create_story', outcomeStatus: 'SUCCESS' },
      { nodeId: 'dev_story', outcomeStatus: 'SUCCESS' },
      { nodeId: 'code_review', outcomeStatus: 'FAIL' },
      { nodeId: 'dev_story', outcomeStatus: 'SUCCESS' },
      { nodeId: 'code_review', outcomeStatus: 'SUCCESS' },
    ],
  },
  {
    storyKey: '1-3',
    storyContent: STORY_CONTENT_TEMPLATE('1-3'),
    expectedStatus: 'escalated',
    phases: [
      { nodeId: 'create_story', outcomeStatus: 'SUCCESS' },
      { nodeId: 'dev_story', outcomeStatus: 'SUCCESS' },
      { nodeId: 'code_review', outcomeStatus: 'FAIL' },
      { nodeId: 'dev_story', outcomeStatus: 'SUCCESS' },
      { nodeId: 'code_review', outcomeStatus: 'FAIL' },
      { nodeId: 'dev_story', outcomeStatus: 'SUCCESS' },
      { nodeId: 'code_review', outcomeStatus: 'FAIL' },
    ],
  },
  {
    storyKey: '1-4',
    storyContent: STORY_CONTENT_TEMPLATE('1-4'),
    expectedStatus: 'complete',
    conflictGroup: 'contracts-g1',
    phases: [
      { nodeId: 'create_story', outcomeStatus: 'SUCCESS' },
      { nodeId: 'dev_story', outcomeStatus: 'SUCCESS' },
      { nodeId: 'code_review', outcomeStatus: 'SUCCESS' },
    ],
  },
  {
    storyKey: '1-5',
    storyContent: STORY_CONTENT_TEMPLATE('1-5'),
    expectedStatus: 'complete',
    conflictGroup: 'contracts-g1',
    phases: [
      { nodeId: 'create_story', outcomeStatus: 'SUCCESS' },
      { nodeId: 'dev_story', outcomeStatus: 'SUCCESS' },
      { nodeId: 'code_review', outcomeStatus: 'SUCCESS' },
    ],
  },
]

// ---------------------------------------------------------------------------
// Project config
// ---------------------------------------------------------------------------

export const YNAB_PROJECT_CONFIG = {
  projectRoot: '/fixtures/ynab',
  methodologyPack: 'default',
  maxConcurrency: 1,
  maxReviewCycles: 2,
}
