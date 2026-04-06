'use strict';

// ============================================================
// TRAILING STOP & PARTIAL TAKE PROFIT MANAGER v2
//
// MASALAH LAMA (dari log):
//   - TP1 di 1.3x → exit terlalu cepat, sering cuma dapet 1.0-1.2x
//   - Trail distance 20% terlalu ketat → trigger noise, bukan reversal
//   - Banyak coin lanjut ke 3x-8x setelah kita exit di 1.2x
//   - BREAKEVEN terlalu agresif → exit di 1.01x, rugi net karena fee
//
// STRATEGI BARU:
//   TP1 (2.0x) → Jual 30% posisi, SL geser ke 1.3x (lock profit)
//   TP2 (4.0x) → Jual 30% lagi, trailing 25% dari high
//   TP3 (8x+)  → Trailing ketat 15% (biarkan moon)
//   TRAIL      → Sell sisa dengan trail lebih lebar di awal
//
// Prinsip: "Let winners run, cut losers fast"
// SL statis di trading engine tetap menjaga downside (-10%)
// Trailing hanya aktif setelah ada profit signifikan (2x)
// ============================================================

const TRAIL_PHASES = [
    // TP1: tunggu 2x sebelum jual — jangan keluar terlalu cepat
    {
        multiplier: 2.0,
        sellPct:    0.30,   // jual 30% dari posisi awal
        trailPct:   0.30,   // trail 30% dari high (longgar)
        lockPct:    1.30,   // SL naik ke 1.3x entry (lock profit)
        label:      'TP1 (2x)',
    },
    // TP2: 4x → jual 30% lagi, trail lebih ketat
    {
        multiplier: 4.0,
        sellPct:    0.30,
        trailPct:   0.25,   // trail 25% dari high
        lockPct:    null,   // SL sudah terkunci dari TP1
        label:      'TP2 (4x)',
    },
    // TP3: 8x → jangan jual, perketat trail
    {
        multiplier: 8.0,
        sellPct:    0.00,   // jangan jual di sini
        trailPct:   0.15,   // trailing sangat ketat
        lockPct:    null,
        label:      'TP3 (8x, trail ketat)',
    },
];

// ============================================================
// STATE per posisi
// ============================================================
const trailState = new Map();

function initTrail(mint, entryPriceSol) {
    trailState.set(mint, {
        entryPriceSol,
        highPriceSol:    entryPriceSol,
        trailStopPct:    null,   // null = belum aktif (SL statis menangani)
        lockStopPrice:   null,   // harga lock minimum (tidak pernah turun dari ini)
        phaseIndex:      0,
        soldPct:         0,
        breakevenLocked: false,
    });
}

function removeTrail(mint) {
    trailState.delete(mint);
}

// ============================================================
// UPDATE — panggil setiap price tick
// Returns: { action, phase, sellPct, remaining, multiplier, stopPrice } | null
// ============================================================
function update(mint, currentPriceSol) {
    const state = trailState.get(mint);
    if (!state) return null;

    // Update high water mark
    if (currentPriceSol > state.highPriceSol) {
        state.highPriceSol = currentPriceSol;
    }

    const multiplier = currentPriceSol / state.entryPriceSol;

    // --- Cek apakah ada fase baru yang tercapai ---
    while (state.phaseIndex < TRAIL_PHASES.length) {
        const phase = TRAIL_PHASES[state.phaseIndex];

        if (multiplier >= phase.multiplier) {
            // Aktifkan atau perketat trailing stop
            state.trailStopPct = phase.trailPct;
            state.phaseIndex++;

            // Lock SL di level minimum jika ada
            if (phase.lockPct != null) {
                const lockPrice = state.entryPriceSol * phase.lockPct;
                if (state.lockStopPrice == null || lockPrice > state.lockStopPrice) {
                    state.lockStopPrice = lockPrice;
                }
            }

            if (phase.sellPct > 0) {
                state.soldPct += phase.sellPct;

                return {
                    action:    'PARTIAL_SELL',
                    phase:     phase.label,
                    sellPct:   phase.sellPct,
                    remaining: Math.max(0, 1 - state.soldPct),
                    multiplier: multiplier.toFixed(2),
                    stopPrice: state.highPriceSol * (1 - phase.trailPct),
                };
            }
            // Jika sellPct = 0 (TP3), tidak return — lanjut ke fase berikutnya atau trailing
        } else {
            break;
        }
    }

    // --- Cek trailing stop ---
    if (state.trailStopPct !== null) {
        const rawTrailStop  = state.highPriceSol * (1 - state.trailStopPct);

        // Trailing stop tidak boleh turun di bawah lock price
        const trailStopPrice = state.lockStopPrice != null
            ? Math.max(rawTrailStop, state.lockStopPrice)
            : rawTrailStop;

        if (currentPriceSol <= trailStopPrice) {
            const remaining = 1 - state.soldPct;
            return {
                action:    'TRAIL_STOP',
                phase:     'TRAILING_STOP',
                sellPct:   remaining,
                remaining: 0,
                multiplier: multiplier.toFixed(2),
                highPrice:  state.highPriceSol,
                stopPrice:  trailStopPrice,
            };
        }
    }

    // --- LOCK STOP: SL terkunci di level tertentu setelah TP1 ---
    // Ini menggantikan BREAKEVEN yang terlalu agresif
    if (state.lockStopPrice != null && currentPriceSol <= state.lockStopPrice) {
        const remaining = 1 - state.soldPct;
        if (remaining > 0.05) {
            return {
                action:    'LOCK_STOP',
                phase:     'LOCK_STOP',
                sellPct:   remaining,
                remaining: 0,
                multiplier: multiplier.toFixed(2),
                stopPrice:  state.lockStopPrice,
            };
        }
    }

    return null; // tidak ada aksi
}

// ============================================================
// GETTERS
// ============================================================
function getState(mint) {
    return trailState.get(mint) || null;
}

function getCurrentStopPrice(mint) {
    const state = trailState.get(mint);
    if (!state) return null;

    const candidates = [];
    if (state.trailStopPct != null)
        candidates.push(state.highPriceSol * (1 - state.trailStopPct));
    if (state.lockStopPrice != null)
        candidates.push(state.lockStopPrice);

    if (candidates.length === 0) return null;
    return Math.max(...candidates); // gunakan yang tertinggi (paling protektif)
}

module.exports = {
    initTrail,
    removeTrail,
    update,
    getState,
    getCurrentStopPrice,
    TRAIL_PHASES,
};