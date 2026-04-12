import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    'cli/index': 'src/cli/index.ts',
    index: 'src/index.ts',
  },
  format: ['esm'],
  target: 'node20',
  sourcemap: true,
  dts: true,
  clean: true,
  treeshake: true,
  platform: 'node',
  outDir: 'dist',
  // G12.2: migrated from `external` (deprecated in tsdown 0.21). Dropped
  // `promptfoo` — the rolldown ChainExpression bug (rolldown/rolldown#6231)
  // is fixed in rolldown >= 1.0.0-beta.39, which tsdown >= 0.15.3 bundles.
  deps: {
    neverBundle: ['pino', 'commander', 'tree-sitter', 'tree-sitter-typescript', 'tree-sitter-javascript', 'tree-sitter-python'],
  },
})
