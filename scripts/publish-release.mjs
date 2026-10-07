import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  createGitHubClient,
  GitHubError,
  githubOutput,
  releaseTag,
  summary,
} from './lib/github.mjs';
import { mainCommit, tagCommit, trustedRun, runReleaseId } from './lib/releases.mjs';
import { verifiedBundle } from './lib/bundle.mjs';

export async function publishRelease(client, { directory, version, release, commit }) {
  const tag = releaseTag(version);
  const { files, metadata } = verifiedBundle(directory, { release, commit });
  const run = await trustedRun(client, metadata.buildRunId, metadata.buildAttempt);
  if (run.head_sha !== commit || runReleaseId(run) !== release)
    throw new Error('Bundle build provenance is invalid');
  if ((await mainCommit(client)) !== commit)
    throw new Error('master 已更新，请用最新成功 CI 发布版本');
  try {
    if ((await tagCommit(client, tag)) !== commit)
      throw new Error('该版本标签已指向其他提交，不能覆盖');
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 404) throw error;
    await client.request('/git/refs', {
      method: 'POST',
      body: { ref: `refs/tags/${tag}`, sha: commit },
    });
  }
  let record;
  try {
    record = await client.request(`/releases/tags/${encodeURIComponent(tag)}`);
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 404) throw error;
  }
  if (record && !record.draft)
    throw new Error('该版本已发布，请用一键部署指定标签；修改内容需要新的版本号');
  if (record && !record.body?.includes(`<!-- automatic-build:${release} -->`))
    throw new Error('已有草稿属于另一构建，请使用新版本号或先处理旧草稿');
  record ??= await client.request('/releases', {
    method: 'POST',
    body: {
      tag_name: tag,
      target_commitish: commit,
      name: tag,
      draft: true,
      prerelease: tag.split('+')[0].includes('-'),
      generate_release_notes: true,
      body: `<!-- automatic-build:${release} -->\n\nVerified CI: ${run.html_url}\n\nCommit: \`${commit}\`\n\nRelease bundle: \`${release}\`\n\n数据库迁移采用向前兼容方式；代码回滚不恢复数据库。`,
    },
  });
  for (const file of files) {
    const name = file.split(/[\\/]/).at(-1);
    const bytes = readFileSync(file);
    const existing = record.assets?.find((asset) => asset.name === name);
    if (existing) {
      const uploaded = await client.request(`/releases/assets/${existing.id}`, {
        raw: true,
        accept: 'application/octet-stream',
      });
      if (!uploaded.equals(bytes)) throw new Error(`草稿中的 ${name} 与本次构建不同，拒绝覆盖`);
      continue;
    }
    const upload = new URL(record.upload_url.replace(/\{.*$/, ''));
    upload.searchParams.set('name', name);
    await client.request(upload.href, {
      method: 'POST',
      body: bytes,
      raw: true,
      contentType: name.endsWith('.json') ? 'application/json' : 'application/octet-stream',
    });
  }
  const published = await client.request(`/releases/${record.id}`, {
    method: 'PATCH',
    body: { draft: false },
  });
  return { tag, release, commit, url: published.html_url };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  publishRelease(createGitHubClient(), {
    directory: 'artifact',
    version: process.env.RELEASE_VERSION,
    release: process.env.RELEASE_ID,
    commit: process.env.RELEASE_COMMIT,
  })
    .then((result) => {
      githubOutput(result);
      summary(`已发布 [${result.tag}](${result.url})，复用已验证包 \`${result.release}\`。`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
