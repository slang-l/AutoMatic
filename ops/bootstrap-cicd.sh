#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID == 0 ]] || { echo 'Run as root'; exit 2; }
public_key=${1:?Usage: sudo bash ops/bootstrap-cicd.sh /path/to/deploy-key.pub}
grep -Eq '^ssh-ed25519 [A-Za-z0-9+/=]+( .*)?$' "$public_key" || exit 2
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
test -f /srv/automatic/shared/api.env
test -f /etc/systemd/system/automatic-api.service
id automatic-deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash automatic-deploy
install -d -o automatic-deploy -g automatic-deploy -m 700 /home/automatic-deploy/.ssh /srv/automatic/incoming
key=$(cat "$public_key")
authorized=/home/automatic-deploy/.ssh/authorized_keys
touch "$authorized"
grep -Fq -- "$key" "$authorized" || printf 'restrict %s\n' "$key" >> "$authorized"
chown automatic-deploy:automatic-deploy "$authorized"
chmod 600 "$authorized"
install -o root -g root -m 755 "$script_dir/automatic-release.sh" /usr/local/sbin/automatic-release
printf '%s\n' 'automatic-deploy ALL=(root) NOPASSWD: /usr/local/sbin/automatic-release' > /etc/sudoers.d/automatic-deploy
chmod 440 /etc/sudoers.d/automatic-deploy
visudo -cf /etc/sudoers.d/automatic-deploy
chown root:root /srv/automatic /srv/automatic/releases /var/www/automatic /var/www/automatic/assets
install -d -m 755 /etc/systemd/system/automatic-api.service.d
cat > /etc/systemd/system/automatic-api.service.d/release.conf <<'SERVICE'
[Service]
EnvironmentFile=-/srv/automatic/shared/release.env
SERVICE
systemctl daemon-reload
echo 'Dedicated deploy user, restricted SSH key and release command installed. Existing API was not restarted.'
