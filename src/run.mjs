#!/usr/bin/env node
import { appendFile, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeReport } from './analyze.mjs';
import { githubRepo, isSameRepoPr, updateComment } from './github.mjs';

const usage = 'Usage: node src/run.mjs REPORT.json [--output FILE.md] [--ai] [--model NAME] [--baseline BASE.json] [--artifact-url URL]\n' +
  'AI suggestions require --ai and OPENAI_API_KEY. The default runs locally.';
const limit = 64 * 1024 * 1024;

function within(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function html(value, max = 480) {
  return String(value ?? '').slice(0, max)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
    .replaceAll('\n', ' ').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;').replaceAll('@', '@\u200b');
}

function parseCli(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--ai') options.ai = true;
    else if (['--output', '--model', '--baseline', '--artifact-url'].includes(arg) && argv[i + 1] && !argv[i + 1].startsWith('-')) {
      options[arg.slice(2)] = argv[++i];
    } else if (!arg.startsWith('-') && !options.report) options.report = arg;
    else throw new Error(usage);
  }
  if (!options.report) throw new Error(usage);
  return options;
}

function artifactUrl(text, repo, runId) {
  if (!text) return '';
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/actions\/runs\/([1-9]\d*)\/artifacts\/[1-9]\d*$/.exec(text);
  if (!match || match[0] !== text || [match[1], match[2]].some(part => part === '.' || part === '..')) {
    throw new Error('artifact-url must be a GitHub Actions artifact URL.');
  }
  if (repo !== undefined && ((match[1] + '/' + match[2]).toLowerCase() !== repo.toLowerCase() || match[3] !== runId)) {
    throw new Error('artifact-url must belong to the current repository and run.');
  }
  return text;
}

async function loadReport(file, workspace) {
  const resolved = await realpath(file);
  if (workspace && !within(workspace, resolved)) throw new Error('Report must be inside the workspace.');
  const info = await stat(resolved);
  if (!info.isFile() || info.size > limit) throw new Error('Report must be a regular JSON file of at most 64 MiB.');
  const raw = await readFile(resolved, 'utf8');
  try { return JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch { throw new Error('Invalid JSON. Supply a Playwright JSON reporter file.'); }
}

async function linkLocation(location, context) {
  const { workspace, repo, sha, rootDir } = context;
  if (!workspace || !repo || !/^[0-9a-f]{40}$/i.test(sha || '')) return '';
  const match = /^(.+?):(\d+)(?::\d+)?$/.exec(location);
  if (!match || Number(match[2]) < 1) return '';
  try {
    const candidate = path.resolve(workspace, rootDir || '.', match[1]);
    if (!within(workspace, candidate)) return '';
    const resolved = await realpath(candidate);
    if (!within(workspace, resolved) || !(await stat(resolved)).isFile()) return '';
    const parts = path.relative(workspace, resolved).split(path.sep).map(encodeURIComponent);
    return 'https://github.com/' + repo + '/blob/' + sha + '/' + parts.join('/') + '#L' + match[2];
  } catch { return ''; }
}

export async function renderMarkdown(analysis, context = {}) {
  const { totalFailures, findings, flakyTests, aiStatus } = analysis;
  const lines = ['## TraceBrief · Playwright', '', totalFailures === 0 ? '**No unexpected failures.**' :
    '**' + totalFailures + ' unexpected failure' + (totalFailures === 1 ? '' : 's') + '.**'];
  if (flakyTests > 0) lines.push('', flakyTests + ' test' + (flakyTests === 1 ? '' : 's') + ' recovered on retry.');
  for (const finding of findings) {
    const url = await linkLocation(finding.location, context);
    const location = '<code>' + html(finding.location) + '</code>';
    lines.push('', '<h3>' + html(finding.title, 220) + '</h3>');
    if (finding.location) lines.push('', '<p>' + (url ? '<a href="' + html(url, 1500) + '">' + location + '</a>' : location) + '</p>');
    if (finding.baseline) lines.push('', '<p>' + html(finding.baseline) + '</p>');
    if (finding.evidence.length) lines.push('', '<pre>' + finding.evidence.slice(0, 4).map(e => html(e, 320)).join('\n') + '</pre>');
    lines.push('', '<p><strong>' + (finding.source === 'ai' ? 'AI suggestion' : 'Next check') + '</strong> · ' + html(finding.nextStep) + '</p>');
  }
  if (totalFailures > findings.length) lines.push('', 'Showing ' + findings.length + ' of ' + totalFailures + ' failures.');
  if (aiStatus === 'fallback') lines.push('', 'AI suggestions were unavailable for some or all findings. Local checks are included.');
  if (context.repo && /^\d+$/.test(context.runId || '')) {
    lines.push('', '[View workflow run](https://github.com/' + context.repo + '/actions/runs/' + context.runId + ')');
  }
  if (context.artifact) lines.push('', '[Screenshots and traces](' + context.artifact + ')');
  return lines.join('\n') + '\n';
}

export async function run({ argv = process.argv.slice(2), env = process.env, fetchImpl = fetch,
  stdout = process.stdout, stderr = process.stderr } = {}) {
  if (argv.includes('--help') || argv.includes('-h')) { stdout.write(usage + '\n'); return; }
  const action = !argv.length && env.GITHUB_ACTIONS === 'true';
  if (action && env.GITHUB_EVENT_NAME === 'pull_request_target') {
    throw new Error('Use the pull_request event to analyze PR reports.');
  }
  let options, event, workspace;
  if (action) {
    workspace = await realpath(env.GITHUB_WORKSPACE);
    if (env.GITHUB_EVENT_NAME === 'pull_request') event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
    const comment = (env.INPUT_COMMENT || 'true').toLowerCase();
    if (!['true', 'false'].includes(comment)) throw new Error('comment must be true or false.');
    options = { report: path.resolve(workspace, env.INPUT_REPORT || 'playwright-report.json'),
      baseline: env.INPUT_BASELINE && path.resolve(workspace, env.INPUT_BASELINE), 'artifact-url': env['INPUT_ARTIFACT-URL'],
      comment: comment === 'true', model: env.INPUT_MODEL || undefined,
      apiKey: env.GITHUB_EVENT_NAME === 'pull_request' && !isSameRepoPr(env, event) ? undefined : env['INPUT_OPENAI-API-KEY'] };
  } else {
    options = parseCli(argv);
    if (options.ai && !env.OPENAI_API_KEY) throw new Error('--ai requires OPENAI_API_KEY.');
    options.apiKey = options.ai ? env.OPENAI_API_KEY : undefined;
  }
  const artifact = artifactUrl(options['artifact-url'], action ? githubRepo(env) : undefined, env.GITHUB_RUN_ID);
  const report = await loadReport(options.report, workspace);
  const baselineReport = options.baseline ? await loadReport(options.baseline, workspace) : undefined;
  const analysis = await analyzeReport(report, { apiKey: options.apiKey, model: options.model, fetchImpl, baselineReport });
  const markdown = await renderMarkdown(analysis, action ? { artifact,
    workspace, repo: githubRepo(env), sha: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, rootDir: report.config?.rootDir,
  } : { artifact });
  if (!action) {
    if (options.output) {
      const inputPath = await realpath(options.report);
      const outputPath = await realpath(options.output).catch(() => path.resolve(options.output));
      if (inputPath === outputPath || (options.baseline && await realpath(options.baseline) === outputPath)) {
        throw new Error('Choose a different output path from the input reports.');
      }
      await writeFile(options.output, markdown);
    } else stdout.write(markdown);
    return;
  }
  await appendFile(env.GITHUB_STEP_SUMMARY, markdown);
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, 'failure-count=' + analysis.totalFailures + '\nflaky-count=' + analysis.flakyTests + '\n');
  if (options.comment) {
    try {
      const status = await updateComment({ env, event, markdown, hasFailures: analysis.totalFailures > 0, fetchImpl });
      stdout.write('TraceBrief: ' + status + '.\n');
    } catch (error) {
      const status = /^GitHub returned HTTP \d{3}$/.test(error.message) ? ' (' + error.message + ')' : '';
      stderr.write('TraceBrief could not update the PR comment' + status + '. The report is in the job summary.\n');
    }
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => {
    process.stderr.write('TraceBrief: ' + error.message + '\n');
    process.exitCode = 1;
  });
}
