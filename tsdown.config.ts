import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    'cli/index': 'src/cli/index.ts',
    index: 'src/index.ts',
    // Explicit entry so runtime probes can import dist/src/modules/decision-router/index.js
    // directly (Story 72-1). Previously compiled via a separate npx tsc in postbuild,
    // which was fragile and outside the main build graph.
    'src/modules/decision-router/index': 'src/modules/decision-router/index.ts',
  },
  format: ['esm'],
  target: 'node18',
  sourcemap: true,
  dts: true,
  clean: true,
  treeshake: true,
  platform: 'node',
  outDir: 'dist',
  external: ['pino', 'commander', 'tree-sitter', 'tree-sitter-typescript', 'tree-sitter-javascript', 'tree-sitter-python'],
})
