'use strict';

// ============================================================
// TRAILING STOP & PARTIAL TAKE PROFIT MANAGER
//
// Strategi:
//   TP1 (1.5x) → Jual 40% posisi, geser SL ke breakeven
//   TP2 (3x)   → Jual 35% lagi, trailing stop 20% dari high
//   TP3 (5x+)  → Trailing stop 15% dari high (biarkan moon)
//
// Trailing stop mengikuti harga naik secara otomatis.
// Saat harga turun X% dari high → trigger sell sisa.
// ============================================================

const TRAIL_PHASES = [
    // { multiplier: trigger x dari entry, sellPct: % posisi dijual, trailPct: trailing % setelah ini }
    { multiplier: 1.3, sellPct: 0.40, trailPct: 0.20, label: 'TP1 (1.3x)' },
    { multiplier: 2.0, sellPct: 0.30, trailPct: 0.15, label: 'TP2 (2x)' },
    { multiplier: 4.0, sellPct: 0.00, trailPct: 0.10, label: 'TP3 (4x, trail ketat)' },
];

// ============================================================
// STATE per posisi
// key: mint
// value: { highPriceSol, trailStopPct, phaseIndex, soldPct }
// ============================================================
const trailState = new Map();

function initTrail(mint, entryPriceSol) {
    trailState.set(mint, {
        entryPriceSol,
        highPriceSol:  entryPriceSol,
        trailStopPct:  null,   // null = belum aktif (masih pakai SL statis)
        phaseIndex:    0,      // index di TRAIL_PHASES yang sudah dicapai
        soldPct:       0,      // total % posisi yang sudah dijual
        breakevenSet:  false,
    });
}

function removeTrail(mint) {
    trailState.delete(mint);
}

// ============================================================
// UPDATE — panggil setiap price tick
// Returns: { action, phaseDone, sellPct, stopPrice } | null
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
            // Aktifkan trailing stop untuk fase ini
            state.trailStopPct = phase.trailPct;
            state.phaseIndex++;

            // Setelah TP1, pindahkan SL ke breakeven
            if (!state.breakevenSet && phase.label === 'TP1') {
                state.breakevenSet = true;
            }

            if (phase.sellPct > 0) {
                const remainingPct = 1 - state.soldPct;
                const sellThisPct  = phase.sellPct; // % dari posisi AWAL
                state.soldPct += sellThisPct;

                return {
                    action:    'PARTIAL_SELL',
                    phase:     phase.label,
                    sellPct:   sellThisPct,        // berapa persen dari posisi awal
                    remaining: Math.max(0, 1 - state.soldPct),
                    multiplier: multiplier.toFixed(2),
                };
            }
        } else {
            break;
        }
    }

    // --- Cek trailing stop ---
    if (state.trailStopPct !== null) {
        const trailStopPrice = state.highPriceSol * (1 - state.trailStopPct);

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

    // --- Cek breakeven SL (setelah TP1, jangan rugi) ---
    if (state.breakevenSet && currentPriceSol <= state.entryPriceSol * 1.01) {
        const remaining = 1 - state.soldPct;
        if (remaining > 0.05) { // ada sisa yang worth dijual
            return {
                action:    'BREAKEVEN_STOP',
                phase:     'BREAKEVEN',
                sellPct:   remaining,
                remaining: 0,
                multiplier: multiplier.toFixed(2),
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
    if (!state || state.trailStopPct === null) return null;
    return state.highPriceSol * (1 - state.trailStopPct);
}

module.exports = {
    initTrail,
    removeTrail,
    update,
    getState,
    getCurrentStopPrice,
    TRAIL_PHASES,
};