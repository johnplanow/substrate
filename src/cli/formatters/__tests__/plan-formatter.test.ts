/**
 * Unit tests for plan-formatter.ts
 *
 * Covers AC1, AC7, AC8 — human-readable formatting of plans.
 */

import { describe, it, expect } from 'vitest'
import {
  formatPlanForDisplay,
  formatPlanList,
  formatPlanDetail,
} from '../plan-formatter.js'
import type { Plan } from '../../../persistence/queries/plans.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makePlanResult = (overrides: Record<string, unknown> = {}) => ({
  success: true,
  planningAgent: 'claude',
  taskCount: 2,
  estimatedExecutionCost: 0.35,
  taskGraph: {
    version: '1',
    session: { name: 'test-plan' },
    tasks: {
      'setup-project': {
        name: 'Setup Project',
        description: 'Initialize the project structure and install dependencies.',
        prompt: 'Set up the project',
        type: 'coding' as const,
        depends_on: [],
        budget_usd: 0.10,
      },
      'implement-api': {
        name: 'Implement API',
        description: 'Build REST API endpoints for users and posts.',
        prompt: 'Implement the API',
        type: 'coding' as const,
        depends_on: ['setup-project'],
        budget_usd: 0.25,
      },
    },
  },
  ...overrides,
})

const makePlan = (overrides: Partial<Plan> = {}): Plan => ({
  id: 'abc12345-6789-0000-0000-000000000001',
  description: 'Add authentication to the app',
  task_count: 3,
  estimated_cost_usd: 0.45,
  planning_agent: 'claude',
  plan_yaml: 'version: "1"\nsession:\n  name: test\ntasks: {}',
  status: 'approved',
  created_at: '2026-02-20T12:00:00.000Z',
  updated_at: '2026-02-20T12:01:00.000Z',
  ...overrides,
})

// ---------------------------------------------------------------------------
// formatPlanForDisplay
// ---------------------------------------------------------------------------

describe('formatPlanForDisplay', () => {
  it('AC1: includes planning agent, task count, estimated cost', () => {
    const result = formatPlanForDisplay(makePlanResult())
    expect(result).toContain('Planning agent: claude')
    expect(result).toContain('Task count:     2')
    expect(result).toContain('Estimated cost: $0.35')
  })

  it('AC1: includes task IDs and types', () => {
    const result = formatPlanForDisplay(makePlanResult())
    expect(result).toContain('setup-project')
    expect(result).toContain('implement-api')
    expect(result).toContain('[coding]')
  })

  it('AC1: includes task descriptions', () => {
    const result = formatPlanForDisplay(makePlanResult())
    expect(result).toContain('Initialize the project structure')
    expect(result).toContain('Build REST API endpoints')
  })

  it('AC1: task with no deps shows depends_on: (none)', () => {
    const result = formatPlanForDisplay(makePlanResult())
    expect(result).toContain('depends_on: (none)')
  })

  it('AC1: task with deps shows dependency IDs', () => {
    const result = formatPlanForDisplay(makePlanResult())
    expect(result).toContain('depends_on: setup-project')
  })

  it('AC1: includes subscription routing line', () => {
    const result = formatPlanForDisplay(makePlanResult())
    expect(result).toContain('Subscription routing:')
  })

  it('AC1: includes header and footer', () => {
    const result = formatPlanForDisplay(makePlanResult())
    expect(result).toContain('=== Generated Plan ===')
    expect(result).toContain('======================')
  })

  it('AC1: truncates description to 80 chars', () => {
    const longDesc = 'A'.repeat(100)
    const result = formatPlanForDisplay(
      makePlanResult({
        taskGraph: {
          version: '1',
          session: { name: 'test' },
          tasks: {
            'long-task': {
              name: 'Long Task',
              description: longDesc,
              prompt: 'do it',
              type: 'coding' as const,
              depends_on: [],
            },
          },
        },
      }),
    )
    // Description should be truncated (80 chars + '...')
    expect(result).toContain('A'.repeat(80) + '...')
    expect(result).not.toContain('A'.repeat(100))
  })

  it('AC1: shows agent assignment', () => {
    const result = formatPlanForDisplay(makePlanResult())
    // Default: no task.agent, so shows policy-routed
    expect(result).toContain('agent: policy-routed')
  })

  it('AC1: handles plan with no tasks', () => {
    const result = formatPlanForDisplay(
      makePlanResult({
        taskCount: 0,
        taskGraph: {
          version: '1',
          session: { name: 'empty-plan' },
          tasks: {},
        },
      }),
    )
    expect(result).toContain('Task count:     0')
  })

  it('AC1: handles missing taskGraph', () => {
    const result = formatPlanForDisplay({
      success: true,
      planningAgent: 'claude',
      taskCount: 0,
      estimatedExecutionCost: 0,
    })
    expect(result).toContain('=== Generated Plan ===')
    expect(result).toContain('======================')
  })
})

// ---------------------------------------------------------------------------
// formatPlanList
// ---------------------------------------------------------------------------

describe('formatPlanList', () => {
  it('AC7: shows "No plans found." when empty', () => {
    const result = formatPlanList([])
    expect(result).toBe('No plans found.')
  })

  it('AC7: includes column headers', () => {
    const result = formatPlanList([makePlan()])
    expect(result).toContain('ID')
    expect(result).toContain('DATE')
    expect(result).toContain('TASKS')
    expect(result).toContain('EST. COST')
    expect(result).toContain('STATUS')
    expect(result).toContain('DESCRIPTION')
  })

  it('AC7: ID truncated to 8 chars', () => {
    const plan = makePlan({ id: 'abc12345-6789-0000-0000-000000000001' })
    const result = formatPlanList([plan])
    expect(result).toContain('abc12345')
    // Should not show the full ID
    expect(result).not.toContain('abc12345-6789')
  })

  it('AC7: date truncated to first 10 chars', () => {
    const plan = makePlan({ created_at: '2026-02-20T12:00:00.000Z' })
    const result = formatPlanList([plan])
    expect(result).toContain('2026-02-20')
  })

  it('AC7: cost formatted as $X.XX', () => {
    const plan = makePlan({ estimated_cost_usd: 0.45 })
    const result = formatPlanList([plan])
    expect(result).toContain('$0.45')
  })

  it('AC7: status shown', () => {
    const plan = makePlan({ status: 'approved' })
    const result = formatPlanList([plan])
    expect(result).toContain('approved')
  })

  it('AC7: description truncated to 60 chars', () => {
    const longDesc = 'B'.repeat(80)
    const plan = makePlan({ description: longDesc })
    const result = formatPlanList([plan])
    expect(result).toContain('B'.repeat(60))
    expect(result).not.toContain('B'.repeat(61))
  })

  it('AC7: shows multiple plans', () => {
    const plans = [
      makePlan({ id: 'plan0001-0000-0000-0000-000000000001', description: 'First plan' }),
      makePlan({ id: 'plan0002-0000-0000-0000-000000000002', description: 'Second plan' }),
    ]
    const result = formatPlanList(plans)
    expect(result).toContain('First plan')
    expect(result).toContain('Second plan')
  })
})

// ---------------------------------------------------------------------------
// formatPlanDetail
// ---------------------------------------------------------------------------

describe('formatPlanDetail', () => {
  it('AC8: includes all plan fields', () => {
    const plan = makePlan()
    const result = formatPlanDetail(plan)
    expect(result).toContain(plan.id)
    expect(result).toContain(plan.status)
    expect(result).toContain(plan.planning_agent)
    expect(result).toContain(String(plan.task_count))
    expect(result).toContain(plan.description)
    expect(result).toContain(plan.created_at)
    expect(result).toContain(plan.updated_at)
  })

  it('AC8: includes full plan YAML content', () => {
    const plan = makePlan()
    const result = formatPlanDetail(plan)
    expect(result).toContain(plan.plan_yaml)
    expect(result).toContain('--- Plan YAML ---')
  })

  it('AC8: includes header and footer', () => {
    const plan = makePlan()
    const result = formatPlanDetail(plan)
    expect(result).toContain('=== Plan Detail ===')
    expect(result).toContain('=================')
  })

  it('AC8: estimated cost formatted as $X.XX', () => {
    const plan = makePlan({ estimated_cost_usd: 0.45 })
    const result = formatPlanDetail(plan)
    expect(result).toContain('$0.45')
  })
})
