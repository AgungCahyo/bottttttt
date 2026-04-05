'use strict';
const CONFIG = require('../config');
const log = require('../utils/logger');

let _bot = null; // set saat init

function init(botInstance) {
    _bot = botInstance;
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

    try {
        const options = { parse_mode: 'HTML' };
        if (keyboard) options.reply_markup = keyboard.reply_markup;

        const result = await _bot.telegram.sendMessage(CONFIG.TELEGRAM_CHANNEL_ID, html, options);
        log.sent(`msg_id=${result.message_id} chat=${result.chat.id} (${result.chat.username || 'N/A'})`);
        return result;
    } catch (err) {
        log.telegramErr(err.message);
        if (err.description) log.telegramErr(String(err.description));
        return null;
    }
}

module.exports = { init, sendToChannel };