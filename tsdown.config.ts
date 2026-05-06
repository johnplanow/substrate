import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    'cli/index': 'src/cli/index.ts',
    index: 'src/index.ts',
    // Explicit entry so runtime probes can import dist/src/modules/decision-router/index.js
    // directly (Story 72-1). Previously compiled via a separate npx tsc in postbuild,
    // which was fragile and outside the main build graph.
    'src/modules/decision-router/index': 'src/modules/decision-router/index.ts',
    // Explicit entry so runtime probes can import dist/modules/interactive-prompt/index.js
    // directly (Story 73-2). Uses shorter key (no src/ prefix) so probe path resolves
    // to dist/modules/interactive-prompt/index.js rather than dist/src/modules/...
    'modules/interactive-prompt/index': 'src/modules/interactive-prompt/index.ts',
    // Explicit entry so runtime probes can import dist/src/modules/recovery-engine/index.js
    // directly (Story 73-1). Follows the decision-router pattern (with src/ prefix).
    'src/modules/recovery-engine/index': 'src/modules/recovery-engine/index.ts',
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
