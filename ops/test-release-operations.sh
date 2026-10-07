#!/usr/bin/env bash
# Test real deploy/rollback orchestration using temporary data and command shims.
set -Eeuo pipefail
[[ $EUID == 0 ]] || { echo 'Run as root on a disposable CI runner'; exit 2; }
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
fixture=$(mktemp -d /var/tmp/automatic-operations-test.XXXXXXXX)
cleanup() {
  if [[ -f "$fixture/service.pid" ]]; then kill "$(cat "$fixture/service.pid")" 2>/dev/null || true; fi
  rm -rf "$fixture"
}
trap cleanup EXIT
mkdir -p "$fixture/bin" "$fixture/shared" "$fixture/releases" "$fixture/incoming" "$fixture/assets" "$fixture/backups"
printf 'fixture only\n' > "$fixture/shared/api.env"
touch "$fixture/shared/compose.yaml"
cat > "$fixture/bin/systemctl" <<'SHIM'
#!/usr/bin/env bash
set -eu
[[ $1 == restart && $2 == automatic-api ]] || exit 2
base=${AUTOMATIC_TEST_BASE:?}
if [[ -f "$base/service.pid" ]]; then kill "$(cat "$base/service.pid")" 2>/dev/null || true; fi
# Real systemd starts the service separately; do not inherit the caller's lock.
/usr/bin/node "$base/current/apps/api/dist/server.js" > "$base/service.log" 2>&1 9>&- &
echo $! > "$base/service.pid"
echo restart >> "$base/restarts"
sleep 0.2
SHIM
cat > "$fixture/bin/docker" <<'SHIM'
#!/usr/bin/env bash
echo 'isolated fixture backup; no Docker or PostgreSQL was contacted'
SHIM
cat > "$fixture/bin/runuser" <<'SHIM'
#!/usr/bin/env bash
set -eu
[[ $1 == -u && $2 == automatic && $3 == -- ]] || exit 2
shift 3
exec "$@"
SHIM
chmod 755 "$fixture/bin/"*

make_release() {
  local name=$1
  local root="$fixture/stage/$name"
  mkdir -p "$root/apps/api/dist/database" "$root/apps/api/node_modules/pg" "$root/apps/web/dist/assets"
  printf '{}\n' > "$root/apps/api/node_modules/pg/package.json"
  printf '<html>fixture</html>\n' > "$root/apps/web/dist/index.html"
  printf 'asset\n' > "$root/apps/web/dist/assets/fixture.js"
  cat > "$root/release.json" <<JSON
{"schema":1,"release":"$name","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","source":"git","nodeMajor":22,"platform":"linux","arch":"x64"}
JSON
  cat > "$root/apps/api/dist/database/migrate.js" <<'NODE'
if (process.env.AUTOMATIC_TEST_MIGRATION_FAIL === '1') process.exit(1);
NODE
  cat > "$root/apps/api/dist/server.js" <<'NODE'
const fs = require('fs');
const path = require('path');
const metadata = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../release.json')));
require('http').createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(req.url.startsWith('/api/health')
    ? { status: 'ok', service: 'automatic-api', release: metadata.release, commit: metadata.commit }
    : metadata));
}).listen(3198, '127.0.0.1');
NODE
  cp "$root/release.json" "$root/apps/web/dist/version.json"
}

package_release() {
  local name=$1
  tar -czf "$fixture/incoming/$name.tar.gz" -C "$fixture/stage/$name" apps release.json
  sha256sum "$fixture/incoming/$name.tar.gz" | cut -d ' ' -f 1 > "$fixture/incoming/$name.sha256"
}

python3 - "$script_dir/automatic-release.sh" "$fixture" <<'PY'
import pathlib, sys
source, base = sys.argv[1:]
text = pathlib.Path(source).read_text()
text = text.replace('base=/srv/automatic', 'base=' + base)
text = text.replace('/run/automatic-release.lock', base + '/release.lock')
text = text.replace('/etc/automatic/release.conf', base + '/root-release.conf')
text = text.replace('public_url=https://180.76.248.209', 'public_url=http://127.0.0.1:3198')
text = text.replace('127.0.0.1:3000', '127.0.0.1:3198').replace('range(40)', 'range(3)')
text = text.replace('chown root:automatic', 'chown root:root')
text = text.replace('/var/backups/automatic', base + '/backups')
text = text.replace('/var/www/automatic/assets', base + '/assets')
pathlib.Path(base, 'release-command.sh').write_text(text)
PY
export AUTOMATIC_TEST_BASE="$fixture"
export PATH="$fixture/bin:$PATH"
invoke() { bash "$fixture/release-command.sh" "$@"; }

make_release initial
cp -a "$fixture/stage/initial" "$fixture/releases/initial"
ln -s "$fixture/releases/initial" "$fixture/current"
systemctl restart automatic-api
make_release verified
package_release verified
invoke deploy verified
test "$(readlink -f "$fixture/current")" = "$fixture/releases/verified"
invoke status > "$fixture/status.json"
python3 - "$fixture/status.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
assert data['release'] == 'verified' and data['previous'] == 'initial'
assert data['manifest'] and len(data['releases']) == 2
PY

restarts=$(wc -l < "$fixture/restarts")
invoke deploy verified
test "$(wc -l < "$fixture/restarts")" = "$restarts"
invoke rollback verified
test "$(wc -l < "$fixture/restarts")" = "$restarts"
test "$(cat "$fixture/shared/previous-release")" = "$fixture/releases/initial"
printf '\n// changed bytes\n' >> "$fixture/stage/verified/apps/api/dist/server.js"
package_release verified
if invoke deploy verified > "$fixture/fingerprint.log" 2>&1; then echo 'Changed bytes reused an existing release ID'; exit 1; fi
grep -q 'different artifact bytes' "$fixture/fingerprint.log"

make_release unhealthy
printf 'process.exit(1);\n' > "$fixture/stage/unhealthy/apps/api/dist/server.js"
package_release unhealthy
if invoke deploy unhealthy > "$fixture/recovery.log" 2>&1; then echo 'Unhealthy deployment was accepted'; exit 1; fi
grep -q 'Restored code:' "$fixture/recovery.log"
test "$(readlink -f "$fixture/current")" = "$fixture/releases/verified"
invoke rollback previous
test "$(readlink -f "$fixture/current")" = "$fixture/releases/initial"
invoke rollback previous
test "$(readlink -f "$fixture/current")" = "$fixture/releases/verified"

make_release migration-retry
package_release migration-retry
export AUTOMATIC_TEST_MIGRATION_FAIL=1
if invoke deploy migration-retry > "$fixture/migration.log" 2>&1; then echo 'Failed migration was accepted'; exit 1; fi
test "$(readlink -f "$fixture/current")" = "$fixture/releases/verified"
unset AUTOMATIC_TEST_MIGRATION_FAIL
invoke deploy migration-retry
test "$(readlink -f "$fixture/current")" = "$fixture/releases/migration-retry"
test "$(find "$fixture/backups" -name 'predeploy-migration-retry-*.dump' | wc -l)" = 2

printf '/outside/verified\n' > "$fixture/shared/previous-release"
if invoke rollback previous > "$fixture/pointer.log" 2>&1; then echo 'Invalid previous pointer was accepted'; exit 1; fi
grep -q 'Invalid previous release pointer' "$fixture/pointer.log"
if invoke rollback ../outside >/dev/null 2>&1; then echo 'Invalid release path was accepted'; exit 1; fi
echo 'Verified deploy, status, idempotent repeat, fingerprint rejection, migration retry, unique backups, previous rollback and automatic recovery in an isolated fixture.'
