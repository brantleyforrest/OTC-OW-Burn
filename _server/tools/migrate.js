// Brings the config and the data folder up to this release. The installer runs it with the
// service stopped, after taking a backup, and before switching to the new release:
//   node tools/migrate.js --config <file> --data <dir> --from <version|none> --to <version>
// Exit code 0 means the upgrade may go on; anything else stops it and the installer restores the
// backup and the old release.
//
// Rules for later releases:
// - DATA_SCHEMA is the layout of the files in the data folder. When it changes, add 1 and add a
//   step to STEPS that turns schema n - 1 into n. Steps must be safe to run twice.
// - A release refuses data with a newer schema than its own (a downgrade past a data change).
// - Config changes: give a new field a default in config.js, so old configs stay valid. If a
//   field must be renamed or removed, rewrite the file here (write a temporary file, then rename).
'use strict';

const fs = require('fs');
const path = require('path');
const { load, ConfigError } = require('../config');

const DATA_SCHEMA = 1;

// STEPS[n] turns schema n - 1 into schema n. Schema 0 means a new, empty data folder.
const STEPS = {
    1: () => { /* Nothing to convert: schema 1 is the first. */ }
};

function arg(name) {
    const argv = process.argv.slice(2);
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
}

function main() {
    const configFile = arg('--config');
    const dataDir = arg('--data');
    const from = arg('--from') || 'none';
    const to = arg('--to') || '?';
    if (!configFile || !dataDir) {
        console.error('Usage: node tools/migrate.js --config <file> --data <dir> --from <version|none> --to <version>');
        return 2;
    }

    try { load(path.resolve(configFile)); } catch (e) {
        console.error(e instanceof ConfigError ? e.message : `Config error: ${e.message}`);
        return 1;
    }

    fs.mkdirSync(dataDir, { recursive: true });
    const schemaFile = path.join(dataDir, 'SCHEMA');
    let have = 0;
    if (fs.existsSync(schemaFile)) {
        have = Number(fs.readFileSync(schemaFile, 'utf8').trim());
        if (!Number.isInteger(have) || have < 0) {
            console.error(`${schemaFile} does not hold a whole number.`);
            return 1;
        }
    }
    if (have > DATA_SCHEMA) {
        console.error(`The data folder uses schema ${have}, newer than this release (${DATA_SCHEMA}). Restore a backup made by that older release, or install a newer one.`);
        return 1;
    }
    for (let n = have + 1; n <= DATA_SCHEMA; n++) {
        STEPS[n]({ dataDir, from, to });
        console.log(`data schema ${n - 1} -> ${n}`);
    }
    const tmp = `${schemaFile}.tmp`;
    fs.writeFileSync(tmp, `${DATA_SCHEMA}\n`);
    fs.renameSync(tmp, schemaFile);
    console.log(`migrate ${from} -> ${to}: config valid, data schema ${DATA_SCHEMA}`);
    return 0;
}

process.exitCode = main();
