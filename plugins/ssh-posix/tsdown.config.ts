import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  dts: true,
  clean: true,
  // `lib/index.js`, not `.mjs`: package.json main/types are written against the
  // extension tsdown's fixed-extension default would not produce.
  fixedExtension: false,
})
