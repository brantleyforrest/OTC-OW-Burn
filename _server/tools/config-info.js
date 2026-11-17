// Prints the parts of a config that the install and management scripts need, as shell-safe
// KEY=value lines. Never prints the API token or anything else secret.
// Usage: node tools/config-info.js --config <file>
'use strict';

const { load, configPathFromArgs, ConfigError } = require('../config');

try {
    const cfg = load(configPathFromArgs());
    const loopback = h => (h === '0.0.0.0' ? '127.0.0.1' : h === '::' ? '::1' : h);
    const hostPart = h => (h.includes(':') ? `[${h}]` : h);
    const files = cfg.tls.mode === 'files';
    const healthUrl = files
        ? `https://127.0.0.1:${cfg.publicPort}/health`
        : `http://${hostPart(loopback(cfg.listen.host))}:${cfg.listen.port}/health`;
    const out = {
        TLS_MODE: cfg.tls.mode,
        PUBLIC_DOMAIN: cfg.publicDomain,
        PUBLIC_PORT: cfg.publicPort,
        LISTEN_HOST: cfg.listen.host,
        LISTEN_PORT: cfg.listen.port,
        DATA_DIR: cfg.dataDir,
        HEALTH_URL: healthUrl,
        CLOUDFLARE: cfg.cloudflare.enabled ? 'on' : 'off'
    };
    const q = v => `'${String(v).replace(/'/g, `'\\''`)}'`;
    for (const [k, v] of Object.entries(out)) console.log(`${k}=${q(v)}`);
} catch (e) {
    console.error(e instanceof ConfigError ? e.message : `Config error: ${e.message}`);
    process.exit(1);
}
