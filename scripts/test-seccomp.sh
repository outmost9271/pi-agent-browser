#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
image="${PIAB_TEST_IMAGE:-pi-agent-browser:0.36.0}"
policy="$PWD/config/seccomp-browser.json"
common=(--rm --network none --cap-drop ALL --security-opt no-new-privileges:true
  --read-only --memory 256m --pids-limit 64 --cpus 1
  --entrypoint /usr/bin/unshare)

# A negative control distinguishes a meaningful policy change from a permissive host.
set +e
baseline_output=$(docker run "${common[@]}" "$image" --user --map-root-user true 2>&1)
baseline_status=$?
set -e
if [[ $baseline_status -eq 0 ]]; then
  printf '%s\n' 'Default profile already permits user namespaces; custom policy needs reassessment.' >&2
  exit 1
fi
if [[ $baseline_status -ne 1 || "$baseline_output" != *'Operation not permitted'* ]]; then
  printf '%s\n' "$baseline_output" >&2
  printf '%s\n' 'Negative control failed for an unexpected reason.' >&2
  exit 1
fi
printf '%s\n' 'PASS: default profile blocks the user namespace probe.'
docker run "${common[@]}" --security-opt "seccomp=$policy" "$image" --user --map-root-user true
printf '%s\n' 'PASS: derived profile permits the user namespace probe without capabilities.'
printf '%s\n' 'This does NOT establish that Chrome sandboxing is active.'
