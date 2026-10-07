import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  createGitHubClient,
  MAIN_BRANCH,
  positiveId,
  releaseTag,
  RELEASE_ID_PATTERN,
} from './lib/github.mjs';

const HELP = `AutoMatic CI/CD（操作远端已提交代码，不自动提交本地文件）
  pnpm ci:run                         验证并构建 master
  pnpm deploy:prod                    部署 master 当前提交的成功 CI 包
  pnpm deploy:prod --tag v1.2.3        部署已发布的版本
  pnpm deploy:prod --run 123456789     部署指定成功 CI 包
  pnpm release 1.2.3                   创建版本 Release 并部署
  pnpm release 1.2.3 --no-deploy       只发布版本，不部署
  pnpm rollback                       回滚服务器记录的上一版代码
  pnpm rollback RELEASE_ID            回滚指定保留版本
  pnpm deploy:status                  查看服务器当前、上一版和保留版本

默认等待 Actions 完成；--no-wait 只触发任务。
本地未提交或 HEAD 与远端 master 不同时拒绝发布；--remote 明确选择操作远端版本。
先安装 GitHub CLI 并执行 gh auth login，或设置 GH_TOKEN（Actions: write，Contents: read）。`;

export function parseCommand(args) {
  const [command, ...rest] = args;
  if (!command || ['--help', '-h', 'help'].includes(command) || rest.includes('--help'))
    return { help: true };
  const options = { wait: true, remote: false, deploy: true };
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const value = rest[i];
    if (value === '--no-wait') options.wait = false;
    else if (value === '--remote') options.remote = true;
    else if (value === '--no-deploy') options.deploy = false;
    else if (['--tag', '--run'].includes(value)) {
      if (options.source) throw new Error('--tag 和 --run 只能选择一个');
      const reference = rest[++i];
      options.source = value === '--tag' ? 'tag' : 'run';
      options.reference = value === '--tag' ? releaseTag(reference) : positiveId(reference);
    } else if (value.startsWith('-')) throw new Error(`Unknown option: ${value}`);
    else positional.push(value);
  }
  if (positional.length > 1) throw new Error('Too many arguments');
  const workflows = {
    ci: 'ci-cd.yml',
    deploy: 'deploy.yml',
    release: 'release.yml',
    rollback: 'rollback.yml',
    status: 'status.yml',
  };
  if (!workflows[command]) throw new Error('Unknown command; run pnpm cicd --help');
  if (command !== 'deploy' && options.source) throw new Error('--tag / --run 仅用于 deploy');
  if (command !== 'release' && !options.deploy) throw new Error('--no-deploy 仅用于 release');
  let inputs = {};
  if (command === 'release')
    inputs = { version: releaseTag(positional[0]), deploy: String(options.deploy) };
  else if (command === 'deploy') {
    if (positional.length) throw new Error('Use --tag VERSION or --run RUN_ID');
    inputs = { source: options.source || 'latest', reference: options.reference || '' };
  } else if (command === 'rollback') {
    const release = positional[0] || 'previous';
    if (!RELEASE_ID_PATTERN.test(release)) throw new Error('Invalid rollback release ID');
    inputs = { release };
  } else if (positional.length) throw new Error('This command has no positional arguments');
  return { command, workflow: workflows[command], inputs, ...options };
}

export function repositoryFromRemote(remote) {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
      remote.trim(),
    );
  if (!match)
    throw new Error('origin 必须指向 GitHub；也可设置 GITHUB_REPOSITORY=owner/repository');
  return match[1];
}

function runLocal(program, args) {
  return execFileSync(program, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}

export async function assertRemoteSource(client, { command, source, remote }, run = runLocal) {
  if (
    remote ||
    ['rollback', 'status'].includes(command) ||
    (command === 'deploy' && source && source !== 'latest')
  )
    return;
  if (run('git', ['status', '--porcelain', '--ignore-submodules=dirty']))
    throw new Error('本地有未提交文件。先提交并 push；如仅操作远端已提交代码，添加 --remote');
  const local = run('git', ['rev-parse', 'HEAD']);
  const ref = await client.request(`/git/ref/heads/${MAIN_BRANCH}`);
  if (local !== ref.object.sha)
    throw new Error('本地 HEAD 与远端 master 不同。请先 push / 合并，或明确使用 --remote');
}

export async function dispatchAndWait(
  client,
  operation,
  {
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    log = console.log,
    timeoutMs = 45 * 60_000,
    correlation = randomUUID(),
  } = {},
) {
  const note = `cli-${correlation}`;
  const started = now();
  await client.request(`/actions/workflows/${operation.workflow}/dispatches`, {
    method: 'POST',
    body: { ref: MAIN_BRANCH, inputs: { ...operation.inputs, note } },
  });
  const workflowUrl = `https://github.com/${client.repository}/actions/workflows/${operation.workflow}`;
  log(`已触发 ${operation.command}：${workflowUrl}`);
  if (!operation.wait) return { dispatched: true, url: workflowUrl };
  let run;
  let reported = false;
  while (now() - started < timeoutMs) {
    if (!run) {
      const data = await client.request(
        `/actions/workflows/${operation.workflow}/runs?event=workflow_dispatch&branch=${MAIN_BRANCH}&per_page=100`,
      );
      run = data.workflow_runs.find((item) => item.display_title?.includes(note));
    } else run = await client.request(`/actions/runs/${run.id}`);
    if (run && !reported) {
      log(`任务：${run.html_url}`);
      reported = true;
    }
    if (run?.status === 'completed') {
      if (run.conclusion !== 'success')
        throw new Error(`任务 ${run.conclusion}，查看 ${run.html_url}；不会把触发成功当作部署成功`);
      log(`任务完成：${run.html_url}（版本、部署结果及日志见 Summary）`);
      return run;
    }
    await sleep(5000);
  }
  throw new Error(`本地等待超时，远端任务未被取消。请查看 ${run?.html_url || workflowUrl}`);
}

async function main() {
  const operation = parseCommand(process.argv.slice(2));
  if (operation.help) {
    console.log(HELP);
    return;
  }
  const repository =
    process.env.GITHUB_REPOSITORY ||
    repositoryFromRemote(runLocal('git', ['remote', 'get-url', 'origin']));
  let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    try {
      token = runLocal('gh', ['auth', 'token']);
    } catch {
      throw new Error('请先 gh auth login，或设置 GH_TOKEN；无需把 token 写入项目');
    }
  }
  const client = createGitHubClient({ repository, token });
  await assertRemoteSource(client, operation);
  await dispatchAndWait(client, operation);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
