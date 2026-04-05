'use strict';
require('dotenv').config();
const log = require('../utils/logger');

// ============================================================
// VALIDASI ENVIRONMENT
// ============================================================
const REQUIRED_ENV = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHANNEL_ID'];
const missingEnv = REQUIRED_ENV.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
    log.err(`Variable .env belum diisi:\n  ${missingEnv.join('\n  ')}`);
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
    /**
     * Cadangan SOL minimum di atas jumlah beli (biaya tx, CU, rent ATA).
     * Cek: saldo ≥ AUTO_BUY_AMOUNT_SOL + MIN_SOL_BUFFER_SOL. Turunkan jika saldo kecil (risiko tx gagal).
     */
    MIN_SOL_BUFFER_SOL: (() => {
        const v = parseFloat(process.env.MIN_SOL_BUFFER_SOL || '0.02');
        return Number.isFinite(v) && v >= 0 ? v : 0.02;
    })(),
    /** Skor minimum radar untuk auto-buy (55 = longgar, 70+ = lebih selektif, bukan jaminan win) */
    SIGNAL_MIN_SCORE:       parseInt(process.env.SIGNAL_MIN_SCORE || '55', 10),

    /** Sim: potong quote tambahan (BPS) agar fill tidak terlalu optimistis vs real (slippage + buffer) */
    SIM_EXTRA_IMPACT_BPS:   parseInt(process.env.SIM_EXTRA_IMPACT_BPS || '350', 10),

    /** Stream: min sampel harga sebelum SL dari WebSocket; pakai rata-rata window (kurangi wick palsu) */
    STREAM_SL_AVG_WINDOW:   Math.min(5, Math.max(2, parseInt(process.env.STREAM_SL_AVG_WINDOW || '3', 10))),
    STREAM_SL_MIN_SAMPLES: Math.min(5, Math.max(2, parseInt(process.env.STREAM_SL_MIN_SAMPLES || '2', 10))),

    /** Real: priority fee (microLamports per CU) — naik jika score entry ≥ PRIORITY_SCORE_HIGH */
    PRIORITY_SCORE_HIGH:         parseInt(process.env.PRIORITY_SCORE_HIGH || '80', 10),
    PRIORITY_MICRO_LAMPORTS_DEFAULT: parseInt(process.env.PRIORITY_MICRO_LAMPORTS_DEFAULT || '1000000', 10),
    PRIORITY_MICRO_LAMPORTS_HIGH:    parseInt(process.env.PRIORITY_MICRO_LAMPORTS_HIGH || '8000000', 10),

    /** Real: setelah jual penuh, coba lagi jika sisa token > ambang (pembulatan / dust) */
    TOKEN_DUST_THRESHOLD_UI: parseFloat(process.env.TOKEN_DUST_THRESHOLD_UI || '0.00001'),
    SELL_DUST_EXTRA_ROUNDS:  parseInt(process.env.SELL_DUST_EXTRA_ROUNDS || '2', 10),

    // Feature Flags
    ENABLE_SOLANA_STREAM: process.env.ENABLE_SOLANA_STREAM === 'true',
    ENABLE_NEWS_POLLING:  process.env.ENABLE_NEWS_POLLING  === 'true',
    ENABLE_PUMP_RADAR:    process.env.ENABLE_PUMP_RADAR    !== 'false',
};

// Ringkasan boot (warna via logger)
log.cfgTitle();
log.cfgRow('Channel', CONFIG.TELEGRAM_CHANNEL_ID);
log.cfgRow('Port', String(CONFIG.PORT));
log.cfgRow('Simulation', CONFIG.ENABLE_SIMULATION_MODE ? log.stateSim() : log.stateLive());
log.cfgRow('Auto-Buy', `${CONFIG.AUTO_BUY_AMOUNT_SOL} SOL (slippage ${CONFIG.AUTO_BUY_SLIPPAGE_BPS / 100}%)`);
log.cfgRow('Min SOL buffer (real)', `${CONFIG.MIN_SOL_BUFFER_SOL} SOL`);
log.cfgRow('Min skor buy', `${CONFIG.SIGNAL_MIN_SCORE}/100`);
log.cfgRow(
    'News polling',
    CONFIG.ENABLE_NEWS_POLLING
        ? `${log.stateOn()} setiap ${CONFIG.NEWS_INTERVAL_MS / 60_000} mnt`
        : log.stateOff()
);
log.cfgRow('Pump radar', CONFIG.ENABLE_PUMP_RADAR ? log.stateOn() : log.stateOff());
log.cfgRow('Solana stream', CONFIG.ENABLE_SOLANA_STREAM ? log.stateOn() : log.stateOff());
log.cfgRow('NewsData API', CONFIG.NEWSDATA_API_KEY ? log.stateOn() : log.stateUnknown());

module.exports = CONFIG;