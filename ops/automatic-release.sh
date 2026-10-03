#!/usr/bin/env bash
# Installed root-owned. Invoked by the deploy account through one sudo rule.
set -Eeuo pipefail
[[ $EUID == 0 ]] || { echo 'Run with sudo'; exit 2; }
action=${1:-}
release=${2:-}
[[ $# == 2 && $action =~ ^(deploy|rollback)$ && $release =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$ ]] || { echo 'Usage: automatic-release deploy|rollback RELEASE_ID'; exit 2; }
base=/srv/automatic
target="$base/releases/$release"
exec 9>/run/automatic-release.lock
flock -w 300 9 || { echo 'Another deployment is running'; exit 1; }
previous=$(readlink -f "$base/current" || true)
scratch=$(mktemp -d /var/tmp/automatic-release.XXXXXXXX)
trap 'rm -rf "$scratch"' EXIT

health() {
  python3 - "$1" <<'PY'
import json, pathlib, subprocess, sys, time, urllib.request
root = pathlib.Path(sys.argv[1])
manifest = root / 'release.json'
expected = json.loads(manifest.read_text()) if manifest.exists() else None
for _ in range(40):
    try:
        with urllib.request.urlopen('http://127.0.0.1:3000/api/health', timeout=3) as response:
            data = json.load(response)
        assert data['status'] == 'ok' and data['service'] == 'automatic-api'
        if expected:
            assert data.get('release') == expected['release'] and data.get('commit') == expected['commit']
            response = subprocess.run(['curl', '--fail', '--silent', '--show-error', '--max-time', '5',
                '--resolve', '180.76.248.209:443:127.0.0.1', 'https://180.76.248.209/version.json'],
                capture_output=True, text=True, check=True)
            web = json.loads(response.stdout)
            assert web['release'] == expected['release'] and web['commit'] == expected['commit']
        print('Healthy:', root.name)
        sys.exit(0)
    except Exception:
        time.sleep(1)
print('Health or release identity check failed:', root.name, file=sys.stderr)
sys.exit(1)
PY
}

activate() {
  local directory=$1
  python3 - "$directory" "$base/shared/release.env" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
manifest = root / 'release.json'
data = json.loads(manifest.read_text()) if manifest.exists() else {'release': root.name, 'commit': ''}
pathlib.Path(sys.argv[2]).write_text('AUTOMATIC_RELEASE=' + data['release'] + '\nAUTOMATIC_COMMIT=' + data['commit'] + '\n')
PY
  chown root:automatic "$base/shared/release.env"
  chmod 640 "$base/shared/release.env"
  rm -f "$base/current-switch"
  ln -s "$directory" "$base/current-switch"
  mv -Tf "$base/current-switch" "$base/current"
  systemctl restart automatic-api
}

recover() {
  echo 'Release failed; database migrations are not undone.' >&2
  if [[ -n $previous && -f "$previous/apps/api/dist/server.js" ]]; then
    if activate "$previous" && health "$previous"; then echo "Restored code: $previous" >&2;
    else echo 'Previous version did not recover; inspect journalctl -u automatic-api' >&2; fi
  fi
  exit 1
}

if [[ $action == deploy ]]; then
  [[ ! -e $target ]] || { echo 'Release already exists; use a new workflow attempt'; exit 2; }
  install -m 600 "$base/incoming/$release.tar.gz" "$scratch/release.tar.gz"
  install -m 600 "$base/incoming/$release.sha256" "$scratch/release.sha256"
  digest=$(tr -d '\r\n' < "$scratch/release.sha256")
  [[ $digest =~ ^[a-f0-9]{64}$ ]] || exit 2
  actual=$(sha256sum "$scratch/release.tar.gz" | cut -d ' ' -f 1)
  [[ $actual == "$digest" ]] || { echo 'Artifact checksum mismatch'; exit 2; }
  python3 - "$scratch/release.tar.gz" "$target" "$release" <<'PY'
import json, pathlib, re, sys, tarfile
archive, target, release = sys.argv[1:]
with tarfile.open(archive) as tar:
    members = tar.getmembers()
    assert len(members) < 100000 and sum(m.size for m in members) < 1024**3, 'Artifact too large'
    for member in members:
        p = pathlib.PurePosixPath(member.name)
        assert not p.is_absolute() and '..' not in p.parts, 'Invalid artifact path'
        assert p.parts and p.parts[0] in ('apps', 'release.json'), 'Unexpected artifact content'
        assert '.env' not in p.parts, 'Artifact must not contain a production environment file'
        tarfile.data_filter(member, target)
    data = json.load(tar.extractfile('release.json'))
    assert data['schema'] == 1 and data['release'] == release
    assert re.fullmatch(r'[a-f0-9]{40}', data['commit'])
    assert (data['nodeMajor'], data['platform'], data['arch']) == (22, 'linux', 'x64')
    pathlib.Path(target).mkdir(mode=0o700)
    tar.extractall(target, filter='data')
PY
  test -f "$target/apps/api/dist/server.js"
  test -f "$target/apps/api/dist/database/migrate.js"
  test -f "$target/apps/api/node_modules/pg/package.json"
  test -f "$target/apps/web/dist/index.html"
  chown -R root:root "$target"
  chmod -R u=rwX,go=rX "$target"
  ln -s "$base/shared/api.env" "$target/apps/api/.env"
  install -d -m 700 /var/backups/automatic
  umask 077
  backup="/var/backups/automatic/predeploy-$release.dump"
  docker compose -f "$base/shared/compose.yaml" exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup"
  test -s "$backup"
  cp -a "$base/shared/api.env" "/var/backups/automatic/api-$release.env"
  (cd "$target/apps/api" && runuser -u automatic -- /usr/bin/node dist/database/migrate.js)
  cp -a "$target/apps/web/dist/assets/." /var/www/automatic/assets/
  find /var/www/automatic/assets -type d -exec chmod 755 {} +
  find /var/www/automatic/assets -type f -exec chmod 644 {} +
else
  [[ -d $target && ! -L $target ]] || { echo 'Unknown local release'; exit 2; }
  [[ $(readlink -f "$target") == "$target" ]] || exit 2
  test -f "$target/apps/api/dist/server.js"
  test -f "$target/apps/web/dist/index.html"
  echo 'Rollback changes code only. Database schema must remain compatible.'
fi
trap recover ERR
activate "$target"
health "$target"
trap - ERR
printf '%s\n' "$previous" > "$base/shared/previous-release"
printf '%s %s %s\n' "$(date -u +%FT%TZ)" "$action" "$release" >> "$base/shared/deployment-history.log"
echo "Active release: $release"
