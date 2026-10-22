#!/usr/bin/env bash
# Install Docker Engine + Compose plugin from Docker's official apt repo. Run ON the server as root:
#   ssh agent-server 'bash -s' < scripts/server-docker.sh
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
. /etc/os-release

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get -y -qq install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Keep container logs from filling the disk.
cat > /etc/docker/daemon.json <<'EOF'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
EOF
systemctl enable --now docker
systemctl restart docker
docker --version
docker compose version
docker run --rm hello-world 2>&1 | sed -n 1,3p
