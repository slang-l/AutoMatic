import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { COMMIT_PATTERN, RELEASE_ID_PATTERN, summary } from './lib/github.mjs';

export async function verifyDeployment({
  url,
  release,
  commit,
  legacy = false,
  fetcher = fetch,
  attempts = 10,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const base = new URL(url);
  if (
    base.protocol !== 'https:' &&
    !(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname))
  )
    throw new Error('Production URL must use HTTPS');
  if (!RELEASE_ID_PATTERN.test(release ?? '') || (!legacy && !COMMIT_PATTERN.test(commit ?? '')))
    throw new Error('Invalid expected deployment identity');
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const load = async (path) => {
        const address = new URL(path, base);
        address.searchParams.set('verify', `${Date.now()}-${attempt}`);
        const response = await fetcher(address, {
          signal: AbortSignal.timeout(8000),
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`${path} returned ${response.status}`);
        return response.json();
      };
      const health = await load('/api/health');
      if (health.status !== 'ok' || health.service !== 'automatic-api')
        throw new Error('API health failed');
      if (!legacy) {
        const web = await load('/version.json');
        if (
          health.release !== release ||
          health.commit !== commit ||
          web.release !== release ||
          web.commit !== commit
        )
          throw new Error('API / frontend release identity mismatch');
      }
      return { release, commit, url: base.origin, legacy };
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < attempts) await sleep(2000);
  }
  throw lastError;
}

async function main() {
  const status = process.env.SERVER_STATUS_FILE
    ? JSON.parse(readFileSync(process.env.SERVER_STATUS_FILE, 'utf8'))
    : null;
  const result = await verifyDeployment({
    url: process.env.DEPLOY_URL || 'https://180.76.248.209',
    release: status?.release || process.env.RELEASE_ID,
    commit: status?.commit ?? process.env.RELEASE_COMMIT,
    legacy: status?.manifest === false,
  });
  summary(
    `公网验证通过：[${result.url}](${result.url})\n\n当前版本：\`${result.release}\`，提交：\`${result.commit || '旧版本未记录'}\`。`,
  );
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
