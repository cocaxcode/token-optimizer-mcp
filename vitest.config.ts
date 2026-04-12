import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: [
        'src/lib/**',
        'src/tools/**',
        'src/services/**',
        'src/hooks/**',
        'src/coach/**',
        'src/orchestration/**',
        'src/cli/**',
        'src/db/**',
        'src/server.ts',
      ],
      exclude: ['src/__tests__/**', 'src/index.ts'],
    },
    testTimeout: 10000,
  },
})
