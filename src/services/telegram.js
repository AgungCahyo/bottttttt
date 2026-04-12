'use strict';
const CONFIG = require('../config');
const log = require('../utils/logger');

let _bot = null; // set saat init
const queue = [];
let processing = false;
let nextAllowedAt = 0;
const recentHashes = new Map();

function init(botInstance) {
    _bot = botInstance;
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function msgHash(html, keyboard) {
    const kb = keyboard?.reply_markup ? JSON.stringify(keyboard.reply_markup) : '';
    return `${html || ''}::${kb}`;
}

function cleanupRecentHashes() {
    const now = Date.now();
    const win = Math.max(1000, Number(CONFIG.TELEGRAM_DEDUPE_WINDOW_MS) || 12000);
    for (const [k, ts] of recentHashes.entries()) {
        if (now - ts > win) recentHashes.delete(k);
    }
}

function extractRetryAfterMs(err) {
    const p = err?.parameters?.retry_after;
    if (Number.isFinite(p) && p > 0) return Math.ceil(p * 1000);

    const msg = String(err?.description || err?.message || '');
    const m = msg.match(/retry after\s+(\d+)/i);
    if (m) return Math.ceil(Number(m[1]) * 1000);
    return null;
}

async function sendRaw(html, keyboard) {
    const options = { parse_mode: 'HTML' };
    if (keyboard) options.reply_markup = keyboard.reply_markup;
    return _bot.telegram.sendMessage(CONFIG.TELEGRAM_CHANNEL_ID, html, options);
}

async function processQueue() {
    if (processing) return;
    processing = true;
    try {
        while (queue.length > 0) {
            const item = queue.shift();
            const now = Date.now();
            if (now < nextAllowedAt) await sleep(nextAllowedAt - now);

            let attempt = 0;
            const maxRetry = Math.max(0, Number(CONFIG.TELEGRAM_MAX_RETRY_429) || 8);
            // retry loop for 429 only
            while (true) {
                try {
                    const result = await sendRaw(item.html, item.keyboard);
                    log.sent(`msg_id=${result.message_id} chat=${result.chat.id} (${result.chat.username || 'N/A'})`);
                    item.resolve(result);
                    break;
                } catch (err) {
                    const retryMs = extractRetryAfterMs(err);
                    if (retryMs == null || attempt >= maxRetry) {
                        log.telegramErr(err.message);
                        if (err.description) log.telegramErr(String(err.description));
                        item.resolve(null);
                        break;
                    }
                    attempt++;
                    const jitter = Math.floor(Math.random() * 250);
                    await sleep(retryMs + jitter);
                }
            }

            nextAllowedAt = Date.now() + Math.max(250, Number(CONFIG.TELEGRAM_RATE_LIMIT_MS) || 1300);
        }
    } finally {
        processing = false;
    }
}

// ============================================================
// KIRIM KE CHANNEL
// Mendukung: text biasa, HTML, inline keyboard (Markup)
// ============================================================
async function sendToChannel(html, keyboard = null) {
    if (!CONFIG.TELEGRAM_CHANNEL_ID) {
        log.warn('Gagal kirim: TELEGRAM_CHANNEL_ID tidak ada di .env');
        return null;
    }
    if (!_bot) {
        log.warn('Gagal kirim: bot belum diinisialisasi');
        return null;
    }

    cleanupRecentHashes();
    const h = msgHash(html, keyboard);
    if (recentHashes.has(h)) return null;
    recentHashes.set(h, Date.now());

    return await new Promise(resolve => {
        queue.push({ html, keyboard, resolve });
        processQueue().catch(() => {});
    });
}

module.exports = { init, sendToChannel };