import { MAIN_BRANCH, CI_WORKFLOW, COMMIT_PATTERN, positiveId, releaseTag } from './github.mjs';

export async function trustedRun(client, runId, attempt) {
  const [run, workflow] = await Promise.all([
    client.request(
      `/actions/runs/${positiveId(runId)}${attempt ? `/attempts/${positiveId(attempt, 'run attempt')}` : ''}`,
    ),
    client.request(`/actions/workflows/${CI_WORKFLOW}`),
  ]);
  if (
    run.workflow_id !== workflow.id ||
    run.head_repository?.full_name !== client.repository ||
    run.head_branch !== MAIN_BRANCH ||
    !['push', 'workflow_dispatch'].includes(run.event) ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    !COMMIT_PATTERN.test(run.head_sha)
  ) {
    throw new Error('仅接受本仓库 master 分支成功完成的 CI 发布包，拒绝 PR、其他分支或失败任务');
  }
  return run;
}

export function runReleaseId(run) {
  return `${positiveId(run.id)}-${positiveId(run.run_attempt, 'run attempt')}-${run.head_sha.slice(0, 12)}`;
}

export async function resolveRunArtifact(client, runId) {
  const run = await trustedRun(client, runId);
  const release = runReleaseId(run);
  const artifacts = await client.request(`/actions/runs/${run.id}/artifacts?per_page=100`);
  const artifact = artifacts.artifacts.find(
    (item) => item.name === `release-${release}` && !item.expired,
  );
  if (!artifact)
    throw new Error('已验证发布包不存在或已过期；请重新运行 CI，或选择已保存的 Release 版本');
  return {
    kind: 'artifact',
    release,
    commit: run.head_sha,
    run_id: String(run.id),
    artifact: artifact.name,
    artifact_id: String(artifact.id),
    url: run.html_url,
  };
}

export async function mainCommit(client) {
  const ref = await client.request(`/git/ref/heads/${MAIN_BRANCH}`);
  if (!COMMIT_PATTERN.test(ref.object?.sha)) throw new Error('Invalid main branch commit');
  return ref.object.sha;
}

export async function latestArtifact(
  client,
  {
    waitMs = 600_000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
  } = {},
) {
  const commit = await mainCommit(client);
  const deadline = now() + waitMs;
  do {
    const data = await client.request(
      `/actions/workflows/${CI_WORKFLOW}/runs?branch=${MAIN_BRANCH}&head_sha=${commit}&per_page=100`,
    );
    const runs = data.workflow_runs.filter(
      (run) => run.head_sha === commit && ['push', 'workflow_dispatch'].includes(run.event),
    );
    for (const run of runs.filter(
      (item) => item.status === 'completed' && item.conclusion === 'success',
    )) {
      try {
        return { ...(await resolveRunArtifact(client, run.id)), latest: true };
      } catch (error) {
        if (!error.message.includes('已过期')) throw error;
      }
    }
    if (
      !runs.some((run) =>
        ['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(run.status),
      )
    ) {
      throw new Error(
        'master 当前提交没有可用的成功 CI 发布包，请先运行 CI；不会部署较旧提交代替它',
      );
    }
    if (now() >= deadline) break;
    if ((await mainCommit(client)) !== commit)
      throw new Error('等待期间 master 已更新，请针对最新提交重新执行');
    await sleep(10_000);
  } while (now() <= deadline);
  throw new Error('等待 CI 超时，请在 CI 完成后重试');
}

export async function tagCommit(client, tag) {
  let object = (await client.request(`/git/ref/tags/${encodeURIComponent(tag)}`)).object;
  // Support existing annotated as well as lightweight tags, with a depth bound.
  for (let depth = 0; object.type === 'tag' && depth < 5; depth++)
    object = (await client.request(`/git/tags/${object.sha}`)).object;
  if (object.type !== 'commit' || !COMMIT_PATTERN.test(object.sha))
    throw new Error('Invalid release tag target');
  return object.sha;
}

export async function releaseAssets(client, version) {
  const tag = releaseTag(version);
  const release = await client.request(`/releases/tags/${encodeURIComponent(tag)}`);
  if (release.draft) throw new Error('Release 尚未发布完成');
  const manifestAsset = release.assets.find((asset) =>
    /^\d+-\d+-[a-f0-9]{12}\.json$/.test(asset.name),
  );
  if (!manifestAsset) throw new Error('该版本没有 AutoMatic 发布包清单');
  const metadata = JSON.parse(
    (
      await client.request(`/releases/assets/${positiveId(manifestAsset.id, 'asset ID')}`, {
        raw: true,
        accept: 'application/octet-stream',
      })
    ).toString('utf8'),
  );
  const resolved = await trustedRun(client, metadata.buildRunId, metadata.buildAttempt);
  const id = runReleaseId({ ...resolved, run_attempt: metadata.buildAttempt });
  if (
    metadata.schema !== 1 ||
    metadata.source !== 'git' ||
    metadata.release !== id ||
    metadata.commit !== resolved.head_sha ||
    metadata.commit !== (await tagCommit(client, tag)) ||
    manifestAsset.name !== `${id}.json`
  )
    throw new Error('Release 清单、Git 标签和已验证 CI 不匹配');
  const archive = release.assets.find((asset) => asset.name === `${id}.tar.gz`);
  const checksum = release.assets.find((asset) => asset.name === `${id}.sha256`);
  if (!archive || !checksum) throw new Error('Release 缺少归档或校验文件');
  return {
    kind: 'release',
    release: id,
    commit: metadata.commit,
    run_id: String(resolved.id),
    archive_id: positiveId(archive.id, 'asset ID'),
    checksum_id: positiveId(checksum.id, 'asset ID'),
    manifest_id: positiveId(manifestAsset.id, 'asset ID'),
    tag,
    url: release.html_url,
  };
}
