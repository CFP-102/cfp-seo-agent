#!/usr/bin/env bash
# Baseline hardening for a fresh Ubuntu server. Run ON the server as root, via:
#   ssh agent-server 'bash -s' < scripts/server-harden.sh
# Idempotent. Keeps SSH key login working; disables password login only after validating sshd config.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "== apt update + upgrade"
apt-get update -qq
apt-get -y -qq upgrade
apt-get -y -qq install ufw fail2ban unattended-upgrades ca-certificates curl

echo "== firewall: only SSH, HTTP, HTTPS"
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null   # HTTP/3 (Caddy)
ufw --force enable >/dev/null
ufw status verbose | sed -n 1,12p

echo "== ssh: key only, no passwords"
install -d -m 755 /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/00-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
EOF
sshd -t
# Ubuntu 24.04+ starts sshd per connection via ssh.socket: new sessions read the config anyway.
if systemctl is-active --quiet ssh; then systemctl reload ssh; elif systemctl is-active --quiet sshd; then systemctl reload sshd; fi
echo "effective: $(sshd -T | grep -E '^(passwordauthentication|permitrootlogin) ' | tr '\n' ' ')"

echo "== fail2ban (sshd jail)"
cat > /etc/fail2ban/jail.d/sshd.local <<'EOF'
[sshd]
enabled = true
maxretry = 4
findtime = 10m
bantime = 1h
EOF
systemctl enable --now fail2ban >/dev/null 2>&1
systemctl restart fail2ban

echo "== automatic security updates"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

echo "== done"
[ -f /var/run/reboot-required ] && echo "NOTE: reboot required (kernel update)" || echo "no reboot required"

# Log retention promised in the privacy policy: system logs at most about four weeks.
mkdir -p /etc/systemd/journald.conf.d
printf "[Journal]\nMaxRetentionSec=4week\n" > /etc/systemd/journald.conf.d/retention.conf
systemctl restart systemd-journald
sed -i "0,/rotate [0-9]*/s//rotate 3/" /etc/logrotate.d/rsyslog
