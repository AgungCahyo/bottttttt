'use strict';
const CONFIG  = require('../config');
const state   = require('../config/state');
const { formatUptime } = require('../utils/helpers');
const { sendToChannel } = require('../services/telegram');
const { fetchCryptoNews } = require('../services/news');

// ============================================================
// ADMIN GUARD
// ============================================================
function isAdmin(ctx) {
    if (CONFIG.ADMIN_USER_IDS.length === 0) return true;
    return CONFIG.ADMIN_USER_IDS.includes(String(ctx.from?.id || ''));
}

function requireAdmin(ctx, next) {
    if (!isAdmin(ctx)) return ctx.reply('🚫 Hanya untuk admin.');
    return next();
}

// ============================================================
// STATUS HELPER
// ============================================================
function buildStatusMessage() {
    return (
        `<b>📊 Status Bot</b>\n\n` +
        `⏱ Uptime: ${formatUptime(state.stats.botStartTime)}\n` +
        `📰 Berita terkirim  : ${state.stats.newsSentCount}\n` +
        `📡 Webhook hits     : ${state.stats.webhookHitCount}\n` +
        `🪐 Mooner alerts    : ${state.stats.moonerAlertCount}\n` +
        `🔄 Polling          : ${state.isPollingActive ? 'Aktif ▶️' : 'Pause ⏸️'}\n` +
        `💾 Cache (berita)   : ${state.cacheSize()} artikel\n` +
        `📢 Channel          : ${CONFIG.TELEGRAM_CHANNEL_ID}`
    );
}

// ============================================================
// REGISTER COMMANDS
// ============================================================
function registerHandlers(bot) {
    // Logging middleware
    bot.use(async (ctx, next) => {
        const user = ctx.from ? `@${ctx.from.username || ctx.from.id}` : 'unknown';
        console.log(`📩 [${user}] ${ctx.message?.text || ctx.updateType}`);
        return next();
    });

    // ─── Public Commands ──────────────────────────────────────
    bot.command('start', ctx => ctx.reply(
        '👋 <b>Crypto Radar Bot</b>\n\n' +
        '📰 Auto-polling berita crypto\n' +
        '🪐 Pump.fun Mooner Radar\n' +
        '💎 Solana webhook monitor\n\n' +
        'Ketik /help untuk daftar perintah.',
        { parse_mode: 'HTML' }
    ));

    bot.command('help', ctx => ctx.reply(
        '<b>📋 Perintah Tersedia:</b>\n\n' +
        '/start   — Sambutan\n' +
        '/help    — Bantuan ini\n' +
        '/test    — Test kirim ke channel\n' +
        '/status  — Status bot' +
        (isAdmin(ctx) ? '\n\n<b>🔑 Admin:</b>\n/pause /resume /forcenews /broadcast &lt;pesan&gt;' : ''),
        { parse_mode: 'HTML' }
    ));

    bot.command('test', async ctx => {
        const res = await sendToChannel('✅ <b>Test berhasil!</b> Bot aktif dan terhubung ke channel.');
        return res
            ? ctx.reply(`✅ Pesan test dikirim. (ID: ${res.message_id})`)
            : ctx.reply('❌ Gagal! Periksa log di terminal.');
    });

    bot.command('debug', async ctx => {
        ctx.reply('🔍 Mengirim pesan debug ke channel...');
        const res = await sendToChannel('<b>DEBUG:</b> Pesan tes dari /debug.');
        return res
            ? ctx.reply(`✅ Berhasil. Pesan ID: ${res.message_id}`)
            : ctx.reply('❌ Gagal! Lihat log terminal.');
    });

    bot.command('status', async ctx => {
        return ctx.reply(buildStatusMessage(), { parse_mode: 'HTML' });
    });

    // ─── Admin Commands ───────────────────────────────────────
    bot.command('pause',  requireAdmin, ctx => {
        state.pausePolling();
        return ctx.reply('⏸️ Polling dihentikan.');
    });

    bot.command('resume', requireAdmin, ctx => {
        state.resumePolling();
        return ctx.reply('▶️ Polling dilanjutkan.');
    });

    bot.command('forcenews', requireAdmin, async ctx => {
        await ctx.reply('🔄 Memaksa cek berita...');
        await fetchCryptoNews();
        return ctx.reply('✅ Selesai.');
    });

    bot.command('broadcast', requireAdmin, async ctx => {
        const text = ctx.message.text.replace('/broadcast', '').trim();
        if (!text) return ctx.reply('⚠️ Penggunaan: /broadcast <pesan>');
        try {
            await bot.telegram.sendMessage(CONFIG.TELEGRAM_CHANNEL_ID, text);
            return ctx.reply('✅ Pesan disiarkan ke channel.');
        } catch (err) {
            return ctx.reply(`❌ Gagal: ${err.message}`);
        }
    });

    // ─── Fallback ─────────────────────────────────────────────
    bot.on('text', ctx => {
        if (ctx.message.text.startsWith('/'))
            return ctx.reply('❓ Perintah tidak dikenal. Ketik /help.');
    });

    console.log('✅ Command handlers terdaftar.');
}

module.exports = { registerHandlers, isAdmin };