'use strict';
const CONFIG  = require('../config');
const state   = require('../config/state');
const { formatUptime } = require('../utils/helpers');
const { sendToChannel } = require('../services/telegram');
const { fetchCryptoNews } = require('../services/news');
const f   = require('../utils/tgFormat');
const log = require('../utils/logger');

// ============================================================
// ADMIN GUARD
// ============================================================
function isAdmin(ctx) {
    if (CONFIG.ADMIN_USER_IDS.length === 0) return true;
    return CONFIG.ADMIN_USER_IDS.includes(String(ctx.from?.id || ''));
}

function requireAdmin(ctx, next) {
    if (!isAdmin(ctx)) return ctx.reply('Access denied.');
    return next();
}

// ============================================================
// STATUS MESSAGE
// ============================================================
function buildStatusMessage() {
    const up = formatUptime(state.stats.botStartTime);
    return (
        `${f.header('BOT STATUS')}\n` +
        `${f.sep()}\n` +
        `${f.row('Uptime', up)}\n` +
        `${f.row('Polling', state.isPollingActive ? 'active' : 'paused')}\n` +
        `${f.row('Sol price', `$${state.currentSolPrice.toFixed(2)}`)}\n` +
        `${f.sep()}\n` +
        `${f.row('News sent', state.stats.newsSentCount)}\n` +
        `${f.row('Webhook hits', state.stats.webhookHitCount)}\n` +
        `${f.row('Signal alerts', state.stats.moonerAlertCount)}\n` +
        `${f.row('Cache size', `${state.cacheSize()} articles`)}\n` +
        `${f.row('Tracked tokens', state.trackedTokens.size)}\n` +
        `${f.sep()}\n` +
        `${f.row('Channel', CONFIG.TELEGRAM_CHANNEL_ID, true)}`
    );
}

// ============================================================
// REGISTER COMMANDS
// ============================================================
function registerHandlers(bot) {
    // Logging middleware
    bot.use(async (ctx, next) => {
        const user = ctx.from ? `@${ctx.from.username || ctx.from.id}` : 'unknown';
        log.cmd(`[${user}] ${ctx.message?.text || ctx.updateType}`);
        return next();
    });

    // ─── /start ──────────────────────────────────────────────
    bot.command('start', ctx => ctx.reply(
        `${f.header('CRYPTO RADAR BOT')}\n` +
        `${f.sep()}\n` +
        `${f.row('News polling', 'auto, crypto headlines')}\n` +
        `${f.row('Pump radar', 'pump.fun early signal')}\n` +
        `${f.row('Trading', 'auto-buy / stop-loss / trailing')}\n` +
        `${f.row('Solana', 'webhook monitor')}\n\n` +
        `Type <code>/help</code> for command list.`,
        { parse_mode: 'HTML' }
    ));

    // ─── /help ───────────────────────────────────────────────
    bot.command('help', ctx => {
        const adminSection = isAdmin(ctx)
            ? `\n${f.sep()}\n` +
              `<b>Admin commands</b>\n` +
              `<code>/pause</code>             pause news polling\n` +
              `<code>/resume</code>            resume news polling\n` +
              `<code>/forcenews</code>         force news check now\n` +
              `<code>/broadcast</code> msg     send raw message to channel\n` +
              `<code>/reset_daily</code>       reset daily trade stats\n` +
              `<code>/clear_sim</code>         remove all simulation positions\n` +
              `<code>/close_all</code>         emergency close all positions\n` +
              `<code>/close</code> mint        close single position\n` +
              `<code>/risk_set</code> key val  update risk parameter\n` +
              `<code>/whitelist_add</code> m   add mint to whitelist\n` +
              `<code>/whitelist_remove</code>  remove mint from whitelist\n` +
              `<code>/dca_create</code>        create DCA plan\n` +
              `<code>/dca_cancel</code> id     cancel DCA plan\n` +
              `<code>/grid_create</code>       create grid plan\n` +
              `<code>/grid_cancel</code> id    cancel grid plan`
            : '';

        return ctx.reply(
            `${f.header('COMMAND LIST')}\n` +
            `${f.sep()}\n` +
            `<code>/start</code>              welcome info\n` +
            `<code>/help</code>               this message\n` +
            `<code>/status</code>             bot status\n` +
            `<code>/wallet</code>             wallet address & SOL balance\n` +
            `<code>/trading_status</code>     open positions & daily stats\n` +
            `<code>/risk_config</code>        view risk parameters\n` +
            `<code>/alert_config</code>       view notification flags\n` +
            `<code>/test</code>               send test message to channel` +
            adminSection,
            { parse_mode: 'HTML' }
        );
    });

    // ─── /test ───────────────────────────────────────────────
    bot.command('test', async ctx => {
        const res = await sendToChannel(
            `${f.header('TEST MESSAGE')}\n` +
            `${f.sep()}\n` +
            `Connection OK.`
        );
        return res
            ? ctx.reply(`Test sent. Message ID: ${res.message_id}`)
            : ctx.reply('Failed. Check terminal log.');
    });

    // ─── /debug ──────────────────────────────────────────────
    bot.command('debug', async ctx => {
        ctx.reply('Sending debug message to channel...');
        const res = await sendToChannel(
            `${f.header('DEBUG')}\n` +
            `${f.sep()}\n` +
            `Triggered by: <code>/debug</code>`
        );
        return res
            ? ctx.reply(`Done. Message ID: ${res.message_id}`)
            : ctx.reply('Failed. Check terminal log.');
    });

    // ─── /status ─────────────────────────────────────────────
    bot.command('status', async ctx => {
        return ctx.reply(buildStatusMessage(), { parse_mode: 'HTML' });
    });

    // ─── Admin: pause / resume / forcenews / broadcast ───────
    bot.command('pause', requireAdmin, ctx => {
        state.pausePolling();
        return ctx.reply('News polling paused.');
    });

    bot.command('resume', requireAdmin, ctx => {
        state.resumePolling();
        return ctx.reply('News polling resumed.');
    });

    bot.command('forcenews', requireAdmin, async ctx => {
        await ctx.reply('Forcing news check...');
        await fetchCryptoNews();
        return ctx.reply('Done.');
    });

    bot.command('broadcast', requireAdmin, async ctx => {
        const text = ctx.message.text.replace('/broadcast', '').trim();
        if (!text) return ctx.reply('Usage: /broadcast <message>');
        try {
            await bot.telegram.sendMessage(CONFIG.TELEGRAM_CHANNEL_ID, text);
            return ctx.reply('Broadcast sent.');
        } catch (err) {
            return ctx.reply(`Failed: ${err.message}`);
        }
    });

    log.ok('Main command handlers registered');
}

// ============================================================
// FALLBACK
// ============================================================
function registerFallbackHandler(bot) {
    bot.on('text', ctx => {
        if (ctx.message.text.startsWith('/'))
            return ctx.reply('Unknown command. Type /help.');
    });
    log.ok('Fallback handler registered');
}

module.exports = { registerHandlers, registerFallbackHandler, isAdmin, requireAdmin };