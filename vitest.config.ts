// vitest.config.ts
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // lib/db.ts instantiates the Neon client at module scope, so merely importing
    // a financial lib needs this set. Never points at a real database — these
    // tests exercise pure logic and source text, they issue no queries.
    env: { DATABASE_URL: 'postgres://vitest:vitest@localhost/vitest' },
  },
  resolve: { alias: { '@': fileURLToPath(new URL('./', import.meta.url)) } },
})
