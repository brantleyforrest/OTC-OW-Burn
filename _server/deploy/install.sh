#!/usr/bin/env bash
# Burn server installer for Ubuntu (and other systemd Linux systems).
#
# Put a release tarball (burn-server-<version>.tar.gz) and this script in one folder, then run:
#     sudo bash install.sh                      # installs or upgrades to the newest tarball here
#     sudo bash install.sh burn-server-0.2.0.tar.gz
#     sudo bash install.sh --dry-run            # shows every step and changes nothing
# Run "bash install.sh --help" for every option.
#
# The same script does a first install and an upgrade. An upgrade keeps the config and the data,
# takes a backup first, and goes back to the old release on its own if anything fails, including
# the new release's health check. It manages only this server: it never installs packages,
# touches a firewall, or changes a reverse proxy. It prints what is left for you to do.
#
# Install layout 1 (what this script creates; later installers must be able to upgrade it):
#     /opt/burn/releases/<version>/   each installed release, unpacked
#     /opt/burn/current               symlink to the running release
#     /opt/burn/previous              symlink to the release before it (for rollback)
#     /opt/burn/backups/              config and data backups taken before each upgrade
#     /opt/burn/install.conf          what this script chose (service user, node path, keep)
#     /opt/burn/LAYOUT                the install layout number
#     /etc/burn/config.json           the server config (yours; an upgrade never replaces it
#                                      unless you pass --config)
#     /var/lib/burn/                  data (the leaderboard)
#     /etc/systemd/system/burn.service
#     /usr/local/bin/burnctl          the management command
set -euo pipefail

INSTALLER_LAYOUT=1
APP=burn
BASE=/opt/burn
RELEASES=$BASE/releases
BACKUPS=$BASE/backups
STATE=$BASE/install.conf
LAYOUT_FILE=$BASE/LAYOUT
ETC=/etc/burn
CONFIG=$ETC/config.json
DATA=/var/lib/burn
UNIT=/etc/systemd/system/$APP.service
CTL=/usr/local/bin/burnctl
LOCK=/run/lock/burn-install.lock
MARK='# Managed by the Burn installer'

DRY=0; ASSUME_YES=0; NO_START=0; REINSTALL=0; DOWNGRADE=0
TARBALL=''; NEW_CONFIG=''; SVC_USER=''; NODE=''; KEEP=''
ARGS="$*"

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
die()  { printf 'Error: %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY" = 1 ]; then printf '  + %s\n' "$*"; else "$@"; fi; }

usage() {
    cat <<'EOF'
Usage: sudo bash install.sh [TARBALL] [options]

TARBALL       A burn-server-<version>.tar.gz file. Without it, the newest one in this
              script's folder (or else the current folder) is used.

Options:
  --config FILE      Use FILE as the server config. On a first install it becomes
                     /etc/burn/config.json; on an upgrade it replaces that file (the old one
                     goes into the backup). Its dataDir is set to /var/lib/burn.
  --user NAME        Run the service as NAME (default: burn, created as a system account).
                     First install only; upgrades keep the same account.
  --node PATH        The node program to use (default: the one saved by the last install,
                     else the one on PATH). Needs Node 20 or later.
  --keep N           How many old releases to keep besides the current one (default 2).
  --reinstall        Install even if this version is already the current one.
  --allow-downgrade  Install even if this version is older than the current one.
  --no-start         First install only: install and enable the service, but do not start it.
  --dry-run          Print each step and change nothing (works without root).
  -y, --yes          Do not ask before going on.
  -h, --help         Show this help.
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --config) [ $# -ge 2 ] || die "--config needs a file."; NEW_CONFIG=$2; shift 2 ;;
        --user) [ $# -ge 2 ] || die "--user needs a name."; SVC_USER=$2; shift 2 ;;
        --node) [ $# -ge 2 ] || die "--node needs a path."; NODE=$2; shift 2 ;;
        --keep) [ $# -ge 2 ] || die "--keep needs a number."; KEEP=$2; shift 2 ;;
        --reinstall) REINSTALL=1; shift ;;
        --allow-downgrade) DOWNGRADE=1; shift ;;
        --no-start) NO_START=1; shift ;;
        --dry-run) DRY=1; shift ;;
        -y|--yes) ASSUME_YES=1; shift ;;
        -h|--help) usage; exit 0 ;;
        -*) die "Unknown option $1 (see --help)." ;;
        *) [ -z "$TARBALL" ] || die "Give only one tarball."; TARBALL=$1; shift ;;
    esac
done

# =====================================================================================
# Checks. Nothing here changes the machine.
# =====================================================================================

[ "$(uname -s)" = Linux ] || die "This installer runs on Linux."
if [ "$DRY" = 0 ] && [ "$(id -u)" != 0 ]; then die "Run it as root: sudo bash $0 $ARGS"; fi
command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] \
    || die "systemd is not running here. This installer needs systemd to run the service."
for tool in tar gzip sha256sum flock install readlink sort awk; do
    command -v "$tool" >/dev/null 2>&1 || die "The command '$tool' is missing."
done
if [ -n "$KEEP" ]; then case "$KEEP" in *[!0-9]*) die "--keep needs a whole number." ;; esac; fi
if [ -n "$NEW_CONFIG" ]; then [ -f "$NEW_CONFIG" ] || die "No such config file: $NEW_CONFIG"; NEW_CONFIG=$(readlink -f "$NEW_CONFIG"); fi

# One install, upgrade or rollback at a time (burnctl takes the same lock).
if [ "$DRY" = 0 ]; then
    mkdir -p "$(dirname "$LOCK")"
    exec 9>"$LOCK"
    flock -n 9 || die "Another install, upgrade or rollback is running."
fi

# The tarball.
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
newest_tarball() {  # newest burn-server-*.tar.gz in a folder, by version
    ls -1 "$1" 2>/dev/null | grep -E '^burn-server-.+\.tar\.gz$' \
        | sed -E 's/^burn-server-(.+)\.tar\.gz$/\1/' | sort -V | tail -n 1 \
        | sed "s|^|$1/burn-server-|; s|\$|.tar.gz|"
}
if [ -z "$TARBALL" ]; then
    TARBALL=$(newest_tarball "$script_dir")
    [ -n "$TARBALL" ] || TARBALL=$(newest_tarball "$PWD")
    [ -n "$TARBALL" ] || die "No burn-server-*.tar.gz next to this script or in the current folder."
    say "Using $(basename "$TARBALL") (the newest release tarball found)."
fi
[ -f "$TARBALL" ] || die "No such file: $TARBALL"
TARBALL=$(readlink -f "$TARBALL")

if [ -f "$TARBALL.sha256" ]; then
    want=$(awk '{print $1; exit}' "$TARBALL.sha256")
    have=$(sha256sum "$TARBALL" | awk '{print $1}')
    [ "$want" = "$have" ] || die "Checksum mismatch for $(basename "$TARBALL"). The file may be damaged; copy it again."
    say "Checksum OK."
fi

# The release's description, read without unpacking.
R_TOP=$(tar -tzf "$TARBALL" 2>/dev/null | awk -F/ 'NR == 1 { print $1 }') || true
[ -n "$R_TOP" ] || die "$(basename "$TARBALL") is not a readable .tar.gz file."
release_info=$(tar -xzOf "$TARBALL" "$R_TOP/RELEASE" 2>/dev/null) \
    || die "$(basename "$TARBALL") is not a Burn server release (no RELEASE file)."
field() { printf '%s\n' "$release_info" | sed -n "s/^$1=//p" | head -n 1; }
R_NAME=$(field name); R_VERSION=$(field version); R_LAYOUT=$(field layout)
R_NODE_MIN=$(field node_min); R_ENGINE=$(field engine)
[ "$R_NAME" = burn-server ] || die "$(basename "$TARBALL") is not a Burn server release."
printf '%s' "$R_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$' \
    || die "The release has a bad version number: '$R_VERSION'."
case "$R_LAYOUT" in ''|*[!0-9]*) die "The release has a bad layout number." ;; esac
case "${R_NODE_MIN:-20}" in *[!0-9]*) die "The release has a bad node_min." ;; esac
[ "$R_LAYOUT" -le "$INSTALLER_LAYOUT" ] \
    || die "Release $R_VERSION needs install layout $R_LAYOUT; this installer knows up to $INSTALLER_LAYOUT. Use the install.sh that came with that release."
# (Listed into a variable first: "tar | grep -q" can fail under pipefail when grep stops early.)
tar_list=$(tar -tzf "$TARBALL") || die "$(basename "$TARBALL") cannot be read."
grep -qx "$R_TOP/_server/server.js" <<<"$tar_list" || die "The release is missing _server/server.js."

# What is installed now.
OLD_VERSION=''; OLD_PREVIOUS=''; FIRST=1
if [ -f "$LAYOUT_FILE" ]; then
    FIRST=0
    have_layout=$(cat "$LAYOUT_FILE")
    case "$have_layout" in ''|*[!0-9]*) die "$LAYOUT_FILE is damaged." ;; esac
    [ "$have_layout" -le "$INSTALLER_LAYOUT" ] \
        || die "This machine has install layout $have_layout, newer than this installer knows ($INSTALLER_LAYOUT). Use a newer install.sh."
    [ -L "$BASE/current" ] && OLD_VERSION=$(basename "$(readlink "$BASE/current")")
    [ -L "$BASE/previous" ] && OLD_PREVIOUS=$(basename "$(readlink "$BASE/previous")")
    [ -f "$STATE" ] || die "$STATE is missing; the install is damaged."
    # shellcheck disable=SC1090
    . "$STATE"
    if [ -n "$SVC_USER" ] && [ "$SVC_USER" != "$STATE_USER" ]; then
        warn "--user is ignored on an upgrade; the service keeps running as $STATE_USER."
    fi
    SVC_USER=$STATE_USER
    [ -n "$NODE" ] || NODE=$STATE_NODE
    [ -n "$KEEP" ] || KEEP=$STATE_KEEP
elif [ -e "$BASE" ] && [ -n "$(ls -A "$BASE" 2>/dev/null | grep -vx backups)" ]; then
    # (A folder holding only backups/ is what "burnctl uninstall" leaves; that is fine.)
    die "$BASE already exists and was not made by this installer. Move it away first."
fi
if [ -f "$UNIT" ] && ! grep -qF "$MARK" "$UNIT"; then
    die "$UNIT exists and was not made by this installer. Remove or rename it first."
fi
SVC_USER=${SVC_USER:-burn}
KEEP=${KEEP:-2}
printf '%s' "$SVC_USER" | grep -Eq '^[a-z_][a-z0-9_-]{0,31}$' || die "Bad user name '$SVC_USER'."

ver_lt() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1)" = "$1" ]; }
if [ -n "$OLD_VERSION" ]; then
    if [ "$OLD_VERSION" = "$R_VERSION" ] && [ "$REINSTALL" = 0 ]; then
        say "burn-server $R_VERSION is already installed and current. Nothing to do."
        say "(Use --reinstall to install it again, or 'burnctl status' to check on it.)"
        exit 0
    fi
    if ver_lt "$R_VERSION" "$OLD_VERSION" && [ "$DOWNGRADE" = 0 ]; then
        die "$R_VERSION is older than the installed $OLD_VERSION. Use 'sudo burnctl rollback' to go back, or --allow-downgrade."
    fi
fi

# Node.
if [ -n "$NODE" ] && [ ! -x "$NODE" ]; then
    warn "$NODE is gone; looking for node on PATH."
    NODE=''
fi
[ -n "$NODE" ] || NODE=$(command -v node || true)
[ -n "$NODE" ] || die "Node.js was not found. Install Node ${R_NODE_MIN:-20} or later, or pass --node /path/to/node.
  On Ubuntu 24.04 the 'nodejs' package is too old (18); use the Node.js project's packages
  (NodeSource) or a Node.js tarball. On Ubuntu 25.04 and later, 'sudo apt install nodejs' is enough."
NODE=$(readlink -f "$NODE")
node_ver=$("$NODE" -p 'process.versions.node' 2>/dev/null) || die "$NODE does not run."
[ "${node_ver%%.*}" -ge "${R_NODE_MIN:-20}" ] \
    || die "$NODE is Node $node_ver; release $R_VERSION needs ${R_NODE_MIN:-20} or later. Install a newer Node or pass --node."

if id -u "$SVC_USER" >/dev/null 2>&1; then SVC_GROUP=$(id -gn "$SVC_USER"); else SVC_GROUP=$SVC_USER; fi

# =====================================================================================
# The plan
# =====================================================================================

step "Plan"
if [ "$FIRST" = 1 ]; then say "First install of burn-server $R_VERSION (engine $R_ENGINE)."
elif [ "$OLD_VERSION" = "$R_VERSION" ]; then say "Reinstall of burn-server $R_VERSION."
else say "Upgrade of burn-server from ${OLD_VERSION:-an unknown version} to $R_VERSION (engine $R_ENGINE)."
fi
say "  service user: $SVC_USER"
say "  node:         $NODE (Node $node_ver)"
say "  release:      $RELEASES/$R_VERSION"
if [ -n "$NEW_CONFIG" ]; then say "  config:       $CONFIG, replaced by $NEW_CONFIG"
elif [ -f "$CONFIG" ]; then say "  config:       $CONFIG, kept"
else say "  config:       $CONFIG, made from the example"
fi
say "  data:         $DATA"
say "  keep:         $KEEP old releases"
[ "$DRY" = 1 ] && say "Dry run: the steps below are printed, not done."
if [ "$DRY" = 0 ] && [ "$ASSUME_YES" = 0 ] && [ -t 0 ]; then
    printf 'Go on? [y/N] '
    read -r answer
    case "$answer" in y|Y|yes|YES) ;; *) say "Stopped. Nothing was changed."; exit 1 ;; esac
fi

# =====================================================================================
# Helpers that change things
# =====================================================================================

as_user() {
    if command -v runuser >/dev/null 2>&1; then runuser -u "$SVC_USER" -- "$@"
    else su -s /bin/sh "$SVC_USER" -c "$(printf '%q ' "$@")"; fi
}

write_file() {  # write_file PATH MODE OWNER < content
    local path=$1 mode=$2 owner=$3 tmp
    if [ "$DRY" = 1 ]; then printf '  + write %s (mode %s, owner %s)\n' "$path" "$mode" "$owner"; cat >/dev/null; return; fi
    tmp=$(mktemp "$path.XXXXXX")
    cat >"$tmp"
    chmod "$mode" "$tmp"; chown "$owner" "$tmp"
    mv -f "$tmp" "$path"
}

set_link() {  # set_link NAME TARGET, replaced in one step
    run ln -sfn "$2" "$1.new"
    run mv -Tf "$1.new" "$1"
}

write_unit() {
    write_file "$UNIT" 644 root:root <<EOF
$MARK (install.sh). It is rewritten on every install or upgrade.
# Put local changes in a drop-in instead: sudo systemctl edit $APP
[Unit]
Description=Burn relative motion game server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_GROUP
WorkingDirectory=$BASE/current/_server
ExecStart=$NODE $BASE/current/_server/server.js --config $CONFIG
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=5
TimeoutStopSec=10
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
ReadWritePaths=$DATA_DIR
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
MemoryMax=256M
CPUQuota=50%
TasksMax=64

[Install]
WantedBy=multi-user.target
EOF
}

# =====================================================================================
# Rollback (runs on its own if an upgrade fails after the backup)
# =====================================================================================

UNPACK_TMP=''; CANDIDATE=''; ROLLBACK_READY=0; SWITCHED=0; BACKUP=''; WAS_ACTIVE=0

rollback() {
    systemctl stop "$APP" 2>/dev/null || true
    if [ -n "$BACKUP" ] && [ -f "$BACKUP" ]; then
        # Set the possibly migrated data aside, then put back the config and data as they were.
        rm -rf "$DATA.failed-$R_VERSION"
        [ -d "$DATA" ] && mv -T "$DATA" "$DATA.failed-$R_VERSION"
        tar -xzf "$BACKUP" -C /
        say "Restored the config and data from $BACKUP (the data the failed upgrade touched is in $DATA.failed-$R_VERSION)." >&2
    fi
    if [ "$SWITCHED" = 1 ]; then
        if [ "$OLD_VERSION" = "$R_VERSION" ] && [ -d "$RELEASES/.replaced-$R_VERSION" ]; then
            rm -rf "$RELEASES/.failed-$R_VERSION"
            mv -T "$RELEASES/$R_VERSION" "$RELEASES/.failed-$R_VERSION"
            mv -T "$RELEASES/.replaced-$R_VERSION" "$RELEASES/$R_VERSION"
        fi
        ln -sfn "releases/$OLD_VERSION" "$BASE/current.new" && mv -Tf "$BASE/current.new" "$BASE/current"
        if [ -n "$OLD_PREVIOUS" ]; then
            ln -sfn "releases/$OLD_PREVIOUS" "$BASE/previous.new" && mv -Tf "$BASE/previous.new" "$BASE/previous"
        else
            rm -f "$BASE/previous"
        fi
        install -m 755 -o root -g root "$BASE/current/_server/deploy/burnctl" "$CTL" 2>/dev/null || true
    fi
    [ -f "$UNIT.bak" ] && mv -f "$UNIT.bak" "$UNIT"
    systemctl daemon-reload
    if [ "$WAS_ACTIVE" = 1 ]; then
        systemctl reset-failed "$APP" 2>/dev/null || true
        systemctl start "$APP" || true
        if "$NODE" "$BASE/current/_server/tools/health.js" --config "$CONFIG" --wait 20 >&2; then
            say "Back on $OLD_VERSION, and it is healthy." >&2
        else
            say "Back on $OLD_VERSION, but it is not healthy either. See: burnctl logs" >&2
        fi
    else
        say "Back on $OLD_VERSION. It was stopped before the upgrade, so it stays stopped." >&2
    fi
}

cleanup() {
    local code=$?
    [ -n "$UNPACK_TMP" ] && rm -rf "$UNPACK_TMP"
    [ -n "$CANDIDATE" ] && rm -f "$CANDIDATE"
    if [ "$code" != 0 ] && [ "$ROLLBACK_READY" = 1 ]; then
        ROLLBACK_READY=0
        printf '\n== The upgrade failed; going back to %s\n' "$OLD_VERSION" >&2
        rollback || printf 'Error: the rollback failed too. See: journalctl -u %s\n' "$APP" >&2
    fi
    exit "$code"
}
trap cleanup EXIT

# =====================================================================================
# Install
# =====================================================================================

step "Service account"
if id -u "$SVC_USER" >/dev/null 2>&1; then
    say "Account $SVC_USER exists."
else
    run useradd --system --user-group --no-create-home --home-dir /nonexistent \
        --shell "$(command -v nologin || echo /usr/sbin/nologin)" "$SVC_USER"
fi

step "Folders"
run install -d -m 755 -o root -g root "$BASE" "$RELEASES"
run install -d -m 700 -o root -g root "$BACKUPS"
run install -d -m 750 -o root -g "$SVC_GROUP" "$ETC"
run install -d -m 750 -o "$SVC_USER" -g "$SVC_GROUP" "$DATA"

step "Unpack $R_VERSION"
NEW=$RELEASES/$R_VERSION
if [ "$DRY" = 1 ]; then
    say "  + unpack $(basename "$TARBALL") into $NEW"
else
    UNPACK_TMP=$(mktemp -d "$RELEASES/.unpack-XXXXXX")
    tar -xzf "$TARBALL" -C "$UNPACK_TMP" --no-same-owner --no-same-permissions
    [ -f "$UNPACK_TMP/$R_TOP/_server/server.js" ] || die "Unpacking did not give $R_TOP/_server/server.js."
    chown -R root:root "$UNPACK_TMP/$R_TOP"
    chmod -R u=rwX,go=rX "$UNPACK_TMP/$R_TOP"
    chmod 755 "$UNPACK_TMP/$R_TOP/_server/deploy/install.sh" "$UNPACK_TMP/$R_TOP/_server/deploy/burnctl"
    if [ -d "$NEW" ]; then
        if [ "$OLD_VERSION" = "$R_VERSION" ]; then
            rm -rf "$RELEASES/.replaced-$R_VERSION"
            mv -T "$NEW" "$RELEASES/.replaced-$R_VERSION"   # kept until the reinstall succeeds
        else
            rm -rf "$NEW"
        fi
    fi
    mv -T "$UNPACK_TMP/$R_TOP" "$NEW"
    rm -rf "$UNPACK_TMP"; UNPACK_TMP=''
    say "Unpacked into $NEW."
fi
# Where to run the new release's tools from (in a dry run, the current release stands in).
TOOLS=$NEW
if [ "$DRY" = 1 ]; then TOOLS=$BASE/current; [ -d "$TOOLS" ] || TOOLS=''; fi

step "Config"
config_from_example=0
USE_CONFIG=$CONFIG
src=''
if [ -n "$NEW_CONFIG" ]; then src=$NEW_CONFIG
elif [ ! -f "$CONFIG" ]; then src=$NEW/_server/config.example.json; config_from_example=1
fi
if [ -n "$src" ]; then
    # A candidate copy with dataDir set to $DATA. It replaces the live config only after the
    # backup, so a failed check leaves the running server exactly as it was.
    if [ "$DRY" = 1 ]; then
        say "  + copy $( [ "$config_from_example" = 1 ] && echo config.example.json || echo "$src") to $CONFIG, with dataDir $DATA"
    else
        CANDIDATE=$ETC/config.json.new
        "$NODE" -e '
            const fs = require("fs");
            const [src, dataDir] = process.argv.slice(1);
            let c;
            try { c = JSON.parse(fs.readFileSync(src, "utf8")); }
            catch (e) { console.error(src + " is not valid JSON (" + e.message + ")."); process.exit(1); }
            c.dataDir = dataDir;
            process.stdout.write(JSON.stringify(c, null, 2) + "\n");
        ' "$src" "$DATA" | write_file "$CANDIDATE" 640 "root:$SVC_GROUP"
        USE_CONFIG=$CANDIDATE
    fi
else
    say "Keeping $CONFIG."
fi

DATA_DIR=$DATA
if [ -n "$TOOLS" ] && [ -f "$USE_CONFIG" ]; then
    info=$("$NODE" "$TOOLS/_server/tools/config-info.js" --config "$USE_CONFIG") \
        || die "The config is not valid for release $R_VERSION (see above). Fix it and run this again. Nothing running has changed."
    eval "$info"
fi
case "$DATA_DIR" in
    "$BASE"|"$BASE"/*) die "The config's dataDir ($DATA_DIR) is inside $BASE, where upgrades would lose it. Set it to $DATA." ;;
esac
if [ "$DATA_DIR" != "$DATA" ]; then
    warn "The config's dataDir is $DATA_DIR, not $DATA. It is used, but backups cover only $DATA."
    run install -d -m 750 -o "$SVC_USER" -g "$SVC_GROUP" "$DATA_DIR"
fi
if [ "$DRY" = 0 ]; then
    if ! check_out=$(as_user "$NODE" "$NEW/_server/server.js" --config "$USE_CONFIG" --check 2>&1); then
        printf '%s\n' "$check_out" >&2
        die "The config does not pass the check when read as $SVC_USER (see above). Nothing running has changed."
    fi
    say "Config check passed."
fi

systemctl is-active --quiet "$APP" 2>/dev/null && WAS_ACTIVE=1

if [ "$FIRST" = 0 ]; then
    step "Backup"
    BACKUP=$BACKUPS/$(date -u +%Y%m%dT%H%M%SZ)-upgrade-from-${OLD_VERSION:-unknown}-to-$R_VERSION.tar.gz
    [ "$WAS_ACTIVE" = 1 ] && run systemctl stop "$APP"
    bk_items=("${ETC#/}/config.json")
    [ -d "$DATA" ] && bk_items+=("${DATA#/}")
    if [ "$DRY" = 1 ]; then
        say "  + save ${bk_items[*]} to $BACKUP"
    else
        [ -f "$CONFIG" ] || bk_items=("${bk_items[@]:1}")
        (umask 077; tar -czf "$BACKUP" -C / "${bk_items[@]}")
        [ -f "$UNIT" ] && cp -p "$UNIT" "$UNIT.bak"
        ROLLBACK_READY=1
        say "Saved the config and data to $BACKUP."
    fi
fi

if [ -n "$CANDIDATE" ]; then
    run mv -f "$CANDIDATE" "$CONFIG"
    CANDIDATE=''
    say "Installed the new config as $CONFIG."
fi

step "Migrate"
if [ "$DRY" = 1 ]; then
    say "  + node $NEW/_server/tools/migrate.js --config $CONFIG --data $DATA_DIR --from ${OLD_VERSION:-none} --to $R_VERSION"
else
    "$NODE" "$NEW/_server/tools/migrate.js" --config "$CONFIG" --data "$DATA_DIR" --from "${OLD_VERSION:-none}" --to "$R_VERSION"
    chown -R "$SVC_USER:$SVC_GROUP" "$DATA_DIR"
fi

step "Switch to $R_VERSION"
if [ -n "$OLD_VERSION" ] && [ "$OLD_VERSION" != "$R_VERSION" ]; then
    set_link "$BASE/previous" "releases/$OLD_VERSION"
fi
SWITCHED=1
set_link "$BASE/current" "releases/$R_VERSION"
printf '%s\n' "$INSTALLER_LAYOUT" | write_file "$LAYOUT_FILE" 644 root:root
write_file "$STATE" 644 root:root <<EOF
# Written by the Burn installer; burnctl and later installs read it.
STATE_USER=$SVC_USER
STATE_NODE=$NODE
STATE_KEEP=$KEEP
STATE_INSTALLED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
write_unit
run install -m 755 -o root -g root "$NEW/_server/deploy/burnctl" "$CTL"
run systemctl daemon-reload
run systemctl enable --quiet "$APP"

step "Start"
started=0
if [ "$FIRST" = 1 ] && [ "$NO_START" = 1 ]; then
    say "Not started (--no-start). Start it with: sudo burnctl start"
elif [ "$FIRST" = 0 ] && [ "$WAS_ACTIVE" = 0 ]; then
    say "The service was stopped before the upgrade, so it stays stopped. Start it with: sudo burnctl start"
else
    # (reset-failed: quick stops and starts can trip systemd's start limit)
    run systemctl reset-failed "$APP" 2>/dev/null || true
    run systemctl restart "$APP"
    started=1
fi
if [ "$started" = 1 ] && [ "$DRY" = 0 ]; then
    if ! "$NODE" "$NEW/_server/tools/health.js" --config "$CONFIG" --wait 20; then
        journalctl -u "$APP" -n 20 --no-pager >&2 || true
        [ "$ROLLBACK_READY" = 1 ] && die "Release $R_VERSION did not pass its health check."
        die "The server did not pass its health check. It is installed; fix the problem above, then: sudo burnctl restart"
    fi
fi
ROLLBACK_READY=0
[ "$DRY" = 1 ] || rm -f "$UNIT.bak"

step "Tidy up"
if [ "$DRY" = 0 ]; then rm -rf "$RELEASES"/.replaced-* "$RELEASES"/.unpack-*; fi
# Keep the current release, the previous one, and the newest others up to $KEEP old ones in all.
prev=''; [ -L "$BASE/previous" ] && prev=$(basename "$(readlink "$BASE/previous")")
others=$(ls -1 "$RELEASES" 2>/dev/null | grep -v '^\.' | grep -vxF "$R_VERSION" | grep -vxF "${prev:-/}" | sort -V -r || true)
room=$KEEP; [ -n "$prev" ] && room=$(( KEEP > 0 ? KEEP - 1 : 0 ))
n=0
for v in $others; do
    n=$((n + 1))
    if [ "$n" -gt "$room" ]; then run rm -rf "${RELEASES:?}/$v"; say "Removed old release $v."; fi
done
# Keep the newest 10 backups.
{ ls -1t "$BACKUPS"/*.tar.gz 2>/dev/null || true; } | tail -n +11 | while read -r f; do run rm -f "$f"; done

step "Done"
if [ "$DRY" = 1 ]; then say "Dry run finished. Nothing was changed."; exit 0; fi
say "burn-server $R_VERSION is installed. Manage it with: burnctl help"
if [ "$FIRST" = 1 ]; then
    cat <<EOF

Still to do (this installer does not touch these):
  1. The config: sudo burnctl config edit
     Set publicDomain, publicPort and allowedOrigins. Then: sudo burnctl restart
  2. TLS. In "proxy" mode (the default), add a site to the Caddy or nginx on this machine;
     "burnctl proxy caddy" or "burnctl proxy nginx" prints the block. Then reload that proxy.
  3. The firewall: allow TCP on the public port (and TCP 80 if Caddy gets the certificate).
     A cloud machine needs the rule in the provider's network settings too.
  4. From another machine, https://<publicDomain>/health should answer "ok".
EOF
    [ "$config_from_example" = 1 ] && say "" && say "The config was made from the example, so it still names burn.example.com."
fi
exit 0
