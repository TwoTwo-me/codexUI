import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/cli/index.ts',
    connector: 'src/connector/index.ts',
  },
  outDir: 'dist-cli',
  format: 'esm',
  target: 'node18',
  sourcemap: true,
  clean: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  external: ['express', 'commander', 'better-sqlite3'],
})
