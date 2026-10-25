import {defineConfig} from 'vitest/config';
import {cloudflareTest} from '@cloudflare/vitest-plugin';
export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: {configPath: './wrangler.jsonc'},
    miniflare: {bindings: {OPENAI_API_KEY: 'test-only-not-a-real-key', DAILY_AI_LIMIT: '3'}},
  })],
  test: {include: ['test-worker/**/*.test.js'], fileParallelism: false, testTimeout: 15000},
});
