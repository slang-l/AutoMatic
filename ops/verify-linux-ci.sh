#!/usr/bin/env bash
# /workspace is mounted read-only; /build and PostgreSQL are disposable.
set -Eeuo pipefail
mkdir -p /build
tar -C /workspace --exclude=.git --exclude=node_modules --exclude='.tmp*' \
  --exclude=.env --exclude='.env.*' --exclude=.codex --exclude=.agents --exclude=.aws \
  --exclude=dist --exclude=coverage --exclude='.pnpm-store' -cf - . | tar -C /build -xf -
cd /build
node --version
pnpm --version
shellcheck ops/*.sh
pnpm install --frozen-lockfile
pnpm format:check
bash ops/test-release-recovery.sh
bash ops/test-release-operations.sh
pnpm check
release=local-ci-validation
export BUILD_SOURCE=working-tree
bash ops/package-release.sh "$release" "${AUTOMATIC_TEST_COMMIT:?}"
mkdir -p .tmp/smoke-release
tar -xzf ".tmp/artifacts/$release.tar.gz" -C .tmp/smoke-release
node scripts/smoke-release.mjs .tmp/smoke-release
cp .tmp/artifacts/* /out/
echo 'Linux CI, PostgreSQL, packaged runtime, deployment and rollback verification passed.'
