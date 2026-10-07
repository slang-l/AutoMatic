import { appendFileSync } from 'node:fs';

export const MAIN_BRANCH = 'master';
export const CI_WORKFLOW = 'ci-cd.yml';
export const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
export const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function releaseTag(version) {
  const value = String(version ?? '').replace(/^v/, '');
  if (!VERSION_PATTERN.test(value) || value.length > 80)
    throw new Error('版本号需使用 1.2.3 或 1.2.3-rc.1 格式');
  return `v${value}`;
}

export function positiveId(value, label = 'run ID') {
  if (!/^[1-9]\d{0,19}$/.test(String(value))) throw new Error(`Invalid ${label}`);
  return String(value);
}

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createGitHubClient({
  repository = process.env.GITHUB_REPOSITORY,
  token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
  fetcher = fetch,
} = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? ''))
    throw new Error('GITHUB_REPOSITORY must be owner/repository');
  if (!token) throw new Error('设置 GH_TOKEN / GITHUB_TOKEN，或先执行 gh auth login');
  const prefix = `/repos/${repository}`;
  async function request(
    path,
    {
      method = 'GET',
      body,
      raw = false,
      accept = 'application/vnd.github+json',
      contentType = 'application/json',
    } = {},
  ) {
    const url = path.startsWith('https://')
      ? new URL(path)
      : new URL(`https://api.github.com${prefix}${path}`);
    if (
      !['api.github.com', 'uploads.github.com'].includes(url.hostname) ||
      url.protocol !== 'https:'
    )
      throw new Error('Untrusted GitHub API URL');
    const headers = {
      authorization: `Bearer ${token}`,
      accept,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'automatic-cicd',
    };
    if (body !== undefined) headers['content-type'] = contentType;
    const response = await fetcher(url, {
      method,
      headers,
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(raw ? 180_000 : 30_000),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new GitHubError(
        response.status,
        `GitHub ${method} ${url.pathname}: ${payload.message || response.status}`,
      );
    }
    if (raw && method === 'GET') return Buffer.from(await response.arrayBuffer());
    return response.status === 204 ? undefined : response.json();
  }
  return { repository, request };
}

export function githubOutput(values, env = process.env) {
  if (!env.GITHUB_OUTPUT) return;
  for (const [key, value] of Object.entries(values)) {
    const text = String(value ?? '');
    if (!/^[a-z][a-z0-9_-]*$/.test(key) || /[\r\n]/.test(text))
      throw new Error('Invalid GitHub output');
    appendFileSync(env.GITHUB_OUTPUT, `${key}=${text}\n`);
  }
}

export function summary(text, env = process.env) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
}
