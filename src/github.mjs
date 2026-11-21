import { createHash } from 'node:crypto';

const validRepo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export function githubRepo(env) {
  const repo = env.GITHUB_REPOSITORY || '';
  if (env.GITHUB_SERVER_URL !== 'https://github.com' || !validRepo.test(repo)) return '';
  return repo.split('/').some(part => part === '.' || part === '..') ? '' : repo;
}

function isCurrentRepoPr(event, repo) {
  return Number.isSafeInteger(event?.number) && event.number > 0
    && [event.pull_request?.base?.repo?.full_name, event.pull_request?.head?.repo?.full_name]
      .every(name => typeof name === 'string' && name.toLowerCase() === repo.toLowerCase());
}

export function isSameRepoPr(env, event) {
  const repo = githubRepo(env);
  return Boolean(repo && env.GITHUB_EVENT_NAME === 'pull_request' && isCurrentRepoPr(event, repo));
}

export async function updateComment({ env, event, markdown, hasFailures, fetchImpl = fetch }) {
  const repo = githubRepo(env);
  const token = env.INPUT_TOKEN;
  if (!token || !isSameRepoPr(env, event)) return 'summary only';
  const pr = event.number;
  const sha = event.pull_request.head.sha || '';
  if (!/^[a-f0-9]{40}$/i.test(sha)) return 'summary only';
  const workflowKey = createHash('sha256').update(JSON.stringify([env.GITHUB_WORKFLOW, env.GITHUB_JOB])).digest('hex').slice(0, 20);
  const marker = '<!-- tracebrief:' + workflowKey + ' -->';
  const issueComments = '/issues/' + pr + '/comments';

  async function api(path, method = 'GET', content) {
    const response = await fetchImpl('https://api.github.com/repos/' + repo + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'tracebrief-action',
      },
      body: content && JSON.stringify({ body: content }),
    });
    if (!response.ok) throw new Error('GitHub returned HTTP ' + response.status);
    if (method === 'GET') return response.json();
  }

  let existing;
  for (let page = 1; page <= 100; page++) {
    const comments = await api(issueComments + '?per_page=100&page=' + page);
    if (!Array.isArray(comments)) throw new Error('Unexpected GitHub comment response');
    existing = comments.find(comment => comment.user?.login === 'github-actions[bot]'
      && comment.user?.type === 'Bot' && comment.body?.startsWith(marker + '\n')
      && Number.isSafeInteger(comment.id));
    if (existing || comments.length < 100) break;
    if (page === 100) return 'summary only (comment pagination limit)';
  }
  if (!existing && !hasFailures) return 'summary only (no open failure comment)';
  const current = await api('/pulls/' + pr);
  if (current.head?.sha !== sha || current.state !== 'open') return 'summary only (pull request changed)';

  const body = marker + '\n' + markdown;
  if (existing) {
    if (existing.body === body) return 'comment already current';
    await api('/issues/comments/' + existing.id, 'PATCH', body);
    return 'comment updated';
  }
  await api(issueComments, 'POST', body);
  return 'comment posted';
}
