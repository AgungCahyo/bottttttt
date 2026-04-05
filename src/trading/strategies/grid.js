'use strict';
const fs   = require('fs');
const path = require('path');

const jupiter     = require('../jupiterClient');
const riskManager = require('../risk/riskManager');
const posTracker  = require('../positionTracker');
const { sendToChannel } = require('../../services/telegram');
const { esc } = require('../../utils/helpers');
const log = require('../../utils/logger');

const GRID_FILE = path.join(__dirname, '../../../trading_grid.json');

// ============================================================
// GRID PLAN STORE
// Grid: beli di harga rendah, jual di harga tinggi berulang
// ============================================================
let gridPlans = new Map();

function loadGridPlans() {
    try {
        if (fs.existsSync(GRID_FILE)) {
            const arr = JSON.parse(fs.readFileSync(GRID_FILE, 'utf8'));
            gridPlans = new Map(arr.map(p => [p.id, p]));
            log.load(`Grid plans: ${gridPlans.size}`);
        }
    } catch { /* ignore */ }
}

function saveGridPlans() {
    try {
        fs.writeFileSync(GRID_FILE, JSON.stringify([...gridPlans.values()], null, 2), 'utf8');
    } catch { /* ignore */ }
}

// ============================================================
// BUILD GRID LEVELS
// ============================================================
function buildGridLevels(lowerPrice, upperPrice, gridCount) {
    const step = (upperPrice - lowerPrice) / gridCount;
    return Array.from({ length: gridCount + 1 }, (_, i) => ({
        price:    lowerPrice + step * i,
        hasOrder: false,
        filled:   false,
    }));
}

// ============================================================
// CREATE GRID PLAN
// ============================================================
function createGridPlan({ mint, symbol, totalSol, lowerPrice, upperPrice, gridCount = 10, stopLossPct = 20 }) {
    const perGridSol = totalSol / gridCount;
    const id = `grid_${mint.slice(0, 6)}_${Date.now()}`;

    const plan = {
        id,
        mint,
        symbol:      symbol || mint.slice(0, 8),
        totalSol,
        perGridSol,
        lowerPrice,
        upperPrice,
        gridCount,
        stopLossPct,
        levels:      buildGridLevels(lowerPrice, upperPrice, gridCount),
        active:      true,
        totalPnlSol: 0,
        trades:      0,
        createdAt:   Date.now(),
    };

    gridPlans.set(id, plan);
    saveGridPlans();
    log.plan(`Grid ${symbol} — ${gridCount} level [${lowerPrice.toFixed(8)} – ${upperPrice.toFixed(8)} SOL]`);
    return plan;
}

// ============================================================
// PROCESS GRID TICK (dipanggil dengan harga terkini)
// ============================================================
async function processGridTick(plan, currentPriceSol) {
    if (!plan.active) return;

    const risk = riskManager.getRiskConfig();

    // Stop loss seluruh grid
    const stopLoss = plan.lowerPrice * (1 - plan.stopLossPct / 100);
    if (currentPriceSol < stopLoss) {
        plan.active = false;
        saveGridPlans();
        await sendToChannel(
            `🛑 <b>GRID STOP LOSS</b>\n🪙 ${esc(plan.symbol)}\n` +
            `Harga: ${currentPriceSol.toFixed(8)} SOL\n` +
            `Total PnL: ${plan.totalPnlSol >= 0 ? '+' : ''}${plan.totalPnlSol.toFixed(4)} SOL`
        );
        return;
    }

    for (let i = 0; i < plan.levels.length - 1; i++) {
        const buyLevel  = plan.levels[i];
        const sellLevel = plan.levels[i + 1];

        // BUY: harga turun ke level bawah & belum ada order
        if (!buyLevel.hasOrder && currentPriceSol <= buyLevel.price) {
            const check = riskManager.validateBuy({ mint: plan.mint, amountSol: plan.perGridSol });
            if (!check.allowed) continue;

            try {
                const result = await jupiter.executeSwap({
                    inputMint:     jupiter.SOL_MINT,
                    outputMint:    plan.mint,
                    amountLamports: Math.floor(plan.perGridSol * 1e9),
                    slippageBps:   risk.defaultSlippageBps,
                });

                buyLevel.hasOrder  = true;
                buyLevel.tokenAmt  = result.outputAmount;
                buyLevel.buyPrice  = currentPriceSol;
                buyLevel.buyTxid   = result.txid;
                plan.trades++;
                saveGridPlans();

                await sendToChannel(
                    `🟢 <b>GRID BUY</b> — ${esc(plan.symbol)}\n` +
                    `📊 Level ${i + 1}/${plan.gridCount}\n` +
                    `💰 ${plan.perGridSol} SOL → ${result.outputAmount.toFixed(2)} token\n` +
                    `📍 Price: ${currentPriceSol.toFixed(8)} SOL\n` +
                    `🔗 <a href="https://solscan.io/tx/${result.txid}">Solscan</a>`
                );
            } catch (err) {
                log.gridErr(`Grid buy: ${err.message}`);
            }
        }

        // SELL: harga naik ke level atas & level bawah sudah terisi
        if (buyLevel.hasOrder && !buyLevel.filled && currentPriceSol >= sellLevel.price) {
            try {
                const tokenAmt = buyLevel.tokenAmt || 0;
                if (tokenAmt <= 0) continue;

                const tokenLamports = Math.floor(tokenAmt * 1e6); // asumsi 6 desimal
                const result = await jupiter.executeSwap({
                    inputMint:     plan.mint,
                    outputMint:    jupiter.SOL_MINT,
                    amountLamports: tokenLamports,
                    slippageBps:   risk.defaultSlippageBps,
                });

                const pnl = result.outputAmount - plan.perGridSol;
                plan.totalPnlSol += pnl;
                buyLevel.filled   = true;
                buyLevel.hasOrder = false; // bisa dipakai lagi
                plan.trades++;
                saveGridPlans();

                riskManager.recordTrade({ pnlSol: pnl });

                await sendToChannel(
                    `🔴 <b>GRID SELL</b> — ${esc(plan.symbol)}\n` +
                    `📊 Level ${i + 1} → ${i + 2}\n` +
                    `💰 ${tokenAmt.toFixed(2)} token → ${result.outputAmount.toFixed(4)} SOL\n` +
                    `📈 PnL grid: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL\n` +
                    `📊 Total PnL: ${plan.totalPnlSol >= 0 ? '+' : ''}${plan.totalPnlSol.toFixed(4)} SOL\n` +
                    `🔗 <a href="https://solscan.io/tx/${result.txid}">Solscan</a>`
                );
            } catch (err) {
                log.gridErr(`Grid sell: ${err.message}`);
            }
        }
    }
}

// ============================================================
// TICK — dipanggil oleh price monitor
// ============================================================
async function tick(mint, currentPriceSol) {
    for (const plan of gridPlans.values()) {
        if (plan.mint === mint && plan.active) {
            await processGridTick(plan, currentPriceSol);
        }
    }
}

function getAllPlans()   { return [...gridPlans.values()]; }
function getPlan(id)    { return gridPlans.get(id) || null; }
function cancelPlan(id) {
    const p = gridPlans.get(id);
    if (p) { p.active = false; saveGridPlans(); }
    return !!p;
}

module.exports = { loadGridPlans, createGridPlan, cancelPlan, getAllPlans, getPlan, tick };