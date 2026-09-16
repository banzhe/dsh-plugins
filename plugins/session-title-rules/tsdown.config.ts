import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  dts: true,
  clean: true,
  // Emit `lib/index.js` + `lib/index.d.ts`, which is what package.json declares.
  fixedExtension: false,
})
