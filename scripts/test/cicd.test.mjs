import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGitHubClient, GitHubError, releaseTag } from '../lib/github.mjs';
import { latestArtifact, releaseAssets, resolveRunArtifact, trustedRun } from '../lib/releases.mjs';
import { verifiedBundle } from '../lib/bundle.mjs';
import { resolveRelease } from '../resolve-release.mjs';
import { publishRelease } from '../publish-release.mjs';
import { verifyDeployment } from '../verify-deployment.mjs';
import {
  assertRemoteSource,
  dispatchAndWait,
  parseCommand,
  repositoryFromRemote,
} from '../cicd.mjs';

const repository = 'slang-l/AutoMatic';
const commit = 'a'.repeat(40);
const release = '42-1-aaaaaaaaaaaa';
const run = {
  id: 42,
  run_attempt: 1,
  workflow_id: 7,
  head_repository: { full_name: repository },
  head_branch: 'master',
  head_sha: commit,
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  html_url: `https://github.com/${repository}/actions/runs/42`,
};
const metadata = {
  schema: 1,
  release,
  commit,
  source: 'git',
  nodeMajor: 22,
  platform: 'linux',
  arch: 'x64',
  buildRunId: '42',
  buildAttempt: '1',
  repository,
};
function clientWith(overrides = {}) {
  const calls = [];
  return {
    repository,
    calls,
    async request(path, options = {}) {
      calls.push({ path, options });
      if (overrides[path]) return overrides[path](options);
      if (path === '/actions/workflows/ci-cd.yml') return { id: 7 };
      if (['/actions/runs/42', '/actions/runs/42/attempts/1'].includes(path))
        return structuredClone(run);
      if (path === '/actions/runs/42/artifacts?per_page=100')
        return { artifacts: [{ id: 8, name: `release-${release}`, expired: false }] };
      if (path === '/git/ref/heads/master') return { object: { type: 'commit', sha: commit } };
      if (path.startsWith('/actions/workflows/ci-cd.yml/runs?'))
        return { workflow_runs: [structuredClone(run)] };
      throw new Error(`Unexpected API call ${path}`);
    },
  };
}

test('versions and one-click options validate input before any network mutation', () => {
  assert.equal(releaseTag('1.2.3'), 'v1.2.3');
  assert.equal(releaseTag('v1.2.3-rc.1+build.2'), 'v1.2.3-rc.1+build.2');
  for (const value of ['1.2', '01.2.3', '1.2.3-01', 'v1.2.3;rm -rf /', undefined])
    assert.throws(() => releaseTag(value));
  assert.deepEqual(parseCommand(['rollback']).inputs, { release: 'previous' });
  assert.deepEqual(parseCommand(['release', '1.2.3', '--no-deploy']).inputs, {
    version: 'v1.2.3',
    deploy: 'false',
  });
  assert.deepEqual(parseCommand(['deploy', '--tag', '1.2.3']).inputs, {
    source: 'tag',
    reference: 'v1.2.3',
  });
  assert.equal(parseCommand(['deploy']).wait, true);
  for (const args of [
    ['deploy', '--run', '42;echo'],
    ['deploy', '--tag', '1.2.3', '--run', '42'],
    ['rollback', '../outside'],
    ['status', '--no-deploy'],
  ])
    assert.throws(() => parseCommand(args));
  assert.equal(repositoryFromRemote('https://github.com/slang-l/AutoMatic.git'), repository);
  assert.equal(repositoryFromRemote('git@github.com:slang-l/AutoMatic.git'), repository);
  assert.throws(() => repositoryFromRemote('https://github.com.attacker/slang-l/AutoMatic.git'));
});

test('GitHub client never sends credentials to an untrusted host and reports failed dispatches', async () => {
  let requests = 0;
  const client = createGitHubClient({
    repository,
    token: 'unit-test-only',
    fetcher: async () => {
      requests++;
      return new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 });
    },
  });
  await assert.rejects(client.request('https://attacker.example/upload'), /Untrusted/);
  assert.equal(requests, 0);
  await assert.rejects(
    client.request('/actions/workflows/deploy.yml/dispatches', { method: 'POST', body: {} }),
    /Forbidden/,
  );
});

test('build provenance rejects failed jobs, pull requests, forks, other branches and other workflows', async () => {
  for (const patch of [
    { conclusion: 'failure' },
    { event: 'pull_request' },
    { head_branch: 'feature' },
    { head_repository: { full_name: 'outsider/AutoMatic' } },
    { workflow_id: 999 },
    { head_sha: 'bad' },
  ]) {
    const client = clientWith({ '/actions/runs/42': () => ({ ...run, ...patch }) });
    await assert.rejects(trustedRun(client, 42), /仅接受/);
  }
  assert.equal((await resolveRunArtifact(clientWith(), 42)).release, release);
});

test('latest deployment never substitutes an older successful build for current master', async () => {
  const client = clientWith({
    '/git/ref/heads/master': () => ({ object: { sha: 'b'.repeat(40) } }),
  });
  await assert.rejects(latestArtifact(client, { waitMs: 0 }), /当前提交没有/);
  assert.ok(!client.calls.some((call) => call.path === '/actions/runs/42/artifacts?per_page=100'));
});

test('latest waits for the matching pending build but detects branch movement during the wait', async () => {
  let polls = 0;
  const path = `/actions/workflows/ci-cd.yml/runs?branch=master&head_sha=${commit}&per_page=100`;
  const client = clientWith({
    [path]: () => ({ workflow_runs: [{ ...run, status: polls++ ? 'completed' : 'in_progress' }] }),
  });
  let elapsed = 0;
  const result = await latestArtifact(client, {
    now: () => elapsed,
    sleep: async (ms) => {
      elapsed += ms;
    },
  });
  assert.equal(result.release, release);
  let references = 0;
  const moved = clientWith({
    '/git/ref/heads/master': () => ({ object: { sha: references++ ? 'b'.repeat(40) : commit } }),
    [path]: () => ({ workflow_runs: [{ ...run, status: 'in_progress' }] }),
  });
  await assert.rejects(latestArtifact(moved, { sleep: async () => {} }), /master 已更新/);
});

test('expired artifacts fail clearly; PR or superseded workflow_run events never enter deployment', async () => {
  const expired = clientWith({
    '/actions/runs/42/artifacts?per_page=100': () => ({
      artifacts: [{ name: `release-${release}`, expired: true }],
    }),
  });
  await assert.rejects(resolveRunArtifact(expired, 42), /已过期/);
  const client = clientWith();
  assert.equal(
    (await resolveRelease(client, { event: { workflow_run: { ...run, event: 'pull_request' } } }))
      .skip,
    'true',
  );
  assert.equal(client.calls.length, 0);
  const stale = clientWith({
    '/git/ref/heads/master': () => ({ object: { sha: 'b'.repeat(40) } }),
  });
  assert.equal((await resolveRelease(stale, { event: { workflow_run: run } })).skip, 'true');
});

test('permanent Release assets require a published tag and the exact successful build attempt', async () => {
  const record = {
    draft: false,
    html_url: 'https://github.com/slang-l/AutoMatic/releases/tag/v1.2.3',
    assets: [
      { id: 101, name: `${release}.json` },
      { id: 102, name: `${release}.tar.gz` },
      { id: 103, name: `${release}.sha256` },
    ],
  };
  const client = clientWith({
    '/releases/tags/v1.2.3': () => record,
    '/releases/assets/101': () => Buffer.from(JSON.stringify(metadata)),
    '/git/ref/tags/v1.2.3': () => ({ object: { type: 'commit', sha: commit } }),
  });
  const result = await releaseAssets(client, '1.2.3');
  assert.equal(result.kind, 'release');
  assert.ok(client.calls.some((call) => call.path === '/actions/runs/42/attempts/1'));
  const moved = clientWith({
    '/releases/tags/v1.2.3': () => record,
    '/releases/assets/101': () => Buffer.from(JSON.stringify(metadata)),
    '/git/ref/tags/v1.2.3': () => ({ object: { type: 'commit', sha: 'b'.repeat(40) } }),
  });
  await assert.rejects(releaseAssets(moved, '1.2.3'), /不匹配/);
});

function fixtureBundle(t) {
  const directory = mkdtempSync(join(tmpdir(), 'automatic-cicd-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const archive = Buffer.from('isolated archive bytes');
  writeFileSync(join(directory, `${release}.tar.gz`), archive);
  writeFileSync(
    join(directory, `${release}.sha256`),
    createHash('sha256').update(archive).digest('hex') + '\n',
  );
  writeFileSync(join(directory, `${release}.json`), JSON.stringify(metadata));
  return directory;
}

test('bundle verification rejects tampering and a manifest for another commit', (t) => {
  const directory = fixtureBundle(t);
  assert.equal(verifiedBundle(directory, { release, commit }).metadata.release, release);
  assert.throws(() => verifiedBundle(directory, { release, commit: 'b'.repeat(40) }), /manifest/);
  writeFileSync(join(directory, `${release}.tar.gz`), 'tampered');
  assert.throws(() => verifiedBundle(directory, { release, commit }), /checksum mismatch/);
});

test('publication creates a draft, uploads all verified assets, then publishes; tags are never overwritten', async (t) => {
  const directory = fixtureBundle(t);
  const missing = () => {
    throw new GitHubError(404, 'Not found');
  };
  const client = clientWith({
    '/git/ref/tags/v1.2.3': missing,
    '/releases/tags/v1.2.3': missing,
    '/git/refs': () => ({}),
    '/releases': ({ body }) => {
      assert.equal(body.draft, true);
      return {
        id: 99,
        upload_url:
          'https://uploads.github.com/repos/slang-l/AutoMatic/releases/99/assets{?name,label}',
        assets: [],
      };
    },
    '/releases/99': ({ body }) => {
      assert.equal(body.draft, false);
      return { html_url: 'https://github.com/slang-l/AutoMatic/releases/tag/v1.2.3' };
    },
  });
  const original = client.request;
  client.request = async (path, options) =>
    path.startsWith('https://uploads.github.com/')
      ? (client.calls.push({ path, options }), {})
      : original(path, options);
  const result = await publishRelease(client, { directory, version: '1.2.3', release, commit });
  assert.equal(result.tag, 'v1.2.3');
  assert.equal(
    client.calls.filter((call) => call.path.startsWith('https://uploads.github.com/')).length,
    3,
  );
  assert.equal(client.calls.at(-1).path, '/releases/99');
  const conflicting = clientWith({
    '/git/ref/tags/v1.2.3': () => ({ object: { type: 'commit', sha: 'b'.repeat(40) } }),
  });
  await assert.rejects(
    publishRelease(conflicting, { directory, version: '1.2.3', release, commit }),
    /不能覆盖/,
  );
  assert.ok(!conflicting.calls.some((call) => call.options.method === 'POST'));
});

test('publication failures leave a draft and never publish partial uploads', async (t) => {
  const directory = fixtureBundle(t);
  const client = clientWith({
    '/git/ref/tags/v1.2.3': () => ({ object: { type: 'commit', sha: commit } }),
    '/releases/tags/v1.2.3': () => ({
      id: 99,
      draft: true,
      body: `<!-- automatic-build:${release} -->`,
      assets: [],
      upload_url:
        'https://uploads.github.com/repos/slang-l/AutoMatic/releases/99/assets{?name,label}',
    }),
  });
  const original = client.request;
  client.request = (path, options) =>
    path.startsWith('https://uploads.github.com/')
      ? Promise.reject(new Error('Upload interrupted'))
      : original(path, options);
  await assert.rejects(
    publishRelease(client, { directory, version: '1.2.3', release, commit }),
    /Upload interrupted/,
  );
  assert.ok(!client.calls.some((call) => call.options.method === 'PATCH'));
});

test('public verification checks both API and frontend identity, not only HTTP 200', async () => {
  const fetcher = async (url) =>
    new Response(
      JSON.stringify(
        url.pathname === '/api/health'
          ? { status: 'ok', service: 'automatic-api', release, commit }
          : { release, commit },
      ),
      { status: 200 },
    );
  assert.equal(
    (await verifyDeployment({ url: 'https://example.test', release, commit, fetcher })).release,
    release,
  );
  await assert.rejects(
    verifyDeployment({
      url: 'https://example.test',
      release,
      commit,
      attempts: 1,
      fetcher: async () =>
        new Response(
          JSON.stringify({ status: 'ok', service: 'automatic-api', release: 'wrong', commit }),
        ),
    }),
    /identity mismatch/,
  );
  await assert.rejects(
    verifyDeployment({ url: 'http://production.example', release, commit, fetcher }),
    /HTTPS/,
  );
});

test('local CLI refuses dirty or unpushed code unless the caller explicitly selects remote code', async () => {
  const client = clientWith();
  await assert.rejects(
    assertRemoteSource(client, parseCommand(['release', '1.2.3']), () => ' M user-file'),
    /未提交/,
  );
  assert.equal(client.calls.length, 0);
  await assertRemoteSource(client, parseCommand(['release', '1.2.3', '--remote']), () => {
    throw new Error('Git should not be read');
  });
  await assert.rejects(
    assertRemoteSource(client, parseCommand(['deploy']), (_program, args) =>
      args[0] === 'status' ? '' : 'b'.repeat(40),
    ),
    /HEAD 与远端/,
  );
});

test('CLI correlates its dispatch, waits for completion and propagates a failed workflow', async () => {
  let polls = 0;
  const operation = parseCommand(['deploy', '--remote']);
  const client = clientWith({
    '/actions/workflows/deploy.yml/dispatches': () => undefined,
    '/actions/workflows/deploy.yml/runs?event=workflow_dispatch&branch=master&per_page=100':
      () => ({
        workflow_runs: [
          { ...run, id: 101, display_title: 'Deploy latest cli-unit-request', status: 'queued' },
          { ...run, id: 102, display_title: 'Someone else' },
        ],
      }),
    '/actions/runs/101': () => ({
      ...run,
      id: 101,
      status: ++polls > 1 ? 'completed' : 'in_progress',
    }),
  });
  const result = await dispatchAndWait(client, operation, {
    correlation: 'unit-request',
    sleep: async () => {},
    log: () => {},
  });
  assert.equal(result.id, 101);
  assert.equal(client.calls[0].options.body.ref, 'master');
  assert.equal(client.calls[0].options.body.inputs.source, 'latest');
  client.request = async (path) =>
    path.endsWith('/dispatches')
      ? undefined
      : { workflow_runs: [{ ...run, display_title: 'cli-failed', conclusion: 'failure' }] };
  await assert.rejects(
    dispatchAndWait(client, operation, { correlation: 'failed', log: () => {} }),
    /任务 failure/,
  );
});

test('CLI no-wait triggers only once and prints the workflow link', async () => {
  const client = clientWith({ '/actions/workflows/rollback.yml/dispatches': () => undefined });
  const result = await dispatchAndWait(client, parseCommand(['rollback', '--no-wait']), {
    log: () => {},
  });
  assert.equal(result.dispatched, true);
  assert.equal(client.calls.length, 1);
});
