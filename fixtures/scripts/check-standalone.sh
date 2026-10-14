#!/usr/bin/env bash
# Proves the fixtures work outside the monorepo, the way the integration
# runner materializes them: website/, api/, requirements/ as sibling mounts,
# each installed on its own (no workspace, no root tsconfig, no turbo).
#
# Checks:
#   1. integration shape: api tests, website tests (contract included), both typechecks
#   2. plan §C.1 row 7: api adds `breakdown` -> contract fails; schema declares it -> passes
#   3. client-edition shape (website only): suite passes, contract test skipped
#
#   fixtures/scripts/check-standalone.sh        (uses $TMPDIR, cleans up after)
#   KEEP=1 fixtures/scripts/check-standalone.sh (keeps the temp dir)
set -euo pipefail

fixtures="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/cf-fixtures-standalone.XXXXXX")"
[[ "${KEEP:-}" == 1 ]] || trap 'rm -rf "$work"' EXIT
echo "standalone check in $work"

# Copy tracked + untracked-but-not-ignored files only (no node_modules/dist).
copy_mount() { # <fixture> <dest-root>
  mkdir -p "$2/$1"
  (cd "$fixtures/$1" && git ls-files -co --exclude-standard -z . | tar --null -T - -cf -) | tar -xf - -C "$2/$1"
  if [[ -e "$2/$1/turbo.json" ]]; then rm "$2/$1/turbo.json"; fi # monorepo-only config
}
# Each mount gets its own pnpm-workspace.yaml carrying the monorepo's install
# policy (allowBuilds for esbuild/workerd, minimumReleaseAgeExclude) minus the
# package globs. pnpm 12 fails installs whose build scripts are not approved, so
# the integration runner must apply the same policy when it installs a mount.
root_policy="$(sed '/^packages:/,/^$/d' "$fixtures/../pnpm-workspace.yaml")"
install_mount() {
  printf '%s\n' "$root_policy" > "$1/pnpm-workspace.yaml"
  (cd "$1" && pnpm install --prefer-offline --silent >/dev/null)
}
vitest() { (cd "$1" && pnpm exec vitest run "${@:2}" 2>&1); }
expect() { # <label> <output> <regex>
  if grep -Eq "$3" <<<"$2"; then echo "  ok   $1"; else echo "  FAIL $1"; echo "$2" | tail -30; exit 1; fi
}

echo "1. integration shape (website + api + requirements as siblings)"
int="$work/integration"
for m in website api requirements; do copy_mount "$m" "$int"; done
install_mount "$int/api"
install_mount "$int/website"
(cd "$int/api" && pnpm exec tsc -p tsconfig.json --noEmit) && echo "  ok   api typecheck"
(cd "$int/website" && pnpm exec tsc -p tsconfig.json --noEmit) && echo "  ok   website typecheck"
expect "api tests" "$(vitest "$int/api")" 'Tests +[0-9]+ passed \([0-9]+\)'
out="$(vitest "$int/website")"
expect "website tests (contract ran)" "$out" 'Tests +14 passed \(14\)'

echo "2. contract-failure scenario (plan §C.1 row 7)"
sed -i 's|^    apiVersion,$|    apiVersion,\n    breakdown: { gross, discount: roundCents(gross - total) },|' "$int/api/src/pricing.ts"
grep -q breakdown "$int/api/src/pricing.ts"
out="$(vitest "$int/website" tests/quote-contract.test.ts || true)"
expect "api adds breakdown -> contract fails" "$out" '"path": "\$\.breakdown"'
expect "  ... reported as undeclared" "$out" 'is not declared in the contract'
expect "  ... 3 contract cases fail" "$out" 'Tests +3 failed \(3\)'
node -e '
  const fs = require("node:fs"); const p = process.argv[1];
  const s = JSON.parse(fs.readFileSync(p, "utf8"));
  s.properties.breakdown = { type: "object", additionalProperties: false, required: ["gross", "discount"],
    properties: { gross: { type: "number" }, discount: { type: "number" } } };
  fs.writeFileSync(p, JSON.stringify(s, null, 2));
' "$int/requirements/contracts/quote.schema.json"
expect "schema declares breakdown -> contract passes" "$(vitest "$int/website" tests/quote-contract.test.ts)" 'Tests +3 passed \(3\)'

echo "3. client-edition shape (website only)"
ed="$work/edition"
copy_mount website "$ed"
install_mount "$ed/website"
out="$(vitest "$ed/website" --reporter=verbose)"
expect "contract suite skipped with a note" "$out" '\[quote-contract\] SKIPPED'
expect "rest of the suite passes" "$out" 'Tests +11 passed \| 1 skipped \(12\)'

echo "standalone check: PASS"
