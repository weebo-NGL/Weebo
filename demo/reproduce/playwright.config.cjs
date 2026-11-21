const { defineConfig } = require('playwright/test');

module.exports = defineConfig({
  testDir: '.',
  testMatch: 'checkout.spec.cjs',
  retries: 1,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'checkout-report.json' }]],
  projects: [{ name: 'checkout-api' }],
});
