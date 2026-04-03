'use strict';
// ============================================================
// ENTRY POINT
// Load order matters: config → state → services → app
// ============================================================

const express  = require('express');
const { Telegraf } = require('telegraf');

const CONFIG   = require('./src/config');
const state    = require('./src/config/state');
const tradingEngine = require('./src/trading/tradingEngine')
const telegram       = require('./src/services/telegram');
const { startPriceUpdater }  = require('./src/services/solPrice');
const { startNewsPolling }   = require('./src/services/news');
const { initPumpRadar }      = require('./src/services/pumpRadar');

const { registerHandlers }   = require('./src/handlers/commands');
const routes = require('./src/handlers/routes');

// ============================================================
// INIT BOT & EXPRESS
// ============================================================
const bot = new Telegraf(CONFIG.BOT_TOKEN);
const app = express();

app.use(express.json());
app.use('/', routes);

// ============================================================
// WIRE TELEGRAM SERVICE
// ============================================================
telegram.init(bot);

// ============================================================
// REGISTER COMMANDS
// ============================================================
registerHandlers(bot);

// ============================================================
// STARTUP
// ============================================================
async function start() {
    console.log('🚀 Memulai bot...');

    try {
        // 1. Load persisted cache & state
        state.loadCache();

        // 2. Inisialisasi Trading Engine (Wallet & Jupiter)
        console.log('--- INISIALISASI TRADING ENGINE ---');
        tradingEngine.init({
            rpcUrl: CONFIG.SOLANA_RPC_URL,
            privateKeyBase58: CONFIG.PRIVATE_KEY_BASE58
        });
        console.log('✅ Trading Engine AKTIF!');

        // 3. SOL price updater (setiap 2 menit)
        startPriceUpdater(120_000);

        // 4. Pump.fun Radar
        if (CONFIG.ENABLE_PUMP_RADAR) {
            initPumpRadar();
        } else {
            console.log('⛔ Pump Radar dinonaktifkan via config.');
        }

        // 5. News polling
        if (CONFIG.ENABLE_NEWS_POLLING && CONFIG.NEWSDATA_API_KEY) {
            startNewsPolling();
        } else {
            console.log('⛔ News polling dinonaktifkan via config.');
        }

        // 6. Launch Telegram bot (long polling)
        console.log('--- INISIALISASI TELEGRAM ---');
        await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
        await bot.launch();
        console.log('✅ Bot Telegram AKTIF!');

    } catch (err) {
        console.error('💥 GAGAL TOTAL saat startup:', err.message);
        if (err.stack) console.error(err.stack);
        process.exit(1);
    }
}

// ============================================================
// LISTEN
// ============================================================
app.listen(CONFIG.PORT, () => {
    console.log(`📡 Server berjalan di port ${CONFIG.PORT}`);
    console.log(`   Health  : http://localhost:${CONFIG.PORT}/health`);
    console.log(`   Webhook : http://localhost:${CONFIG.PORT}/solana-webhook`);
    start();
});

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================
['SIGINT', 'SIGTERM'].forEach(sig => {
    process.once(sig, () => {
        console.log(`\n🛑 ${sig} — menghentikan bot...`);
        bot.stop(sig);
        process.exit(0);
    });
});

process.on('uncaughtException',  err => console.error('💥 uncaughtException:', err));
process.on('unhandledRejection', err => console.error('💥 unhandledRejection:', err));