import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const target = resolve(process.argv[2] || 'packages/blocksuite');
const patches = readdirSync('patches/blocksuite')
  .filter((name) => name.endsWith('.patch'))
  .sort();
execFileSync('git', ['-C', target, 'rev-parse', '--git-dir'], { stdio: 'ignore' });
for (const name of patches) {
  const patch = resolve('patches/blocksuite', name);
  const check = (extra = []) =>
    spawnSync('git', ['-C', target, 'apply', ...extra, '--check', patch], { stdio: 'ignore' })
      .status === 0;
  if (check(['--reverse'])) {
    console.log(`Already applied: ${name}`);
  } else if (check()) {
    execFileSync('git', ['-C', target, 'apply', patch], { stdio: 'inherit' });
    console.log(`Applied: ${name}`);
  } else {
    throw new Error(
      `Cannot apply ${name}. Review the submodule revision and local edits; no files were reset.`,
    );
  }
}
