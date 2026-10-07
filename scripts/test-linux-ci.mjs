import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('.');
const suffix = randomBytes(6).toString('hex');
const network = `automatic-ci-test-${suffix}`;
const postgres = `automatic-ci-postgres-${suffix}`;
const runner = `automatic-ci-runner-${suffix}`;
const output = resolve('.tmp/cicd-linux');
mkdirSync(output, { recursive: true });
const run = (args) =>
  new Promise((resolveRun, reject) => {
    const child = spawn('docker', args, { stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolveRun() : reject(new Error(`docker ${args[0]} failed (${code})`)),
    );
  });
let networkCreated = false;
let databaseCreated = false;
try {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid workspace base commit');
  await run([
    'build',
    '--platform',
    'linux/amd64',
    '-t',
    'automatic-ci-test:local',
    '-f',
    'ops/Dockerfile.ci-test',
    'ops',
  ]);
  await run(['network', 'create', network]);
  networkCreated = true;
  await run([
    'run',
    '-d',
    '--name',
    postgres,
    '--network',
    network,
    '--network-alias',
    'postgres',
    '-e',
    'POSTGRES_DB=automatic_ci',
    '-e',
    'POSTGRES_USER=automatic_ci',
    '-e',
    'POSTGRES_PASSWORD=ci-only-password',
    '--health-cmd',
    'pg_isready -U automatic_ci -d automatic_ci',
    '--health-interval',
    '2s',
    '--health-retries',
    '30',
    'postgres:17-alpine',
  ]);
  databaseCreated = true;
  let healthy = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const status = execFileSync(
      'docker',
      ['inspect', '--format', '{{.State.Health.Status}}', postgres],
      { encoding: 'utf8', windowsHide: true },
    ).trim();
    if (status === 'healthy') {
      healthy = true;
      break;
    }
    await new Promise((finish) => setTimeout(finish, 1000));
  }
  if (!healthy) throw new Error('Isolated PostgreSQL did not become healthy');
  const database = 'postgresql://automatic_ci:ci-only-password@postgres:5432/automatic_ci';
  await run([
    'run',
    '--rm',
    '--name',
    runner,
    '--platform',
    'linux/amd64',
    '--network',
    network,
    '--mount',
    `type=bind,source=${root},target=/workspace,readonly`,
    '--mount',
    `type=bind,source=${output},target=/out`,
    '-e',
    `ARTICLE_TEST_DATABASE_URL=${database}`,
    '-e',
    `COLLABORATION_TEST_DATABASE_URL=${database}`,
    '-e',
    `CI_TEST_DATABASE_URL=${database}`,
    '-e',
    `AUTOMATIC_TEST_COMMIT=${commit}`,
    '-e',
    'NODE_OPTIONS=--max-old-space-size=4096',
    'automatic-ci-test:local',
    'bash',
    '/workspace/ops/verify-linux-ci.sh',
  ]);
  console.log(
    `发布包保存在 ${output}；source=working-tree，仅用于本地验证，未发布到 GitHub 或服务器。`,
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  const cleanup = (args) => {
    try {
      execFileSync('docker', args, { stdio: 'ignore', windowsHide: true });
    } catch {
      /* May already be removed by --rm. */
    }
  };
  cleanup(['rm', '-f', runner]);
  if (databaseCreated) cleanup(['rm', '-f', postgres]);
  if (networkCreated) cleanup(['network', 'rm', network]);
}
