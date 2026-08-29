import { defineConfig } from 'vite';

// Relative base: the app deploys to a GitHub Pages project page
// (user.github.io/<repo>/), where absolute asset paths (/assets/...) would
// resolve against the domain root and 404. './' keeps every URL relative to
// the page, so the same build serves from a subpath or the domain root.
// ponytail: no router, so relative base has no history-API caveats here.
export default defineConfig({ base: './' });
