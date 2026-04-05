'use strict';

/**
 * Terminal logger — warna ANSI (tanpa emoji).
 * Set NO_COLOR=1 untuk mematikan warna. Set FORCE_COLOR=1 untuk paksa warna.
 */

function colorEnabled() {
    if (process.env.FORCE_COLOR === '0') return false;
    if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
    if (process.env.NO_COLOR) return false;
    return Boolean(process.stdout?.isTTY);
}

const C = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[97m',
    gray: '\x1b[90m',
};

function paint(code, text) {
    if (!colorEnabled()) return String(text);
    return `${code}${text}${C.reset}`;
}

function bracket(name, color) {
    return paint(`${C.bold}${color}`, `[${name}]`);
}

function keyLabel(k) {
    return paint(C.gray, `${k}:`);
}

function stateOn() {
    return paint(C.green, 'on');
}

function stateOff() {
    return paint(C.gray, 'off');
}

function stateSim() {
    return paint(C.cyan, 'SIMULATION (no real SOL)');
}

function stateLive() {
    return paint(C.red + C.bold, 'LIVE (real SOL)');
}

function stateUnknown() {
    return paint(C.yellow, 'not configured');
}

module.exports = {
    colorEnabled,
    paint,
    bracket,
    keyLabel,
    C,
    stateOn,
    stateOff,
    stateSim,
    stateLive,
    stateUnknown,

    cfgTitle() {
        console.log(paint(`${C.bold}${C.cyan}`, 'Konfigurasi'));
    },

    cfgRow(keyStr, valueStr) {
        console.log(`   ${keyLabel(keyStr)} ${valueStr}`);
    },

    section(msg) {
        console.log(paint(`${C.bold}${C.cyan}`, `--- ${msg} ---`));
    },

    ok(msg) { console.log(`${bracket('ok', C.green)} ${msg}`); },
    warn(msg) { console.warn(`${bracket('warn', C.yellow)} ${msg}`); },
    err(msg) { console.error(`${bracket('err', C.red)} ${msg}`); },
    info(msg) { console.log(`${bracket('info', C.cyan)} ${msg}`); },
    dim(msg) { console.log(paint(`${C.dim}${C.gray}`, msg)); },

    boot(msg) { console.log(`${bracket('boot', C.cyan)} ${msg}`); },
    stop(msg) { console.log(`\n${bracket('shutdown', C.yellow)} ${msg}`); },
    crash(msg) { console.error(`${bracket('crash', C.red)} ${msg}`); },

    wallet(msg) { console.log(`${bracket('wallet', C.white)} ${msg}`); },
    load(msg) { console.log(`${bracket('load', C.cyan)} ${msg}`); },
    clean(msg) { console.log(`${bracket('clean', C.yellow)} ${msg}`); },

    trade(msg) { console.log(`${bracket('trade', C.magenta)} ${msg}`); },
    stream(msg) { console.log(`${bracket('stream', C.blue)} ${msg}`); },
    sim(msg) { console.log(`${bracket('sim', C.magenta)} ${msg}`); },

    price(msg) { console.log(`${bracket('price', C.cyan)} ${msg}`); },
    rpc(msg) { console.log(`${bracket('rpc', C.gray)} ${msg}`); },

    sent(msg) { console.log(`${bracket('sent', C.green)} ${msg}`); },
    telegramErr(msg) { console.error(`${bracket('telegram', C.red)} ${msg}`); },

    signal(msg) { console.log(`\n${bracket('signal', C.green)} ${msg}`); },
    skip(msg) { console.log(`\n${bracket('skip', C.yellow)} ${msg}`); },

    open(msg) { console.log(`${bracket('open', C.green)} ${msg}`); },
    close(msg, loss) {
        console.log(`${bracket('close', loss ? C.red : C.yellow)} ${msg}`);
    },
    stopLoss(msg) { console.log(`${bracket('stop-loss', C.red)} ${msg}`); },

    radar(msg) { console.log(`${bracket('radar', C.cyan)} ${msg}`); },
    radarErr(msg) { console.error(`${bracket('radar', C.red)} ${msg}`); },
    radarWarn(msg) { console.warn(`${bracket('radar', C.yellow)} ${msg}`); },

    engine(msg) { console.log(`${bracket('engine', C.green)} ${msg}`); },
    risk(msg) { console.log(`${bracket('risk', C.yellow)} ${msg}`); },
    riskWarn(msg) { console.warn(`${bracket('risk', C.yellow)} ${msg}`); },

    news(msg) { console.log(`${bracket('news', C.cyan)} ${msg}`); },
    newsErr(msg) { console.error(`${bracket('news', C.red)} ${msg}`); },

    cmd(msg) { console.log(`${bracket('cmd', C.gray)} ${msg}`); },
    bots(msg) { console.log(`${bracket('bots', C.green)} ${msg}`); },

    txOk(msg) { console.log(`${bracket('tx-ok', C.green)} ${msg}`); },
    txErr(msg) { console.error(`${bracket('tx-err', C.red)} ${msg}`); },
    txLogs(msg) { console.error(`${bracket('tx-log', C.red)} ${msg}`); },

    jupiter(msg) { console.log(`${bracket('jupiter', C.blue)} ${msg}`); },
    slot(msg) { console.warn(`${bracket('slot', C.yellow)} ${msg}`); },

    dcaWarn(msg) { console.warn(`${bracket('dca', C.yellow)} ${msg}`); },
    dcaErr(msg) { console.error(`${bracket('dca', C.red)} ${msg}`); },
    plan(msg) { console.log(`${bracket('plan', C.cyan)} ${msg}`); },
    gridErr(msg) { console.error(`${bracket('grid', C.red)} ${msg}`); },

    trace(msg) { console.log(paint(`${C.dim}${C.gray}`, msg)); },
};
