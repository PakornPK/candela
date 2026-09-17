// defineConfig from vitest/config (re-exports Vite's) so the `test` block is
// typed; vitest is a devDependency, so `vite build` resolves it fine.
import { defineConfig } from 'vitest/config';

// Relative base: the app deploys to a GitHub Pages project page
// (user.github.io/<repo>/), where absolute asset paths (/assets/...) would
// resolve against the domain root and 404. './' keeps every URL relative to
// the page, so the same build serves from a subpath or the domain root.
// ponytail: no router, so relative base has no history-API caveats here.
export default defineConfig({
  base: './',
  test: {
    // Agent tooling drops its own node:test fixtures into .agents/.claude/
    // .hermes (untracked, not part of the app). Vitest picked them up and
    // reported "6 failed" files alongside 316 passing tests, which hides a
    // real regression in the noise. Only the app's own tests count here.
    exclude: ['**/node_modules/**', '**/dist/**', '.agents/**', '.claude/**', '.hermes/**'],
  },
});