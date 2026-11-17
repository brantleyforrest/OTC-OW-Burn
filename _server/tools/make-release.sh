#!/usr/bin/env bash
# Builds a server release: _server/dist/burn-server-<version>.tar.gz, its .sha256, and a copy of
# deploy/install.sh beside them. Copy those three files to the host and run:
#     sudo bash install.sh
#
# Run from anywhere:  bash _server/tools/make-release.sh [--force]
# The version is "version" in _server/package.json; raise it before each release. --force
# rebuilds a version that was already built (only do that if it was never installed anywhere).
#
# The tarball holds the server, the two rules files it loads from burn/, and its production
# packages (node_modules from npm ci --omit=dev), so the host needs no npm and no network.
# Never included: secrets/, data/, test/, dist/, deploy/out/, config.dev.json.
set -euo pipefail

FORCE=0
for a in "$@"; do
    case "$a" in --force) FORCE=1 ;; -h|--help) sed -n '2,13p' "$0"; exit 0 ;; *) echo "Unknown option $a" >&2; exit 2 ;; esac
done

INSTALL_LAYOUT=1   # must match INSTALLER_LAYOUT in deploy/install.sh
SERVER=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ROOT=$(cd "$SERVER/.." && pwd)
DIST=$SERVER/dist

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null || die "node is needed."
command -v npm >/dev/null || die "npm is needed."
tar --version 2>/dev/null | grep -q 'GNU tar' || die "GNU tar is needed (Git Bash and Linux have it)."

VERSION=$(cd "$SERVER" && node -p "require('./package.json').version")
ENGINE=$(cd "$ROOT" && node -p "require('./burn/burn-core.js').ENGINE_VERSION")
NODE_MIN=$(cd "$SERVER" && node -p "(require('./package.json').engines.node.match(/[0-9]+/) || [20])[0]")
printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$' || die "Bad version '$VERSION' in package.json."
grep -q "^INSTALLER_LAYOUT=$INSTALL_LAYOUT\$" "$SERVER/deploy/install.sh" || die "INSTALL_LAYOUT here and INSTALLER_LAYOUT in deploy/install.sh differ."

NAME=burn-server-$VERSION
OUT=$DIST/$NAME.tar.gz
if [ -f "$OUT" ] && [ "$FORCE" = 0 ]; then
    die "$OUT already exists. Raise \"version\" in _server/package.json, or pass --force."
fi

# Shell scripts must have Unix line endings, or bash on the host fails on them.
for f in "$SERVER/deploy/install.sh" "$SERVER/deploy/burnctl" "$SERVER/tools/make-release.sh"; do
    if grep -q $'\r' "$f"; then die "$f has Windows line endings. Convert it to LF (see .gitattributes)."; fi
done

# The tests must pass first.
( cd "$SERVER" && npm test --silent ) || die "The tests failed; no release built."

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/$NAME/_server" "$STAGE/$NAME/burn"

tar -C "$SERVER" -cf - \
    --exclude=./secrets --exclude=./data --exclude=./test --exclude=./dist \
    --exclude=./deploy/out --exclude=./node_modules --exclude=./config.dev.json . \
  | tar -C "$STAGE/$NAME/_server" -xf -
cp "$ROOT/burn/burn-core.js" "$ROOT/burn/burn-scenarios.js" "$STAGE/$NAME/burn/"
cp "$ROOT/LICENSE" "$STAGE/$NAME/"
[ ! -e "$STAGE/$NAME/_server/secrets" ] || die "secrets/ ended up in the stage; stopping."

( cd "$STAGE/$NAME/_server" && npm ci --omit=dev --no-audit --no-fund --ignore-scripts --loglevel=error >/dev/null ) \
    || die "npm ci failed."

COMMIT=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo none)
DIRTY=$(git -C "$ROOT" status --porcelain -- _server burn 2>/dev/null | head -n 1)
[ -n "$DIRTY" ] && COMMIT="$COMMIT+uncommitted"
cat >"$STAGE/$NAME/RELEASE" <<EOF
name=burn-server
version=$VERSION
engine=$ENGINE
layout=$INSTALL_LAYOUT
node_min=$NODE_MIN
built=$(date -u +%Y-%m-%dT%H:%M:%SZ)
commit=$COMMIT
EOF

mkdir -p "$DIST"
# RELEASE first, so the installer finds the top folder and the release info quickly.
( cd "$STAGE" && find "$NAME" -mindepth 1 -not -path "$NAME/RELEASE" | LC_ALL=C sort >"$STAGE/files" )
tar -C "$STAGE" -czf "$OUT.tmp" \
    --owner=0 --group=0 --numeric-owner --mode='u+rwX,go+rX,go-w' --no-recursion \
    "$NAME" "$NAME/RELEASE" -T "$STAGE/files"
mv -f "$OUT.tmp" "$OUT"
( cd "$DIST" && sha256sum "$NAME.tar.gz" >"$NAME.tar.gz.sha256" )
cp "$SERVER/deploy/install.sh" "$DIST/install.sh"

echo "Built $OUT ($(du -h "$OUT" | cut -f1)), engine $ENGINE, commit $COMMIT."
echo "Copy these to the host and run 'sudo bash install.sh' there:"
echo "  $OUT"
echo "  $OUT.sha256"
echo "  $DIST/install.sh"
