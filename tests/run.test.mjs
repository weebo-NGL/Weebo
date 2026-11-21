import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../src/run.mjs';

const sha = 'a'.repeat(40);
const artifact = 'https://github.com/example/shop/actions/runs/23/artifacts/31';
const badTitle = '<img src=x onerror="bad"> & title';

function report(status = 'unexpected', title = badTitle) {
  return { suites: [{ specs: [{ file: 'checkout.spec.ts', line: 2, title, tests: [
    { status, expectedStatus: 'passed', results: [{ status: status === 'unexpected' ? 'failed' : 'passed',
      error: { message: 'Timeout waiting for locator(#checkout)' } }] },
  ] }] }] };
}

async function context(t, status) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tracebrief-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = { full_name: 'example/shop' };
  const event = { number: 7, pull_request: { head: { repo, sha }, base: { repo } } };
  const reportPath = path.join(dir, 'playwright-report.json');
  const env = {
    GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: repo.full_name, GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: path.join(dir, 'event.json'),
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary'), GITHUB_OUTPUT: path.join(dir, 'out'),
    GITHUB_WORKSPACE: dir, GITHUB_WORKFLOW: 'tests', GITHUB_JOB: 'test', GITHUB_SHA: sha,
    GITHUB_RUN_ID: '23', INPUT_TOKEN: 'workflow-token', 'INPUT_ARTIFACT-URL': artifact,
  };
  await writeFile(env.GITHUB_EVENT_PATH, JSON.stringify(event));
  await writeFile(path.join(dir, 'checkout.spec.ts'), '/* test */');
  await writeFile(reportPath, '\uFEFF' + JSON.stringify(report(status)));
  const cliOptions = { argv: [], env, stdout: { write() {} }, stderr: { write() {} } };
  return { dir, event, env, reportPath, cliOptions };
}

test('CLI writes an escaped Markdown report and explicitly enables AI', async t => {
  const { dir, reportPath } = await context(t);
  const output = path.join(dir, 'out.md');
  const baseline = path.join(dir, 'baseline.json');
  await writeFile(baseline, JSON.stringify(report('expected')));
  const argv = [reportPath, '--output', output, '--artifact-url', artifact, '--baseline', baseline];
  const fetchImpl = () => assert.fail('Offline analysis attempted a network call');
  await run({ argv, env: { OPENAI_API_KEY: 'ambient-key' }, fetchImpl });
  const markdown = await readFile(output, 'utf8');
  assert.match(markdown, /1 unexpected failure\./);
  assert.match(markdown, /&lt;img src=x onerror=&quot;bad&quot;&gt; &amp; title/);
  assert.match(markdown, /Screenshots and traces/);
  assert.match(markdown, /Passed in the supplied baseline report/);
  assert.doesNotMatch(markdown, /<img|AI suggestion/);
  await assert.rejects(run({ argv: [...argv, '--ai'], env: {} }), /requires OPENAI_API_KEY/);
  await assert.rejects(run({ argv: [reportPath, '--output', reportPath], env: {} }), /different output/);
  for (const url of ['https://example.test/x', artifact + '?download=1', artifact + '\n', artifact.replace('example', '..')]) {
    await assert.rejects(run({ argv: [reportPath, '--artifact-url', url], env: {} }), /artifact-url/);
  }
});

test('first failure posts one comment, links the evidence, and a green rerun resolves it', async t => {
  const { env, reportPath, cliOptions } = await context(t);
  const calls = [];
  let body;
  const fetchImpl = async (url, options) => {
    calls.push([options.method, url]);
    assert.match(url, /^https:\/\/api\.github\.com\/repos\/example\/shop\//);
    assert.equal(options.headers.Authorization, 'Bearer workflow-token');
    if (url.includes('?per_page')) {
      const author = { login: 'github-actions[bot]', type: 'Bot' };
      return Response.json(body ? [{ id: 41, body, user: { login: 'unrelated', type: 'User' } }, { id: 42, body, user: author }] : []);
    }
    if (url.endsWith('/pulls/7')) return Response.json({ state: 'open', head: { sha } });
    body = JSON.parse(options.body).body;
    return new Response(null, { status: 201 });
  };
  await run({ ...cliOptions, fetchImpl });
  assert.equal(calls.at(-1)[0], 'POST');
  assert.match(body, /^<!-- tracebrief:/);
  assert.match(body, /blob\/a{40}\/checkout.spec.ts#L2/);
  assert.match(body, /View workflow run/);
  assert.match(body, /Screenshots and traces/);
  assert.equal(await readFile(env.GITHUB_OUTPUT, 'utf8'), 'failure-count=1\nflaky-count=0\n');
  await writeFile(reportPath, JSON.stringify(report('expected')));
  await run({ ...cliOptions, fetchImpl });
  assert.deepEqual(calls.at(-1), ['PATCH', 'https://api.github.com/repos/example/shop/issues/comments/42']);
  assert.match(body, /No unexpected failures/);
});

test('forks get a summary with neither AI traffic nor comment requests', async t => {
  const { event, env, cliOptions } = await context(t);
  event.pull_request.head.repo = { full_name: 'other/shop' };
  await writeFile(env.GITHUB_EVENT_PATH, JSON.stringify(event));
  env['INPUT_OPENAI-API-KEY'] = 'test-key';
  let requests = 0;
  await run({ ...cliOptions, fetchImpl: () => { requests++; throw Error(); } });
  assert.equal(requests, 0);
  assert.match(await readFile(env.GITHUB_STEP_SUMMARY, 'utf8'), /Next check/);
});

test('403 falls back to job summary and latest PR head must match before mutation', async t => {
  const { env, cliOptions } = await context(t);
  let warning = '';
  await run({ ...cliOptions, stderr: { write(s) { warning += s; } },
    fetchImpl: () => new Response(null, { status: 403 }) });
  assert.match(warning, /HTTP 403/);
  assert.match(await readFile(env.GITHUB_STEP_SUMMARY, 'utf8'), /Playwright/);
  const methods = [];
  await run({ ...cliOptions, fetchImpl: (u, o) => {
    methods.push(o.method);
    return Response.json(u.endsWith('/pulls/7') ? { state: 'open', head: { sha: 'b'.repeat(40) } } : []);
  } });
  assert.deepEqual(methods, ['GET', 'GET']);
});

test('summary-only clean runs avoid a fresh PR comment and unsafe contexts are rejected', async t => {
  const { env, cliOptions } = await context(t, 'expected');
  const calls = [];
  await run({ ...cliOptions, fetchImpl: (_, o) => { calls.push(o.method); return Response.json([]); } });
  assert.deepEqual(calls, ['GET']);
  env['INPUT_ARTIFACT-URL'] = artifact.replace('/23/', '/24/');
  await assert.rejects(run(cliOptions), /current repository and run/);
  env.GITHUB_EVENT_NAME = 'pull_request_target';
  await assert.rejects(run(cliOptions), /Use the pull_request event/);
});
