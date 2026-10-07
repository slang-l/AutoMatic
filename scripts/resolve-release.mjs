import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createGitHubClient, githubOutput, summary } from './lib/github.mjs';
import { latestArtifact, mainCommit, releaseAssets, resolveRunArtifact } from './lib/releases.mjs';

export async function resolveRelease(
  client,
  { source = 'latest', reference = '', event = null } = {},
) {
  if (event?.workflow_run) {
    const run = event.workflow_run;
    if (
      run.event !== 'push' ||
      run.head_branch !== 'master' ||
      run.head_repository?.full_name !== client.repository ||
      run.conclusion !== 'success'
    )
      return { skip: 'true', reason: '非 master 主仓库的成功 push，跳过自动部署' };
    if (run.head_sha !== (await mainCommit(client)))
      return { skip: 'true', reason: '已有更新的 master 提交，跳过旧版本自动部署' };
    return { ...(await resolveRunArtifact(client, run.id)), latest: true, skip: 'false' };
  }
  if (source === 'latest') return { ...(await latestArtifact(client)), skip: 'false' };
  if (source === 'run') return { ...(await resolveRunArtifact(client, reference)), skip: 'false' };
  if (source === 'tag') return { ...(await releaseAssets(client, reference)), skip: 'false' };
  throw new Error('Unknown deployment source');
}

async function main() {
  const event =
    process.env.GITHUB_EVENT_NAME === 'workflow_run'
      ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
      : null;
  const result = await resolveRelease(createGitHubClient(), {
    source: process.env.RELEASE_SOURCE || 'latest',
    reference: process.env.RELEASE_REFERENCE || '',
    event,
  });
  githubOutput(result);
  summary(
    result.skip === 'true'
      ? result.reason
      : `发布包 **${result.release}**，提交 \`${result.commit}\`。\n\n来源：[已验证构建 / Release](${result.url})。`,
  );
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
