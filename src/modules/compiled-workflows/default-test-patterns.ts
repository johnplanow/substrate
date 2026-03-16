/**
 * default-test-patterns.ts — Stack-aware test pattern resolver.
 *
 * Provides per-stack default test pattern blocks for injection into compiled
 * workflow prompts (dev-story, test-plan, test-expansion) when no test-patterns
 * decisions have been seeded into the decision store.
 *
 * Reads `.substrate/project-profile.yaml` synchronously (same pattern as
 * Stories 37-3, 37-4, 37-5). No imports from project-profile/ module —
 * avoids circular dependencies.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'

// ---------------------------------------------------------------------------
// Per-stack default pattern constants
// ---------------------------------------------------------------------------

/** Default test patterns for Vitest/Jest/Mocha (Node.js ecosystem) */
export const VITEST_DEFAULT_PATTERNS = `## Test Patterns (defaults)
- Framework: Vitest (NOT jest — --testPathPattern flag does not work, use -- "pattern")
- Mock approach: vi.mock() with hoisting for module-level mocks
- Assertion style: expect().toBe(), expect().toEqual(), expect().toThrow()
- Test structure: describe/it blocks with beforeEach/afterEach
- Coverage: 80% enforced
- IMPORTANT: During development, run ONLY your relevant tests to save memory:
  npx vitest run --no-coverage -- "your-module-name"
- Final validation ONLY: npm test 2>&1 | grep -E "Test Files|Tests " | tail -3
- Do NOT run the full suite (npm test) repeatedly — it consumes excessive memory when multiple agents run in parallel`

/** Default test patterns for Go (stdlib testing) */
const GO_DEFAULT_PATTERNS = `## Test Patterns (defaults)
- Framework: Go test (stdlib)
- Test file naming: <module>_test.go alongside source files
- Test structure: table-driven tests using t.Run() subtests
- Run all tests: go test ./...
- Run specific test: go test ./... -v -run TestFunctionName
- IMPORTANT: Run targeted tests during development: go test ./pkg/... -v -run TestSpecific
- Assertion style: t.Errorf(), t.Fatalf(); use testify if already in go.mod (require.Equal, assert.NoError)`

/** Default test patterns for Gradle (JUnit 5) */
const GRADLE_DEFAULT_PATTERNS = `## Test Patterns (defaults)
- Framework: JUnit 5 (Gradle)
- Test structure: @Test annotated methods in class under src/test/
- Run all tests: ./gradlew test
- Run specific test: ./gradlew test --tests "com.example.ClassName.methodName"
- IMPORTANT: Run targeted tests during development: ./gradlew test --tests "ClassName"
- Assertion style: assertThat(...).isEqualTo(...) (AssertJ) or assertEquals (JUnit)`

/** Default test patterns for Maven (JUnit 5) */
const MAVEN_DEFAULT_PATTERNS = `## Test Patterns (defaults)
- Framework: JUnit 5 (Maven)
- Test structure: @Test annotated methods in class under src/test/
- Run all tests: mvn test
- Run specific test: mvn test -Dtest="ClassName#methodName"
- IMPORTANT: Run targeted tests during development: mvn test -Dtest="ClassName"
- Assertion style: assertThat(...).isEqualTo(...) (AssertJ) or assertEquals (JUnit)`

/** Default test patterns for Cargo (Rust) */
const CARGO_DEFAULT_PATTERNS = `## Test Patterns (defaults)
- Framework: Rust test (cargo)
- Test file naming: #[cfg(test)] module in same file, or tests/ directory for integration tests
- Test structure: #[test] annotated functions
- Run all tests: cargo test
- Run specific test: cargo test test_function_name
- IMPORTANT: Run targeted tests during development: cargo test --lib test_module
- Assertion style: assert_eq!, assert!, assert_ne! macros`

/** Default test patterns for pytest (Python) */
const PYTEST_DEFAULT_PATTERNS = `## Test Patterns (defaults)
- Framework: pytest
- Test file naming: test_<module>.py or <module>_test.py
- Test structure: test_* functions or Test* classes with test_* methods
- Run all tests: pytest
- Run specific test: pytest tests/test_foo.py::test_bar -v
- IMPORTANT: Run targeted tests during development: pytest -k "test_name" -v
- Assertion style: plain assert statements; use pytest.raises() for exceptions`

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the appropriate default test pattern block for the project.
 *
 * Algorithm:
 * 1. If projectRoot is undefined or empty → return VITEST_DEFAULT_PATTERNS
 * 2. Build profile path: join(projectRoot, '.substrate/project-profile.yaml')
 * 3. If file does not exist → return VITEST_DEFAULT_PATTERNS
 * 4. Parse YAML; on error → return VITEST_DEFAULT_PATTERNS
 * 5. Match project.testCommand (case-insensitive substring):
 *    go test → GO, gradlew/gradle → GRADLE, mvn → MAVEN,
 *    cargo test → CARGO, pytest → PYTEST, vitest/jest/mocha/npm → VITEST
 * 6. If testCommand unmatched, try project.language:
 *    go → GO, kotlin/java → GRADLE, rust → CARGO, python → PYTEST,
 *    typescript/javascript → VITEST
 * 7. Nothing matched → return VITEST_DEFAULT_PATTERNS
 *
 * @param projectRoot - Absolute path to the project root (or undefined)
 * @returns Stack-appropriate test pattern block string
 */
export function resolveDefaultTestPatterns(projectRoot?: string): string {
  if (!projectRoot) return VITEST_DEFAULT_PATTERNS

  const profilePath = join(projectRoot, '.substrate/project-profile.yaml')

  if (!existsSync(profilePath)) return VITEST_DEFAULT_PATTERNS

  let profile: Record<string, unknown> | null = null
  try {
    const content = readFileSync(profilePath, 'utf-8')
    profile = yaml.load(content) as Record<string, unknown> | null
  } catch {
    return VITEST_DEFAULT_PATTERNS
  }

  if (!profile) return VITEST_DEFAULT_PATTERNS

  const project = profile['project'] as Record<string, unknown> | undefined
  if (!project) return VITEST_DEFAULT_PATTERNS

  // Primary: match on testCommand (case-insensitive substring)
  // NOTE: 'cargo test' is checked before 'go test' because 'cargo test'
  // contains the substring 'go test' (c-a-r-g-o- -t-e-s-t).
  const testCommand = ((project['testCommand'] as string | undefined) ?? '').toLowerCase()
  if (testCommand) {
    if (testCommand.includes('cargo test')) return CARGO_DEFAULT_PATTERNS
    if (testCommand.includes('go test')) return GO_DEFAULT_PATTERNS
    if (testCommand.includes('gradlew') || testCommand.includes('gradle')) return GRADLE_DEFAULT_PATTERNS
    if (testCommand.includes('mvn')) return MAVEN_DEFAULT_PATTERNS
    if (testCommand.includes('pytest')) return PYTEST_DEFAULT_PATTERNS
    if (
      testCommand.includes('vitest') ||
      testCommand.includes('jest') ||
      testCommand.includes('mocha') ||
      testCommand.includes('npm')
    ) {
      return VITEST_DEFAULT_PATTERNS
    }
  }

  // Secondary: match on language field
  const language = ((project['language'] as string | undefined) ?? '').toLowerCase()
  if (language === 'go') return GO_DEFAULT_PATTERNS
  if (language === 'kotlin' || language === 'java') return GRADLE_DEFAULT_PATTERNS
  if (language === 'rust') return CARGO_DEFAULT_PATTERNS
  if (language === 'python') return PYTEST_DEFAULT_PATTERNS
  if (language === 'typescript' || language === 'javascript') return VITEST_DEFAULT_PATTERNS

  // Nothing matched
  return VITEST_DEFAULT_PATTERNS
}
