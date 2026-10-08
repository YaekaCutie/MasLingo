#!/usr/bin/env bash
#
# Bootstrap an Oracle Cloud "Always Free" Ubuntu instance (arm64 or amd64) as
# the shared MasLingo OCR backend.
#
# Usage, on the fresh instance:
#   bash deploy/bootstrap-vm.sh            # derives <public-ip>.sslip.io
#   bash deploy/bootstrap-vm.sh ocr.example.com
#
# Safe to re-run: every step is idempotent.

set -euo pipefail

REPO_URL="${MAS_REPO_URL:-https://github.com/YaekaCutie/MasLingo.git}"
TARGET_DIR="${MAS_TARGET_DIR:-$HOME/MasLingo}"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "Do not run this as root; run it as the ubuntu user (it uses sudo)."

log "Resolving the public hostname"
PUBLIC_IP="$(curl -fsS --max-time 10 https://api.ipify.org || true)"
[ -n "$PUBLIC_IP" ] || die "Could not determine the public IP; pass a domain as the first argument."
DOMAIN="${1:-${PUBLIC_IP}.sslip.io}"
echo "public IP : $PUBLIC_IP"
echo "domain    : $DOMAIN"

log "1/6 Installing base packages"
sudo DEBIAN_FRONTEND=noninteractive apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates curl git iptables-persistent

log "2/6 Opening ports 80/443 in the instance-local firewall"
# Oracle's Ubuntu images ship iptables rules that REJECT everything but SSH,
# so opening the VCN Security List alone is not enough.
sudo iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT
sudo iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
sudo iptables -C INPUT -p udp --dport 443 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 1 -p udp --dport 443 -j ACCEPT
sudo netfilter-persistent save
echo "persisted rules:"
sudo iptables -L INPUT -n --line-numbers | head -n 8

log "3/6 Checking that the VCN Security List lets 80/443 through"
if command -v ss >/dev/null 2>&1; then
  echo "(cloud-side ingress is configured in the OCI console, not here)"
fi

log "4/6 Installing Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
else
  echo "docker already installed: $(docker --version)"
fi
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER" || true

log "5/6 Fetching the project into $TARGET_DIR"
if [ -d "$TARGET_DIR/.git" ]; then
  git -C "$TARGET_DIR" pull --ff-only
else
  git clone --depth 1 "$REPO_URL" "$TARGET_DIR"
fi

cd "$TARGET_DIR/deploy"
if [ ! -f .env ]; then
  cp .env.example .env
fi
# Keep an existing MAS_DOMAIN if one was set, otherwise write the resolved one.
if grep -q '^MAS_DOMAIN=CHANGE_ME' .env; then
  sed -i "s|^MAS_DOMAIN=.*|MAS_DOMAIN=${DOMAIN}|" .env
else
  echo "keeping existing MAS_DOMAIN=$(grep '^MAS_DOMAIN=' .env | cut -d= -f2-)"
fi

log "6/6 Building and starting the stack (first build downloads torch: 5-15 min)"
# Run compose through sudo so this works before the docker group is refreshed.
sudo docker compose up -d --build

cat <<EOF

$(printf '\033[1;32m==> Done\033[0m')

Check it from the VM:
  curl -s https://${DOMAIN}/health

Check it from your own machine (must be reachable from the internet):
  curl -s https://${DOMAIN}/health

Then point the extension at it:
  set MAS_BACKEND_URL in extension/config.js to https://${DOMAIN}
  and add the same host to host_permissions in extension/manifest.json

Useful commands:
  cd ${TARGET_DIR}/deploy
  sudo docker compose logs -f api      # OCR logs
  sudo docker compose logs -f caddy    # TLS / access logs
  sudo docker compose restart api
  sudo docker compose down             # stop
  git -C ${TARGET_DIR} pull && sudo docker compose up -d --build   # update

If the certificate does not appear within a minute, the VCN Security List is
almost always the cause: add ingress rules for TCP 80 and TCP 443 from
0.0.0.0/0 in the OCI console.
EOF
