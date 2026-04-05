'use strict';
const fs   = require('fs');
const path = require('path');
const CONFIG = require('../../config');
const log  = require('../../utils/logger');

const RISK_FILE = path.join(__dirname, '../../../trading_risk.json');

// ============================================================
// DEFAULT RISK CONFIG
// Edit via /trading_config command atau langsung di .env
// ============================================================
const DEFAULT_RISK = {
    // Per-trade
    maxLossPerTradePct:  15,     // SL -15% (lebih aman untuk disiplin)
    maxBuyAmountSol:     0.5,
    minBuyAmountSol:     0.001,

    // Harian
    dailyLossLimitSol:   2.0,
    maxTradesPerDay:     50,

    // Token
    whitelistEnabled:    false,
    whitelist:           [],

    // Slippage
    defaultSlippageBps:  1500,   // 15% (pump.fun butuh slippage tinggi)
    maxSlippageBps:      3000,   // 30% max

    // Price Impact
    maxPriceImpactPct:   15.0,   // Naikkan dari 3% → 15% untuk meme coin
};

// ============================================================
// DAILY STATS (reset tiap hari)
// ============================================================
let dailyStats = {
    date:        today(),
    totalLossSol: 0,
    totalProfitSol: 0,
    tradeCount:  0,
    blockedCount: 0,
};

function today() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function checkDayReset() {
    if (dailyStats.date !== today()) {
        dailyStats = { date: today(), totalLossSol: 0, totalProfitSol: 0, tradeCount: 0, blockedCount: 0 };
        log.risk('Daily stats direset (hari baru)');
    }
}

// ============================================================
// LOAD / SAVE RISK CONFIG
// ============================================================
let riskConfig = { ...DEFAULT_RISK };

function loadRiskConfig() {
    try {
        if (fs.existsSync(RISK_FILE)) {
            const saved = JSON.parse(fs.readFileSync(RISK_FILE, 'utf8'));
            riskConfig = { ...DEFAULT_RISK, ...saved };
            log.risk('Config dimuat dari file');
        }
    } catch (err) {
        log.riskWarn(`Gagal load risk config: ${err.message}`);
    }
    // Samakan min buy dengan AUTO_BUY: file lama sering punya min 0.01 padahal .env 0.001
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
        log.riskWarn(`Gagal simpan risk config: ${err.message}`);
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

    // 1. Jumlah minimum & maksimum
    if (amountSol < riskConfig.minBuyAmountSol)
        return { allowed: false, reason: `Jumlah terlalu kecil (min ${riskConfig.minBuyAmountSol} SOL)` };

    if (amountSol > riskConfig.maxBuyAmountSol)
        return { allowed: false, reason: `Jumlah melebihi batas (max ${riskConfig.maxBuyAmountSol} SOL)` };

    // 2. Daily loss limit
    if (dailyStats.totalLossSol >= riskConfig.dailyLossLimitSol)
        return { allowed: false, reason: `Daily loss limit tercapai (${dailyStats.totalLossSol.toFixed(3)} SOL)` };

    // 3. Max trades per day
    if (dailyStats.tradeCount >= riskConfig.maxTradesPerDay)
        return { allowed: false, reason: `Batas trade harian tercapai (${riskConfig.maxTradesPerDay}x)` };

    // 4. Whitelist
    if (riskConfig.whitelistEnabled && !riskConfig.whitelist.includes(mint))
        return { allowed: false, reason: `Token tidak ada di whitelist` };

    // 5. Price impact
    if (priceImpactPct > riskConfig.maxPriceImpactPct)
        return { allowed: false, reason: `Price impact terlalu besar (${priceImpactPct.toFixed(2)}% > ${riskConfig.maxPriceImpactPct}%)` };

    return { allowed: true, reason: 'OK' };
}

// ============================================================
// HITUNG STOP LOSS PRICE
// ============================================================
function calcStopLossPrice(entryPriceSol) {
    const lossPct = riskConfig.maxLossPerTradePct / 100;
    return entryPriceSol * (1 - lossPct);
}

// ============================================================
// UPDATE STATS SETELAH TRADE
// ============================================================
function recordTrade({ pnlSol }) {
    checkDayReset();
    dailyStats.tradeCount++;
    if (pnlSol < 0) dailyStats.totalLossSol  += Math.abs(pnlSol);
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
    getDailyStats,
    addToWhitelist,
    removeFromWhitelist,
};