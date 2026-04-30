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
  // Shebang for direct CLI invocation when installed via `npm install -g`
  // or `npx`. The `bin` field in package.json points at this output.
  banner: { js: '#!/usr/bin/env node' },
  // Declarations are generated using the build-specific tsconfig, which sets
  // noEmit: false and declaration: true. The root tsconfig.json stays
  // emit-less for editor / `tsc --noEmit` typechecking. See
  // docs/DECISIONS.md ADR-0002.
  dts: true,
  tsconfig: 'tsconfig.build.json',
});
