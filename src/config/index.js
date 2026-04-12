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

// ─── HELPER PARSERS ───────────────────────────────────────────
/** Ambil boolean dari env. Default dipakai jika key tidak ada. */
function envBool(key, defaultVal) {
    const v = process.env[key];
    if (v === undefined || v === '') return defaultVal;
    return v !== 'false' && v !== '0';
}

/** Ambil float dari env. Fallback jika tidak valid. */
function envFloat(key, defaultVal) {
    const v = parseFloat(process.env[key]);
    return Number.isFinite(v) ? v : defaultVal;
}

/** Ambil int dari env. Fallback jika tidak valid. */
function envInt(key, defaultVal) {
    const v = parseInt(process.env[key], 10);
    return Number.isFinite(v) ? v : defaultVal;
}

// ============================================================
// CONFIG OBJECT
// ============================================================
const CONFIG = {
    // ─── Telegram ───────────────────────────────────────────
    BOT_TOKEN:           process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHANNEL_ID: process.env.TELEGRAM_CHANNEL_ID,
    ADMIN_USER_IDS:      (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
    WEBHOOK_SECRET:      process.env.WEBHOOK_SECRET || null,

    // ─── Solana ─────────────────────────────────────────────
    SOLANA_RPC_URL:    process.env.SOLANA_RPC_URL,
    PRIVATE_KEY_BASE58: process.env.WALLET_PRIVATE_KEY,

    // ─── Server ─────────────────────────────────────────────
    PORT: envInt('PORT', 3000),

    // ─── News ───────────────────────────────────────────────
    NEWSDATA_API_KEY:  process.env.NEWSDATA_API_KEY || null,
    NEWS_INTERVAL_MS:  900_000, // 15 menit (tidak perlu diubah via env)

    // ─── Retry ──────────────────────────────────────────────
    MAX_RETRIES:    3,
    RETRY_DELAY_MS: 2_000,

    // ─── Fitur On/Off ───────────────────────────────────────
    ENABLE_PUMP_RADAR:    envBool('ENABLE_PUMP_RADAR', true),
    ENABLE_NEWS_POLLING:  envBool('ENABLE_NEWS_POLLING', false),
    ENABLE_SOLANA_STREAM: envBool('ENABLE_SOLANA_STREAM', false),

    // ─── Copy Trader (Trojan-style, opt-in) ──────────────────
    ENABLE_COPY_TRADER:          envBool('ENABLE_COPY_TRADER', false),
    COPY_TRADER_WALLETS:         process.env.COPY_TRADER_WALLETS || '',
    COPY_TRADER_BUY_AMOUNT_SOL:  envFloat('COPY_TRADER_BUY_AMOUNT_SOL', 0.05),
    ENABLE_COPY_TRADER_COPY_SELL: envBool('ENABLE_COPY_TRADER_COPY_SELL', false),

    // ─── Kontrol Notifikasi Channel (anti-spam) ─────────────
    /** Kirim early signal & call confirmed ke channel */
    ENABLE_SIGNAL_ALERTS:  envBool('ENABLE_SIGNAL_ALERTS', true),
    /** Kirim notif trailing-stop / partial TP ke channel */
    ENABLE_PROFIT_ALERTS:  envBool('ENABLE_PROFIT_ALERTS', true),
    /** Kirim notif stop-loss ke channel */
    ENABLE_STOPLOSS_ALERTS: envBool('ENABLE_STOPLOSS_ALERTS', true),
    /** Kirim notif auto-buy ke channel */
    ENABLE_BUY_ALERTS:     envBool('ENABLE_BUY_ALERTS', true),
    TELEGRAM_RATE_LIMIT_MS: envInt('TELEGRAM_RATE_LIMIT_MS', 1300),
    TELEGRAM_MAX_RETRY_429: envInt('TELEGRAM_MAX_RETRY_429', 8),
    TELEGRAM_DEDUPE_WINDOW_MS: envInt('TELEGRAM_DEDUPE_WINDOW_MS', 12000),

    // ─── Auto Trading ───────────────────────────────────────
    ENABLE_SIMULATION_MODE: envBool('ENABLE_SIMULATION_MODE', true),
    AUTO_BUY_AMOUNT_SOL:    envFloat('AUTO_BUY_AMOUNT_SOL', 0.1),
    AUTO_BUY_SLIPPAGE_BPS:  envInt('AUTO_BUY_SLIPPAGE_BPS', 1500),
    ENABLE_AUTO_POSITION_SIZING: envBool('ENABLE_AUTO_POSITION_SIZING', true),
    POSITION_SIZE_MULTIPLIER_LOW: envFloat('POSITION_SIZE_MULTIPLIER_LOW', 1.0),
    POSITION_SIZE_MULTIPLIER_MEDIUM: envFloat('POSITION_SIZE_MULTIPLIER_MEDIUM', 0.85),
    POSITION_SIZE_MULTIPLIER_HIGH: envFloat('POSITION_SIZE_MULTIPLIER_HIGH', 0.6),
    MIN_SOL_BUFFER_SOL: (() => {
        const v = envFloat('MIN_SOL_BUFFER_SOL', 0.02);
        return v >= 0 ? v : 0.02;
    })(),
    SIGNAL_MIN_SCORE: envInt('SIGNAL_MIN_SCORE', 55),
    SCORER_PROFILE: (process.env.SCORER_PROFILE || 'balanced').toLowerCase(),
    ENFORCE_PROFILE_MIN_SCORE_FLOOR: envBool('ENFORCE_PROFILE_MIN_SCORE_FLOOR', false),

    // ─── Simulasi ───────────────────────────────────────────
    SIM_EXTRA_IMPACT_BPS: envInt('SIM_EXTRA_IMPACT_BPS', 350),

    // ─── Stream Stop Loss ───────────────────────────────────
    STREAM_SL_AVG_WINDOW:  Math.min(5, Math.max(2, envInt('STREAM_SL_AVG_WINDOW', 3))),
    STREAM_SL_MIN_SAMPLES: Math.min(5, Math.max(2, envInt('STREAM_SL_MIN_SAMPLES', 2))),
    ENABLE_ADAPTIVE_STOPLOSS: envBool('ENABLE_ADAPTIVE_STOPLOSS', true),
    ADAPTIVE_SL_BASE_PCT: envFloat('ADAPTIVE_SL_BASE_PCT', 10),
    ADAPTIVE_SL_MIN_PCT: envFloat('ADAPTIVE_SL_MIN_PCT', 6),
    ADAPTIVE_SL_MAX_PCT: envFloat('ADAPTIVE_SL_MAX_PCT', 14),
    ENABLE_TIME_STOP: envBool('ENABLE_TIME_STOP', true),
    TIME_STOP_AFTER_MINUTES: envInt('TIME_STOP_AFTER_MINUTES', 20),
    TIME_STOP_MAX_DRAWDOWN_PCT: envFloat('TIME_STOP_MAX_DRAWDOWN_PCT', 6),

    // ─── Priority Fee ───────────────────────────────────────
    PRIORITY_SCORE_HIGH:              envInt('PRIORITY_SCORE_HIGH', 80),
    PRIORITY_MICRO_LAMPORTS_DEFAULT:  envInt('PRIORITY_MICRO_LAMPORTS_DEFAULT', 1_000_000),
    PRIORITY_MICRO_LAMPORTS_HIGH:     envInt('PRIORITY_MICRO_LAMPORTS_HIGH', 8_000_000),

    // ─── Dust / Sisa Token ──────────────────────────────────
    TOKEN_DUST_THRESHOLD_UI: envFloat('TOKEN_DUST_THRESHOLD_UI', 0.00001),
    SELL_DUST_EXTRA_ROUNDS:  envInt('SELL_DUST_EXTRA_ROUNDS', 2),

    // ─── Risk Management (tersentralisasi di env) ────────────
    RISK_MAX_LOSS_PCT:        envFloat('RISK_MAX_LOSS_PCT', 15),
    RISK_MAX_BUY_SOL:         envFloat('RISK_MAX_BUY_SOL', 0.5),
    RISK_MIN_BUY_SOL:         envFloat('RISK_MIN_BUY_SOL', 0.001),
    RISK_DAILY_LOSS_LIMIT_SOL: envFloat('RISK_DAILY_LOSS_LIMIT_SOL', 2.0),
    RISK_MAX_TRADES_PER_DAY:  envInt('RISK_MAX_TRADES_PER_DAY', 50),
    RISK_DEFAULT_SLIPPAGE_BPS: envInt('RISK_DEFAULT_SLIPPAGE_BPS', 1500),
    RISK_MAX_PRICE_IMPACT_PCT: envFloat('RISK_MAX_PRICE_IMPACT_PCT', 15.0),

    // ─── Pump.fun Radar ─────────────────────────────────────
    PUMP_MIN_VOLUME_SOL:   envFloat('PUMP_MIN_VOLUME_SOL', 5.0),
    PUMP_MIN_BUYERS:       envInt('PUMP_MIN_BUYERS', 10),
    PUMP_TRACK_WINDOW_MS:  envInt('PUMP_TRACK_WINDOW_MS', 3_600_000),
    PUMP_CURVE_TARGET_SOL: 85,
    PUMP_TOTAL_SUPPLY:     1_000_000_000,
    MIN_WHALE_SOL:         1.0,
    BUNDLED_WINDOW_MS:     1_500,
    STREAM_SPOT_REFRESH_DEBOUNCE_MS: envInt('STREAM_SPOT_REFRESH_DEBOUNCE_MS', 1200),
    STREAM_SPOT_MIN_REFRESH_INTERVAL_MS: envInt('STREAM_SPOT_MIN_REFRESH_INTERVAL_MS', 3000),
    PRICE_CACHE_TTL_MS: envInt('PRICE_CACHE_TTL_MS', 1500),
    HTTP_MAX_RETRIES_429: envInt('HTTP_MAX_RETRIES_429', 4),
};

// ============================================================
// LOG RINGKASAN BOOT
// ============================================================
log.cfgTitle();
log.cfgRow('Channel',            CONFIG.TELEGRAM_CHANNEL_ID);
log.cfgRow('Port',               String(CONFIG.PORT));
log.cfgRow('Simulation',         CONFIG.ENABLE_SIMULATION_MODE ? log.stateSim() : log.stateLive());
log.cfgRow('Auto-Buy',           `${CONFIG.AUTO_BUY_AMOUNT_SOL} SOL (slippage ${CONFIG.AUTO_BUY_SLIPPAGE_BPS / 100}%)`);
log.cfgRow('Auto position sizing', CONFIG.ENABLE_AUTO_POSITION_SIZING ? log.stateOn() : log.stateOff());
log.cfgRow('Min SOL buffer',     `${CONFIG.MIN_SOL_BUFFER_SOL} SOL`);
log.cfgRow('Min skor buy',       `${CONFIG.SIGNAL_MIN_SCORE}/100`);
log.cfgRow('Scorer profile',     CONFIG.SCORER_PROFILE);
log.cfgRow('Signal alerts',      CONFIG.ENABLE_SIGNAL_ALERTS  ? log.stateOn() : log.stateOff());
log.cfgRow('Profit alerts',      CONFIG.ENABLE_PROFIT_ALERTS  ? log.stateOn() : log.stateOff());
log.cfgRow('Stoploss alerts',    CONFIG.ENABLE_STOPLOSS_ALERTS ? log.stateOn() : log.stateOff());
log.cfgRow('Buy alerts',         CONFIG.ENABLE_BUY_ALERTS     ? log.stateOn() : log.stateOff());
log.cfgRow('TG rate limit',      `${CONFIG.TELEGRAM_RATE_LIMIT_MS} ms/msg`);
log.cfgRow('News polling',       CONFIG.ENABLE_NEWS_POLLING
    ? `${log.stateOn()} setiap ${CONFIG.NEWS_INTERVAL_MS / 60_000} mnt`
    : log.stateOff());
log.cfgRow('Pump radar',         CONFIG.ENABLE_PUMP_RADAR    ? log.stateOn() : log.stateOff());
log.cfgRow('Solana stream',      CONFIG.ENABLE_SOLANA_STREAM ? log.stateOn() : log.stateOff());
log.cfgRow('Copy trader',        CONFIG.ENABLE_COPY_TRADER   ? log.stateOn() : log.stateOff());
log.cfgRow('NewsData API',       CONFIG.NEWSDATA_API_KEY     ? log.stateOn() : log.stateUnknown());
log.cfgRow('Risk: SL%',          `${CONFIG.RISK_MAX_LOSS_PCT}%`);
log.cfgRow('Risk: daily limit',  `${CONFIG.RISK_DAILY_LOSS_LIMIT_SOL} SOL`);
log.cfgRow('Risk: max trades',   `${CONFIG.RISK_MAX_TRADES_PER_DAY}/hari`);
log.cfgRow('Adaptive SL',        CONFIG.ENABLE_ADAPTIVE_STOPLOSS ? log.stateOn() : log.stateOff());
log.cfgRow('Time stop',          CONFIG.ENABLE_TIME_STOP ? log.stateOn() : log.stateOff());

module.exports = CONFIG;