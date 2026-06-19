#!/usr/bin/env bash
set -euo pipefail

ASTRAL_BINARY="${ASTRAL_BINARY:-/opt/astral-bin/astral}"
ASTRAL_HOME="${ASTRAL_HOME:-/astral-home}"
ASTRAL_SOURCE="${ASTRAL_SOURCE:-/opt/astral-code}"
ASTRAL_TOKEN_FILE="${ASTRAL_TOKEN_FILE:-${ASTRAL_HOME}/app-server-token}"
CARGO_HOME="${CARGO_HOME:-/cargo-home}"
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/cargo-target}"
ASTRAL_BUILD_PROFILE="${ASTRAL_BUILD_PROFILE:-release}"

export CARGO_HOME
export CARGO_TARGET_DIR
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-6}"
export CARGO_PROFILE_RELEASE_LTO="${CARGO_PROFILE_RELEASE_LTO:-false}"
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS="${CARGO_PROFILE_RELEASE_CODEGEN_UNITS:-16}"
export CARGO_PROFILE_RELEASE_DEBUG="${CARGO_PROFILE_RELEASE_DEBUG:-none}"

mkdir -p "${ASTRAL_HOME}" /workspace "$(dirname "${ASTRAL_BINARY}")" "${CARGO_HOME}" "${CARGO_TARGET_DIR}"

if [[ -n "${ASTRAL_APP_SERVER_TOKEN:-}" ]]; then
  printf '%s\n' "${ASTRAL_APP_SERVER_TOKEN}" > "${ASTRAL_TOKEN_FILE}"
  chmod 600 "${ASTRAL_TOKEN_FILE}"
fi

if [[ ! -x "${ASTRAL_BINARY}" ]]; then
  if [[ ! -d "${ASTRAL_SOURCE}/codex-rs" ]]; then
    echo "Astral binary not found at ${ASTRAL_BINARY}, and source not found at ${ASTRAL_SOURCE}/codex-rs" >&2
    exit 1
  fi
  cd "${ASTRAL_SOURCE}/codex-rs"
  case "${ASTRAL_BUILD_PROFILE}" in
    release)
      cargo build -p codex-cli --bin astral --release
      build_dir="release"
      ;;
    dev | debug)
      cargo build -p codex-cli --bin astral
      build_dir="debug"
      ;;
    *)
      cargo build -p codex-cli --bin astral --profile "${ASTRAL_BUILD_PROFILE}"
      build_dir="${ASTRAL_BUILD_PROFILE}"
      ;;
  esac
  cp "${CARGO_TARGET_DIR}/${build_dir}/astral" "${ASTRAL_BINARY}"
  chmod +x "${ASTRAL_BINARY}"
fi

if [[ ! -s "${ASTRAL_TOKEN_FILE}" ]]; then
  echo "ASTRAL_APP_SERVER_TOKEN is required for non-loopback app-server auth" >&2
  exit 1
fi

exec "${ASTRAL_BINARY}" app-server \
  --listen ws://0.0.0.0:4222 \
  --ws-auth capability-token \
  --ws-token-file "${ASTRAL_TOKEN_FILE}"
