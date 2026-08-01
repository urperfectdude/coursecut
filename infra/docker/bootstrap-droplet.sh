#!/usr/bin/env bash
# One-time droplet preparation — runbook §1 (plan §8's M0), as something you
# run rather than something you retype.
#
#   scp infra/docker/bootstrap-droplet.sh root@<droplet>:/tmp/
#   ssh root@<droplet> 'bash /tmp/bootstrap-droplet.sh "<ci-public-key>"'
#
# Run as root, once, on a droplet that is otherwise untouched. It is
# idempotent: running it twice changes nothing the second time, which matters
# because the most likely reason to run it again is that you are not sure
# whether it finished.
#
# **Two things it deliberately does NOT do**, because both can lock you out of
# a machine and neither should happen from a script you are reading for the
# first time:
#
#   * Rotate the root password. Do that in the DigitalOcean console — over the
#     web, not over SSH, and not into a chat window. The current one is
#     compromised (plan §8) until you do.
#   * Disable password authentication. It edits `sshd_config` and tells you the
#     command to apply it, but does not restart sshd itself: you want to prove
#     a key-based session works *while still holding an open one*, and a script
#     cannot check that for you.
#
# What it does do: the deploy user CI logs in as, Docker, a firewall that
# allows exactly three ports, fail2ban, and the stack's directory.

set -euo pipefail

CI_PUBLIC_KEY="${1:-}"
if [[ -z "$CI_PUBLIC_KEY" ]]; then
  echo "usage: bash bootstrap-droplet.sh '<ci deploy public key>'" >&2
  echo "       (the contents of ~/.ssh/coursecut_deploy.pub — the CI-only key," >&2
  echo "        not your personal one)" >&2
  exit 2
fi
if [[ $EUID -ne 0 ]]; then
  echo "run this as root" >&2
  exit 2
fi

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

step "deploy user"
# CI authenticates with a key and never a password, so the account has none to
# guess. `--disabled-password` leaves it unable to log in any other way.
id -u deploy >/dev/null 2>&1 || adduser --disabled-password --gecos "" deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
touch /home/deploy/.ssh/authorized_keys
grep -qxF "$CI_PUBLIC_KEY" /home/deploy/.ssh/authorized_keys \
  || echo "$CI_PUBLIC_KEY" >> /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys

step "docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
# `deploy.sh` uses `docker compose` (the plugin, not the old standalone
# binary). If this line fails, the deploy will fail in the same way later.
docker compose version >/dev/null
usermod -aG docker deploy

step "firewall"
# 22, 80, 443 and nothing else. Postgres is never in this list: it publishes no
# port in `compose.prod.yml`, so it is reachable only on the compose network —
# ufw is the second lock, not the first.
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ufw fail2ban >/dev/null
ufw --force default deny incoming
ufw --force default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

step "fail2ban"
systemctl enable --now fail2ban

step "stack directory"
install -d -o deploy -g deploy /opt/coursecut

step "sshd hardening (staged, not applied)"
# Written but not restarted — see this script's header. Proving a key session
# works before cutting off passwords is the whole point, and only a human
# holding an open terminal can do that.
#
# **A drop-in, and specifically one that sorts first.** Appending to
# `sshd_config` looks right and does nothing on a stock Ubuntu cloud image:
# line 12 is `Include /etc/ssh/sshd_config.d/*.conf`, OpenSSH takes the
# **first** value it sees for a keyword, and DigitalOcean's image ships
# `50-cloud-init.conf` containing `PasswordAuthentication yes`. So the include
# wins over anything further down the main file, and `60-cloudimg-settings.conf`
# saying `no` loses to `50-` for the same first-wins reason. Naming this `00-`
# is what puts it in front of both.
#
# Found the hard way: the first version of this script edited the main file,
# reported success, and left password authentication fully enabled.
sshd_dropin=/etc/ssh/sshd_config.d/00-coursecut-hardening.conf
changed=0
if grep -qE '^\s*Include\s+/etc/ssh/sshd_config\.d/' /etc/ssh/sshd_config; then
  target="$sshd_dropin"
  install -d -m 755 /etc/ssh/sshd_config.d
else
  # No include support (older sshd): the main file is the only place to write,
  # and there appending is genuinely enough.
  target=/etc/ssh/sshd_config
fi

desired='PasswordAuthentication no
PermitRootLogin prohibit-password
KbdInteractiveAuthentication no'

if [[ "$target" == "$sshd_dropin" ]]; then
  if [[ ! -f "$target" ]] || ! diff -q <(printf '%s\n' "$desired") "$target" >/dev/null 2>&1; then
    printf '# Written by bootstrap-droplet.sh. Sorts before 50-cloud-init.conf,\n# which is what makes it win — sshd takes the first value it sees.\n%s\n' "$desired" > "$target"
    chmod 644 "$target"
    changed=1
  fi
else
  while IFS= read -r line; do
    key=${line%% *}
    grep -qxF "$line" "$target" && continue
    sed -i -E "/^\s*#?\s*${key}\s+/d" "$target"
    echo "$line" >> "$target"
    changed=1
  done <<< "$desired"
fi

# Prove the file parses before anyone restarts anything. A syntax error here
# means sshd refuses to start, and on a remote box that is unrecoverable
# without the DigitalOcean console.
sshd -t

cat <<EOF

Done. Two things left, both yours:

  1. Rotate the root password in the DigitalOcean console, if you have not.
$(if [[ $changed -eq 1 ]]; then cat <<INNER
  2. sshd_config now says PasswordAuthentication no / PermitRootLogin
     prohibit-password, but sshd has NOT been restarted. From a second
     terminal, prove this works:

         ssh -i ~/.ssh/coursecut_deploy deploy@\$(hostname -I | awk '{print \$1}') true

     Then, and only then:  systemctl restart ssh
INNER
else echo "  2. sshd was already hardened — nothing to restart."; fi)

EOF
