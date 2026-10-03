#!/usr/bin/env bash
set -Eeuo pipefail
release=${1:?Usage: package-release.sh RELEASE_ID COMMIT_SHA}
commit=${2:?Commit SHA is required}
[[ $release =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$ ]] || exit 2
[[ $commit =~ ^[a-f0-9]{40}$ ]] || exit 2
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'Package on Linux x86_64'; exit 2; }
[[ $(node -p 'process.versions.node.split(".")[0]') == 22 ]] || exit 2
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
test -f apps/api/dist/server.js
test -f apps/web/dist/index.html
pnpm --filter @automatic/api deploy --prod "$stage/apps/api"
node --input-type=module - "$stage/apps/api" <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const deployed = fs.realpathSync(process.argv[2]);
const source = fs.realpathSync('apps/api');
function inspect(entry) {
  const info = fs.lstatSync(entry);
  if (info.isSymbolicLink()) {
    let resolved = fs.realpathSync(entry);
    // pnpm 9 may hoist the package's own name as a link to the source workspace.
    // Bind that one self-reference to the deployed root instead.
    if (resolved === source && entry.endsWith(path.join('node_modules', '@automatic', 'api'))) {
      fs.unlinkSync(entry);
      fs.symlinkSync(path.relative(path.dirname(entry), deployed), entry, 'dir');
      resolved = fs.realpathSync(entry);
    }
    assert.ok(resolved === deployed || resolved.startsWith(deployed + path.sep), `Nonportable dependency link: ${entry}`);
  } else if (info.isDirectory()) {
    for (const name of fs.readdirSync(entry)) inspect(path.join(entry, name));
  }
}
inspect(deployed);
console.log('All runtime dependency links stay inside the release package');
NODE
mkdir -p "$stage/apps/web"
cp -a apps/web/dist "$stage/apps/web/"
test ! -e "$stage/apps/api/.env"
node --input-type=module - "$stage" "$release" "$commit" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const [stage, release, commit] = process.argv.slice(2);
const metadata = { schema: 1, release, commit, source: process.env.BUILD_SOURCE || 'git', builtAt: new Date().toISOString(), nodeMajor: 22, platform: 'linux', arch: 'x64' };
fs.writeFileSync(path.join(stage, 'release.json'), JSON.stringify(metadata, null, 2) + '\n');
fs.writeFileSync(path.join(stage, 'apps/web/dist/version.json'), JSON.stringify(metadata) + '\n');
NODE
mkdir -p .tmp/artifacts
tar --hard-dereference -czf ".tmp/artifacts/$release.tar.gz" -C "$stage" apps release.json
sha256sum ".tmp/artifacts/$release.tar.gz" | cut -d ' ' -f 1 > ".tmp/artifacts/$release.sha256"
echo "Packaged $release"
