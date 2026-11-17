// Asks the running server for GET /health until it answers "ok" or the time runs out.
// Usage: node tools/health.js --config <file> [--wait <seconds>]
// Exit code 0: healthy. 1: not healthy (the reason is printed). 2: bad config.
'use strict';

const http = require('http');
const https = require('https');
const { load, configPathFromArgs, ConfigError } = require('../config');

// In "files" mode the server's certificate names the public domain, not 127.0.0.1, so this one
// loopback request skips the name check. Nothing leaves the machine.
function once(url, secure) {
    return new Promise(resolve => {
        const lib = secure ? https : http;
        const req = lib.get(url, secure ? { timeout: 3000, rejectUnauthorized: false } : { timeout: 3000 }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', c => { body += c; });
            res.on('end', () => resolve(res.statusCode === 200 && body.trim() === 'ok' ? null : `HTTP ${res.statusCode}`));
        });
        req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
        req.on('error', e => resolve(e.code || e.message));
    });
}

(async () => {
    let cfg;
    try { cfg = load(configPathFromArgs()); } catch (e) {
        console.error(e instanceof ConfigError ? e.message : `Config error: ${e.message}`);
        process.exit(2);
    }
    const argv = process.argv.slice(2);
    const w = argv.indexOf('--wait');
    const waitSec = w >= 0 ? Math.max(0, Number(argv[w + 1]) || 0) : 0;

    const loopback = h => (h === '0.0.0.0' ? '127.0.0.1' : h === '::' ? '::1' : h);
    const hostPart = h => (h.includes(':') ? `[${h}]` : h);
    const secure = cfg.tls.mode === 'files';
    const url = secure
        ? `https://127.0.0.1:${cfg.publicPort}/health`
        : `http://${hostPart(loopback(cfg.listen.host))}:${cfg.listen.port}/health`;

    const until = Date.now() + waitSec * 1000;
    let why;
    for (;;) {
        why = await once(url, secure);
        if (!why) { console.log(`healthy (${url})`); process.exit(0); }
        if (Date.now() >= until) break;
        await new Promise(r => setTimeout(r, 1000));
    }
    console.log(`not healthy: ${why} (${url})`);
    process.exit(1);
})();
