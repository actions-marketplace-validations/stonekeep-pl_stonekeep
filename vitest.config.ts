import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (p: string): string => fileURLToPath(new URL(`./packages/${p}`, import.meta.url));

// Node >= 22 ships an experimental global `localStorage` that shadows jsdom's
// (and is unusable without --localstorage-file). Turn it off in test workers.
const nodeMajor = Number(process.versions.node.split('.')[0]);
const execArgv = nodeMajor >= 22 ? ['--no-experimental-webstorage'] : [];

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    // Run tests against source so `pnpm test` works without a build step.
    alias: [
      { find: /^@stonekeep\/core\/engine$/, replacement: pkg('core/src/engine/index.ts') },
      { find: /^@stonekeep\/core\/consent$/, replacement: pkg('core/src/consent/index.ts') },
      { find: /^@stonekeep\/core$/, replacement: pkg('core/src/index.ts') },
      { find: /^@stonekeep\/connectors$/, replacement: pkg('connectors/src/index.ts') },
      { find: /^@stonekeep\/ai$/, replacement: pkg('ai/src/index.ts') },
      { find: /^@stonekeep\/mcp$/, replacement: pkg('mcp/src/index.ts') },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.{ts,tsx}'],
    environment: 'node',
    poolOptions: { forks: { execArgv }, threads: { execArgv } },
    // Integration tests may pull a Postgres image on first run.
    testTimeout: 60_000,
    hookTimeout: 240_000,
  },
});
