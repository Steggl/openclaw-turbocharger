import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  minify: false,
  // Declarations are generated using the build-specific tsconfig, which sets
  // noEmit: false and declaration: true. The root tsconfig.json stays
  // emit-less for editor / `tsc --noEmit` typechecking. See
  // docs/DECISIONS.md ADR-0002.
  dts: true,
  tsconfig: 'tsconfig.build.json',
});
