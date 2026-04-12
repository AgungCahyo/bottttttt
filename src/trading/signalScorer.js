'use strict';

const CONFIG = require('../config');

// Trojan/Axiom-like flow:
// 1) Timing gate  -> token tidak terlalu dini / tidak telat.
// 2) Hard filters -> rug pattern, sell pressure, concentration.
// 3) Confidence   -> weighted score dari pressure + quality + velocity.

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function linearScore(v, lo, hi) {
    if (!Number.isFinite(v)) return 0;
    if (v <= lo) return 0;
    if (v >= hi) return 1;
    return (v - lo) / (hi - lo);
}

function tradeWindows(token) {
    const tape = Array.isArray(token.tradeTape) ? token.tradeTape : [];
    const now  = Date.now();
    const win = [15_000, 45_000, 90_000];

    const agg = w => {
        const minTs = now - w;
        let buys = 0;
        let sells = 0;
        let buySol = 0;
        let sellSol = 0;
        for (const t of tape) {
            if (!t || t.ts < minTs) continue;
            if (t.type === 'buy') {
                buys++;
                buySol += Number(t.sol || 0);
            } else if (t.type === 'sell') {
                sells++;
                sellSol += Number(t.sol || 0);
            }
        }
        return { buys, sells, buySol, sellSol };
    };

    return {
        w15: agg(win[0]),
        w45: agg(win[1]),
        w90: agg(win[2]),
    };
}

function walletConcentration(token) {
    const m = token.buySolByWallet;
    if (!(m instanceof Map) || m.size === 0) return { top1Pct: 0, top3Pct: 0 };

    const vals = [...m.values()].filter(v => Number.isFinite(v) && v > 0).sort((a, b) => b - a);
    if (vals.length === 0) return { top1Pct: 0, top3Pct: 0 };

    const total = vals.reduce((a, b) => a + b, 0);
    if (!(total > 0)) return { top1Pct: 0, top3Pct: 0 };

    const top1 = vals[0] / total;
    const top3 = vals.slice(0, 3).reduce((a, b) => a + b, 0) / total;
    return { top1Pct: top1, top3Pct: top3 };
}

function minScoreToBuy() {
    const floors = { trojan_like: 84, axiom_like: 86, balanced: 80 };
    const floor = floors[CONFIG.SCORER_PROFILE] || floors.balanced;
    const n = CONFIG.SIGNAL_MIN_SCORE;
    const requested = Number.isFinite(n) ? n : floor;
    const effective = CONFIG.ENFORCE_PROFILE_MIN_SCORE_FLOOR
        ? Math.max(floor, requested)
        : requested;
    return Math.max(0, Math.min(effective, 100));
}

function calcVelocityStats(token, timeDiffSec) {
    const avgVelocity = token.buys / Math.max(timeDiffSec / 60, 0.2);
    const recentVelocity = (Number(token.recentBuys) || 0) / 0.5; // buys/min in last 30s
    const decayRatio = avgVelocity > 0 ? (recentVelocity / avgVelocity) : 1;
    return { avgVelocity, recentVelocity, decayRatio };
}

function getHardRejects(token, timeDiffSec, win, conc) {
    const rejects = [];
    const totalTx = token.buys + token.sells;
    const sellRatio = totalTx > 0 ? token.sells / totalTx : 0;
    const buyRatio45 = (win.w45.buys + win.w45.sells) > 0
        ? win.w45.buys / (win.w45.buys + win.w45.sells)
        : 1;
    const buyPressure45 = win.w45.buySol - win.w45.sellSol;
    const { decayRatio } = calcVelocityStats(token, timeDiffSec);

    // Entry timing: terlalu cepat sering noisy, terlalu lama sering sudah fade.
    if (timeDiffSec < 8) rejects.push('ENTRY_TOO_EARLY');
    if (timeDiffSec > 240) rejects.push('ENTRY_TOO_LATE');

    if (token.isDevSold) rejects.push('DEV_SOLD');
    if (token.isBundled) rejects.push('BUNDLED_LAUNCH');
    if (totalTx >= 10 && sellRatio > 0.38) rejects.push('HIGH_SELL_RATIO');
    if (win.w45.sells >= 6 && buyRatio45 < 0.58) rejects.push('SELL_PRESSURE_45S');
    if (timeDiffSec >= 45 && buyPressure45 <= 0) rejects.push('NEGATIVE_NET_FLOW');
    if (token.whales > 6) rejects.push('SUSPICIOUS_WHALE_CLUSTER');
    if (conc.top1Pct > 0.45 || conc.top3Pct > 0.78) rejects.push('WALLET_CONCENTRATED');
    if (token.volumeSol > 15 && token.buyers.size < 12) rejects.push('LOW_UNIQUE_BUYERS');
    if (timeDiffSec >= 60 && decayRatio < 0.5) rejects.push('VELOCITY_DYING');

    return Array.from(new Set(rejects));
}

function evaluate(token) {
    const timeDiffSec = Math.max((Date.now() - token.startTime) / 1000, 1);
    const totalTx = token.buys + token.sells;
    const buyers = token.buyers.size;
    const volPerBuyer = buyers > 0 ? token.volumeSol / buyers : 0;
    const windows = tradeWindows(token);
    const conc = walletConcentration(token);
    const vel = calcVelocityStats(token, timeDiffSec);

    const buyRatio = totalTx > 0 ? token.buys / totalTx : 1;
    const buyRatio45 = (windows.w45.buys + windows.w45.sells) > 0
        ? windows.w45.buys / (windows.w45.buys + windows.w45.sells)
        : 1;
    const pressure45 = windows.w45.buySol - windows.w45.sellSol;

    const rejects = getHardRejects(token, timeDiffSec, windows, conc);

    const weightsByProfile = {
        trojan_like: {
            pressure: 0.24, buyRatio: 0.11, velocity: 0.18, decay: 0.09,
            buyers: 0.11, vol: 0.08, whale: 0.06, conc: 0.07, timing: 0.06,
        },
        axiom_like: {
            pressure: 0.18, buyRatio: 0.14, velocity: 0.12, decay: 0.13,
            buyers: 0.16, vol: 0.11, whale: 0.08, conc: 0.06, timing: 0.02,
        },
        balanced: {
            pressure: 0.22, buyRatio: 0.12, velocity: 0.16, decay: 0.10,
            buyers: 0.13, vol: 0.10, whale: 0.07, conc: 0.06, timing: 0.04,
        },
    };
    const w = weightsByProfile[CONFIG.SCORER_PROFILE] || weightsByProfile.balanced;

    const sPressure = linearScore(pressure45, 0.5, 9.0);
    const sBuyRatio = linearScore(buyRatio45, 0.58, 0.92);
    const sVelocity = linearScore(vel.recentVelocity, 8, 45);
    const sDecay    = linearScore(vel.decayRatio, 0.6, 1.6);
    const sBuyers   = linearScore(buyers, 8, 55);
    const sVolQual  = linearScore(volPerBuyer, 0.05, 0.5);
    const sWhaleBal = 1 - linearScore(token.whales, 4, 9); // too many whales = worse
    const sConc     = 1 - linearScore(conc.top3Pct, 0.62, 0.86);
    const sTiming   = 1 - Math.abs(clamp((timeDiffSec - 45) / 90, -1, 1)); // best around early trend phase

    const weighted =
        (sPressure * w.pressure) +
        (sBuyRatio * w.buyRatio) +
        (sVelocity * w.velocity) +
        (sDecay * w.decay) +
        (sBuyers * w.buyers) +
        (sVolQual * w.vol) +
        (sWhaleBal * w.whale) +
        (sConc * w.conc) +
        (sTiming * w.timing);

    const bonus =
        (buyRatio >= 0.8 && buyers >= 20 && vel.decayRatio >= 0.85 && pressure45 > 1.5)
            ? 5
            : 0;

    const total = clamp(Math.round(weighted * 100 + bonus), 0, 100);
    const minS = minScoreToBuy();
    const shouldBuy = rejects.length === 0 && total >= minS;

    // Risk regime exported to execution layer for adaptive stop-loss sizing.
    let riskLevel = 'medium';
    if (total >= 90 && rejects.length === 0 && vel.decayRatio >= 0.9 && buyRatio45 >= 0.75) riskLevel = 'low';
    else if (total < 85 || vel.decayRatio < 0.75 || conc.top1Pct > 0.35) riskLevel = 'high';

    const recommendedSlPct = riskLevel === 'low' ? 7.5 : riskLevel === 'high' ? 11.5 : 9.5;

    const breakdown = {
        pressure: Number((sPressure * 100).toFixed(0)),
        buyRatio45: Number((sBuyRatio * 100).toFixed(0)),
        velocityNow: Number((sVelocity * 100).toFixed(0)),
        momentumDecay: Number((sDecay * 100).toFixed(0)),
        buyers: Number((sBuyers * 100).toFixed(0)),
        volumeQuality: Number((sVolQual * 100).toFixed(0)),
        whaleBalance: Number((sWhaleBal * 100).toFixed(0)),
        walletDistribution: Number((sConc * 100).toFixed(0)),
        timing: Number((sTiming * 100).toFixed(0)),
        bonus,
    };

    return {
        shouldBuy,
        score: total,
        rejects,
        breakdown,
        velocity: vel.recentVelocity.toFixed(1),
        minScore: minS,
        riskLevel,
        recommendedSlPct,
        profile: CONFIG.SCORER_PROFILE || 'balanced',
    };
}

module.exports = { evaluate, minScoreToBuy };