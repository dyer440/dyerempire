// vitest.integration.config.ts
// Runs test/integration/** against a REAL local Postgres (not Neon, never prod).
//   PG_TEST_URL=postgres://neondb_owner:owner@localhost:54329/neondb \
//   PG_TEST_RO_URL=postgres://dyer_bot_ro:ro@localhost:54329/neondb \
//   npx vitest run -c vitest.integration.config.ts   (after: npm i --no-save vitest@3 pg@8)
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    fileParallelism: false,
    env: {
      TZ: 'UTC',
      DATABASE_URL: process.env.PG_TEST_URL ?? 'postgres://neondb_owner:owner@localhost:54329/neondb',
    },
  },
  resolve: {
    alias: {
      '@neondatabase/serverless': fileURLToPath(new URL('./test/integration/pg-neon.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
})
