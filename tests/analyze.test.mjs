import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeReport } from '../src/analyze.mjs';

const attempt = (message, status = 'failed') => ({ status, error: { message } });
const outcome = (status, results, projectName = 'chromium') => ({ status, results, projectName, expectedStatus: 'passed' });
function report(...tests) {
  const spec = { title: 'checkout', file: 'cart.spec.ts', line: 11, tests };
  return { suites: [{ specs: [], suites: [{ specs: [spec] }] }], errors: [] };
}

const failed = outcome('unexpected', [attempt('Error: locator.click timed out\nCall log:\n- waiting for getByRole("button", {name: "Pay"})')]);

test('uses final test outcomes across projects and reports the last non-skipped attempt', async () => {
  const failure = outcome('unexpected', [attempt('old error'), ...failed.results, { status: 'skipped' }]);
  const data = report(failure, outcome('flaky', [attempt('old error'), { status: 'passed' }]),
    outcome('expected', [{ status: 'passed' }]), { ...outcome('expected', [attempt('annotated')]), expectedStatus: 'failed' });
  const summary = await analyzeReport(data);
  assert.equal(summary.totalFailures, 1);
  assert.equal(summary.flakyTests, 1);
  assert.equal(summary.aiStatus, 'off');
  assert.deepEqual(summary.findings, [{ title: 'checkout (chromium)', location: 'cart.spec.ts:11',
    evidence: ['Error: locator.click timed out', '- waiting for getByRole("button", {name: "Pay"})'],
    nextStep: 'Inspect the recorded page at the failing step and check whether the locator matches the intended element.', source: 'rules' }]);
});

test('reports runner errors and an unexpected pass even without an error message', async () => {
  const data = report({ ...outcome('unexpected', [{ status: 'passed' }]), expectedStatus: 'failed' });
  data.errors.push({ message: 'Cannot find module "setup"', location: { file: 'config.ts', line: 8 } });
  const { findings, totalFailures } = await analyzeReport(data);
  assert.equal(totalFailures, 2);
  assert.match(findings[0].nextStep, /module/);
  assert.equal(findings[0].location, 'config.ts:8');
  assert.match(findings[1].evidence[0], /Observed status: passed/);
  assert.match(findings[1].nextStep, /expected-failure annotation/);
});

test('uses the observed and expected routes or numbers in offline next checks', async () => {
  const check = async message => (await analyzeReport(report(outcome('unexpected', [attempt(message)])))).findings[0].nextStep;
  const route = await check('Expected: "/payment"\r\nReceived: "/sign-in"');
  assert.match(route, /whether a redirect or session fixture/);
  assert.match(route, /\/sign-in.*\/payment/);
  assert.match(await check('Expected: 30\nReceived: 25'), /inputs.*25, which is 5 below the expected 30/);
  assert.match(await check('Expected: 0.1\nReceived: 0.3'), /0.3, which is 0.2 above the expected 0.1/);
  assert.match(await check('Expected: dog\nReceived: cat'), /Compare the expected and observed values/);
});

test('redacts values in tab-separated fields, CRLF lines and CR-only logs', async () => {
  const message = 'Error: expected status\r\napi_key\tsuper-secret\rpassword:\t"secret value"\r\nAuthorization\tprivateToken\r\nsession_id=hide-me';
  const { findings } = await analyzeReport(report(outcome('unexpected', [attempt(message)])));
  assert.doesNotMatch(JSON.stringify(findings), /super-secret|secret value|privateToken|hide-me/);
  assert.equal(findings[0].evidence.length, 5);
});

test('caps displayed findings while counting all failures', async () => {
  const { findings, totalFailures } = await analyzeReport(report(failed, failed, failed), { maxFindings: 1 });
  assert.equal(findings.length, 1);
  assert.equal(totalFailures, 3);
});

test('explains a failing job when failOnFlakyTests is enabled', async () => {
  const data = report(outcome('flaky', [attempt('first attempt timeout'), { status: 'passed' }]));
  data.config = { failOnFlakyTests: true };
  const result = await analyzeReport(data);
  assert.equal(result.totalFailures, 1);
  assert.equal(result.flakyTests, 1);
  assert.match(result.findings[0].evidence[0], /failOnFlakyTests/);
  assert.equal(result.findings[0].evidence[1], 'first attempt timeout');
});

test('rejects malformed reports and invalid limits', async () => {
  for (const data of [{}, { suites: [{}] }, { suites: [{ specs: [{}] }] }, report({ status: 'typo' })]) {
    await assert.rejects(analyzeReport(data), /Playwright/);
  }
  for (const maxFindings of [0, 11, 2.2]) await assert.rejects(analyzeReport(report(), { maxFindings }), /maxFindings/);
});

test('offline and clean reports make no network request', async () => {
  let calls = 0;
  const fetchImpl = () => { calls++; throw new Error('unexpected network request'); };
  assert.equal((await analyzeReport(report(failed), { fetchImpl })).aiStatus, 'off');
  assert.equal((await analyzeReport(report(), { apiKey: 'key', fetchImpl })).aiStatus, 'unused');
  assert.equal(calls, 0);
});

test('sends only selected redacted excerpts in one request and verifies the cited phrase', async () => {
  const result = { ...attempt('\u001b[31mError: 403 Forbidden\u001b[0m\nAuthorization: Bearer fake-token\napi_key="private-key"\nhttps://app.com/account?id=secret-data\nhello@example.com'),
    stdout: [{ text: 'private stdout' }], attachments: [{ body: 'private screenshot' }] };
  let requests = 0;
  const fetchImpl = async (url, options) => {
    requests++;
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'Bearer dummy');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'chosen-model');
    assert.equal(body.store, false);
    assert.doesNotMatch(body.messages[1].content, /private|fake-token|secret-data|example.com|cart.spec|checkout|chromium/i);
    const entries = JSON.parse(body.messages[1].content);
    assert.equal(entries[0].evidence[0], 'Error: 403 Forbidden');
    return completion(entries.map(({ id }) => ({ id, line: 0, anchor: '403 Forbidden', check: 'Check which request returned 403 Forbidden and inspect the session used for it.' })));
  };
  const { findings, aiStatus } = await analyzeReport(report(outcome('unexpected', [result]), outcome('unexpected', [result])), { apiKey: 'dummy', model: 'chosen-model', fetchImpl });
  assert.equal(requests, 1);
  assert.equal(aiStatus, 'used');
  assert.ok(findings.every(f => f.source === 'ai' && f.nextStep.includes('403 Forbidden')));
});

function completion(choices) {
  return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ choices }) } }] }) };
}

test('baseline requires the same project, file, suite path and title to actually pass', async () => {
  const base = report(outcome('expected', [{ status: 'passed' }]));
  const current = report(failed);
  const analyze = async baselineReport => (await analyzeReport(current, { baselineReport })).findings[0].baseline;
  assert.equal(await analyze(base), 'Passed in the supplied baseline report.');
  for (const change of [
    suite => { suite.title = 'Other describe block'; },
    suite => { suite.specs[0].title = 'login'; },
    suite => { suite.specs[0].file = 'other.spec.ts'; },
    suite => { suite.specs[0].tests[0].projectName = 'webkit'; },
    suite => { suite.specs[0].tests[0].status = 'flaky'; },
    suite => { suite.specs[0].tests[0].results[0].status = 'failed'; },
    suite => { suite.specs[0].tests.push(failed); },
  ]) {
    const baseline = structuredClone(base);
    change(baseline.suites[0].suites[0]);
    assert.equal(await analyze(baseline), undefined);
  }
});

test('provider failures, invalid or ungrounded suggestions leave all local findings intact', async () => {
  const data = report(failed, failed);
  const baseline = await analyzeReport(data);
  const ok = { id: 0, unknown: true };
  for (const fetchImpl of [async () => { throw new Error('timeout'); }, async () => ({ ok: false }),
    async () => completion([ok, ok]),
    async () => completion([ok, { id: 1, line: 0, anchor: 'Redirect', check: 'Check Redirect in the logs.' }]),
    async () => completion([ok, { id: 1, line: 1, anchor: 'Pay', check: 'Run a command for Pay.' }])]) {
    const result = await analyzeReport(data, { apiKey: 'dummy', fetchImpl });
    assert.equal(result.aiStatus, 'fallback');
    assert.deepEqual(result.findings, baseline.findings);
  }
});
