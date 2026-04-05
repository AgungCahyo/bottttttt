'use strict';
const CONFIG = require('../config');
const log = require('./logger');

// ============================================================
// HTML ESCAPING
// ============================================================
function esc(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ============================================================
// RETRY WRAPPER
// ============================================================
async function withRetry(fn, label = 'operasi', maxRetries = CONFIG.MAX_RETRIES) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const isLast = attempt === maxRetries;
            log.warn(`[${label}] percobaan ${attempt}/${maxRetries} gagal: ${err.message}`);
            if (isLast) throw err;
            await sleep(CONFIG.RETRY_DELAY_MS * attempt);
        }
    }
}

// ============================================================
// MISC
// ============================================================
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function formatUptime(startTime) {
    const s = Math.floor((Date.now() - startTime) / 1000);
    return `${Math.floor(s / 3600)}j ${Math.floor((s % 3600) / 60)}m ${s % 60}d`;
}

module.exports = { esc, withRetry, sleep, formatUptime };