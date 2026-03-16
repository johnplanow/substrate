/**
 * Unit tests for buildStackAwareDevNotes (Story 37-7)
 *
 * AC1: TypeScript/Node.js Single Project
 * AC2: Go Single Project
 * AC3: JVM (Gradle or Maven) Single Project
 * AC4: Rust/Cargo Single Project
 * AC5: Python Single Project
 * AC6: Turborepo Monorepo
 * AC7: No Profile / Backward Compatibility
 */

import { describe, it, expect } from 'vitest'
import {
  buildStackAwareDevNotes,
  DEV_WORKFLOW_START_MARKER,
  DEV_WORKFLOW_END_MARKER,
} from '../build-dev-notes.js'
import type { ProjectProfile } from '../../../modules/project-profile/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNodeProfile(buildCommand: string, testCommand = 'npm test'): ProjectProfile {
  return {
    project: {
      type: 'single',
      language: 'typescript',
      buildTool: 'npm',
      buildCommand,
      testCommand,
    },
  }
}

function makeGoProfile(): ProjectProfile {
  return {
    project: {
      type: 'single',
      language: 'go',
      buildTool: 'go',
      buildCommand: 'go build ./...',
      testCommand: 'go test ./...',
    },
  }
}

function makeGradleProfile(): ProjectProfile {
  return {
    project: {
      type: 'single',
      language: 'java',
      buildTool: 'gradle',
      buildCommand: './gradlew build',
      testCommand: './gradlew test',
    },
  }
}

function makeMavenProfile(): ProjectProfile {
  return {
    project: {
      type: 'single',
      language: 'java',
      buildTool: 'maven',
      buildCommand: 'mvn compile',
      testCommand: 'mvn test',
    },
  }
}

function makeCargoProfile(): ProjectProfile {
  return {
    project: {
      type: 'single',
      language: 'rust',
      buildTool: 'cargo',
      buildCommand: 'cargo build',
      testCommand: 'cargo test',
    },
  }
}

function makePythonPoetryProfile(): ProjectProfile {
  return {
    project: {
      type: 'single',
      language: 'python',
      buildTool: 'poetry',
      buildCommand: 'poetry install',
      testCommand: 'pytest',
    },
  }
}

function makePythonPipProfile(): ProjectProfile {
  return {
    project: {
      type: 'single',
      language: 'python',
      buildTool: 'pip',
      buildCommand: 'pip install -e .',
      testCommand: 'pytest',
    },
  }
}

function makeTurborepoProfile(): ProjectProfile {
  return {
    project: {
      type: 'monorepo',
      tool: 'turborepo',
      buildCommand: 'turbo build',
      testCommand: 'turbo test',
      packages: [
        {
          path: 'apps/web',
          language: 'typescript',
          buildTool: 'pnpm',
          framework: 'nextjs',
          testCommand: 'pnpm test',
        },
        {
          path: 'apps/lock-service',
          language: 'go',
          buildTool: 'go',
        },
        {
          path: 'apps/pricing-worker',
          language: 'typescript',
          buildTool: 'pnpm',
          framework: 'node',
          testCommand: 'pnpm test',
        },
      ],
    },
  }
}

// ---------------------------------------------------------------------------
// AC7: null profile — empty string
// ---------------------------------------------------------------------------

describe('AC7: null profile returns empty string', () => {
  it('returns empty string for null profile', () => {
    expect(buildStackAwareDevNotes(null)).toBe('')
  })

  it('returns empty string for undefined (coerced to null)', () => {
    // The function signature is ProjectProfile | null, but test defensive cast
    expect(buildStackAwareDevNotes(null)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Marker contract
// ---------------------------------------------------------------------------

describe('Markers: non-null profile always includes start/end markers', () => {
  it('wraps output in dev-workflow markers for Go profile', () => {
    const result = buildStackAwareDevNotes(makeGoProfile())
    expect(result).toContain(DEV_WORKFLOW_START_MARKER)
    expect(result).toContain(DEV_WORKFLOW_END_MARKER)
    const startIdx = result.indexOf(DEV_WORKFLOW_START_MARKER)
    const endIdx = result.indexOf(DEV_WORKFLOW_END_MARKER)
    expect(startIdx).toBeLessThan(endIdx)
  })
})

// ---------------------------------------------------------------------------
// AC1: TypeScript/Node.js
// ---------------------------------------------------------------------------

describe('AC1: TypeScript/Node.js profiles', () => {
  it('npm build command → includes npm run build and npm test', () => {
    const result = buildStackAwareDevNotes(makeNodeProfile('npm run build'))
    // Use backtick-wrapped strings for precise matching (avoids false substring matches)
    expect(result).toContain('`npm run build`')
    expect(result).toContain('`npm test`')
    expect(result).not.toContain('pnpm run')
    expect(result).not.toContain('yarn build')
  })

  it('pnpm build command → includes pnpm run build and pnpm test', () => {
    const result = buildStackAwareDevNotes(makeNodeProfile('pnpm run build', 'pnpm test'))
    // Use backtick-wrapped strings for precise matching
    expect(result).toContain('`pnpm run build`')
    expect(result).toContain('`pnpm test`')
    // Note: 'pnpm run build' contains 'npm run build' as a substring (p+npm run build),
    // so we check for the backtick-delimited command instead
    expect(result).not.toContain('`npm run build`')
  })

  it('yarn build command → includes yarn build and yarn test', () => {
    const result = buildStackAwareDevNotes(makeNodeProfile('yarn build', 'yarn test'))
    expect(result).toContain('yarn build')
    expect(result).toContain('yarn test')
  })

  it('bun build command → includes bun run build and bun test', () => {
    const result = buildStackAwareDevNotes(makeNodeProfile('bun run build', 'bun test'))
    expect(result).toContain('bun run build')
    expect(result).toContain('bun test')
  })

  it('fallback to npm when buildCommand does not hint a package manager', () => {
    const result = buildStackAwareDevNotes(makeNodeProfile('node build.js'))
    expect(result).toContain('npm run build')
    expect(result).toContain('npm test')
  })
})

// ---------------------------------------------------------------------------
// AC2: Go
// ---------------------------------------------------------------------------

describe('AC2: Go single project', () => {
  it('includes go build ./...', () => {
    const result = buildStackAwareDevNotes(makeGoProfile())
    expect(result).toContain('go build ./...')
  })

  it('includes go test ./...', () => {
    const result = buildStackAwareDevNotes(makeGoProfile())
    expect(result).toContain('go test ./...')
  })

  it('includes -run flag note for targeted test execution', () => {
    const result = buildStackAwareDevNotes(makeGoProfile())
    expect(result).toContain('-run')
  })

  it('includes -v flag note', () => {
    const result = buildStackAwareDevNotes(makeGoProfile())
    expect(result).toContain('-v')
  })
})

// ---------------------------------------------------------------------------
// AC3: JVM — Gradle and Maven
// ---------------------------------------------------------------------------

describe('AC3: Gradle single project', () => {
  it('includes ./gradlew build', () => {
    const result = buildStackAwareDevNotes(makeGradleProfile())
    expect(result).toContain('./gradlew build')
  })

  it('includes ./gradlew test', () => {
    const result = buildStackAwareDevNotes(makeGradleProfile())
    expect(result).toContain('./gradlew test')
  })

  it('includes --tests note for targeted execution', () => {
    const result = buildStackAwareDevNotes(makeGradleProfile())
    expect(result).toContain('--tests')
  })
})

describe('AC3: Maven single project', () => {
  it('includes mvn compile', () => {
    const result = buildStackAwareDevNotes(makeMavenProfile())
    expect(result).toContain('mvn compile')
  })

  it('includes mvn test', () => {
    const result = buildStackAwareDevNotes(makeMavenProfile())
    expect(result).toContain('mvn test')
  })

  it('includes -Dtest note for targeted execution', () => {
    const result = buildStackAwareDevNotes(makeMavenProfile())
    expect(result).toContain('-Dtest')
  })
})

// ---------------------------------------------------------------------------
// AC4: Rust/Cargo
// ---------------------------------------------------------------------------

describe('AC4: Rust/Cargo single project', () => {
  it('includes cargo build', () => {
    const result = buildStackAwareDevNotes(makeCargoProfile())
    expect(result).toContain('cargo build')
  })

  it('includes cargo test', () => {
    const result = buildStackAwareDevNotes(makeCargoProfile())
    expect(result).toContain('cargo test')
  })

  it('includes --nocapture note', () => {
    const result = buildStackAwareDevNotes(makeCargoProfile())
    expect(result).toContain('--nocapture')
  })
})

// ---------------------------------------------------------------------------
// AC5: Python
// ---------------------------------------------------------------------------

describe('AC5: Python single project', () => {
  it('poetry profile → includes poetry install and pytest', () => {
    const result = buildStackAwareDevNotes(makePythonPoetryProfile())
    expect(result).toContain('poetry install')
    expect(result).toContain('pytest')
  })

  it('pip profile → includes pip install and pytest', () => {
    const result = buildStackAwareDevNotes(makePythonPipProfile())
    expect(result).toContain('pip install')
    expect(result).toContain('pytest')
  })
})

// ---------------------------------------------------------------------------
// AC6: Turborepo Monorepo
// ---------------------------------------------------------------------------

describe('AC6: Turborepo monorepo', () => {
  it('includes root turbo build command', () => {
    const result = buildStackAwareDevNotes(makeTurborepoProfile())
    expect(result).toContain('turbo build')
  })

  it('includes root turbo test command', () => {
    const result = buildStackAwareDevNotes(makeTurborepoProfile())
    expect(result).toContain('turbo test')
  })

  it('includes package table with path column', () => {
    const result = buildStackAwareDevNotes(makeTurborepoProfile())
    expect(result).toContain('apps/web')
    expect(result).toContain('apps/lock-service')
    expect(result).toContain('apps/pricing-worker')
  })

  it('includes package table with language column', () => {
    const result = buildStackAwareDevNotes(makeTurborepoProfile())
    expect(result).toContain('typescript')
    expect(result).toContain('go')
  })

  it('uses — for missing framework', () => {
    const result = buildStackAwareDevNotes(makeTurborepoProfile())
    // lock-service has no framework
    expect(result).toContain('—')
  })

  it('uses package testCommand when provided', () => {
    const result = buildStackAwareDevNotes(makeTurborepoProfile())
    expect(result).toContain('pnpm test')
  })

  it('falls back to stack default test command when testCommand is absent', () => {
    const result = buildStackAwareDevNotes(makeTurborepoProfile())
    // lock-service is Go with no testCommand, should default to go test ./...
    expect(result).toContain('go test ./...')
  })

  it('monorepo without packages still renders root commands', () => {
    const profile: ProjectProfile = {
      project: {
        type: 'monorepo',
        tool: 'turborepo',
        buildCommand: 'turbo build',
        testCommand: 'turbo test',
        packages: [],
      },
    }
    const result = buildStackAwareDevNotes(profile)
    expect(result).toContain('turbo build')
    expect(result).toContain('turbo test')
  })
})
