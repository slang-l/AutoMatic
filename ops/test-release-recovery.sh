#!/usr/bin/env bash
# Exercise the switch/recovery code using an isolated service and filesystem.
set -Eeuo pipefail
[[ $EUID == 0 ]] || { echo 'Run with sudo on a disposable CI runner'; exit 2; }
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
fixture=$(mktemp -d /var/tmp/automatic-recovery-test.XXXXXXXX)
cleanup() {
  if [[ -f "$fixture/service.pid" ]]; then kill "$(cat "$fixture/service.pid")" 2>/dev/null || true; fi
  rm -rf "$fixture"
}
trap cleanup EXIT
mkdir -p "$fixture/bin" "$fixture/shared" "$fixture/releases/good/apps/api/dist" "$fixture/releases/good/apps/web/dist" "$fixture/releases/bad/apps/api/dist" "$fixture/releases/bad/apps/web/dist"
touch "$fixture/releases/good/apps/web/dist/index.html" "$fixture/releases/bad/apps/web/dist/index.html"
cat > "$fixture/releases/good/apps/api/dist/server.js" <<'NODE'
require('http').createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ status: 'ok', service: 'automatic-api' }));
}).listen(3199, '127.0.0.1');
NODE
printf 'process.exit(1);\n' > "$fixture/releases/bad/apps/api/dist/server.js"
ln -s "$fixture/releases/good" "$fixture/current"
cat > "$fixture/bin/systemctl" <<'SHIM'
#!/usr/bin/env bash
set -eu
[[ $1 == restart && $2 == automatic-api ]] || exit 2
base=${AUTOMATIC_TEST_BASE:?}
if [[ -f "$base/service.pid" ]]; then kill "$(cat "$base/service.pid")" 2>/dev/null || true; fi
/usr/bin/node "$base/current/apps/api/dist/server.js" > "$base/service.log" 2>&1 &
echo $! > "$base/service.pid"
sleep 0.2
SHIM
chmod 755 "$fixture/bin/systemctl"
python3 - "$script_dir/automatic-release.sh" "$fixture" <<'PY'
import pathlib, sys
source, base = sys.argv[1:]
text = pathlib.Path(source).read_text()
text = text.replace('base=/srv/automatic', 'base=' + base)
text = text.replace('/run/automatic-release.lock', base + '/release.lock')
text = text.replace('127.0.0.1:3000', '127.0.0.1:3199').replace('range(40)', 'range(3)')
text = text.replace('chown root:automatic', 'chown root:root')
pathlib.Path(base, 'release-command.sh').write_text(text)
PY
export AUTOMATIC_TEST_BASE="$fixture"
env PATH="$fixture/bin:$PATH" systemctl restart automatic-api
if env PATH="$fixture/bin:$PATH" bash "$fixture/release-command.sh" rollback bad > "$fixture/result.log" 2>&1; then
  cat "$fixture/result.log"; echo 'An unhealthy release was accepted'; exit 1
fi
test "$(readlink -f "$fixture/current")" = "$fixture/releases/good"
grep -q 'Restored code:' "$fixture/result.log"
curl -fsS http://127.0.0.1:3199/api/health >/dev/null
echo 'Verified automatic code recovery after an unhealthy version starts; production was not touched.'
