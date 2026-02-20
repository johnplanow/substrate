import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
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
    },
  },
})
