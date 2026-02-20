import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    'cli/index': 'src/cli/index.ts',
    index: 'src/index.ts',
  },
  format: ['esm'],
  target: 'node18',
  sourcemap: true,
  dts: true,
  clean: true,
  treeshake: true,
  platform: 'node',
  outDir: 'dist',
  external: ['pino', 'commander'],
})
