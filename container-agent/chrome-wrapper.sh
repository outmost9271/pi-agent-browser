#!/bin/bash
# PIAB Chrome wrapper: enforce sandbox when PIAB_REQUIRE_SANDBOX=1
# Filters out sandbox bypass flags that upstream auto-adds in Docker

if [[ "${PIAB_REQUIRE_SANDBOX:-}" == "1" ]]; then
  FILTERED=()
  for arg in "$@"; do
    case "$arg" in
      --no-sandbox|--disable-setuid-sandbox|--disable-namespace-sandbox|--disable-seccomp-filter-sandbox|--disable-gpu-sandbox|--single-process|--no-zygote)
        echo "[chrome-piab] PIAB_REQUIRE_SANDBOX=1: removing $arg" >&2
        continue
        ;;
      --no-sandbox=*|--disable-setuid-sandbox=*|--disable-namespace-sandbox=*|--disable-seccomp-filter-sandbox=*|--disable-gpu-sandbox=*|--single-process=*|--no-zygote=*)
        echo "[chrome-piab] PIAB_REQUIRE_SANDBOX=1: removing $arg" >&2
        continue
        ;;
      *)
        FILTERED+=("$arg")
        ;;
    esac
  done
  set -- "${FILTERED[@]}"
fi

HERE="$(dirname "$(readlink -f "$0")")"
# The real binary is chrome.real; if not present, try chrome.bin
if [[ -x "$HERE/chrome.real" ]]; then
  exec "$HERE/chrome.real" "$@"
elif [[ -x "$HERE/chrome.bin" ]]; then
  exec "$HERE/chrome.bin" "$@"
else
  echo "[chrome-piab] chrome.real not found at $HERE/chrome.real" >&2
  exit 1
fi
