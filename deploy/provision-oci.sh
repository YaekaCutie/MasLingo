#!/usr/bin/env bash
#
# Create the Always Free Ampere A1 instance that runs the OCR backend.
#
# Run this inside OCI Cloud Shell (Console -> the ">_" icon in the top bar).
# Cloud Shell ships a pre-authenticated oci CLI, so there is nothing to install
# and no API key to configure.
#
#   bash deploy/provision-oci.sh --subnet-id ocid1.subnet.oc1.ap-singapore-1.aaaa...
#
# Why a script: "Out of host capacity" is the *documented, expected* answer for
# Always Free ARM shapes, and Oracle's own advice is to retry in another
# availability domain. This does that rotation for you instead of you clicking
# Create over and over for days.
#
# What it deliberately does NOT do:
#   * it does not create the VCN or subnet — use the console wizard (see
#     deploy/README.md step 2), which is two minutes and hard to get wrong;
#   * it does not touch security lists — `oci network security-list update`
#     REPLACES the entire rule set, which is too easy to get catastrophically
#     wrong from an untested script. Add the 80/443 ingress rules in the
#     console instead.
#
# Safe to re-run: it only ever creates an instance, and only after a launch
# actually succeeds. Ctrl-C stops it, then re-run later.
#
# NOTE: every oci invocation here uses only documented parameters. The two
# places where Oracle's docs are silent are flagged inline with "DOC GAP".

set -euo pipefail

SHAPE="VM.Standard.A1.Flex"
OCPUS=2
MEMORY_GB=12
DISPLAY_NAME="openmanga-ocr-backend"
SUBNET_ID=""
SSH_KEY_FILE=""
IMAGE_ID=""
SLEEP_SECONDS=60
ROUNDS=0          # 0 = retry until interrupted
DRY_RUN=no

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Options:
  --subnet-id OCID      Public subnet to attach the instance to (required).
  --ssh-key-file PATH   Public key to authorise (default: ~/.ssh/id_ed25519.pub
                        or ~/.ssh/id_rsa.pub).
  --ocpus N             Default 2.   DOC GAP: Oracle's Always Free page says
  --memory-gb N         Default 12.  2 OCPU/12 GB, while the Arm shapes page
                                     still says 4 OCPU/24 GB. If launching fails
                                     with a quota error, try --ocpus 4
                                     --memory-gb 24, and vice versa.
  --image-id OCID       Skip image lookup and use this image.
  --display-name NAME   Default: openmanga-ocr-backend
  --sleep SECONDS       Pause between rounds (default 60).
  --rounds N            Stop after N rounds (default 0 = never stop).
  --dry-run             Print what would run, change nothing.
  -h, --help            This text.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --subnet-id)     SUBNET_ID="${2:?}"; shift 2 ;;
    --ssh-key-file)  SSH_KEY_FILE="${2:?}"; shift 2 ;;
    --ocpus)         OCPUS="${2:?}"; shift 2 ;;
    --memory-gb)     MEMORY_GB="${2:?}"; shift 2 ;;
    --image-id)      IMAGE_ID="${2:?}"; shift 2 ;;
    --display-name)  DISPLAY_NAME="${2:?}"; shift 2 ;;
    --sleep)         SLEEP_SECONDS="${2:?}"; shift 2 ;;
    --rounds)        ROUNDS="${2:?}"; shift 2 ;;
    --dry-run)       DRY_RUN=yes; shift ;;
    -h|--help)       usage; exit 0 ;;
    *)               die "unknown option: $1 (try --help)" ;;
  esac
done

[ -n "$SUBNET_ID" ] || { usage; die "--subnet-id is required"; }
command -v oci >/dev/null 2>&1 || die "oci CLI not found. Run this in OCI Cloud Shell."

# --- tenancy -----------------------------------------------------------------
# Cloud Shell keeps its config in /etc/oci (not ~/.oci) and defines no DEFAULT
# profile, so reading a config file is unreliable. OCI_CLI_TENANCY is the
# documented environment variable; when it is absent, asking the IAM service
# for an availability domain returns the tenancy OCID as its compartment-id.
TENANCY_ID="${OCI_CLI_TENANCY:-}"
if [ -z "$TENANCY_ID" ]; then
  log "Resolving tenancy OCID"
  TENANCY_ID="$(oci iam availability-domain list --query 'data[0]."compartment-id"' --raw-output)"
fi
[ -n "$TENANCY_ID" ] && [ "$TENANCY_ID" != "null" ] || die "could not determine the tenancy OCID; export OCI_CLI_TENANCY first"
info "tenancy: $TENANCY_ID"

# --- availability domains ----------------------------------------------------
# --raw-output only strips quotes when the query yields a SINGLE string, so a
# list query would still print JSON. Index one at a time instead.
log "Listing availability domains"
AD_COUNT="$(oci iam availability-domain list --query 'length(data)' --raw-output)"
[ "$AD_COUNT" -ge 1 ] || die "no availability domains returned"
info "$AD_COUNT availability domain(s)"

# --- image -------------------------------------------------------------------
if [ -z "$IMAGE_ID" ]; then
  log "Finding the newest Ubuntu arm64 image"
  # DOC GAP: Oracle's CLI reference documents --shape and --sort-by but never
  # states the --operating-system string for Ubuntu, so filter on the image
  # display name instead. Oracle documents that "'aarch64' in the name" marks
  # Arm images.
  IMAGE_ID="$(oci compute image list \
    --compartment-id "$TENANCY_ID" \
    --shape "$SHAPE" \
    --sort-by TIMECREATED \
    --query "data[?contains(\"display-name\", 'Ubuntu') && contains(\"display-name\", 'aarch64')].id | [0]" \
    --raw-output)"
fi
[ -n "$IMAGE_ID" ] && [ "$IMAGE_ID" != "null" ] || die "no Ubuntu aarch64 image found; pass --image-id explicitly"
info "image: $IMAGE_ID"
info "image name: $(oci compute image get --image-id "$IMAGE_ID" --query 'data."display-name"' --raw-output 2>/dev/null || echo '(lookup failed)')"

# --- ssh key -----------------------------------------------------------------
if [ -z "$SSH_KEY_FILE" ]; then
  for candidate in "$HOME/.ssh/id_ed25519.pub" "$HOME/.ssh/id_rsa.pub"; do
    [ -f "$candidate" ] && SSH_KEY_FILE="$candidate" && break
  done
fi
if [ -z "$SSH_KEY_FILE" ]; then
  log "No SSH key found; generating one in Cloud Shell"
  ssh-keygen -t ed25519 -N '' -f "$HOME/.ssh/id_ed25519" >/dev/null
  SSH_KEY_FILE="$HOME/.ssh/id_ed25519.pub"
fi
[ -f "$SSH_KEY_FILE" ] || die "SSH public key not found: $SSH_KEY_FILE"
info "ssh key: $SSH_KEY_FILE"
info "         (download the private key from Cloud Shell before the session ends)"

# --- launch ------------------------------------------------------------------
SHAPE_CONFIG="{\"ocpus\": $OCPUS, \"memoryInGBs\": $MEMORY_GB}"

# Returns: 0 launched (JSON on stdout), 1 no capacity, 2 fatal, 3 dry run.
# It deliberately does NOT call die(): it runs inside a command substitution, so
# exit would only terminate the subshell and the retry loop would spin forever
# on a fatal error such as bad credentials.
launch_attempt() {
  local ad="$1"
  local output status

  if [ "$DRY_RUN" = "yes" ]; then
    info "[dry-run] oci compute instance launch --availability-domain $ad --shape $SHAPE --shape-config '$SHAPE_CONFIG' ..."
    return 3
  fi

  set +e
  output="$(oci compute instance launch \
    --availability-domain "$ad" \
    --compartment-id "$TENANCY_ID" \
    --shape "$SHAPE" \
    --shape-config "$SHAPE_CONFIG" \
    --image-id "$IMAGE_ID" \
    --subnet-id "$SUBNET_ID" \
    --assign-public-ip true \
    --display-name "$DISPLAY_NAME" \
    --ssh-authorized-keys-file "$SSH_KEY_FILE" \
    --wait-for-state RUNNING \
    --max-wait-seconds 1200 \
    2>&1)"
  status=$?
  set -e

  if [ $status -eq 0 ]; then
    printf '%s' "$output"
    return 0
  fi

  # Capacity failures are the expected case. Oracle's docs do not quote the
  # exact error text, and a service error exits 1 with a JSON block on stderr,
  # so match loosely on "capacity" and treat anything else as fatal.
  if printf '%s' "$output" | grep -qi 'capacity'; then
    return 1
  fi

  if [ $status -eq 2 ]; then
    info "  $ad: created but not RUNNING yet (wait timed out); check the console"
    printf '%s' "$output"
    return 0
  fi

  printf '\n%s\n' "$output" >&2
  return 2
}

log "Launching $SHAPE with $OCPUS OCPU / ${MEMORY_GB} GB in $AD_COUNT domain(s)"
info "Ctrl-C is safe; re-run later to keep trying."

round=0
while :; do
  round=$((round + 1))
  info "--- round $round ---"
  for i in $(seq 0 $((AD_COUNT - 1))); do
    ad="$(oci iam availability-domain list --query "data[$i].name" --raw-output)"
    info "trying $ad"

    set +e
    result="$(launch_attempt "$ad")"
    rc=$?
    set -e

    case "$rc" in
      0)
        log "Instance launched"
        instance_id="$(printf '%s' "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["id"])' 2>/dev/null || true)"
        public_ip=""
        if [ -n "$instance_id" ]; then
          public_ip="$(oci compute instance list-vnics --instance-id "$instance_id" \
            --query 'data[0]."public-ip"' --raw-output 2>/dev/null || true)"
        fi
        echo
        echo "  instance id : ${instance_id:-<see console>}"
        echo "  public IP   : ${public_ip:-<still being assigned; check the console>}"
        cat <<EOF

Next:

  1. In the console, add ingress rules to the subnet's security list:
       TCP 80  from 0.0.0.0/0
       TCP 443 from 0.0.0.0/0
     (port 80 is needed for the Let's Encrypt HTTP-01 challenge)

  2. Download the SSH private key from Cloud Shell if you generated one:
       cat ~/.ssh/id_ed25519
     then from your own machine:
       ssh -i <key> ubuntu@${public_ip:-<public-ip>}

  3. On the instance:
       git clone --depth 1 https://github.com/YaekaCutie/OpenMangaTranslator.git
       cd OpenMangaTranslator
       bash deploy/bootstrap-vm.sh

  4. Then see deploy/README.md step 6 to point the extension at it.
EOF
        exit 0
        ;;
      1) info "  $ad: out of capacity" ;;
      3) : ;;
      *) die "launch failed for a reason other than capacity (see above)" ;;
    esac
  done

  if [ "$DRY_RUN" = "yes" ]; then
    log "Dry run finished; nothing was created."
    exit 0
  fi

  if [ "$ROUNDS" -gt 0 ] && [ "$round" -ge "$ROUNDS" ]; then
    log "Reached $ROUNDS round(s) without capacity."
    echo "Re-run this script later — Oracle's own advice is to retry, or to"
    echo "upgrade the account to Pay as You Go, which keeps Always Free"
    echo "resources free but gives capacity priority."
    exit 1
  fi

  info "no capacity anywhere this round; sleeping ${SLEEP_SECONDS}s"
  sleep "$SLEEP_SECONDS"
done
