'use strict';

/**
 * tgFormat.js — Telegram message formatter
 *
 * Prinsip desain:
 *   - Tidak ada emoji
 *   - Gunakan karakter ASCII untuk struktur visual
 *   - Monospace (<code>) untuk nilai numerik & alamat
 *   - Bold hanya untuk label utama
 *   - Separator: garis titik-titik atau dash
 */

const { esc } = require('./helpers');

// ─── SEPARATOR ───────────────────────────────────────────────
const SEP  = '................................................................................';
const SEP_SHORT = '..................................';

function sep()      { return SEP; }
function sepShort() { return SEP_SHORT; }

// ─── HEADER ──────────────────────────────────────────────────
function header(title) {
    return `<b>[ ${title} ]</b>`;
}

// ─── ROW ─────────────────────────────────────────────────────
function row(label, value, mono = false) {
    const val = mono ? `<code>${esc(String(value))}</code>` : esc(String(value));
    return `<b>${label}</b>  ${val}`;
}

function rowRaw(label, value) {
    return `<b>${label}</b>  ${value}`;
}

// ─── STATUS BADGE ────────────────────────────────────────────
function badge(text) {
    return `[ ${text} ]`;
}

// ─── SIGN ────────────────────────────────────────────────────
function signed(num, fixed = 4) {
    const n = parseFloat(num);
    if (isNaN(n)) return '0.0000';
    return `${n >= 0 ? '+' : ''}${n.toFixed(fixed)}`;
}

// ─── SOLSCAN LINK ────────────────────────────────────────────
function txLink(txid) {
    if (!txid || txid.startsWith('sim_')) return `<code>${esc(String(txid))}</code>`;
    return `<a href="https://solscan.io/tx/${txid}">solscan.io/tx/${txid.slice(0, 8)}...</a>`;
}

function tokenLink(mint) {
    return `<a href="https://pump.fun/${mint}">pump.fun</a>  <a href="https://solscan.io/token/${mint}">solscan</a>`;
}

function tradeLinks(mint) {
    return (
        `<a href="https://axiom.trade/t/${mint}">axiom.trade</a>` +
        `  |  ` +
        `<a href="https://photon-sol.tinyastro.io/en/lp/${mint}">photon</a>`
    );
}

module.exports = {
    sep,
    sepShort,
    header,
    row,
    rowRaw,
    badge,
    signed,
    txLink,
    tokenLink,
    tradeLinks,
    esc,
};