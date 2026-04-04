'use strict';
require('dotenv').config();

// ============================================================
// VALIDASI ENVIRONMENT
// ============================================================
const REQUIRED_ENV = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHANNEL_ID'];
const missingEnv = REQUIRED_ENV.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
    console.error(`❌ ERROR: Variable berikut belum diisi di .env:\n  ${missingEnv.join('\n  ')}`);
    process.exit(1);
}

// ============================================================
// CONFIG OBJECT
// ============================================================
const CONFIG = {
    // Telegram
    BOT_TOKEN:            process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHANNEL_ID:  process.env.TELEGRAM_CHANNEL_ID,
    ADMIN_USER_IDS:       (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
    WEBHOOK_SECRET:       process.env.WEBHOOK_SECRET || null,
    SOLANA_RPC_URL:       process.env.SOLANA_RPC_URL,
    PRIVATE_KEY_BASE58:   process.env.WALLET_PRIVATE_KEY,
    // Server
    PORT:                 parseInt(process.env.PORT, 10) || 3000,

    // News
    NEWSDATA_API_KEY:     process.env.NEWSDATA_API_KEY || null,
    NEWS_INTERVAL_MS:     900_000,   // 15 menit

    // Retry
    MAX_RETRIES:          3,
    RETRY_DELAY_MS:       2_000,

    // Pump.fun Radar
    PUMP_MIN_VOLUME_SOL:  5.0,
    PUMP_MIN_BUYERS:      10,
    PUMP_TRACK_WINDOW_MS: 3_600_000, // 1 jam
    PUMP_CURVE_TARGET_SOL: 85,
    PUMP_TOTAL_SUPPLY:    1_000_000_000,
    MIN_WHALE_SOL:        1.0,
    BUNDLED_WINDOW_MS:    1_500,

    // Auto-Trading (Simulation or Real)
    ENABLE_SIMULATION_MODE: process.env.ENABLE_SIMULATION_MODE !== 'false', // default: true
    AUTO_BUY_AMOUNT_SOL:    parseFloat(process.env.AUTO_BUY_AMOUNT_SOL || '0.1'),
    AUTO_BUY_SLIPPAGE_BPS:  parseInt(process.env.AUTO_BUY_SLIPPAGE_BPS   || '1500', 10), // 15%
    /** Skor minimum radar untuk auto-buy (55 = longgar, 70+ = lebih selektif, bukan jaminan win) */
    SIGNAL_MIN_SCORE:       parseInt(process.env.SIGNAL_MIN_SCORE || '55', 10),

    // Feature Flags
    ENABLE_SOLANA_STREAM: process.env.ENABLE_SOLANA_STREAM === 'true',
    ENABLE_NEWS_POLLING:  process.env.ENABLE_NEWS_POLLING  === 'true',
    ENABLE_PUMP_RADAR:    process.env.ENABLE_PUMP_RADAR    !== 'false',
};

// Print summary
console.log('🔧 Konfigurasi:');
console.log(`   Channel       : ${CONFIG.TELEGRAM_CHANNEL_ID}`);
console.log(`   Port          : ${CONFIG.PORT}`);
console.log(`   Simulation    : ${CONFIG.ENABLE_SIMULATION_MODE ? '🛡️ AKTIF (Tanpa SOL Asli)' : '💸 NONAKTIF (Menggunakan SOL Asli!)'}`);
console.log(`   Auto-Buy      : ${CONFIG.AUTO_BUY_AMOUNT_SOL} SOL (Slippage: ${CONFIG.AUTO_BUY_SLIPPAGE_BPS / 100}%)`);
console.log(`   Min skor buy  : ${CONFIG.SIGNAL_MIN_SCORE}/100`);
console.log(`   News polling  : ${CONFIG.ENABLE_NEWS_POLLING ? `✅ setiap ${CONFIG.NEWS_INTERVAL_MS / 60_000} mnt` : '⛔ nonaktif'}`);
console.log(`   Pump radar    : ${CONFIG.ENABLE_PUMP_RADAR   ? '✅' : '⛔ nonaktif'}`);
console.log(`   Solana stream : ${CONFIG.ENABLE_SOLANA_STREAM ? '✅' : '⛔ nonaktif'}`);
console.log(`   NewsData API  : ${CONFIG.NEWSDATA_API_KEY    ? '✅' : '⚠️  tidak dikonfigurasi'}`);

module.exports = CONFIG;