// Burn server: HTTP(S) server, WebSocket upgrade, and wiring.
// Built so far: config loading (--check validates and exits), GET /health, the origin check,
// the WebSocket upgrade on /ws with the `hello` message and `ping`/`pong`, TLS from files with
// hourly reloading, and a clean exit on SIGTERM. Rooms, the leaderboard and DDNS come in stages
// G4 and G5; until then every other message gets an error.
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const { load, configPathFromArgs, ConfigError } = require('./config');
const BurnCore = require('../burn/burn-core.js');
const BurnScenarios = require('../burn/burn-scenarios.js');
const pkg = require('./package.json');

const log = (...a) => console.log(new Date().toISOString(), ...a);

function isAllowedOrigin(cfg, origin) {
    if (origin && cfg.allowedOrigins.includes(origin)) return true;
    if (!cfg.allowLocalOrigins) return false;
    if (origin === undefined || origin === 'null') return true;
    return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function start(cfg) {
    const { WebSocketServer } = require('ws');
    const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
    const scenarioIds = BurnScenarios.list.map(s => s.id);

    const onRequest = (req, res) => {
        const url = (req.url || '/').split('?')[0];
        if (req.method === 'GET' && url === '/health') {
            res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
            res.end('ok');
            return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
    };

    let server;
    let tlsTimer = null;
    if (cfg.tls.mode === 'files') {
        const readTls = () => ({ cert: fs.readFileSync(cfg.tls.certFile), key: fs.readFileSync(cfg.tls.keyFile) });
        const mtimes = () => [cfg.tls.certFile, cfg.tls.keyFile].map(f => fs.statSync(f).mtimeMs).join(':');
        server = https.createServer(readTls(), onRequest);
        let seen = mtimes();
        tlsTimer = setInterval(() => {
            try {
                const now = mtimes();
                if (now !== seen) { server.setSecureContext(readTls()); seen = now; log('reloaded the TLS certificate'); }
            } catch (e) { log('TLS reload failed:', e.code || e.message); }
        }, 3600 * 1000);
        tlsTimer.unref();
    } else {
        server = http.createServer(onRequest);
    }

    server.on('upgrade', (req, socket, head) => {
        const url = (req.url || '/').split('?')[0];
        if (url !== '/ws' || !isAllowedOrigin(cfg, req.headers.origin)) {
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    });

    wss.on('connection', ws => {
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
        ws.send(JSON.stringify({ t: 'hello', engine: BurnCore.ENGINE_VERSION, scenarios: scenarioIds }));
        ws.on('message', data => {
            let msg;
            try { msg = JSON.parse(String(data)); } catch { msg = null; }
            if (msg && msg.t === 'ping' && Object.keys(msg).length === 1) { ws.send('{"t":"pong"}'); return; }
            if (msg && msg.t === 'leave' && Object.keys(msg).length === 1) { ws.close(1000); return; }
            ws.send(JSON.stringify({ t: 'error', code: 'BAD_MESSAGE', message: 'This server does not run rooms yet.' }));
        });
    });

    const heartbeat = setInterval(() => {
        for (const ws of wss.clients) {
            if (!ws.isAlive) { ws.terminate(); continue; }
            ws.isAlive = false;
            ws.ping();
        }
    }, 30 * 1000);
    heartbeat.unref();

    const host = cfg.tls.mode === 'files' ? '0.0.0.0' : cfg.listen.host;
    const port = cfg.tls.mode === 'files' ? cfg.publicPort : cfg.listen.port;
    const portField = cfg.tls.mode === 'files' ? 'publicPort' : 'listen.port';

    return new Promise((resolve, reject) => {
        server.once('error', e => {
            if (e.code === 'EADDRINUSE') reject(new ConfigError(`Port ${port} is already in use. Choose another "${portField}" in the config.`));
            else if (e.code === 'EACCES') reject(new ConfigError(`Not allowed to listen on port ${port}. Choose another "${portField}" in the config.`));
            else if (e.code === 'EADDRNOTAVAIL') reject(new ConfigError(`Address ${host} is not on this machine. Fix "listen.host" in the config.`));
            else reject(e);
        });
        server.listen(port, host, () => {
            const close = () => new Promise(done => {
                clearInterval(heartbeat);
                if (tlsTimer) clearInterval(tlsTimer);
                for (const ws of wss.clients) ws.close(1001);
                server.close(() => done());
                setTimeout(() => { for (const ws of wss.clients) ws.terminate(); done(); }, 3000).unref();
            });
            resolve({ server, wss, port: server.address().port, close });
        });
    });
}

async function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--version')) {
        console.log(`burn-server ${pkg.version} (engine ${BurnCore.ENGINE_VERSION})`);
        return;
    }
    let cfg;
    try {
        cfg = load(configPathFromArgs(argv));
    } catch (e) {
        console.error(e instanceof ConfigError ? e.message : `Config error: ${e.message}`);
        process.exit(1);
    }
    if (argv.includes('--check')) {
        if (cfg.tls.mode === 'files') {
            for (const [field, f] of [['tls.certFile', cfg.tls.certFile], ['tls.keyFile', cfg.tls.keyFile]]) {
                try { fs.accessSync(f, fs.constants.R_OK); } catch {
                    console.error(`Config field "${field}": cannot read ${f}.`);
                    process.exit(1);
                }
            }
        }
        console.log('Config is valid.');
        return;
    }
    try {
        fs.mkdirSync(cfg.dataDir, { recursive: true });
        fs.accessSync(cfg.dataDir, fs.constants.W_OK);
    } catch (e) {
        console.error(`Cannot write to the data folder ${cfg.dataDir} (${e.code || e.message}). Fix "dataDir" in the config or the folder's owner.`);
        process.exit(1);
    }
    let running;
    try {
        running = await start(cfg);
    } catch (e) {
        console.error(e instanceof ConfigError ? e.message : `Could not start: ${e.message}`);
        process.exit(1);
    }
    const scheme = cfg.tls.mode === 'none' ? 'ws' : 'wss';
    log(`burn-server ${pkg.version}, engine ${BurnCore.ENGINE_VERSION}, ${cfg.tls.mode} mode, listening on port ${running.port}; public address ${scheme}://${cfg.publicDomain}:${cfg.publicPort}/ws`);
    let stopping = false;
    const stop = sig => {
        if (stopping) return;
        stopping = true;
        log(`${sig}: closing`);
        running.close().then(() => process.exit(0));
    };
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('SIGINT', () => stop('SIGINT'));
}

if (require.main === module) main();

module.exports = { start, isAllowedOrigin };
