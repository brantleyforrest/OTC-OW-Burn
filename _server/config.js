// Burn server: loads and validates the config file. Never prints the config.
// Which file: the --config <path> argument, else $BURN_CONFIG, else secrets/config.json.
'use strict';

const fs = require('fs');
const path = require('path');

const SERVER_DIR = __dirname;
const DEFAULT_PATH = path.join(SERVER_DIR, 'secrets', 'config.json');

class ConfigError extends Error {}

function configPathFromArgs(argv = process.argv.slice(2), env = process.env) {
    const i = argv.indexOf('--config');
    if (i >= 0) {
        if (!argv[i + 1]) throw new ConfigError('--config needs a file path.');
        return path.resolve(argv[i + 1]);
    }
    if (env.BURN_CONFIG) return path.resolve(env.BURN_CONFIG);
    return DEFAULT_PATH;
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isStr = v => typeof v === 'string';
const DOMAIN = /^(localhost|[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+)$/i;
const ORIGIN = /^https?:\/\/[^\s/]+$/;

// Returns a new, fully checked config. Throws ConfigError naming the bad field.
function validate(raw, baseDir = SERVER_DIR) {
    const bad = (field, why) => { throw new ConfigError(`Config field "${field}" ${why}`); };
    if (!isObj(raw)) bad('(top level)', 'must be a JSON object.');

    const known = ['publicDomain', 'publicPort', 'listen', 'tls', 'allowedOrigins', 'allowLocalOrigins',
        'dataDir', 'limits', 'cloudflare'];
    for (const k of Object.keys(raw)) if (!known.includes(k)) bad(k, 'is not a known field.');

    if (!isStr(raw.publicDomain) || !DOMAIN.test(raw.publicDomain)) bad('publicDomain', 'must be a host name such as burn.example.com.');
    if (!isInt(raw.publicPort, 1, 65535)) bad('publicPort', 'must be a whole number from 1 to 65535.');

    if (!isObj(raw.listen)) bad('listen', 'must be an object with host and port.');
    if (!isStr(raw.listen.host) || !raw.listen.host) bad('listen.host', 'must be an address such as 127.0.0.1.');
    if (!isInt(raw.listen.port, 0, 65535)) bad('listen.port', 'must be a whole number from 0 to 65535.');

    if (!isObj(raw.tls)) bad('tls', 'must be an object with mode, certFile and keyFile.');
    if (!['proxy', 'files', 'none'].includes(raw.tls.mode)) bad('tls.mode', 'must be "proxy", "files" or "none".');
    const certFile = raw.tls.certFile ?? '';
    const keyFile = raw.tls.keyFile ?? '';
    if (!isStr(certFile)) bad('tls.certFile', 'must be a file path or "".');
    if (!isStr(keyFile)) bad('tls.keyFile', 'must be a file path or "".');
    if (raw.tls.mode === 'files') {
        if (!certFile) bad('tls.certFile', 'is needed when tls.mode is "files".');
        if (!keyFile) bad('tls.keyFile', 'is needed when tls.mode is "files".');
    }

    if (!Array.isArray(raw.allowedOrigins)) bad('allowedOrigins', 'must be a list of origins.');
    raw.allowedOrigins.forEach((o, i) => {
        if (!isStr(o) || !ORIGIN.test(o)) bad(`allowedOrigins[${i}]`, 'must look like https://example.com (no path, no trailing slash).');
    });
    if (typeof raw.allowLocalOrigins !== 'boolean') bad('allowLocalOrigins', 'must be true or false.');

    if (!isStr(raw.dataDir) || !raw.dataDir) bad('dataDir', 'must be a folder path.');

    const limitsDefault = { maxRooms: 200, maxPlayersPerRoom: 40, maxSocketsPerAddress: 80, messagesPerSecond: 10 };
    const limits = { ...limitsDefault };
    if (raw.limits !== undefined) {
        if (!isObj(raw.limits)) bad('limits', 'must be an object.');
        for (const [k, v] of Object.entries(raw.limits)) {
            if (!(k in limitsDefault)) bad(`limits.${k}`, 'is not a known field.');
            if (!isInt(v, 1, 100000)) bad(`limits.${k}`, 'must be a whole number from 1 to 100000.');
            limits[k] = v;
        }
    }

    const cfDefault = { enabled: false, apiToken: '', zoneId: '', recordName: raw.publicDomain, proxied: false, ttl: 60, checkEverySeconds: 300 };
    const cloudflare = { ...cfDefault };
    if (raw.cloudflare !== undefined) {
        const cf = raw.cloudflare;
        if (!isObj(cf)) bad('cloudflare', 'must be an object.');
        for (const k of Object.keys(cf)) if (!(k in cfDefault)) bad(`cloudflare.${k}`, 'is not a known field.');
        Object.assign(cloudflare, cf);
        if (typeof cloudflare.enabled !== 'boolean') bad('cloudflare.enabled', 'must be true or false.');
        if (typeof cloudflare.proxied !== 'boolean') bad('cloudflare.proxied', 'must be true or false.');
        for (const k of ['apiToken', 'zoneId', 'recordName']) if (!isStr(cloudflare[k])) bad(`cloudflare.${k}`, 'must be text.');
        if (!(cloudflare.ttl === 1 || isInt(cloudflare.ttl, 60, 86400))) bad('cloudflare.ttl', 'must be 1 (automatic) or 60 to 86400.');
        if (!isInt(cloudflare.checkEverySeconds, 30, 86400)) bad('cloudflare.checkEverySeconds', 'must be 30 to 86400.');
        if (cloudflare.enabled) {
            if (!cloudflare.apiToken) bad('cloudflare.apiToken', 'is needed when cloudflare.enabled is true.');
            if (!/^[0-9a-f]{32}$/i.test(cloudflare.zoneId)) bad('cloudflare.zoneId', 'must be the 32-character zone id.');
            if (!DOMAIN.test(cloudflare.recordName || '')) bad('cloudflare.recordName', 'must be a host name.');
        }
        if (!cloudflare.recordName) cloudflare.recordName = raw.publicDomain;
    }

    const resolve = p => (path.isAbsolute(p) ? p : path.resolve(baseDir, p));
    return {
        publicDomain: raw.publicDomain,
        publicPort: raw.publicPort,
        listen: { host: raw.listen.host, port: raw.listen.port },
        tls: { mode: raw.tls.mode, certFile: certFile && resolve(certFile), keyFile: keyFile && resolve(keyFile) },
        allowedOrigins: raw.allowedOrigins.slice(),
        allowLocalOrigins: raw.allowLocalOrigins,
        dataDir: resolve(raw.dataDir),
        limits,
        cloudflare
    };
}

// Reads and validates. Throws ConfigError with a one-line, owner-facing message.
function load(file) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (e) {
        if (e.code === 'ENOENT') {
            throw new ConfigError(`No config file at ${file}. Copy config.example.json to secrets/config.json and fill it in, or pass --config <path>.`);
        }
        throw new ConfigError(`Cannot read the config file at ${file} (${e.code || e.message}).`);
    }
    let raw;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        throw new ConfigError(`The config file at ${file} is not valid JSON (${e.message}).`);
    }
    return validate(raw);
}

module.exports = { load, validate, configPathFromArgs, ConfigError, SERVER_DIR, DEFAULT_PATH };
