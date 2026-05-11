import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    env: {
      LOG_LEVEL: 'silent',
    },
    teardownTimeout: 5000,
    // Default per-test timeout. The vitest default is 5000ms which is too
    // tight for substrate's integration / subprocess-spawning tests on
    // slower CI runners (macos-latest in publish.yml hit
    // `Test timed out in 5000ms` on auto-pipeline.integration,
    // orchestrator Story 24-2 build-failure path, and experimenter under
    // heavy parallel load — v0.20.30 publish 25005391718, 2026-04-27).
    // 30s gives integration tests headroom without masking real hangs.
    testTimeout: 30_000,
    // globalSetup runs once before the suite and its returned teardown
    // runs once after all tests across all forks. Used to detect + clean
    // up .substrate-worktrees/ leaks created by tests that bypass the
    // gitUtils mock and call real git worktree add against the project
    // root. Now FAILS the suite (sets process.exitCode = 1) when leaks
    // are detected — Quinn's stronger gate per BMAD party-mode review,
    // safe to enable since the known leak source (non-interactive-run
    // integration test) was fixed at the source 2026-05-11.
    globalSetup: ['./test/global-setup.ts'],
    include: ['test/**/*.test.ts', 'src/**/*.test.ts', 'packages/**/*.test.ts', 'packages/**/*-test.ts', 'scripts/**/*.test.ts', '__tests__/**/*.test.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 4,
        minForks: 1,
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.test.ts',
        'src/core/types.ts',
        'src/index.ts',
        // CLI entry point is excluded from coverage because it immediately
        // invokes main() with process.argv side effects on import, making
        // it impractical to unit test. The createProgram() function it uses
        // is tested indirectly through integration/E2E tests.
        'src/cli/index.ts',
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'src/core'),
      '@adapters': resolve(__dirname, 'src/adapters'),
      '@engine': resolve(__dirname, 'src/engine'),
      '@utils': resolve(__dirname, 'src/utils'),
      '@cli': resolve(__dirname, 'src/cli'),
      '@substrate-ai/core': resolve(__dirname, 'packages/core/src/index.ts'),
      '@substrate-ai/sdlc': resolve(__dirname, 'packages/sdlc/src/index.ts'),
      '@substrate-ai/factory': resolve(__dirname, 'packages/factory/src/index.ts'),
    },
  },
})
