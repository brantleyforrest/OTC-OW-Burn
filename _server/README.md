# Burn server

A small Node WebSocket server for Burn's room play and leaderboard. Solo play does not need it.

Built so far: config loading and checking, `GET /health`, the origin check, and the WebSocket `hello`. Rooms, races, duels, the leaderboard and the DNS updater come in later stages.

## Running it locally

```bash
cd _server
npm ci
npm test
node server.js --config config.dev.json      # ws://localhost:8787/ws, http://localhost:8787/health
```

## Making a release

```bash
bash _server/tools/make-release.sh
```

This runs the tests, then writes three files to `_server/dist/`:

- `burn-server-<version>.tar.gz`
- its `.sha256`
- `install.sh`

The version comes from `"version"` in `_server/package.json`; raise it for every release. The tarball includes the production packages, so the host needs Node but not npm or network access. It never includes `secrets/`, `data/`, `test/` or `config.dev.json`.

## Installing on Ubuntu

What the host needs:

- **systemd**
- **Node 20 or later.** Ubuntu 25.04 and later can use `sudo apt install nodejs`. On Ubuntu 24.04 that package is Node 18, which is too old: use the Node.js project's packages or a Node.js tarball, and pass `--node /path/to/node` if it is not on `PATH`.

Copy the three files from `_server/dist/` into one folder on the host, then run:

```bash
sudo bash install.sh
```

The script finds the newest tarball beside it, checks its checksum, shows its plan, and asks before going on. Useful options:

- `--dry-run` prints every step without changing anything, and runs without root.
- `--config FILE` installs your own config.
- `--yes` skips the question.
- `bash install.sh --help` lists every option.

It manages only this server. It never installs packages, changes a firewall, or edits a reverse proxy.

What it sets up:

| Path | What |
|---|---|
| `/opt/burn/releases/<version>/` | Each installed release |
| `/opt/burn/current`, `/opt/burn/previous` | Links to the running release and the one before it |
| `/opt/burn/backups/` | Config and data backups, one per upgrade (the newest 10 are kept) |
| `/etc/burn/config.json` | The config. It belongs to you; an upgrade replaces it only if you pass `--config`. |
| `/var/lib/burn/` | Data |
| `/etc/systemd/system/burn.service` | The service. It runs as the `burn` system account, with memory capped at 256 MB and CPU at half a core. |
| `/usr/local/bin/burnctl` | The management command |

After the first install:

1. **Config.** Run `sudo burnctl config edit`, set `publicDomain`, `publicPort` and `allowedOrigins`, then `sudo burnctl restart`. The editor checks the file before saving it. Never commit a real config; on the development machine it lives in `_server/secrets/`, which git ignores.
2. **TLS.** Pick one:
   - **The machine already runs Caddy or nginx.** Add the block that `burnctl proxy caddy` or `burnctl proxy nginx` prints, then reload that proxy.
   - **Nothing uses ports 80 and 443.** Install Caddy 2 and use the Caddy block; Caddy gets and renews the certificate.
   - **Otherwise.** Set `tls.mode` to `files` with readable certificate paths and pick a `publicPort`; Node then serves TLS itself.
3. **Firewall.** Allow TCP on the public port, and TCP 80 if Caddy gets the certificate. A cloud machine also needs the rule in the provider's network settings. Add rules; do not replace the existing ones.
4. **DNS.** Point an A record at the machine, or set the `cloudflare` fields once the DNS updater exists. If you set `cloudflare.proxied` to true, only Cloudflare's HTTPS ports work: 443, 2053, 2083, 2087, 2096 and 8443.
5. **Check.** `https://<publicDomain>/health` should answer `ok`.

## Upgrading

Put the new `burn-server-<version>.tar.gz` and its `install.sh` on the host, and run `sudo bash install.sh` again. An upgrade runs in this order:

1. Check the new release against the current config. If the check fails, it stops here and nothing changes.
2. Stop the service and back up the config and data.
3. Migrate the data.
4. Switch the `current` link and start the service.
5. Wait up to 20 seconds for `/health`.

If anything after the backup fails, the script puts the backup and the old release back on its own and starts the old release again.

The script also refuses some installs:

- Installing the current version again does nothing unless you pass `--reinstall`.
- An older version needs `--allow-downgrade`.
- A release built for a newer install layout needs the `install.sh` that came with it.

## Managing it

Run `burnctl help` for the full list. Commands that change something need `sudo`.

| Command | What it does |
|---|---|
| `burnctl status` | State, memory, versions, public address, and health |
| `burnctl logs [-f] [N]` | Recent log lines |
| `sudo burnctl start`, `stop`, `restart` | Start, stop or restart the service; start and restart wait for health |
| `sudo burnctl rollback` | Go back to the previous release, or name a version. Running it again goes forward again. |
| `sudo burnctl rollback --restore-data` | Also restore the config and data from the backup taken when you upgraded away from that release. Use it when the newer release changed the data format. |
| `burnctl releases`, `sudo burnctl prune [--keep N]` | List installed releases, or remove old ones |
| `sudo burnctl config edit` | Edit the config; it is checked before saving |
| `sudo burnctl config check` | Check the config |
| `burnctl proxy caddy` or `nginx` | Print the reverse-proxy block for this config |
| `sudo burnctl backup` | Save the config and data now |
| `burnctl backups` | List backups |
| `sudo burnctl restore FILE` | Put back the config and data from a backup |
| `sudo burnctl uninstall [--purge]` | Remove the service. The config, data and backups stay unless you add `--purge`. |

## Rules for later releases

These rules keep upgrades working:

- **Install layout.** It is `INSTALLER_LAYOUT` in `deploy/install.sh` and `layout` in the release's `RELEASE` file, and it is 1 now. Change it only if the paths above change. A later `install.sh` must still upgrade every layout from 1 on.
- **New config fields** get a default in `config.js`, so old config files stay valid.
- **Data format changes** add 1 to `DATA_SCHEMA` and add a step in `tools/migrate.js`. A release refuses data newer than it knows; that refusal is what makes a downgrade roll back safely.
- **Shell scripts** keep LF line endings; `.gitattributes` enforces this.
