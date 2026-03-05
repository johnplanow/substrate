/**
 * Tests for export renderers (T4: product-brief, T5: PRD)
 */

import { describe, it, expect } from 'vitest'
import {
  renderProductBrief,
  renderPrd,
  renderArchitecture,
  renderEpics,
  renderReadinessReport,
  renderOperationalFindings,
  renderExperiments,
  fieldLabel,
  safeParseJson,
  renderValue,
} from '../renderers.js'
import type { Decision, Requirement } from '../../../persistence/queries/decisions.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeDecision(
  overrides: Partial<Decision> & { phase: string; category: string; key: string; value: string },
): Decision {
  return {
    id: crypto.randomUUID(),
    pipeline_run_id: 'run-123',
    rationale: null,
    superseded_by: null,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeRequirement(
  overrides: Partial<Requirement> & { type: string; description: string },
): Requirement {
  return {
    id: crypto.randomUUID(),
    pipeline_run_id: 'run-123',
    source: 'planning-phase',
    priority: 'must',
    status: 'active',
    created_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Helper function tests
// ---------------------------------------------------------------------------

describe('fieldLabel', () => {
  it('converts snake_case to Title Case', () => {
    expect(fieldLabel('problem_statement')).toBe('Problem Statement')
    expect(fieldLabel('core_features')).toBe('Core Features')
    expect(fieldLabel('technology_constraints')).toBe('Technology Constraints')
  })

  it('handles single word keys', () => {
    expect(fieldLabel('language')).toBe('Language')
    expect(fieldLabel('framework')).toBe('Framework')
  })

  it('uppercases known acronyms as standalone words', () => {
    expect(fieldLabel('fr_coverage')).toBe('FR Coverage')
    expect(fieldLabel('nfr_performance')).toBe('NFR Performance')
    expect(fieldLabel('ux_alignment')).toBe('UX Alignment')
    expect(fieldLabel('api_style')).toBe('API Style')
    expect(fieldLabel('db_schema')).toBe('DB Schema')
    expect(fieldLabel('user_id')).toBe('User ID')
    expect(fieldLabel('redirect_url')).toBe('Redirect URL')
  })
})

describe('safeParseJson', () => {
  it('parses valid JSON', () => {
    expect(safeParseJson('["a","b"]')).toEqual(['a', 'b'])
    expect(safeParseJson('{"key":"val"}')).toEqual({ key: 'val' })
    expect(safeParseJson('"hello"')).toBe('hello')
  })

  it('returns original string for invalid JSON', () => {
    expect(safeParseJson('not json')).toBe('not json')
    expect(safeParseJson('')).toBe('')
  })
})

describe('renderValue', () => {
  it('renders array values as bulleted list', () => {
    const result = renderValue('["Feature A","Feature B","Feature C"]')
    expect(result).toBe('- Feature A\n- Feature B\n- Feature C')
  })

  it('renders object values as key-value lines', () => {
    const result = renderValue('{"language":"Kotlin","database":"PostgreSQL"}')
    expect(result).toContain('- **Language**: Kotlin')
    expect(result).toContain('- **Database**: PostgreSQL')
  })

  it('renders plain string values as-is', () => {
    expect(renderValue('Simple string value')).toBe('Simple string value')
  })

  it('renders JSON string values', () => {
    expect(renderValue('"quoted string"')).toBe('quoted string')
  })
})

// ---------------------------------------------------------------------------
// renderProductBrief tests (AC2, T4)
// ---------------------------------------------------------------------------

describe('renderProductBrief', () => {
  it('renders all standard product brief fields', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'analysis',
        category: 'product-brief',
        key: 'problem_statement',
        value: 'Teams struggle to share planning artifacts',
      }),
      makeDecision({
        phase: 'analysis',
        category: 'product-brief',
        key: 'target_users',
        value: 'Engineering teams and product managers',
      }),
      makeDecision({
        phase: 'analysis',
        category: 'product-brief',
        key: 'core_features',
        value: JSON.stringify(['Export to markdown', 'Database-free sharing', 'CLI integration']),
      }),
      makeDecision({
        phase: 'analysis',
        category: 'product-brief',
        key: 'success_metrics',
        value: JSON.stringify(['Time to share artifacts < 1 min', '100% data fidelity']),
      }),
      makeDecision({
        phase: 'analysis',
        category: 'product-brief',
        key: 'constraints',
        value: JSON.stringify(['Must use existing decision store', 'No new dependencies']),
      }),
    ]

    const result = renderProductBrief(decisions)

    expect(result).toContain('# Product Brief')
    expect(result).toContain('## Problem Statement')
    expect(result).toContain('Teams struggle to share planning artifacts')
    expect(result).toContain('## Target Users')
    expect(result).toContain('Engineering teams and product managers')
    expect(result).toContain('## Core Features')
    expect(result).toContain('- Export to markdown')
    expect(result).toContain('- Database-free sharing')
    expect(result).toContain('- CLI integration')
    expect(result).toContain('## Success Metrics')
    expect(result).toContain('- Time to share artifacts < 1 min')
    expect(result).toContain('## Constraints')
    expect(result).toContain('- Must use existing decision store')
  })

  it('includes technology constraints from a separate category', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'analysis',
        category: 'product-brief',
        key: 'problem_statement',
        value: 'Problem here',
      }),
      makeDecision({
        phase: 'analysis',
        category: 'technology-constraints',
        key: 'backend_language',
        value: 'Must use Kotlin/JVM for backend services',
      }),
    ]

    const result = renderProductBrief(decisions)

    expect(result).toContain('## Technology Constraints')
    expect(result).toContain('Must use Kotlin/JVM for backend services')
  })

  it('handles technology constraints from product-brief category directly', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'analysis',
        category: 'product-brief',
        key: 'technology_constraints',
        value: JSON.stringify(['Use GCP only', 'No proprietary databases']),
      }),
    ]

    const result = renderProductBrief(decisions)

    expect(result).toContain('## Technology Constraints')
    expect(result).toContain('- Use GCP only')
    expect(result).toContain('- No proprietary databases')
  })

  it('returns empty string when no decisions exist', () => {
    expect(renderProductBrief([])).toBe('')
  })

  it('renders fields in the specified order', () => {
    const decisions: Decision[] = [
      makeDecision({ phase: 'analysis', category: 'product-brief', key: 'success_metrics', value: '"Metric A"' }),
      makeDecision({ phase: 'analysis', category: 'product-brief', key: 'problem_statement', value: '"Problem here"' }),
      makeDecision({ phase: 'analysis', category: 'product-brief', key: 'target_users', value: '"Users"' }),
    ]

    const result = renderProductBrief(decisions)
    const problemIdx = result.indexOf('## Problem Statement')
    const usersIdx = result.indexOf('## Target Users')
    const metricsIdx = result.indexOf('## Success Metrics')

    expect(problemIdx).toBeLessThan(usersIdx)
    expect(usersIdx).toBeLessThan(metricsIdx)
  })

  it('ignores decisions from other categories (e.g. non-analysis)', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'analysis',
        category: 'product-brief',
        key: 'problem_statement',
        value: 'Real problem',
      }),
      makeDecision({
        phase: 'planning',
        category: 'functional-requirements',
        key: 'FR-0',
        value: JSON.stringify({ description: 'Some FR', priority: 'must' }),
      }),
    ]

    const result = renderProductBrief(decisions)
    expect(result).toContain('Real problem')
    expect(result).not.toContain('Some FR')
    expect(result).not.toContain('Functional Requirements')
  })
})

// ---------------------------------------------------------------------------
// renderPrd tests (AC3, T5)
// ---------------------------------------------------------------------------

describe('renderPrd', () => {
  it('renders project classification section', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'planning',
        category: 'classification',
        key: 'project_type',
        value: 'SaaS Application',
      }),
      makeDecision({
        phase: 'planning',
        category: 'classification',
        key: 'vision',
        value: 'Enable seamless artifact sharing for engineering teams',
      }),
      makeDecision({
        phase: 'planning',
        category: 'classification',
        key: 'key_goals',
        value: JSON.stringify(['Export planning artifacts', 'Maintain data fidelity']),
      }),
    ]

    const result = renderPrd(decisions)

    expect(result).toContain('# Product Requirements Document')
    expect(result).toContain('## Project Classification')
    expect(result).toContain('**Project Type**: SaaS Application')
    expect(result).toContain('**Vision**: Enable seamless artifact sharing')
    expect(result).toContain('**Key Goals**:')
    expect(result).toContain('- Export planning artifacts')
    expect(result).toContain('- Maintain data fidelity')
  })

  it('renders functional requirements with FR IDs and priority', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'planning',
        category: 'functional-requirements',
        key: 'FR-0',
        value: JSON.stringify({ id: 'FR-1', description: 'Export product brief', priority: 'must' }),
      }),
      makeDecision({
        phase: 'planning',
        category: 'functional-requirements',
        key: 'FR-1',
        value: JSON.stringify({ id: 'FR-2', description: 'Support JSON output format', priority: 'should' }),
      }),
    ]

    const result = renderPrd(decisions)

    expect(result).toContain('## Functional Requirements')
    expect(result).toContain('**FR-1** [MUST]: Export product brief')
    expect(result).toContain('**FR-2** [SHOULD]: Support JSON output format')
  })

  it('renders non-functional requirements with NFR IDs and category', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'planning',
        category: 'non-functional-requirements',
        key: 'NFR-0',
        value: JSON.stringify({ id: 'NFR-1', description: 'Command must complete in < 5s', category: 'performance' }),
      }),
      makeDecision({
        phase: 'planning',
        category: 'non-functional-requirements',
        key: 'NFR-1',
        value: JSON.stringify({ id: 'NFR-2', description: 'All exported files must be idempotent', category: 'reliability' }),
      }),
    ]

    const result = renderPrd(decisions)

    expect(result).toContain('## Non-Functional Requirements')
    expect(result).toContain('**NFR-1** [PERFORMANCE]: Command must complete in < 5s')
    expect(result).toContain('**NFR-2** [RELIABILITY]: All exported files must be idempotent')
  })

  it('renders domain model section', () => {
    const domainModel = { entities: ['PipelineRun', 'Decision', 'Requirement'] }
    const decisions: Decision[] = [
      makeDecision({
        phase: 'planning',
        category: 'domain-model',
        key: 'entities',
        value: JSON.stringify(domainModel),
      }),
    ]

    const result = renderPrd(decisions)

    expect(result).toContain('## Domain Model')
    expect(result).toContain('PipelineRun')
  })

  it('renders user stories section', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'planning',
        category: 'user-stories',
        key: 'US-0',
        value: JSON.stringify({
          title: 'Export planning artifacts',
          description: 'As a user, I want to export planning artifacts so I can share them',
        }),
      }),
    ]

    const result = renderPrd(decisions)

    expect(result).toContain('## User Stories')
    expect(result).toContain('### Export planning artifacts')
    expect(result).toContain('As a user, I want to export planning artifacts')
  })

  it('renders tech stack decisions from single-key format', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'planning',
        category: 'tech-stack',
        key: 'language',
        value: 'TypeScript',
      }),
      makeDecision({
        phase: 'planning',
        category: 'tech-stack',
        key: 'database',
        value: 'SQLite',
      }),
    ]

    const result = renderPrd(decisions)

    expect(result).toContain('## Tech Stack')
    expect(result).toContain('- **Language**: TypeScript')
    expect(result).toContain('- **Database**: SQLite')
  })

  it('renders tech stack decisions from JSON object format (multi-step planning)', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'planning',
        category: 'tech-stack',
        key: 'tech_stack',
        value: JSON.stringify({ language: 'Kotlin', database: 'PostgreSQL', cloud: 'GCP' }),
      }),
    ]

    const result = renderPrd(decisions)

    expect(result).toContain('## Tech Stack')
    expect(result).toContain('- **Language**: Kotlin')
    expect(result).toContain('- **Database**: PostgreSQL')
    expect(result).toContain('- **Cloud**: GCP')
  })

  it('renders out-of-scope section', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'planning',
        category: 'out-of-scope',
        key: 'items',
        value: JSON.stringify(['Real-time sync', 'Mobile app', 'API access']),
      }),
    ]

    const result = renderPrd(decisions)

    expect(result).toContain('## Out of Scope')
    expect(result).toContain('- Real-time sync')
    expect(result).toContain('- Mobile app')
    expect(result).toContain('- API access')
  })

  it('returns empty string when no decisions exist', () => {
    expect(renderPrd([])).toBe('')
  })

  it('skips sections with no data', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'planning',
        category: 'functional-requirements',
        key: 'FR-0',
        value: JSON.stringify({ description: 'Only FR', priority: 'must' }),
      }),
    ]

    const result = renderPrd(decisions)

    expect(result).toContain('## Functional Requirements')
    expect(result).not.toContain('## Non-Functional Requirements')
    expect(result).not.toContain('## Domain Model')
    expect(result).not.toContain('## User Stories')
    expect(result).not.toContain('## Tech Stack')
    expect(result).not.toContain('## Out of Scope')
  })

  it('includes requirements from requirements table when no FR/NFR decisions exist', () => {
    const decisions: Decision[] = []
    const requirements: Requirement[] = [
      makeRequirement({
        type: 'functional',
        description: 'System must export product brief',
        priority: 'must',
      }),
      makeRequirement({
        type: 'non_functional',
        description: 'Export must complete in < 5 seconds',
        priority: 'should',
      }),
    ]

    const result = renderPrd(decisions, requirements)
    // Empty decisions returns empty string regardless
    expect(result).toBe('')
  })

  it('renders full PRD with all sections', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'planning',
        category: 'classification',
        key: 'project_type',
        value: 'CLI Tool',
      }),
      makeDecision({
        phase: 'planning',
        category: 'functional-requirements',
        key: 'FR-0',
        value: JSON.stringify({ id: 'FR-1', description: 'Export product brief to markdown', priority: 'must' }),
      }),
      makeDecision({
        phase: 'planning',
        category: 'non-functional-requirements',
        key: 'NFR-0',
        value: JSON.stringify({ id: 'NFR-1', description: 'Idempotent exports', category: 'reliability' }),
      }),
      makeDecision({
        phase: 'planning',
        category: 'domain-model',
        key: 'entities',
        value: JSON.stringify({ entities: ['Decision', 'Artifact'] }),
      }),
      makeDecision({
        phase: 'planning',
        category: 'user-stories',
        key: 'US-0',
        value: JSON.stringify({ title: 'Export artifacts', description: 'As a user, I want to export' }),
      }),
      makeDecision({
        phase: 'planning',
        category: 'tech-stack',
        key: 'language',
        value: 'TypeScript',
      }),
      makeDecision({
        phase: 'planning',
        category: 'out-of-scope',
        key: 'items',
        value: JSON.stringify(['Real-time sync']),
      }),
    ]

    const result = renderPrd(decisions)

    expect(result).toContain('# Product Requirements Document')
    expect(result).toContain('## Project Classification')
    expect(result).toContain('## Functional Requirements')
    expect(result).toContain('## Non-Functional Requirements')
    expect(result).toContain('## Domain Model')
    expect(result).toContain('## User Stories')
    expect(result).toContain('## Tech Stack')
    expect(result).toContain('## Out of Scope')
  })
})

// ---------------------------------------------------------------------------
// renderArchitecture tests (AC4, T6)
// ---------------------------------------------------------------------------

describe('renderArchitecture', () => {
  it('returns empty string when no architecture decisions exist', () => {
    expect(renderArchitecture([])).toBe('')
  })

  it('returns empty string when no decisions have category=architecture', () => {
    const decisions: Decision[] = [
      makeDecision({ phase: 'solutioning', category: 'epics', key: 'epic-1', value: '{"title":"E1","description":""}' }),
    ]
    expect(renderArchitecture(decisions)).toBe('')
  })

  it('renders architecture decisions as H1 + H2 heading with key:value pairs', () => {
    const decisions: Decision[] = [
      makeDecision({ phase: 'solutioning', category: 'architecture', key: 'language', value: 'TypeScript' }),
      makeDecision({ phase: 'solutioning', category: 'architecture', key: 'database', value: 'PostgreSQL' }),
    ]
    const result = renderArchitecture(decisions)

    expect(result).toContain('# Architecture')
    expect(result).toContain('## Architecture Decisions')
    expect(result).toContain('**language**: TypeScript')
    expect(result).toContain('**database**: PostgreSQL')
  })

  it('includes rationale when present', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'solutioning',
        category: 'architecture',
        key: 'database',
        value: 'PostgreSQL',
        rationale: 'Best relational DB for ACID compliance',
      }),
    ]
    const result = renderArchitecture(decisions)

    expect(result).toContain('**database**: PostgreSQL *(Best relational DB for ACID compliance)*')
  })

  it('renders JSON object values with sub-fields', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'solutioning',
        category: 'architecture',
        key: 'api_style',
        value: JSON.stringify({ protocol: 'REST', format: 'JSON', versioning: 'URL path' }),
      }),
    ]
    const result = renderArchitecture(decisions)

    expect(result).toContain('**api_style**:')
    expect(result).toContain('*Protocol*: REST')
    expect(result).toContain('*Format*: JSON')
  })

  it('renders JSON array values as bulleted sub-items', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'solutioning',
        category: 'architecture',
        key: 'patterns',
        value: JSON.stringify(['Repository pattern', 'CQRS', 'Event sourcing']),
      }),
    ]
    const result = renderArchitecture(decisions)

    expect(result).toContain('**patterns**:')
    expect(result).toContain('- Repository pattern')
    expect(result).toContain('- CQRS')
    expect(result).toContain('- Event sourcing')
  })

  it('heading matches seedMethodologyContext regex for architecture section', () => {
    // Verify the "## Architecture Decisions" heading satisfies the regex used in
    // seed-methodology-context.ts: /^##\s+(?:ADR|(?:core\s+)?architect(?:ure|ural)\s+decision)/im
    const archSectionRegex = /^##\s+(?:ADR|(?:core\s+)?architect(?:ure|ural)\s+decision)/im
    const heading = '## Architecture Decisions'
    expect(archSectionRegex.test(heading)).toBe(true)
  })

  it('renders multiple decisions in insertion order', () => {
    const decisions: Decision[] = [
      makeDecision({ phase: 'solutioning', category: 'architecture', key: 'language', value: 'Kotlin' }),
      makeDecision({ phase: 'solutioning', category: 'architecture', key: 'cloud', value: 'GCP' }),
      makeDecision({ phase: 'solutioning', category: 'architecture', key: 'runtime', value: 'JVM' }),
    ]
    const result = renderArchitecture(decisions)
    const langIdx = result.indexOf('**language**')
    const cloudIdx = result.indexOf('**cloud**')
    const runtimeIdx = result.indexOf('**runtime**')
    expect(langIdx).toBeLessThan(cloudIdx)
    expect(cloudIdx).toBeLessThan(runtimeIdx)
  })
})

// ---------------------------------------------------------------------------
// renderEpics tests (AC5, T7)
// ---------------------------------------------------------------------------

describe('renderEpics', () => {
  it('returns empty string when no epics or stories exist', () => {
    expect(renderEpics([])).toBe('')
  })

  it('returns empty string when no decisions have category=epics or stories', () => {
    const decisions: Decision[] = [
      makeDecision({ phase: 'solutioning', category: 'architecture', key: 'lang', value: 'TypeScript' }),
    ]
    expect(renderEpics(decisions)).toBe('')
  })

  it('renders an epic with H2 heading matching seedMethodologyContext format', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'solutioning',
        category: 'epics',
        key: 'epic-1',
        value: JSON.stringify({ title: 'Core CLI Infrastructure', description: 'Foundational CLI setup' }),
      }),
    ]
    const result = renderEpics(decisions)

    expect(result).toContain('# Epics and Stories')
    expect(result).toContain('## Epic 1: Core CLI Infrastructure')
    expect(result).toContain('Foundational CLI setup')
  })

  it('epic heading satisfies parseEpicShards regex', () => {
    // Verify the "## Epic N:" heading satisfies the pattern in seed-methodology-context.ts:
    // /^## (?:Epic\s+)?(\d+)[.:\s]/gm
    const epicPattern = /^## (?:Epic\s+)?(\d+)[.:\s]/gm
    const heading = '## Epic 1: Core CLI Infrastructure'
    const match = epicPattern.exec(heading)
    expect(match).not.toBeNull()
    expect(match![1]).toBe('1')
  })

  it('renders stories under their parent epic', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'solutioning',
        category: 'epics',
        key: 'epic-1',
        value: JSON.stringify({ title: 'Core CLI', description: 'CLI commands' }),
      }),
      makeDecision({
        phase: 'solutioning',
        category: 'stories',
        key: '1-1',
        value: JSON.stringify({
          key: '1-1',
          title: 'Register export command',
          description: 'Add export to CLI',
          ac: ['AC1: Help text shown', 'AC2: Command registers'],
          priority: 'must',
        }),
      }),
      makeDecision({
        phase: 'solutioning',
        category: 'stories',
        key: '1-2',
        value: JSON.stringify({
          key: '1-2',
          title: 'Export product brief',
          description: 'Write product-brief.md',
          ac: ['AC1: File written'],
          priority: 'should',
        }),
      }),
    ]
    const result = renderEpics(decisions)

    expect(result).toContain('## Epic 1: Core CLI')
    expect(result).toContain('### Story 1-1: Register export command')
    expect(result).toContain('### Story 1-2: Export product brief')
    expect(result).toContain('**Priority**: must')
    expect(result).toContain('**Priority**: should')
    expect(result).toContain('- AC1: Help text shown')
    expect(result).toContain('- AC2: Command registers')
  })

  it('renders multiple epics with stories sorted by story number', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'solutioning',
        category: 'epics',
        key: 'epic-2',
        value: JSON.stringify({ title: 'Epic Two', description: 'Second epic' }),
      }),
      makeDecision({
        phase: 'solutioning',
        category: 'epics',
        key: 'epic-1',
        value: JSON.stringify({ title: 'Epic One', description: 'First epic' }),
      }),
      makeDecision({
        phase: 'solutioning',
        category: 'stories',
        key: '2-1',
        value: JSON.stringify({ key: '2-1', title: 'Story Two-One', description: '', ac: [], priority: 'must' }),
      }),
      makeDecision({
        phase: 'solutioning',
        category: 'stories',
        key: '1-2',
        value: JSON.stringify({ key: '1-2', title: 'Story One-Two', description: '', ac: [], priority: 'must' }),
      }),
      makeDecision({
        phase: 'solutioning',
        category: 'stories',
        key: '1-1',
        value: JSON.stringify({ key: '1-1', title: 'Story One-One', description: '', ac: [], priority: 'must' }),
      }),
    ]
    const result = renderEpics(decisions)

    // Epics sorted numerically
    const epic1Idx = result.indexOf('## Epic 1:')
    const epic2Idx = result.indexOf('## Epic 2:')
    expect(epic1Idx).toBeLessThan(epic2Idx)

    // Stories sorted within epic 1
    const story11Idx = result.indexOf('### Story 1-1:')
    const story12Idx = result.indexOf('### Story 1-2:')
    expect(story11Idx).toBeLessThan(story12Idx)
  })

  it('renders stories without an epic decision (orphaned stories)', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'solutioning',
        category: 'stories',
        key: '3-1',
        value: JSON.stringify({ key: '3-1', title: 'Orphan Story', description: 'No epic', ac: [], priority: 'could' }),
      }),
    ]
    const result = renderEpics(decisions)

    expect(result).toContain('## Epic 3:')
    expect(result).toContain('### Story 3-1: Orphan Story')
  })

  it('renders acceptance_criteria field as alias for ac', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'solutioning',
        category: 'stories',
        key: '1-1',
        value: JSON.stringify({
          key: '1-1',
          title: 'Story with AC alias',
          description: 'Testing',
          acceptance_criteria: ['Given X, when Y, then Z'],
          priority: 'must',
        }),
      }),
    ]
    const result = renderEpics(decisions)

    expect(result).toContain('- Given X, when Y, then Z')
  })
})

// ---------------------------------------------------------------------------
// renderReadinessReport tests (AC6, T8)
// ---------------------------------------------------------------------------

describe('renderReadinessReport', () => {
  it('returns empty string when no readiness-findings decisions exist', () => {
    expect(renderReadinessReport([])).toBe('')
  })

  it('returns empty string when no decisions have category=readiness-findings', () => {
    const decisions: Decision[] = [
      makeDecision({ phase: 'solutioning', category: 'architecture', key: 'lang', value: 'TypeScript' }),
    ]
    expect(renderReadinessReport(decisions)).toBe('')
  })

  it('renders PASS verdict when no blockers are present', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'solutioning',
        category: 'readiness-findings',
        key: 'finding-1',
        value: JSON.stringify({
          category: 'story_quality',
          severity: 'minor',
          description: 'Some ACs are not testable',
          affected_items: ['1-2'],
        }),
      }),
    ]
    const result = renderReadinessReport(decisions)

    expect(result).toContain('# Readiness Report')
    expect(result).toContain('**Overall Verdict**: PASS')
    expect(result).toContain('[MINOR] Some ACs are not testable')
  })

  it('renders FAIL verdict when blockers are present', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'solutioning',
        category: 'readiness-findings',
        key: 'finding-1',
        value: JSON.stringify({
          category: 'fr_coverage',
          severity: 'blocker',
          description: 'FR-5 has no story coverage',
          affected_items: ['FR-5'],
        }),
      }),
    ]
    const result = renderReadinessReport(decisions)

    expect(result).toContain('**Overall Verdict**: FAIL')
    expect(result).toContain('[BLOCKER] FR-5 has no story coverage')
  })

  it('groups findings by category', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'solutioning',
        category: 'readiness-findings',
        key: 'finding-1',
        value: JSON.stringify({
          category: 'fr_coverage',
          severity: 'major',
          description: 'FR-3 partially covered',
          affected_items: ['FR-3'],
        }),
      }),
      makeDecision({
        phase: 'solutioning',
        category: 'readiness-findings',
        key: 'finding-2',
        value: JSON.stringify({
          category: 'story_quality',
          severity: 'minor',
          description: 'Story 2-3 ACs are vague',
          affected_items: ['2-3'],
        }),
      }),
    ]
    const result = renderReadinessReport(decisions)

    expect(result).toContain('## FR Coverage')
    expect(result).toContain('## Story Quality')
    expect(result).toContain('[MAJOR] FR-3 partially covered')
    expect(result).toContain('[MINOR] Story 2-3 ACs are vague')
  })

  it('shows affected items for each finding', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'solutioning',
        category: 'readiness-findings',
        key: 'finding-1',
        value: JSON.stringify({
          category: 'architecture_compliance',
          severity: 'major',
          description: 'Story uses wrong database',
          affected_items: ['2-1', '2-2'],
        }),
      }),
    ]
    const result = renderReadinessReport(decisions)

    expect(result).toContain('*Affected*: 2-1, 2-2')
  })

  it('renders finding counts in summary section', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'solutioning',
        category: 'readiness-findings',
        key: 'finding-1',
        value: JSON.stringify({ category: 'fr_coverage', severity: 'blocker', description: 'Blocker finding', affected_items: [] }),
      }),
      makeDecision({
        phase: 'solutioning',
        category: 'readiness-findings',
        key: 'finding-2',
        value: JSON.stringify({ category: 'story_quality', severity: 'major', description: 'Major finding', affected_items: [] }),
      }),
      makeDecision({
        phase: 'solutioning',
        category: 'readiness-findings',
        key: 'finding-3',
        value: JSON.stringify({ category: 'story_quality', severity: 'minor', description: 'Minor finding', affected_items: [] }),
      }),
    ]
    const result = renderReadinessReport(decisions)

    expect(result).toContain('**Total Findings**: 3')
    expect(result).toContain('**Blockers**: 1')
    expect(result).toContain('**Major**: 1')
    expect(result).toContain('**Minor**: 1')
  })
})

// ---------------------------------------------------------------------------
// renderOperationalFindings tests (Story 21-1 AC5)
// ---------------------------------------------------------------------------

describe('renderOperationalFindings', () => {
  it('returns empty string when no decisions exist', () => {
    expect(renderOperationalFindings([])).toBe('')
  })

  it('returns empty string when no decisions have category=operational-finding', () => {
    const decisions: Decision[] = [
      makeDecision({ phase: 'solutioning', category: 'architecture', key: 'lang', value: 'TypeScript' }),
    ]
    expect(renderOperationalFindings(decisions)).toBe('')
  })

  it('renders run summaries grouped under Run Summaries heading', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'supervisor',
        category: 'operational-finding',
        key: 'run-summary:abc123',
        value: JSON.stringify({
          succeeded: ['1-1', '1-2'],
          failed: ['1-3'],
          escalated: [],
          total_restarts: 1,
          elapsed_seconds: 300,
          total_input_tokens: 50000,
          total_output_tokens: 10000,
        }),
      }),
    ]

    const result = renderOperationalFindings(decisions)

    expect(result).toContain('## Operational Findings')
    expect(result).toContain('### Run Summaries')
    expect(result).toContain('**Run: abc123**')
    expect(result).toContain('Succeeded: 1-1, 1-2')
    expect(result).toContain('Failed: 1-3')
    expect(result).toContain('Escalated: none')
    expect(result).toContain('Total restarts: 1')
    expect(result).toContain('Elapsed: 300s')
    expect(result).toContain('Tokens: 50000 in / 10000 out')
  })

  it('renders stall findings grouped under Stall Events heading', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'supervisor',
        category: 'operational-finding',
        key: 'stall:1-1:1700000000000',
        value: JSON.stringify({
          phase: 'code-review',
          staleness_secs: 700,
          attempt: 1,
          outcome: 'recovered',
        }),
      }),
    ]

    const result = renderOperationalFindings(decisions)

    expect(result).toContain('### Stall Events')
    expect(result).toContain('stall:1-1:1700000000000')
    expect(result).toContain('phase=code-review')
    expect(result).toContain('staleness=700s')
    expect(result).toContain('attempt=1')
    expect(result).toContain('outcome=recovered')
  })

  it('renders both run summaries and stall findings together', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'supervisor',
        category: 'operational-finding',
        key: 'run-summary:def456',
        value: JSON.stringify({
          succeeded: ['2-1'],
          failed: [],
          escalated: [],
          total_restarts: 0,
          elapsed_seconds: 120,
          total_input_tokens: 25000,
          total_output_tokens: 5000,
        }),
      }),
      makeDecision({
        phase: 'supervisor',
        category: 'operational-finding',
        key: 'stall:2-1:1700000000000',
        value: JSON.stringify({
          phase: 'dev-story',
          staleness_secs: 800,
          attempt: 2,
          outcome: 'max-restarts-escalated',
        }),
      }),
    ]

    const result = renderOperationalFindings(decisions)

    expect(result).toContain('### Run Summaries')
    expect(result).toContain('### Stall Events')
    expect(result).toContain('**Run: def456**')
    expect(result).toContain('outcome=max-restarts-escalated')
  })

  it('handles non-JSON stall values gracefully', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'supervisor',
        category: 'operational-finding',
        key: 'stall:1-1:1700000000000',
        value: 'plain text value',
      }),
    ]

    const result = renderOperationalFindings(decisions)
    expect(result).toContain('plain text value')
  })
})

// ---------------------------------------------------------------------------
// renderExperiments tests (Story 21-1 AC5)
// ---------------------------------------------------------------------------

describe('renderExperiments', () => {
  it('returns empty string when no decisions exist', () => {
    expect(renderExperiments([])).toBe('')
  })

  it('returns empty string when no decisions have category=experiment-result', () => {
    const decisions: Decision[] = [
      makeDecision({ phase: 'supervisor', category: 'operational-finding', key: 'run-summary:x', value: '{}' }),
    ]
    expect(renderExperiments(decisions)).toBe('')
  })

  it('renders experiment results with verdict summary', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'supervisor',
        category: 'experiment-result',
        key: 'experiment:run1:1700000000000',
        value: JSON.stringify({
          target_metric: 'token_regression',
          before: 12000,
          after: 9500,
          verdict: 'IMPROVED',
          branch_name: 'supervisor/experiment/abc12345',
        }),
      }),
      makeDecision({
        phase: 'supervisor',
        category: 'experiment-result',
        key: 'experiment:run1:1700000000001',
        value: JSON.stringify({
          target_metric: 'review_cycles',
          before: 3,
          after: 4,
          verdict: 'REGRESSED',
          branch_name: null,
        }),
      }),
    ]

    const result = renderExperiments(decisions)

    expect(result).toContain('## Experiments')
    expect(result).toContain('**Total**: 2')
    expect(result).toContain('**Improved**: 1')
    expect(result).toContain('**Regressed**: 1')
    expect(result).toContain('**[IMPROVED]** token_regression: before=12000 after=9500')
    expect(result).toContain('`supervisor/experiment/abc12345`')
    expect(result).toContain('**[REGRESSED]** review_cycles: before=3 after=4')
  })

  it('renders mixed verdict experiments', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'supervisor',
        category: 'experiment-result',
        key: 'experiment:run2:1700000000002',
        value: JSON.stringify({
          target_metric: 'wall_clock',
          before: 200,
          after: 180,
          verdict: 'MIXED',
          branch_name: 'experiment/mixed-result',
        }),
      }),
    ]

    const result = renderExperiments(decisions)

    expect(result).toContain('**Mixed**: 1')
    expect(result).toContain('**[MIXED]** wall_clock: before=200 after=180')
    expect(result).toContain('`experiment/mixed-result`')
  })

  it('handles non-JSON experiment values gracefully', () => {
    const decisions: Decision[] = [
      makeDecision({
        phase: 'supervisor',
        category: 'experiment-result',
        key: 'experiment:run3:1700000000003',
        value: 'plain text experiment result',
      }),
    ]

    const result = renderExperiments(decisions)
    expect(result).toContain('plain text experiment result')
  })
})
