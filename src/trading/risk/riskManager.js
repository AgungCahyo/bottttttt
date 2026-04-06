'use strict';
const fs   = require('fs');
const path = require('path');
const log  = require('../../utils/logger');

const RISK_FILE = path.join(__dirname, '../../../trading_risk.json');

// ============================================================
// DEFAULT RISK v2 — Winrate-focused
//
// PERUBAHAN dari v1:
//   - RISK_MAX_LOSS_PCT: 15% → 10% (cut loss lebih cepat)
//     Analisis: token yang turun 10% dari entry hampir tidak pernah recover
//     Dengan SL 15% kita sering rugi lebih besar dari yang perlu
//   - RISK_MAX_TRADES_PER_DAY: 50 → 20 (kualitas > kuantitas)
//     50 trade/hari = terlalu banyak, spread too thin, kurang selektif
//     20 trade = masih banyak tapi jauh lebih terpilih
//   - RISK_DAILY_LOSS_LIMIT_SOL: tetap 2 SOL tapi dengan 20 trade
//     Artinya per trade kita rata-rata masih boleh kalah 0.1 SOL
//   - MIN_POSITION_INTERVAL_MS baru: jangan buka posisi baru dalam 30 detik
//     setelah loss — jeda sebentar, hindari revenge trading
// ============================================================

function buildDefaultRisk() {
    const CONFIG = require('../../config');
    return {
        // SL lebih ketat: 10% bukan 15%
        maxLossPerTradePct:   CONFIG.RISK_MAX_LOSS_PCT || 10,

        maxBuyAmountSol:      CONFIG.RISK_MAX_BUY_SOL     || 0.5,
        minBuyAmountSol:      CONFIG.RISK_MIN_BUY_SOL     || 0.001,
        dailyLossLimitSol:    CONFIG.RISK_DAILY_LOSS_LIMIT_SOL || 2.0,

        // Max 20 trade per hari (bukan 50)
        maxTradesPerDay:      CONFIG.RISK_MAX_TRADES_PER_DAY || 20,

        defaultSlippageBps:   CONFIG.RISK_DEFAULT_SLIPPAGE_BPS || 1500,
        maxSlippageBps:       3000,
        maxPriceImpactPct:    CONFIG.RISK_MAX_PRICE_IMPACT_PCT || 15.0,
        whitelistEnabled:     false,
        whitelist:            [],

        // Baru: cooldown setelah loss agar tidak revenge trade
        lossStreakLimit:      3,      // jika kalah 3x berturut, hentikan trading 10 menit
        lossStreakCooldownMs: 600_000, // 10 menit cooldown
    };
}

// ============================================================
// DAILY STATS
// ============================================================
function today() {
    return new Date().toISOString().slice(0, 10);
}

function makeFreshDailyStats() {
    return {
        date:           today(),
        totalLossSol:   0,
        totalProfitSol: 0,
        tradeCount:     0,
        blockedCount:   0,
        currentLossStreak: 0,
        lastLossAt:     null,
    };
}

let dailyStats = makeFreshDailyStats();

function checkDayReset() {
    if (dailyStats.date !== today()) {
        log.risk(`Hari baru (${today()}) — daily stats direset`);
        dailyStats = makeFreshDailyStats();
    }
}

function resetDailyStats() {
    const prev = { ...dailyStats };
    dailyStats = makeFreshDailyStats();
    log.risk(`Daily stats direset manual (sebelumnya: trades=${prev.tradeCount}, loss=${prev.totalLossSol.toFixed(4)} SOL)`);
    return prev;
}

// ============================================================
// LOAD / SAVE
// ============================================================
let riskConfig = null;

function loadRiskConfig() {
    const defaults = buildDefaultRisk();
    try {
        if (fs.existsSync(RISK_FILE)) {
            const saved = JSON.parse(fs.readFileSync(RISK_FILE, 'utf8'));
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

    // Selaraskan minBuyAmountSol
    const CONFIG = require('../../config');
    const auto = CONFIG.AUTO_BUY_AMOUNT_SOL;
    if (Number.isFinite(auto) && auto > 0 && riskConfig.minBuyAmountSol > auto) {
        riskConfig.minBuyAmountSol = auto;
    }

    // PAKSA maxLossPerTradePct tidak lebih dari 10 untuk winrate
    if (riskConfig.maxLossPerTradePct > 10) {
        log.risk(`maxLossPerTradePct disesuaikan ke 10% (sebelumnya ${riskConfig.maxLossPerTradePct}%)`);
        riskConfig.maxLossPerTradePct = 10;
    }

    // PAKSA maxTradesPerDay tidak lebih dari 20
    if (riskConfig.maxTradesPerDay > 20) {
        log.risk(`maxTradesPerDay disesuaikan ke 20 (sebelumnya ${riskConfig.maxTradesPerDay})`);
        riskConfig.maxTradesPerDay = 20;
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
// COOLDOWN CHECK — loss streak
// ============================================================
function isInCooldown() {
    if (!riskConfig.lossStreakLimit || !riskConfig.lossStreakCooldownMs) return false;

    const streak = dailyStats.currentLossStreak || 0;
    const lastLoss = dailyStats.lastLossAt;

    if (streak >= riskConfig.lossStreakLimit && lastLoss) {
        const elapsed = Date.now() - lastLoss;
        if (elapsed < riskConfig.lossStreakCooldownMs) {
            const remaining = Math.ceil((riskConfig.lossStreakCooldownMs - elapsed) / 60_000);
            return { cooling: true, reason: `Loss streak ${streak}x — cooldown ${remaining} menit lagi` };
        } else {
            // Cooldown selesai, reset streak
            dailyStats.currentLossStreak = 0;
        }
    }
    return false;
}

// ============================================================
// VALIDASI SEBELUM BUY
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
        return { allowed: false, reason: `Price impact terlalu besar (${priceImpactPct.toFixed(2)}%)` };

    // Cek loss streak cooldown
    const cooldown = isInCooldown();
    if (cooldown && cooldown.cooling)
        return { allowed: false, reason: cooldown.reason };

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

    if (pnlSol < 0) {
        dailyStats.totalLossSol    += Math.abs(pnlSol);
        dailyStats.currentLossStreak = (dailyStats.currentLossStreak || 0) + 1;
        dailyStats.lastLossAt       = Date.now();
    } else {
        dailyStats.totalProfitSol  += pnlSol;
        // Reset streak setelah menang
        dailyStats.currentLossStreak = 0;
    }
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
// WHITELIST
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
    resetDailyStats,
    getDailyStats,
    addToWhitelist,
    removeFromWhitelist,
};