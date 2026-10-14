#!/usr/bin/env bash
# Export the variables in apps/worker/.dev.vars into the current shell.
#
# Usage (must be sourced, not executed):
#   source scripts/load-dev-vars.sh            # uses apps/worker/.dev.vars
#   source scripts/load-dev-vars.sh path/to/.dev.vars
#
# .dev.vars is git-ignored; copy apps/worker/.dev.vars.example to create it.
# Values are never echoed. The file's values replace the shell's, except for the names listed in
# LOAD_DEV_VARS_KEEP_ENV (space-separated): a non-empty value already in the environment is kept
# (scripts/deploy-live.sh and deploy-ci.sh list their deployment settings, not credentials).

if [ -n "${BASH_SOURCE[0]:-}" ] && [ "${BASH_SOURCE[0]}" = "$0" ]; then
  echo "load-dev-vars.sh: source this file (source scripts/load-dev-vars.sh) so the exports reach your shell" >&2
  exit 1
fi

_cf_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
_cf_vars_file="${1:-$_cf_repo_root/apps/worker/.dev.vars}"

if [ ! -f "$_cf_vars_file" ]; then
  echo "load-dev-vars.sh: $_cf_vars_file not found (copy apps/worker/.dev.vars.example and fill it in)" >&2
  unset _cf_repo_root _cf_vars_file
  return 1
fi

_cf_count=0
while IFS= read -r _cf_line || [ -n "$_cf_line" ]; do
  # Skip blank lines and comments.
  case "$_cf_line" in
    '' | \#*) continue ;;
  esac
  _cf_line="${_cf_line#export }"
  _cf_key="${_cf_line%%=*}"
  _cf_val="${_cf_line#*=}"
  # Trim whitespace around the key; ignore malformed lines.
  _cf_key="$(printf '%s' "$_cf_key" | tr -d '[:space:]')"
  case "$_cf_key" in
    '' | *[!A-Za-z0-9_]* | [0-9]*) continue ;;
  esac
  # Strip one layer of matching surrounding quotes.
  case "$_cf_val" in
    \"*\") _cf_val="${_cf_val#\"}"; _cf_val="${_cf_val%\"}" ;;
    \'*\') _cf_val="${_cf_val#\'}"; _cf_val="${_cf_val%\'}" ;;
  esac
  case " ${LOAD_DEV_VARS_KEEP_ENV:-} " in
    *" $_cf_key "*) eval "_cf_cur=\${$_cf_key:-}"; [ -n "$_cf_cur" ] && continue ;;
  esac
  export "$_cf_key=$_cf_val"
  _cf_count=$((_cf_count + 1))
done < "$_cf_vars_file"

echo "load-dev-vars.sh: exported $_cf_count variables from $_cf_vars_file" >&2
unset _cf_repo_root _cf_vars_file _cf_line _cf_key _cf_val _cf_count _cf_cur
