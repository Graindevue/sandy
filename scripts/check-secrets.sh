#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
scanner="${GITLEAKS_BIN:-.sandy/tools/gitleaks}"
if ! command -v "$scanner" >/dev/null 2>&1; then
  echo 'Gitleaks is missing. Run pnpm security:setup or set GITLEAKS_BIN.' >&2
  exit 1
fi

flags=(--redact=100 --ignore-gitleaks-allow --max-decode-depth=5 --max-archive-depth=2 --no-banner --no-color)
case "${1:-}" in
  '')
    exec "$scanner" git --log-opts='--all --full-history' "${flags[@]}" .
    ;;
  --staged)
    exec "$scanner" git --pre-commit --staged "${flags[@]}" .
    ;;
  *)
    echo 'Usage: bash scripts/check-secrets.sh [--staged]' >&2
    exit 2
    ;;
esac
