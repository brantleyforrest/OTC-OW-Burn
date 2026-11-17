// Config validation and the parts of the server built so far: /health, 404, the origin check,
// the hello message, ping/pong, and the migrate tool. Run: node test/config.test.js
'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { validate, ConfigError } = require('../config');
const { start } = require('../server');
const BurnCore = require('../../burn/burn-core.js');
const WebSocket = require('ws');

const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8'));
const dev = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.dev.json'), 'utf8'));
let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const clone = o => JSON.parse(JSON.stringify(o));
const rejects = (raw, field) => assert.throws(() => validate(raw), e => e instanceof ConfigError && e.message.includes(`"${field}"`), field);

test('the example and dev configs are valid', () => {
    validate(example);
    const c = validate(dev);
    assert.strictEqual(c.tls.mode, 'none');
    assert.ok(path.isAbsolute(c.dataDir));
});

test('bad fields are named in the error', () => {
    let c = clone(example); c.publicPort = 0; rejects(c, 'publicPort');
    c = clone(example); c.listen.port = 'x'; rejects(c, 'listen.port');
    c = clone(example); c.tls.mode = 'tls'; rejects(c, 'tls.mode');
    c = clone(example); c.tls.mode = 'files'; rejects(c, 'tls.certFile');
    c = clone(example); c.allowedOrigins = ['https://a.example/']; rejects(c, 'allowedOrigins[0]');
    c = clone(example); c.extra = 1; rejects(c, 'extra');
    c = clone(example); c.limits.maxRooms = -1; rejects(c, 'limits.maxRooms');
    c = clone(example); c.cloudflare.enabled = true; rejects(c, 'cloudflare.apiToken');
    c = clone(example); c.cloudflare.ttl = 30; rejects(c, 'cloudflare.ttl');
});

test('limits and cloudflare may be left out and get defaults', () => {
    const c = clone(example); delete c.limits; delete c.cloudflare;
    const v = validate(c);
    assert.strictEqual(v.limits.maxRooms, 200);
    assert.strictEqual(v.cloudflare.enabled, false);
    assert.strictEqual(v.cloudflare.recordName, c.publicDomain);
});

const get = (port, p) => fetch(`http://127.0.0.1:${port}${p}`).then(async r => [r.status, await r.text()]);
const openWs = (port, origin) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, origin ? { origin } : {});
    const msgs = [];
    ws.on('message', d => msgs.push(JSON.parse(String(d))));
    ws.on('open', () => resolve({ ws, msgs }));
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
});
const until = async (fn, ms = 2000) => {
    const end = Date.now() + ms;
    while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)); }
};

test('server: health, 404, hello, ping, origin check', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'burn-test-'));
    const cfg = validate({ ...clone(dev), listen: { host: '127.0.0.1', port: 0 }, allowLocalOrigins: false,
        allowedOrigins: ['https://allowed.example'], dataDir: tmp });
    const s = await start(cfg);
    try {
        assert.deepStrictEqual(await get(s.port, '/health'), [200, 'ok']);
        assert.strictEqual((await get(s.port, '/other'))[0], 404);
        const { ws, msgs } = await openWs(s.port, 'https://allowed.example');
        await until(() => msgs.length >= 1);
        assert.strictEqual(msgs[0].t, 'hello');
        assert.strictEqual(msgs[0].engine, BurnCore.ENGINE_VERSION);
        assert.ok(msgs[0].scenarios.includes('stop-drift'));
        ws.send('{"t":"ping"}');
        await until(() => msgs.length >= 2);
        assert.strictEqual(msgs[1].t, 'pong');
        ws.close();
        await assert.rejects(openWs(s.port, 'https://evil.example'), /403/);
    } finally {
        await s.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('server --check, --version, and a taken port', async () => {
    const node = process.execPath;
    const server = path.join(__dirname, '..', 'server.js');
    const out = execFileSync(node, [server, '--config', path.join(__dirname, '..', 'config.dev.json'), '--check'], { encoding: 'utf8' });
    assert.match(out, /Config is valid/);
    assert.match(execFileSync(node, [server, '--version'], { encoding: 'utf8' }), /^burn-server \d+\.\d+\.\d+ \(engine \d+\)/);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'burn-test-'));
    const cfg = validate({ ...clone(dev), listen: { host: '127.0.0.1', port: 0 }, dataDir: tmp });
    const s = await start(cfg);
    try {
        await assert.rejects(start({ ...cfg, listen: { host: '127.0.0.1', port: s.port } }), e => e instanceof ConfigError && /"listen.port"/.test(e.message));
    } finally {
        await s.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('migrate.js writes the schema, and refuses a newer one', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'burn-test-'));
    const migrate = path.join(__dirname, '..', 'tools', 'migrate.js');
    const conf = path.join(__dirname, '..', 'config.dev.json');
    try {
        execFileSync(process.execPath, [migrate, '--config', conf, '--data', tmp, '--from', 'none', '--to', 'x'], { encoding: 'utf8' });
        assert.strictEqual(fs.readFileSync(path.join(tmp, 'SCHEMA'), 'utf8').trim(), '1');
        execFileSync(process.execPath, [migrate, '--config', conf, '--data', tmp, '--from', 'x', '--to', 'x'], { encoding: 'utf8' });
        fs.writeFileSync(path.join(tmp, 'SCHEMA'), '99\n');
        assert.throws(() => execFileSync(process.execPath, [migrate, '--config', conf, '--data', tmp, '--from', 'x', '--to', 'x'], { stdio: 'pipe' }));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

(async () => {
    for (const [name, fn] of tests) {
        try { await fn(); passed++; console.log(`ok   ${name}`); }
        catch (e) { console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); process.exitCode = 1; }
    }
    console.log(`\n${passed} of ${tests.length} passed`);
})();
