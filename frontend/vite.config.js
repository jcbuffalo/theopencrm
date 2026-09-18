/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Vite config — migrated from Create React App.
//
// Goals:
//   1. Keep the output directory as `build/` so the multi-stage Dockerfile and
//      server.js (which serve `build/index.html`) need no changes.
//   2. Expose the existing `process.env.REACT_APP_*` env-var surface via
//      `define`, so the ~14 call sites in src/ keep working without rewrites
//      to `import.meta.env.VITE_*`.
//   3. Allow JSX in `.js` files (CRA convention) so we don't have to rename
//      ~50 files to `.jsx`.
//
// The `.env.production` file in this directory is read at build time by
// `loadEnv` (Vite reads .env files itself; CRA-style REACT_APP_* keys are
// supported through the explicit `define` mapping below).

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [
      react({
        // Process JSX in .js files too (CRA convention) — avoids a mass rename.
        include: /\.(jsx|js|tsx|ts)$/,
      }),
    ],

    // CRA used port 3000 by default; mirror that for `npm start`.
    server: {
      port: 3000,
      open: false,
    },

    build: {
      // Match CRA's output directory so the Dockerfile builder COPY rule and
      // the Express static-serve path in server.js remain unchanged.
      outDir: 'build',
      sourcemap: false,
    },

    define: {
      // CRA-compat: keep `process.env.REACT_APP_*` working in source without
      // rewriting every call site to `import.meta.env.VITE_*`. Values are
      // inlined as JSON string literals at build time.
      'process.env.REACT_APP_API_URL':           JSON.stringify(env.REACT_APP_API_URL || ''),
      'process.env.REACT_APP_GOOGLE_CLIENT_ID':  JSON.stringify(env.REACT_APP_GOOGLE_CLIENT_ID || ''),
      'process.env.REACT_APP_GITHUB_URL':        JSON.stringify(env.REACT_APP_GITHUB_URL || ''),
    },

    // Vite's build-time esbuild pass runs BEFORE the React plugin's transform
    // and would otherwise reject JSX in `.js` files at the import-analysis
    // step. Tell esbuild to apply the JSX loader to every `src/**/*.js[x]` —
    // this preserves the CRA convention without renaming ~50 files to `.jsx`.
    esbuild: {
      loader: 'jsx',
      include: /src\/.*\.jsx?$/,
      exclude: [],
    },

    optimizeDeps: {
      // Some deps ship JSX inside .js files; tell esbuild's dependency
      // pre-bundling pass to treat .js as JSX during scan.
      esbuildOptions: {
        loader: { '.js': 'jsx' },
      },
    },

    // Vitest config — first-wave unit-test harness. Lives alongside the build
    // config because the React plugin / esbuild loader rules above are reused
    // by Vitest's transform pipeline. css:false skips Tailwind processing in
    // tests (we never assert on computed styles, only className substrings).
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: './src/test-setup.js',
      css: false,
    },
  };
});
