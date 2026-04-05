'use strict';
const express      = require('express');
const { Telegraf } = require('telegraf');

const CONFIG  = require('./src/config');
const state   = require('./src/config/state');

const telegram              = require('./src/services/telegram');
const { startPriceUpdater } = require('./src/services/solPrice');
const { startNewsPolling }  = require('./src/services/news');
const { initPumpRadar }     = require('./src/services/pumpRadar');

const { registerHandlers, registerFallbackHandler, isAdmin, requireAdmin } = require('./src/handlers/commands');
const { registerTradingHandlers } = require('./src/handlers/tradingCommands');
const tradingEngine = require('./src/trading/tradingEngine');
const routes = require('./src/handlers/routes');
const log = require('./src/utils/logger');

const bot = new Telegraf(CONFIG.BOT_TOKEN);
const app = express();

app.use(express.json());
app.use('/', routes);

telegram.init(bot);
registerHandlers(bot);
registerTradingHandlers(bot, isAdmin, requireAdmin);
registerFallbackHandler(bot);

// 🛡️ BULLETPROOF ERROR HANDLERS
process.on('uncaughtException', (err) => {
    const safeMsg = err?.message || 'Unknown crash';
    log.crash(safeMsg);
    log.crash(err?.stack || 'No stack');
    // JANGAN process.exit() - biarkan server jalan
});

process.on('unhandledRejection', (reason, promise) => {
    const safeMsg = reason?.message || reason?.toString?.() || 'Unknown promise rejection';
    log.crash(`promise reject: ${safeMsg}`);
    log.dim(String(promise));
    // JANGAN process.exit()
});

async function start() {
    log.boot('Memulai bot…');
    try {
        state.loadCache();

        log.section('INISIALISASI TRADING ENGINE');
        await tradingEngine.init({
            rpcUrl:           CONFIG.SOLANA_RPC_URL,
            privateKeyBase58: CONFIG.PRIVATE_KEY_BASE58,
        });
        log.engine('Trading engine aktif');

        startPriceUpdater(120_000);

        if (CONFIG.ENABLE_PUMP_RADAR) {
            initPumpRadar();
        } else {
            log.warn('Pump radar dinonaktifkan');
        }

        if (CONFIG.ENABLE_NEWS_POLLING && CONFIG.NEWSDATA_API_KEY) {
            startNewsPolling();
        } else {
            log.warn('News polling dinonaktifkan');
        }

        log.section('INISIALISASI TELEGRAM');
        await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
        await bot.launch();
        log.bots('Bot Telegram aktif\n');

    } catch (err) {
        const safeMsg = err?.message || 'Startup failed';
        log.err(`Gagal startup: ${safeMsg}`);
        log.err(String(err));
        process.exit(1);
    }
}

app.listen(CONFIG.PORT, () => {
    log.info(`HTTP server port ${CONFIG.PORT}`);
    start();
});

// 🛡️ SAFE SHUTDOWN
['SIGINT', 'SIGTERM'].forEach(sig => {
    process.once(sig, async () => {
        log.stop(`${sig} — shutdown…`);
        try {
            await tradingEngine.stop?.();
            await bot.stop(sig);
        } catch (e) {
            log.warn(`Shutdown: ${e.message}`);
        }
        process.exit(0);
    });
});