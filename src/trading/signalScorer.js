'use strict';

// ============================================================
// SIGNAL SCORER
// Hitung skor kualitas token sebelum auto-buy.
// Tujuan: filter token sampah, naikkan winrate.
//
// Skor 0-100. AUTO-BUY hanya jika skor >= MIN_SCORE
// dan tidak ada flag HARD REJECT.
// ============================================================

const MIN_SCORE_TO_BUY = 55; // Threshold minimum untuk auto-buy

// ============================================================
// HARD REJECT — langsung gagal tanpa hitung skor
// ============================================================
function getHardRejects(token, timeDiffSec) {
    const rejects = [];

    // Dev sudah jual → rug signal terkuat
    if (token.isDevSold)
        rejects.push('DEV_SOLD');

    // Rasio sell terlalu tinggi di awal (> 40% transaksi adalah sell)
    const totalTx = token.buys + token.sells;
    if (totalTx > 10 && token.sells / totalTx > 0.4)
        rejects.push('HIGH_SELL_RATIO');

    // Terlalu banyak whale di 30 detik pertama → kemungkinan insider/bundled
    if (timeDiffSec < 30 && token.whales > 5)
        rejects.push('SUSPICIOUS_WHALE_CLUSTER');

    // Volume besar tapi buyer sedikit → manipulasi / wash trading
    if (token.volumeSol > 20 && token.buyers.size < 8)
        rejects.push('LOW_UNIQUE_BUYERS');

    return rejects;
}

// ============================================================
// SCORING BREAKDOWN
// Setiap faktor diberi bobot. Total maks = 100.
// ============================================================
function calcScore(token, timeDiffSec) {
    let score  = 0;
    const breakdown = {};

    // --- 1. MOMENTUM (25 pts) ---
    // Velocity = buys per menit
    const velocity = token.buys / Math.max(timeDiffSec / 60, 0.1);

    if (velocity >= 30)      { score += 25; breakdown.momentum = 25; }
    else if (velocity >= 20) { score += 20; breakdown.momentum = 20; }
    else if (velocity >= 10) { score += 12; breakdown.momentum = 12; }
    else if (velocity >= 5)  { score += 5;  breakdown.momentum = 5;  }
    else                     { score += 0;  breakdown.momentum = 0;  }

    // --- 2. BUYER DIVERSITY (20 pts) ---
    // Banyak buyer unik = demand organik
    const buyers = token.buyers.size;
    if (buyers >= 50)      { score += 20; breakdown.buyers = 20; }
    else if (buyers >= 30) { score += 16; breakdown.buyers = 16; }
    else if (buyers >= 20) { score += 12; breakdown.buyers = 12; }
    else if (buyers >= 10) { score += 6;  breakdown.buyers = 6;  }
    else                   { score += 0;  breakdown.buyers = 0;  }

    // --- 3. VOLUME QUALITY (20 pts) ---
    // Volume per buyer = ukuran komitmen rata-rata
    const volPerBuyer = token.buyers.size > 0
        ? token.volumeSol / token.buyers.size : 0;

    if (volPerBuyer >= 0.3)      { score += 20; breakdown.volume = 20; }
    else if (volPerBuyer >= 0.15) { score += 15; breakdown.volume = 15; }
    else if (volPerBuyer >= 0.07) { score += 8;  breakdown.volume = 8;  }
    else                          { score += 3;  breakdown.volume = 3;  }

    // --- 4. WHALE SIGNAL (15 pts) ---
    // Ada whale = ada modal besar yang percaya token ini
    if (token.whales >= 3 && token.maxWhaleBuy >= 2)  { score += 15; breakdown.whale = 15; }
    else if (token.whales >= 2)                        { score += 10; breakdown.whale = 10; }
    else if (token.whales >= 1)                        { score += 6;  breakdown.whale = 6;  }
    else                                               { score += 0;  breakdown.whale = 0;  }

    // --- 5. BUY/SELL RATIO (10 pts) ---
    // Semakin banyak beli vs jual = sentiment positif
    const totalTx = token.buys + token.sells;
    const buyRatio = totalTx > 0 ? token.buys / totalTx : 1;

    if (buyRatio >= 0.85)      { score += 10; breakdown.bsRatio = 10; }
    else if (buyRatio >= 0.75) { score += 7;  breakdown.bsRatio = 7;  }
    else if (buyRatio >= 0.65) { score += 4;  breakdown.bsRatio = 4;  }
    else                       { score += 0;  breakdown.bsRatio = 0;  }

    // --- 6. SPEED (launch time) (10 pts) ---
    // Pump kencang di awal = FOMO natural
    if (timeDiffSec <= 60)       { score += 10; breakdown.speed = 10; }
    else if (timeDiffSec <= 120) { score += 7;  breakdown.speed = 7;  }
    else if (timeDiffSec <= 180) { score += 4;  breakdown.speed = 4;  }
    else                         { score += 0;  breakdown.speed = 0;  }

    // --- PENALTY ---
    // Bundled launch mengurangi skor (tapi tidak hard reject)
    if (token.isBundled) {
        score -= 15;
        breakdown.bundledPenalty = -15;
    }

    return {
        total: Math.max(0, Math.min(100, score)),
        breakdown,
        velocity: velocity.toFixed(1),
    };
}

// ============================================================
// MAIN EVALUATE FUNCTION
// Returns: { shouldBuy, score, rejects, breakdown, velocity }
// ============================================================
function evaluate(token) {
    const timeDiffSec = Math.max((Date.now() - token.startTime) / 1000, 1);

    const rejects   = getHardRejects(token, timeDiffSec);
    const { total, breakdown, velocity } = calcScore(token, timeDiffSec);

    const shouldBuy = rejects.length === 0 && total >= MIN_SCORE_TO_BUY;

    return {
        shouldBuy,
        score:    total,
        rejects,
        breakdown,
        velocity,
        minScore: MIN_SCORE_TO_BUY,
    };
}

module.exports = { evaluate, MIN_SCORE_TO_BUY };