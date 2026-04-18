import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  minify: false,
  // dts is off in scaffold. Enable once we have a stable public API surface
  // (tracked for issue #15: release v0.1.0-alpha).
  dts: false,
});
