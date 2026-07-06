#!/usr/bin/env node
/**
 * Stub agent scenario script (H2.2, hardening program).
 *
 * Spawned by StubAdapter in place of a real CLI agent:
 *   argv[2]                      — task type (create-story, dev-story, code-review, …)
 *   env SUBSTRATE_STUB_SCENARIO  — success | contamination | zero-impl | auth-error | red-suite
 *   env SUBSTRATE_STUB_FIXTURE   — python-uv | node-ts | go
 *   env SUBSTRATE_STUB_STORY_KEY — story being dispatched
 *   cwd                          — the story worktree
 *
 * Emits the exact YAML output contracts the pipeline parses, and writes real
 * files into the worktree, so the REAL gates (commit-first, TestSuiteCheck,
 * ContaminationCheck, no-implementation, auth classifier) exercise genuine
 * inputs. Deterministic; no network, no LLM.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

const taskType = process.argv[2] ?? 'unknown'
const scenario = process.env.SUBSTRATE_STUB_SCENARIO ?? 'success'
const fixture = process.env.SUBSTRATE_STUB_FIXTURE ?? 'python-uv'
const storyKey = process.env.SUBSTRATE_STUB_STORY_KEY || '1-1'
const cwd = process.cwd()

// Drain stdin (the prompt) so the pipe never backs up; content unused.
try {
  readFileSync(0, 'utf-8')
} catch {
  /* no stdin */
}

// ---------------------------------------------------------------------------
// H4.1 (AC3): git-state scoping enforcement — this stub runs as a REAL
// spawned dispatch, so every matrix cell verifies the child env live.
// Inherited git/location state must be scrubbed, the ceiling must be set,
// and git inside the worktree must still resolve THIS worktree.
// ---------------------------------------------------------------------------
{
  const leaked = ['PWD', 'OLDPWD', 'INIT_CWD', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']
    .filter((k) => process.env[k] !== undefined)
  if (leaked.length > 0) {
    process.stderr.write(`H4.1 violation: git/location env leaked into the dispatched agent: ${leaked.join(', ')}\n`)
    process.exit(78)
  }
  if (process.env.GIT_CEILING_DIRECTORIES === undefined) {
    process.stderr.write('H4.1 violation: GIT_CEILING_DIRECTORIES not set on the dispatched agent\n')
    process.exit(78)
  }
  try {
    const { execFileSync } = await import('node:child_process')
    const toplevel = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim()
    if (toplevel !== cwd) {
      process.stderr.write(`H4.1 violation: git resolves ${toplevel}, expected the worktree ${cwd}\n`)
      process.exit(78)
    }
  } catch {
    // Non-git cwd (planning-style dispatch) — resolution check not applicable.
  }
}

function write(rel, content) {
  const abs = join(cwd, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

function emitYaml(lines) {
  process.stdout.write('```yaml\n' + lines.join('\n') + '\n```\n')
}

// ---------------------------------------------------------------------------
// Per-fixture implementations for the clean story (1-1)
// ---------------------------------------------------------------------------

const IMPLEMENTATIONS = {
  'python-uv': {
    files: {
      'src/greeter/__init__.py': [
        'def greet(name: str) -> str:',
        '    return f"Hello, {name}!"',
        '',
        '',
        'def farewell(name: str) -> str:',
        '    return f"Goodbye, {name}!"',
        '',
      ].join('\n'),
      'tests/test_farewell.py': [
        'from greeter import farewell',
        '',
        '',
        'def test_farewell():',
        '    assert farewell("world") == "Goodbye, world!"',
        '',
      ].join('\n'),
    },
    redSuiteFile: {
      'tests/test_farewell.py': [
        'from greeter import farewell',
        '',
        '',
        'def test_farewell():',
        '    assert farewell("world") == "Goodbye, WRONG!"',
        '',
      ].join('\n'),
    },
  },
  'node-ts': {
    files: {
      'src/counter.mjs': [
        'export function increment(n) {',
        '  return n + 1;',
        '}',
        '',
        'export function decrement(n) {',
        '  return n - 1;',
        '}',
        '',
      ].join('\n'),
      'src/decrement.test.mjs': [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { decrement } from './counter.mjs';",
        '',
        "test('decrement subtracts one', () => {",
        '  assert.equal(decrement(2), 1);',
        '});',
        '',
      ].join('\n'),
    },
    redSuiteFile: {
      'src/decrement.test.mjs': [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { decrement } from './counter.mjs';",
        '',
        "test('decrement subtracts one', () => {",
        '  assert.equal(decrement(2), 999);',
        '});',
        '',
      ].join('\n'),
    },
  },
  go: {
    files: {
      'sub.go': [
        'package adder',
        '',
        '// Sub returns a minus b.',
        'func Sub(a, b int) int {',
        '\treturn a - b',
        '}',
        '',
      ].join('\n'),
      'sub_test.go': [
        'package adder',
        '',
        'import "testing"',
        '',
        'func TestSub(t *testing.T) {',
        '\tif Sub(3, 1) != 2 {',
        '\t\tt.Fatalf("Sub(3,1) != 2")',
        '\t}',
        '}',
        '',
      ].join('\n'),
    },
    redSuiteFile: {
      'sub_test.go': [
        'package adder',
        '',
        'import "testing"',
        '',
        'func TestSub(t *testing.T) {',
        '\tif Sub(3, 1) != 999 {',
        '\t\tt.Fatalf("Sub(3,1) != 999")',
        '\t}',
        '}',
        '',
      ].join('\n'),
    },
  },
}

// ---------------------------------------------------------------------------
// Phase handlers
// ---------------------------------------------------------------------------

if (taskType === 'create-story') {
  if (scenario === 'auth-error') {
    // The exit-0 refusal shape from the field: short auth text, no YAML.
    process.stdout.write('auth source takes precedence over claude.ai login · Invalid API key\n')
    process.exit(0)
  }
  if (scenario === 'no-file') {
    emitYaml(['result: success', `story_key: "${storyKey}"`, 'story_title: No File Story'])
    process.exit(0)
  }
  const rel = `_bmad-output/implementation-artifacts/${storyKey}-stub-story.md`
  // Mirror the epic's AC section (incl. its backticked paths) the way a real
  // create-story render does — SourceAcFidelityCheck cross-references the
  // epic's hard clauses against this artifact.
  const AC_SECTIONS = {
    'python-uv': [
      '1. `farewell(name: str) -> str` exists in `src/greeter/__init__.py` and returns `f"Goodbye, {name}!"`.',
      '2. A pytest test in `tests/test_farewell.py` covers `farewell("world") == "Goodbye, world!"`.',
      '3. The existing `greet` function and its test remain unchanged and passing.',
    ],
    'node-ts': [
      '1. `decrement(n)` exists in `src/counter.mjs` and returns `n - 1`.',
      '2. A node:test case covers `decrement(2) === 1`.',
      '3. Existing `increment` behavior unchanged.',
    ],
    go: [
      '1. `Sub(a, b int) int` exists in `adder.go` and returns `a - b`.',
      '2. A Go test covers `Sub(3, 1) == 2`.',
      '3. Existing `Add` behavior unchanged.',
    ],
  }
  write(rel, [
    `# Story ${storyKey}: Stub story`,
    '',
    '## Acceptance Criteria',
    '',
    ...(AC_SECTIONS[fixture] ?? AC_SECTIONS['python-uv']),
    '',
    '## Tasks',
    '',
    '- [ ] Implement per the fixture contract',
    '',
  ].join('\n'))
  emitYaml([
    'result: success',
    // Absolute worktree path: the orchestrator resolves story_file against
    // its own cwd, not the agent's — and this also exercises the H1.8
    // containment gate on its inside-the-worktree happy path.
    `story_file: ${join(cwd, rel)}`,
    `story_key: "${storyKey}"`,
    'story_title: Stub story',
  ])
  process.exit(0)
}

if (taskType === 'dev-story' || taskType === 'fix-story' || taskType === 'minor-fixes') {
  const impl = IMPLEMENTATIONS[fixture]
  if (!impl) {
    process.stderr.write(`unknown fixture: ${fixture}\n`)
    process.exit(1)
  }
  const filesModified = []

  if (scenario === 'zero-impl') {
    // Write nothing; claim success + tests pass (the finding-#13 shape).
  } else if (scenario === 'contamination') {
    write('package.json', '{ "name": "rogue", "version": "0.0.1", "private": true }\n')
    write('src/rogue.ts', 'export const rogue = true\n')
    filesModified.push('package.json', 'src/rogue.ts')
  } else if (scenario === 'red-suite') {
    for (const [rel, content] of Object.entries(impl.files)) {
      write(rel, content)
      filesModified.push(rel)
    }
    for (const [rel, content] of Object.entries(impl.redSuiteFile)) {
      write(rel, content)
      if (!filesModified.includes(rel)) filesModified.push(rel)
    }
  } else {
    for (const [rel, content] of Object.entries(impl.files)) {
      write(rel, content)
      filesModified.push(rel)
    }
  }

  emitYaml([
    'result: success',
    'ac_met:',
    '  - AC1',
    '  - AC2',
    '  - AC3',
    'ac_failures: []',
    'files_modified:' + (filesModified.length === 0 ? ' []' : ''),
    ...filesModified.map((f) => `  - ${f}`),
    'tests: pass',
  ])
  process.exit(0)
}

if (taskType === 'code-review') {
  emitYaml(['verdict: SHIP_IT', 'issues: 0', 'issue_list: []', 'ac_checklist: []'])
  process.exit(0)
}

// Non-blocking auxiliary phases (test-plan, probe-author, test-expansion, …):
// emit a benign success shape; their parsers tolerate partial data and the
// phases are advisory in this harness.
if (taskType === 'test-plan') {
  emitYaml(['result: success', 'test_files: []', 'test_categories: []', 'coverage_notes: stub'])
  process.exit(0)
}

emitYaml(['result: success'])
process.exit(0)
