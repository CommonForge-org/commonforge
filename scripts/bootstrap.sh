#!/usr/bin/env bash
# Bootstrap a CommonForge deployment into a Cloudflare account (Task 24). Idempotent: rerun it to
# update a deployment or to finish one that stopped half way. Seed of the future
# `npx commonforge init` installer (no npm package is made or published from this script).
#
#   scripts/bootstrap.sh --name <name> [options]          a non-production deployment <name>
#   scripts/bootstrap.sh --production [options]           the canonical production names
#
# Options:
#   --name <name>            3-16 lowercase letters/digits. Every resource derives from it: Workers
#                            <name>-{worker,preview,runner}, D1 <name>, queues <queue>-<name> (incl. the
#                            DLQ), R2 <name>-assets; the deployment's Worker later creates Artifacts
#                            namespaces <name>-o-<org hex>-{canonical,tasks,editions}, release Workers
#                            and KV <name>-o-<org hex>-*. Names that could reach production or the
#                            CI deployment (commonforge*, ci, cfci, cfapp, prod, live, ...) are refused.
#   --production             deploy the names of apps/worker/wrangler*.jsonc (commonforge-worker,
#                            D1 commonforge-dev, ...). Email mode is always send.
#   --email-mode send|log    default send. `log` writes sign-in links to the Worker log instead of
#                            mailing them: anyone with log access can sign in as anyone. Allowed only
#                            on a non-production deployment (the Worker refuses it on production).
#   --email-from <address>   sender address (default: the one an earlier run recorded; the committed
#                            template's login@example.com is only a placeholder). Its domain must be
#                            onboarded to Cloudflare Email Service on this account for send mode.
#                            Without it, a first run in send mode deploys the placeholder with a
#                            warning (see the next steps it prints). A deployment already deployed
#                            whose deployment.json records no sender (an earlier version of this
#                            script did not) is refused: pass --email-from once to record it.
#   (custom domains below: a non-production deployment may not use production's, i.e.
#    COMMONFORGE_LIVE_APP_DOMAIN / _PREVIEW_DOMAIN in the environment or a --production bootstrap's)
#   --app-domain <host>      serve the app on this custom domain (e.g. forge.example.com) instead of
#                            <worker>.<subdomain>.workers.dev: a Custom Domain route on the worker, and
#                            COMMONFORGE_APP_URL / PUBLIC_URL and the runner's worker URL use it. The
#                            host's zone must be on this Cloudflare account. `none` removes it.
#   --preview-domain <host>  the same for the preview Worker (COMMONFORGE_PREVIEW_URL). Must differ from
#                            the app's: previews run untrusted site code on their own origin.
#                            Both are recorded in deployment.json: a rerun without them keeps them.
#   --admin-emails <list>    who may create organizations: comma-separated emails or @domain entries
#                            (COMMONFORGE_ADMIN_EMAILS). Default: COMMONFORGE_ADMIN_EMAILS from the
#                            environment (e.g. loaded by --env-file). With neither, nobody can create
#                            one, and --production refuses (a deploy replaces the live list).
#                            --smoke adds smoke@example.com.
#   --adopt                  take over same-named resources this deployment's state does not record
#                            (otherwise refused: they may be someone else's; teardown deletes adopted ones)
#   --rotate-keys            generate new session, runner-job and preview keys and install them
#                            (signs every user out; invalidates CLI sessions and preview links)
#   --replace-tokens         install CF_ACCOUNT_ID, CF_API_TOKEN and COMMONFORGE_DEPLOY_API_TOKEN from the
#                            environment (all three required); sessions survive
#                            Default for both: set only the secrets a Worker does not have yet.
#   --env-file <file>        load KEY=VALUE credentials from a file first (e.g. apps/worker/.dev.vars)
#   --smoke                  after deploying, sign in (log mode only), create an org and project,
#                            list them and run one runner job (scripts/bootstrap/smoke.mjs)
#   --skip-build             reuse the current build output
#
# Credentials, from the environment (never echoed, never passed on a command line):
#   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID   wrangler and the account REST API. The token needs
#       Workers Scripts, Workers R2 Storage, D1, Queues, Workers KV Storage, Containers and
#       Artifacts: Edit; Account Settings: Read; Workers Tail: Read (for --smoke).
#   CF_API_TOKEN                   the Worker's Artifacts token (ideally dedicated: Artifacts: Edit only)
#   CF_ACCOUNT_ID                  default CLOUDFLARE_ACCOUNT_ID
#   COMMONFORGE_DEPLOY_API_TOKEN   release deploys (Workers Scripts + KV: Edit); when the Worker does not
#                                  have it yet and it is unset, CF_API_TOKEN is installed, with a warning
# A secret the Worker already has is never replaced unless --rotate-keys / --replace-tokens (mirrors
# deploy-ci.sh).
#
# State: ${COMMONFORGE_STATE_DIR:-~/.config/commonforge/deployments}/<name>/ (0700): deployment.json
# is bound to the Cloudflare account and records the identity of every resource this deployment
# created (teardown deletes only those, and refuses if the account or an identity changed);
# secrets.env (0600) the generated random keys (session, runner job, preview).
# Generated wrangler configs: apps/worker/wrangler.deploy-<name>{,-preview,-runner}.jsonc (git-ignored).
# Remove a deployment with scripts/teardown.sh --name <name> --yes.
set -euo pipefail
die() { printf 'bootstrap: %s\n' "$*" >&2; exit 1; }
NAME_RE='^[a-z][a-z0-9]{2,15}$'

name="" production=0 email_mode=send email_from="" app_domain="" preview_domain="" admin_emails="" env_file="" smoke=0 skip_build=0 adopt=0 rotate_keys=0 replace_tokens=0
usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
value() { [ -n "${2:-}" ] && [ "${2#-}" = "$2" ] || die "$1 needs a value (not an option)"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --name) value "$1" "${2:-}"; name="$2"; shift 2 ;;
    --production) production=1; shift ;;
    --email-mode) value "$1" "${2:-}"; email_mode="$2"; shift 2 ;;
    --email-from) value "$1" "${2:-}"; email_from="$2"; shift 2 ;;
    --app-domain) value "$1" "${2:-}"; app_domain="$2"; shift 2 ;;
    --preview-domain) value "$1" "${2:-}"; preview_domain="$2"; shift 2 ;;
    --admin-emails) value "$1" "${2:-}"; admin_emails="$2"; shift 2 ;;
    --env-file) value "$1" "${2:-}"; env_file="$2"; shift 2 ;;
    --adopt) adopt=1; shift ;;
    --rotate-keys) rotate_keys=1; shift ;;
    --replace-tokens) replace_tokens=1; shift ;;
    --smoke) smoke=1; shift ;;
    --skip-build) skip_build=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

# the name is checked before anything else runs (review I2)
if [ "$production" = 1 ]; then
  [ -z "$name" ] || die "--production deploys the canonical names; drop --name"
  [ "$email_mode" = send ] || die "production sends sign-in email; --email-mode log is refused"
  dargs=(--production)
else
  [ -n "$name" ] || die "--name <name> is required (or --production); see --help"
  [[ "$name" =~ $NAME_RE ]] || die "refusing deployment name \"$name\": 3-16 lowercase letters and digits, starting with a letter"
  dargs=("$name")
fi
case "$email_mode" in send|log) ;; *) die "--email-mode is send or log" ;; esac
[ "$smoke" = 0 ] || [ "$email_mode" = log ] || die "--smoke signs in through log-mode links: use it with --email-mode log"
# a relative --env-file is relative to the caller's directory (resolved before the cd below)
if [ -n "$env_file" ]; then
  [ -f "$env_file" ] || die "--env-file $env_file not found"
  env_file="$(cd "$(dirname "$env_file")" && pwd)/$(basename "$env_file")"
fi

cd "$(dirname "$0")/.."
REPO="$(pwd)"
D() { node "$REPO/scripts/bootstrap/deployment.mjs" "$@"; }
D names "${dargs[@]}" >/dev/null # the node side refuses production / CI / reserved names
say() { printf '\n== %s\n' "$*"; }

# ---------------------------------------------------------------------------------------------
say "prerequisites"
if [ -n "$env_file" ]; then
  # shellcheck disable=SC1091
  source scripts/load-dev-vars.sh "$env_file" >/dev/null 2>&1 || die "cannot load $env_file"
fi
# --admin-emails wins; else the environment's list (an --env-file such as apps/worker/.dev.vars)
[ -n "$admin_emails" ] || admin_emails="${COMMONFORGE_ADMIN_EMAILS:-}"
# wrangler deploy replaces vars: an empty list would wipe production's admins
[ "$production" = 0 ] || [ -n "$admin_emails" ] || die "--production needs --admin-emails (or COMMONFORGE_ADMIN_EMAILS in the environment): a deploy with an empty list would remove every instance admin"
command -v node >/dev/null || die "node >= 22 is required"
node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' || die "node >= 22 is required (found $(node --version))"
command -v pnpm >/dev/null || die "pnpm is required (corepack enable)"
command -v openssl >/dev/null || die "openssl is required (random keys)"
command -v curl >/dev/null || die "curl is required"
[ "$smoke" = 0 ] || command -v zip >/dev/null || die "--smoke needs zip"
[ -d node_modules ] || pnpm install --frozen-lockfile
wv="$(cd apps/worker && pnpm exec wrangler --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
node -e 'const [a,b]=process.argv[1].split(".").map(Number); process.exit(a>4||(a===4&&b>=145)?0:1)' "${wv:-0.0.0}" \
  || die "wrangler >= 4.145.0 is required for Artifacts (found ${wv:-none})"
echo "  node $(node --version), pnpm $(pnpm --version), wrangler $wv"
# Container images (runner, preview) are built locally: Docker, or a passwordless `sudo -n docker`.
if docker info >/dev/null 2>&1; then
  echo "  docker: ok"
elif sudo -n docker info >/dev/null 2>&1; then
  wrap="$(mktemp -d)/docker"
  printf '#!/bin/sh\nexec sudo -n docker "$@"\n' >"$wrap"
  chmod +x "$wrap"
  export WRANGLER_DOCKER_BIN="$wrap"
  echo "  docker: via sudo -n"
else
  die "Docker is required to build the runner/preview container image (docker info failed, and sudo -n docker is not allowed)"
fi
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] \
  || die "export CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (an API token on the target account; see --help)"
export CF_ACCOUNT_ID="${CF_ACCOUNT_ID:-$CLOUDFLARE_ACCOUNT_ID}"
[ "$CF_ACCOUNT_ID" = "$CLOUDFLARE_ACCOUNT_ID" ] || die "CF_ACCOUNT_ID and CLOUDFLARE_ACCOUNT_ID name different accounts"
echo "  account and token:"
D probe

if [ "$email_mode" = log ]; then
  cat >&2 <<EOF

  ###########################################################################################
  ##  EMAIL LOG MODE on deployment "$name"
  ##  Sign-in links are written to the Worker log instead of being emailed. Anyone who can read
  ##  this account's Worker logs can sign in as any user. Use it for test deployments only;
  ##  the Worker refuses log mode on a production deployment.
  ###########################################################################################

EOF
fi

# ---------------------------------------------------------------------------------------------
say "resources (create or reuse)"
adopt_flag=(); [ "$adopt" = 1 ] && adopt_flag=(--adopt)
D ensure "${dargs[@]}" ${adopt_flag[@]+"${adopt_flag[@]}"}
state_name="$name"; [ "$production" = 1 ] && state_name=production
STATE_DIR="${COMMONFORGE_STATE_DIR:-$HOME/.config/commonforge/deployments}/$state_name"

say "wrangler configs"
[ "$smoke" = 1 ] && admin_emails="${admin_emails:+$admin_emails,}smoke@example.com"
[ -n "$admin_emails" ] || echo "  warning: no --admin-emails or COMMONFORGE_ADMIN_EMAILS: nobody can create organizations on this deployment" >&2
cfg_args=(--email-mode "$email_mode"); [ -n "$email_from" ] && cfg_args+=(--email-from "$email_from")
[ -n "$admin_emails" ] && cfg_args+=(--admin-emails "$admin_emails")
[ -n "$app_domain" ] && cfg_args+=(--app-domain "$app_domain")
[ -n "$preview_domain" ] && cfg_args+=(--preview-domain "$preview_domain")
names_json="$(D config "${dargs[@]}" "${cfg_args[@]}")"
j() { node -e 'const v=JSON.parse(process.argv[1]); console.log(process.argv[2].split(".").reduce((o,k)=>o[k],v))' "$names_json" "$1"; }
WORKER="$(j worker)"; PREVIEW="$(j preview)"; RUNNER="$(j runner)"
WORKER_URL="$(j workerUrl)"; PREVIEW_URL="$(j previewUrl)"; DB_NAME="$(j d1.database_name)"
CFG_W="$(j configs.worker)"; CFG_P="$(j configs.preview)"; CFG_R="$(j configs.runner)"
EMAIL_FROM="$(j emailFrom)"
APP_DOMAIN="$(j appDomain 2>/dev/null || true)"; [ "$APP_DOMAIN" = undefined ] && APP_DOMAIN=""
PREVIEW_DOMAIN="$(j previewDomain 2>/dev/null || true)"; [ "$PREVIEW_DOMAIN" = undefined ] && PREVIEW_DOMAIN=""
[ -z "$APP_DOMAIN$PREVIEW_DOMAIN" ] || echo "  custom domains: app ${APP_DOMAIN:-(workers.dev)}, previews ${PREVIEW_DOMAIN:-(workers.dev)}"
echo "  apps/worker/$CFG_W, $CFG_P, $CFG_R"

say "secrets"
SECRETS_FILE="$STATE_DIR/secrets.env"
if [ ! -f "$SECRETS_FILE" ] || [ "$rotate_keys" = 1 ]; then
  (umask 077
   { echo "COMMONFORGE_SESSION_SECRET=$(openssl rand -hex 32)"
     echo "COMMONFORGE_RUNNER_JOB_KEY=$(openssl rand -hex 32)"
     echo "COMMONFORGE_PREVIEW_KEY=$(openssl rand -hex 32)"; } >"$SECRETS_FILE.new")
  mv "$SECRETS_FILE.new" "$SECRETS_FILE"
  echo "  generated session, runner-job and preview keys ($SECRETS_FILE, 0600)"
else
  echo "  local keys: $SECRETS_FILE"
fi
chmod 600 "$SECRETS_FILE"
TMPD="$(umask 077; mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT
# worker.json / preview.json for `wrangler deploy --secrets-file`: only the secrets each Worker does not
# have yet, plus the keys with --rotate-keys and the tokens with --replace-tokens. The keys reach only
# this node process (M4); values never hit argv.
rotate_flag=(); [ "$rotate_keys" = 1 ] && rotate_flag+=(--rotate-keys); [ "$replace_tokens" = 1 ] && rotate_flag+=(--replace-tokens)
( set -a
  # shellcheck disable=SC1090
  source "$SECRETS_FILE"
  set +a
  D secrets "${dargs[@]}" --out-dir "$TMPD" ${rotate_flag[@]+"${rotate_flag[@]}"} ) || die "secrets: see above"
secrets_args() { [ "$(cat "$TMPD/$1")" = "{}" ] || printf '%s\n' --secrets-file "$TMPD/$1"; }

say "D1 migrations ($DB_NAME)"
(cd apps/worker && CI=1 pnpm exec wrangler d1 migrations apply "$DB_NAME" --remote -c "$CFG_W" >"$TMPD/migrate.log" 2>&1) || {
  tail -30 "$TMPD/migrate.log" >&2; die "D1 migrations failed"; }
grep -Eo "[0-9]{4}_[a-z_]+\.sql|No migrations to apply" "$TMPD/migrate.log" | sort -u | sed 's/^/  /' || true

if [ "$skip_build" = 0 ]; then
  say "build"
  pnpm build >"$TMPD/build.log" 2>&1 || { tail -40 "$TMPD/build.log" >&2; die "pnpm build failed"; }
  echo "  ok"
fi

# ---------------------------------------------------------------------------------------------
# Order: runner → preview → worker (a new worker may issue jobs only the new runner understands).
# On the first deploy the worker goes first: the runner's service binding needs it to exist.
deploy() {
  local what="$1" cfg="$2"; shift 2
  echo "  deploying $what ($cfg)"
  (cd apps/worker && pnpm exec wrangler deploy -c "$cfg" "$@" >"$TMPD/deploy-$what.log" 2>&1) || {
    tail -30 "$TMPD/deploy-$what.log" >&2; die "deploy of $what failed"; }
  grep -E "^\s*https://|^Deployed|^Current Version ID" "$TMPD/deploy-$what.log" | sed -E 's/^\s*/    /' || true
}
say "deploy"
if D inventory "${dargs[@]}" --json 2>/dev/null | node -e 'let r="";process.stdin.on("data",d=>r+=d).on("end",()=>process.exit(JSON.parse(r).workers.includes(process.argv[1])?0:1))' "$WORKER"; then
  order=(runner preview worker)
else
  order=(worker runner preview)
fi
for t in "${order[@]}"; do
  case "$t" in
    worker) mapfile -t sa < <(secrets_args worker.json); deploy worker "$CFG_W" ${sa[@]+"${sa[@]}"} ;;
    preview) mapfile -t sa < <(secrets_args preview.json); deploy preview "$CFG_P" ${sa[@]+"${sa[@]}"} ;;
    runner) deploy runner "$CFG_R" ;;
  esac
done
D identify "${dargs[@]}" # record the Workers' / containers' identities (teardown checks them)

# ---------------------------------------------------------------------------------------------
say "verify"
wait_json() { # url → body (retries while a fresh workers.dev route or custom domain certificate propagates)
  local url="$1" body="" tries=30
  [ -z "$APP_DOMAIN$PREVIEW_DOMAIN" ] || tries=90
  for _ in $(seq 1 "$tries"); do
    body="$(curl -fsS "$url" 2>/dev/null)" && { printf '%s' "$body"; return 0; }
    sleep 4
  done
  return 1
}
health="$(wait_json "$WORKER_URL/health")" || die "$WORKER_URL/health did not answer"
echo "  worker /health: $health"
want_dep="$name"; [ "$production" = 1 ] && want_dep=production
printf '%s' "$health" | node -e 'let r="";process.stdin.on("data",d=>r+=d).on("end",()=>{const h=JSON.parse(r);
  const [dep, mode] = process.argv.slice(1);
  const bad = [!h.ok && "ok is false", h.deployment !== dep && `deployment is ${h.deployment}, expected ${dep}`, h.emailMode !== mode && `emailMode is ${h.emailMode}`, h.chaos && "chaos flags are active"].filter(Boolean);
  if (bad.length) { console.error("  /health: " + bad.join("; ")); process.exit(1); }})' "$want_dep" "$email_mode" || die "worker /health is wrong"
rh="$(wait_json "$(j runnerUrl)/health")" || die "runner /health did not answer"
echo "  runner /health: $rh"
inv="$(D inventory "${dargs[@]}" --json)"
printf '%s' "$inv" | node -e 'let r="";process.stdin.on("data",d=>r+=d).on("end",()=>{const v=JSON.parse(r); const want=process.argv.slice(1);
  const have=v.containers.map(c=>c.name); const miss=want.filter(w=>!have.includes(w));
  if (miss.length) { console.error("  missing container applications: "+miss.join(", ")); process.exit(1); }
  console.log("  container applications: "+have.join(", "));})' "${RUNNER}-runnerbox" "${PREVIEW}-previewbox" || die "container application missing (redeploy the runner/preview)"

if [ "$smoke" = 1 ]; then
  say "smoke (log-mode sign-in, org, project, runner job)"
  node scripts/bootstrap/smoke.mjs "$name" || die "smoke failed"
fi

# ---------------------------------------------------------------------------------------------
say "done"
cat <<EOF
  App:      $WORKER_URL
  Previews: $PREVIEW_URL
  Health:   $WORKER_URL/health   (deployment $want_dep, email $email_mode)
  State:    $STATE_DIR (keys, D1 id; 0600)

Next steps
  1. Sign in at $WORKER_URL with your email address.
EOF
if [ "$email_mode" = log ]; then
  cat <<EOF
     Log mode: the link is in the Worker log, not your inbox:
       cd apps/worker && pnpm exec wrangler tail $WORKER --format pretty   (look for "magic link for")
EOF
fi
cat <<EOF
  2. Email Service (manual, once per sending domain; needed for --email-mode send):
     a. The sending domain ($(printf '%s' "$EMAIL_FROM" | sed 's/.*@//')) must be a zone on this Cloudflare account,
        the same account as the custom domains' zones (--app-domain / --preview-domain), if any.
     b. Dashboard → Email Service → Email Sending → Onboard domain → pick the zone.
        Cloudflare adds the cf-bounce MX, SPF and DKIM records and a _dmarc record (p=reject at the apex:
        mail sent for that domain through any other provider without SPF/DKIM alignment is then rejected;
        relax it to p=none in DNS if needed).
     c. Wait for the domain to show as verified, then rerun:
          scripts/bootstrap.sh $( [ "$production" = 1 ] && echo --production || echo "--name $name" ) --email-from <login@your-domain> --email-mode send
  3. Replace the broad token: create a dedicated CF_API_TOKEN (Account › Artifacts: Edit only) and a
     dedicated COMMONFORGE_DEPLOY_API_TOKEN (Workers Scripts + Workers KV Storage: Edit, ideally on a
     separate account), export both (and CF_ACCOUNT_ID) and rerun this script with --replace-tokens.
     A plain rerun keeps the installed secrets; --replace-tokens keeps sessions, --rotate-keys signs everyone out.
  4. Optional: Artifacts 'pushed' event subscriptions (wakeups only; apps/worker/API.md "Deploy prerequisites").
  5. CLI: CFORGE_API_URL=$WORKER_URL node apps/cli/dist/index.js login --email <you@example.com>
EOF
if [ -n "$APP_DOMAIN$PREVIEW_DOMAIN" ]; then
  cat <<EOF
  Custom domains: ${APP_DOMAIN:+$APP_DOMAIN (app) }${PREVIEW_DOMAIN:+$PREVIEW_DOMAIN (previews)}. Their zones and the Email Sending
     domain of --email-from must all be on this one Cloudflare account; the deploy created the DNS records and
     certificates. With --app-domain the worker's own workers.dev URL is off (wrangler's default with a route).
EOF
fi
[ "$production" = 1 ] || echo "  Remove everything this deployment created: scripts/teardown.sh --name $name --yes"
