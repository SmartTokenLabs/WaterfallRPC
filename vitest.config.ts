import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        setupFiles: ['tests/setup-env.ts'],
        testTimeout: 180_000,
        hookTimeout: 180_000,
        fileParallelism: false,
    },
});
