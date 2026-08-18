/**
 * tsdown config for the browser half (`lib/client.js`).
 *
 * Mirrors harness's clientBundle preset (`packages/client/tsdown.client.ts`):
 * emits a closure-factory artifact that registers through
 * `window.__ModuleLoader__.load({ id, factory })`; react / cordis / ui-slots
 * stay external because the loader's module table answers them. The node half
 * is built by `tsc` (package.json `build` runs both).
 */
import { defineConfig } from 'tsdown'

/** Bundle id == package name (the loader keys the registration by it). */
const BUNDLE_ID = 'dsh-web-startup-auth'

/** Module-table entries this bundle may require at runtime. */
const EXTERNAL = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
]

export default defineConfig({
  name: `${BUNDLE_ID}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: EXTERNAL,
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(BUNDLE_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
