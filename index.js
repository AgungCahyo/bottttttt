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

const bot = new Telegraf(CONFIG.BOT_TOKEN);
const app = express();

app.use(express.json());
app.use('/', routes);

telegram.init(bot);
registerHandlers(bot);
registerTradingHandlers(bot, isAdmin, requireAdmin);
registerFallbackHandler(bot);

async function start() {
    console.log('🚀 Memulai bot...');
    try {
        state.loadCache();

        console.log('--- INISIALISASI TRADING ENGINE ---');
        tradingEngine.init({
            rpcUrl:           CONFIG.SOLANA_RPC_URL,
            privateKeyBase58: CONFIG.PRIVATE_KEY_BASE58,
        });
        console.log('✅ Trading Engine AKTIF!');

        startPriceUpdater(120_000);

        if (CONFIG.ENABLE_PUMP_RADAR) initPumpRadar();
        else console.log('⛔ Pump Radar dinonaktifkan.');

        if (CONFIG.ENABLE_NEWS_POLLING && CONFIG.NEWSDATA_API_KEY) startNewsPolling();
        else console.log('⛔ News polling dinonaktifkan.');

        console.log('--- INISIALISASI TELEGRAM ---');
        await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
        await bot.launch();
        console.log('✅ Bot Telegram AKTIF!\n');

    } catch (err) {
        console.error('💥 GAGAL startup:', err.message);
        if (err.stack) console.error(err.stack);
        process.exit(1);
    }
}

app.listen(CONFIG.PORT, () => {
    console.log(`📡 Server di port ${CONFIG.PORT}`);
    start();
});

['SIGINT', 'SIGTERM'].forEach(sig => {
    process.once(sig, () => {
        console.log(`\n🛑 ${sig} — shutdown...`);
        bot.stop(sig);
        process.exit(0);
    });
});

process.on('uncaughtException',  err => console.error('💥', err.message));
process.on('unhandledRejection', err => console.error('💥', err));