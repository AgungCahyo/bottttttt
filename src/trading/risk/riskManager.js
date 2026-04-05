'use strict';
const fs   = require('fs');
const path = require('path');
const log  = require('../../utils/logger');

const RISK_FILE = path.join(__dirname, '../../../trading_risk.json');

// ============================================================
// DEFAULT RISK — dibaca dari CONFIG saat loadRiskConfig()
// Semua nilai ini bisa di-override via /risk_set atau file JSON
// ============================================================
function buildDefaultRisk() {
    // Lazy-require agar CONFIG sudah fully loaded
    const CONFIG = require('../../config');
    return {
        maxLossPerTradePct:   CONFIG.RISK_MAX_LOSS_PCT,
        maxBuyAmountSol:      CONFIG.RISK_MAX_BUY_SOL,
        minBuyAmountSol:      CONFIG.RISK_MIN_BUY_SOL,
        dailyLossLimitSol:    CONFIG.RISK_DAILY_LOSS_LIMIT_SOL,
        maxTradesPerDay:      CONFIG.RISK_MAX_TRADES_PER_DAY,
        defaultSlippageBps:   CONFIG.RISK_DEFAULT_SLIPPAGE_BPS,
        maxSlippageBps:       3000,
        maxPriceImpactPct:    CONFIG.RISK_MAX_PRICE_IMPACT_PCT,
        whitelistEnabled:     false,
        whitelist:            [],
    };
}

// ============================================================
// DAILY STATS — reset otomatis tiap hari baru
// ============================================================
function today() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function makeFreshDailyStats() {
    return {
        date:          today(),
        totalLossSol:  0,
        totalProfitSol: 0,
        tradeCount:    0,
        blockedCount:  0,
    };
}

let dailyStats = makeFreshDailyStats();

function checkDayReset() {
    if (dailyStats.date !== today()) {
        log.risk(`Hari baru (${today()}) — daily stats direset`);
        dailyStats = makeFreshDailyStats();
    }
}

// ============================================================
// RESET MANUAL DAILY STATS (dipanggil via command /reset_daily)
// ============================================================
function resetDailyStats() {
    const prev = { ...dailyStats };
    dailyStats = makeFreshDailyStats();
    log.risk(`Daily stats direset manual (sebelumnya: trades=${prev.tradeCount}, loss=${prev.totalLossSol.toFixed(4)} SOL)`);
    return prev;
}

// ============================================================
// LOAD / SAVE RISK CONFIG
// ============================================================
let riskConfig = null; // diisi saat loadRiskConfig()

function loadRiskConfig() {
    const defaults = buildDefaultRisk();

    try {
        if (fs.existsSync(RISK_FILE)) {
            const saved = JSON.parse(fs.readFileSync(RISK_FILE, 'utf8'));
            // Merge: file yang ada override default env, tapi tetap isi field baru dari default
            riskConfig = { ...defaults, ...saved };
            log.risk('Config dimuat dari file (merged dengan .env defaults)');
        } else {
            riskConfig = { ...defaults };
            log.risk('Config baru dari .env defaults');
        }
    } catch (err) {
        log.warn(`Gagal load risk config: ${err.message} — pakai defaults`);
        riskConfig = { ...defaults };
    }

    // Selaraskan minBuyAmountSol dengan AUTO_BUY jika lebih besar
    const CONFIG = require('../../config');
    const auto = CONFIG.AUTO_BUY_AMOUNT_SOL;
    if (Number.isFinite(auto) && auto > 0 && riskConfig.minBuyAmountSol > auto) {
        riskConfig.minBuyAmountSol = auto;
        log.risk(`minBuyAmountSol diselaraskan ke AUTO_BUY (${auto} SOL)`);
    }
}

function saveRiskConfig() {
    try {
        fs.writeFileSync(RISK_FILE, JSON.stringify(riskConfig, null, 2), 'utf8');
    } catch (err) {
        log.warn(`Gagal simpan risk config: ${err.message}`);
    }
}

function getRiskConfig() { return { ...riskConfig }; }

function updateRiskConfig(updates) {
    riskConfig = { ...riskConfig, ...updates };
    saveRiskConfig();
}

// ============================================================
// VALIDASI SEBELUM BUY
// Returns: { allowed: bool, reason: string }
// ============================================================
function validateBuy({ mint, amountSol, priceImpactPct = 0 }) {
    checkDayReset();

    if (amountSol < riskConfig.minBuyAmountSol)
        return { allowed: false, reason: `Jumlah terlalu kecil (min ${riskConfig.minBuyAmountSol} SOL)` };

    if (amountSol > riskConfig.maxBuyAmountSol)
        return { allowed: false, reason: `Jumlah melebihi batas (max ${riskConfig.maxBuyAmountSol} SOL)` };

    if (dailyStats.totalLossSol >= riskConfig.dailyLossLimitSol)
        return { allowed: false, reason: `Daily loss limit tercapai (${dailyStats.totalLossSol.toFixed(3)} SOL)` };

    if (dailyStats.tradeCount >= riskConfig.maxTradesPerDay)
        return { allowed: false, reason: `Batas trade harian tercapai (${riskConfig.maxTradesPerDay}x)` };

    if (riskConfig.whitelistEnabled && !riskConfig.whitelist.includes(mint))
        return { allowed: false, reason: `Token tidak ada di whitelist` };

    if (priceImpactPct > riskConfig.maxPriceImpactPct)
        return { allowed: false, reason: `Price impact terlalu besar (${priceImpactPct.toFixed(2)}% > ${riskConfig.maxPriceImpactPct}%)` };

    return { allowed: true, reason: 'OK' };
}

// ============================================================
// HITUNG STOP LOSS PRICE
// ============================================================
function calcStopLossPrice(entryPriceSol) {
    return entryPriceSol * (1 - riskConfig.maxLossPerTradePct / 100);
}

// ============================================================
// UPDATE STATS SETELAH TRADE
// ============================================================
function recordTrade({ pnlSol }) {
    checkDayReset();
    dailyStats.tradeCount++;
    if (pnlSol < 0) dailyStats.totalLossSol   += Math.abs(pnlSol);
    else             dailyStats.totalProfitSol += pnlSol;
}

function recordBlocked() {
    checkDayReset();
    dailyStats.blockedCount++;
}

function getDailyStats() {
    checkDayReset();
    return { ...dailyStats };
}

// ============================================================
// WHITELIST HELPERS
// ============================================================
function addToWhitelist(mint) {
    if (!riskConfig.whitelist.includes(mint)) {
        riskConfig.whitelist.push(mint);
        saveRiskConfig();
    }
}

function removeFromWhitelist(mint) {
    riskConfig.whitelist = riskConfig.whitelist.filter(m => m !== mint);
    saveRiskConfig();
}

module.exports = {
    loadRiskConfig,
    getRiskConfig,
    updateRiskConfig,
    validateBuy,
    calcStopLossPrice,
    recordTrade,
    recordBlocked,
    resetDailyStats,   // ← BARU: reset manual via command
    getDailyStats,
    addToWhitelist,
    removeFromWhitelist,
};