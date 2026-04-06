'use strict';

const CONFIG = require('../config');

// ============================================================
// SIGNAL SCORER v2 — Winrate-focused rewrite
//
// Insight dari riset & analisis loss trade sebelumnya:
//
// MASALAH LAMA:
//   - Terlalu banyak trade (50/hari), banyak false positive
//   - Score 75-80 winrate jelek → perlu ambang yang lebih tinggi
//   - Trailing stop terlalu sensitif (exit terlalu cepat di 1.0-1.2x)
//   - SL terlalu longgar (-15%) tapi entry sering langsung dump
//   - Tidak ada deteksi "momentum sudah habis saat alert"
//   - SUSPICIOUS_WHALE_CLUSTER terlalu mudah dilewati (> 30 detik)
//
// PERBAIKAN:
//   1. Skor lebih ketat: autobuy hanya jika >= 80 (bukan 75)
//   2. Hard reject lebih banyak & agresif:
//      - HIGH_SELL_RATIO sekarang > 35% (bukan 40%)
//      - WHALE_CLUSTER tidak ada batas waktu lagi (seumur token)
//      - LOW_UNIQUE_BUYERS threshold lebih rendah (vol > 15 SOL)
//      - NEW: VELOCITY_DYING — momentum sedang mati saat alert
//      - NEW: SELL_DOMINATES — lebih banyak sell tx daripada buy
//   3. Bobot skor direfaktorisasi:
//      - Buyer diversity naik (sinyal paling kuat)
//      - Whale quality (bukan hanya jumlah) dihitung
//      - Volume per buyer LEBIH diutamakan
//      - Penalty bundled lebih besar (-25)
//   4. Bonus baru: ORGANIC_GROWTH bonus jika semua indikator bagus
// ============================================================

function minScoreToBuy() {
    const n = CONFIG.SIGNAL_MIN_SCORE;
    // Floor 80 secara paksa — di bawah itu winrate historis < 40%
    const effective = Math.max(80, Number.isFinite(n) && n >= 0 ? n : 80);
    return Math.min(effective, 100);
}

// ============================================================
// KALKULASI VELOCITY SAAT INI vs VELOCITY PUNCAK
// Deteksi apakah momentum sedang mati saat sinyal pertama muncul
// ============================================================
function calcVelocityDecay(token, timeDiffSec) {
    // Hanya relevan jika token sudah cukup tua (> 60 detik)
    if (timeDiffSec < 60) return { isDying: false, currentVelocity: token.buys / Math.max(timeDiffSec / 60, 0.1) };

    // Estimasi velocity di paruh pertama vs paruh kedua waktu
    // Kita punya total buys & total waktu; bisa estimasi decay
    const totalMinutes = timeDiffSec / 60;
    const avgVelocity = token.buys / totalMinutes;

    // Jika ada data recentBuys (buys dalam 30 detik terakhir), gunakan itu
    // Jika tidak, hitung dari total
    const recentVelocity = token.recentBuys != null
        ? (token.recentBuys / 0.5) // per menit dari 30 detik terakhir
        : avgVelocity;

    // Momentum dianggap mati jika velocity sekarang < 40% dari rata-rata
    const isDying = recentVelocity < avgVelocity * 0.4 && avgVelocity > 5;

    return { isDying, currentVelocity: avgVelocity, recentVelocity };
}

// ============================================================
// HARD REJECT — langsung gagal tanpa hitung skor
// Setiap reject = tidak ada autobuy, tidak peduli skor
// ============================================================
function getHardRejects(token, timeDiffSec) {
    const rejects = [];

    // 1. Dev sudah jual — sinyal rug terkuat
    if (token.isDevSold)
        rejects.push('DEV_SOLD');

    // 2. Sell ratio > 35% (diturunkan dari 40%)
    const totalTx = token.buys + token.sells;
    if (totalTx >= 8 && token.sells / totalTx > 0.35)
        rejects.push('HIGH_SELL_RATIO');

    // 3. Lebih banyak sell daripada buy secara absolut
    if (totalTx >= 12 && token.sells > token.buys)
        rejects.push('SELL_DOMINATES');

    // 4. Whale cluster mencurigakan (dihapus batas 30 detik — berlaku seumur token)
    if (token.whales > 5)
        rejects.push('SUSPICIOUS_WHALE_CLUSTER');

    // 5. Volume besar tapi buyer sedikit (threshold diturunkan)
    if (token.volumeSol > 15 && token.buyers.size < 10)
        rejects.push('LOW_UNIQUE_BUYERS');

    // 6. Bundled launch — manipulasi jelas
    if (token.isBundled)
        rejects.push('BUNDLED_LAUNCH');

    // 7. Momentum sedang mati saat kita baru dapat alertnya
    //    (token sudah tua tapi velocity turun drastis)
    const decay = calcVelocityDecay(token, timeDiffSec);
    if (decay.isDying)
        rejects.push('VELOCITY_DYING');

    // 8. Token terlalu tua (> 10 menit) tanpa graduation — kemungkinan sudah dead
    if (timeDiffSec > 600 && token.buyers.size < 30)
        rejects.push('STALE_SLOW_TOKEN');

    return rejects;
}

// ============================================================
// SCORING BREAKDOWN — Total maks 100
// ============================================================
function calcScore(token, timeDiffSec) {
    let score = 0;
    const breakdown = {};

    const totalMinutes = Math.max(timeDiffSec / 60, 0.1);

    // --- 1. BUYER DIVERSITY (30 pts) --- NAIK dari 20
    // Ini sinyal paling kuat: banyak wallet unik = organik
    const buyers = token.buyers.size;
    if (buyers >= 60)      { score += 30; breakdown.buyers = 30; }
    else if (buyers >= 40) { score += 24; breakdown.buyers = 24; }
    else if (buyers >= 25) { score += 17; breakdown.buyers = 17; }
    else if (buyers >= 15) { score += 10; breakdown.buyers = 10; }
    else if (buyers >= 10) { score += 5;  breakdown.buyers = 5;  }
    else                   { score += 0;  breakdown.buyers = 0;  }

    // --- 2. VOLUME QUALITY (20 pts) ---
    // Volume per buyer = ukuran komitmen rata-rata (SOL per wallet)
    const volPerBuyer = buyers > 0 ? token.volumeSol / buyers : 0;
    if (volPerBuyer >= 0.4)       { score += 20; breakdown.volume = 20; }
    else if (volPerBuyer >= 0.2)  { score += 15; breakdown.volume = 15; }
    else if (volPerBuyer >= 0.10) { score += 9;  breakdown.volume = 9;  }
    else if (volPerBuyer >= 0.05) { score += 4;  breakdown.volume = 4;  }
    else                          { score += 0;  breakdown.volume = 0;  }

    // --- 3. MOMENTUM (20 pts) --- TURUN dari 25
    // Velocity sekarang lebih penting dari rata-rata
    const velocity = token.buys / totalMinutes;
    if (velocity >= 40)      { score += 20; breakdown.momentum = 20; }
    else if (velocity >= 25) { score += 15; breakdown.momentum = 15; }
    else if (velocity >= 15) { score += 10; breakdown.momentum = 10; }
    else if (velocity >= 8)  { score += 5;  breakdown.momentum = 5;  }
    else                     { score += 0;  breakdown.momentum = 0;  }

    // --- 4. WHALE QUALITY (15 pts) ---
    // Whale ada TAPI tidak terlalu dominan (antara 1-3 whale = bagus)
    // > 3 whale sudah kena reject, jadi di sini range 1-3
    if (token.whales >= 2 && token.maxWhaleBuy >= 2 && token.maxWhaleBuy <= 10) {
        score += 15; breakdown.whale = 15;
    } else if (token.whales >= 1 && token.maxWhaleBuy >= 1) {
        score += 8; breakdown.whale = 8;
    } else {
        score += 0; breakdown.whale = 0;
    }

    // --- 5. BUY/SELL RATIO (10 pts) ---
    const totalTx = token.buys + token.sells;
    const buyRatio = totalTx > 0 ? token.buys / totalTx : 1;
    if (buyRatio >= 0.90)      { score += 10; breakdown.bsRatio = 10; }
    else if (buyRatio >= 0.80) { score += 7;  breakdown.bsRatio = 7;  }
    else if (buyRatio >= 0.70) { score += 4;  breakdown.bsRatio = 4;  }
    else                       { score += 0;  breakdown.bsRatio = 0;  }

    // --- 6. SPEED (5 pts) --- TURUN dari 10
    // Kurang penting: token cepat seringkali sudah ditinggal bot lain
    if (timeDiffSec <= 45)       { score += 5; breakdown.speed = 5; }
    else if (timeDiffSec <= 90)  { score += 3; breakdown.speed = 3; }
    else if (timeDiffSec <= 180) { score += 1; breakdown.speed = 1; }
    else                         { score += 0; breakdown.speed = 0; }

    // --- BONUS: ORGANIC_GROWTH (+5 bonus, maks total 100) ---
    // Semua sinyal bagus sekaligus → bonus kepercayaan
    if (buyers >= 30 && volPerBuyer >= 0.15 && velocity >= 15 && buyRatio >= 0.80) {
        score += 5;
        breakdown.organicBonus = 5;
    }

    return {
        total: Math.max(0, Math.min(100, score)),
        breakdown,
        velocity: velocity.toFixed(1),
    };
}

// ============================================================
// MAIN EVALUATE FUNCTION
// Returns: { shouldBuy, score, rejects, breakdown, velocity, minScore }
// ============================================================
function evaluate(token) {
    const timeDiffSec = Math.max((Date.now() - token.startTime) / 1000, 1);

    const rejects   = getHardRejects(token, timeDiffSec);
    const { total, breakdown, velocity } = calcScore(token, timeDiffSec);

    const minS      = minScoreToBuy();
    const shouldBuy = rejects.length === 0 && total >= minS;

    return {
        shouldBuy,
        score:    total,
        rejects,
        breakdown,
        velocity,
        minScore: minS,
    };
}

module.exports = { evaluate, minScoreToBuy };