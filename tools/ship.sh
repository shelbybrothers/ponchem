#!/usr/bin/env bash
#
# ship.sh: put the committed site on https://ponchem.ai.
#
#   tools/ship.sh              deploy HEAD to production (the Vercel project in .vercel/project.json)
#   tools/ship.sh --check      only the checks, nothing is deployed
#
# The Vercel project is not linked to git: a push alone changes nothing on ponchem.ai. This deploys what HEAD holds,
# exported with `git archive` into a temporary folder with no .git in it (Vercel blocks deployments it attributes to
# a git identity without a team seat, and an export has none), minus what .vercelignore keeps out anyway.
# Uncommitted changes are refused: what is live should always be a commit you can point at.
#
# First time: link the folder once with `vercel link --project ponchem` (creates .vercel/project.json, which is
# git-ignored). Without that file this script refuses to run.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
say() { printf '%s\n' "$*"; }
die() { printf 'ship.sh: %s\n' "$*" >&2; exit 1; }

command -v vercel >/dev/null || die "the vercel CLI is not installed (npm i -g vercel)"
[ -f .vercel/project.json ] || die "no .vercel/project.json: link the folder once with: vercel link --project ponchem"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not a git repository: ship.sh deploys a commit"
[ -z "$(git status --porcelain)" ] || die "there are uncommitted changes. Commit them first, so what is live is a commit."
node -e "import('./js/config.js').then(() => {}, (e) => { console.error(e.message); process.exit(1); })" ||
  die "js/config.js does not import"
node tools/shell.mjs --check || die "a page carries an old shell: run node tools/shell.mjs and commit"
node tools/verify.mjs --files >/dev/null || { node tools/verify.mjs --files | tail -20 >&2; die "the file gates fail"; }

HEAD_SHA="$(git rev-parse --short HEAD)"
say "shipping $HEAD_SHA: $(git log -1 --format=%s)"
[ "${1:-}" != "--check" ] || { say "checks pass; nothing deployed (--check)"; exit 0; }

T="$(mktemp -d "${TMPDIR:-/tmp}/ponchem-ship.XXXXXX")"
trap 'rm -rf "$T"' EXIT
git archive HEAD | tar -x -C "$T"
mkdir -p "$T/.vercel" && cp .vercel/project.json "$T/.vercel/"
# /lib stays: it carries 3Dmol. data/vectors are test vectors for the engine, not site data.
(cd "$T" && rm -rf reference contracts tools partials notes docs data/vectors .venv .tmp README.md SPEC.md SPEC-*.md)
[ ! -e "$T/.git" ] || die "the export carries a .git folder"

(cd "$T" && vercel deploy --prod --yes) >"$T/deploy.log" 2>&1 || { tail -20 "$T/deploy.log" >&2; die "vercel deploy failed"; }
tail -5 "$T/deploy.log"
CODE="$(curl -s -o /dev/null -w '%{http_code}' https://ponchem.ai/ || true)"
[ "$CODE" = "200" ] && say "https://ponchem.ai answers 200 ($HEAD_SHA)" || say "note: https://ponchem.ai answered $CODE (DNS or the certificate may still be settling)"
