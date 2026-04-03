'use strict';
const fs   = require('fs');
const path = require('path');

const jupiter      = require('../jupiterClient');
const riskManager  = require('../risk/riskManager');
const posTracker   = require('../positionTracker');
const { sendToChannel } = require('../../services/telegram');
const { esc } = require('../../utils/helpers');

const DCA_FILE = path.join(__dirname, '../../../trading_dca.json');

// ============================================================
// DCA PLAN STORE
// key: planId
// value: { id, mint, symbol, totalSol, perOrderSol,
//          intervalMs, ordersTotal, ordersFilled,
//          stopLossPct, takeProfitPct, active, createdAt }
// ============================================================
let dcaPlans = new Map();

function loadDcaPlans() {
    try {
        if (fs.existsSync(DCA_FILE)) {
            const arr = JSON.parse(fs.readFileSync(DCA_FILE, 'utf8'));
            dcaPlans = new Map(arr.map(p => [p.id, p]));
            console.log(`📂 DCA plans dimuat: ${dcaPlans.size} plan.`);
        }
    } catch { /* ignore */ }
}

function saveDcaPlans() {
    try {
        fs.writeFileSync(DCA_FILE, JSON.stringify([...dcaPlans.values()], null, 2), 'utf8');
    } catch { /* ignore */ }
}

// ============================================================
// CREATE DCA PLAN
// ============================================================
function createDcaPlan({ mint, symbol, totalSol, orders, intervalMinutes, stopLossPct = 15, takeProfitPct = 50 }) {
    const perOrderSol = totalSol / orders;
    const id = `dca_${mint.slice(0, 6)}_${Date.now()}`;

    const plan = {
        id,
        mint,
        symbol:        symbol || mint.slice(0, 8),
        totalSol,
        perOrderSol,
        intervalMs:    intervalMinutes * 60_000,
        ordersTotal:   orders,
        ordersFilled:  0,
        stopLossPct,
        takeProfitPct,
        active:        true,
        createdAt:     Date.now(),
        nextOrderAt:   Date.now(), // pertama langsung jalan
    };

    dcaPlans.set(id, plan);
    saveDcaPlans();
    console.log(`📋 DCA Plan dibuat: ${symbol} — ${orders}x ${perOrderSol.toFixed(3)} SOL per ${intervalMinutes} menit`);
    return plan;
}

// ============================================================
// EXECUTE ONE DCA ORDER
// ============================================================
async function executeDcaOrder(plan) {
    const risk = riskManager.getRiskConfig();

    // Validasi risk
    const check = riskManager.validateBuy({
        mint:     plan.mint,
        amountSol: plan.perOrderSol,
    });

    if (!check.allowed) {
        console.warn(`⛔ DCA [${plan.symbol}] diblokir: ${check.reason}`);
        riskManager.recordBlocked();
        return null;
    }

    try {
        const amountLamports = Math.floor(plan.perOrderSol * 1e9);
        const result = await jupiter.executeSwap({
            inputMint:     jupiter.SOL_MINT,
            outputMint:    plan.mint,
            amountLamports,
            slippageBps:   risk.defaultSlippageBps,
        });

        const entryPrice = plan.perOrderSol / result.outputAmount;
        const stopLossPrice    = entryPrice * (1 - plan.stopLossPct / 100);
        const takeProfitPrice  = entryPrice * (1 + plan.takeProfitPct / 100);

        // Buka / update posisi
        if (!posTracker.hasPosition(plan.mint)) {
            posTracker.openPosition({
                mint:             plan.mint,
                symbol:           plan.symbol,
                entryPriceSol:    entryPrice,
                stopLossPriceSol: stopLossPrice,
                takeProfitPriceSol: takeProfitPrice,
                amountToken:      result.outputAmount,
                amountSol:        plan.perOrderSol,
                strategy:         'DCA',
                txid:             result.txid,
            });
        }

        plan.ordersFilled++;
        plan.nextOrderAt = Date.now() + plan.intervalMs;
        if (plan.ordersFilled >= plan.ordersTotal) plan.active = false;
        saveDcaPlans();

        const msg =
            `✅ <b>DCA ORDER TEREKSEKUSI</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `🪙 <b>${esc(plan.symbol)}</b>\n` +
            `📊 Order: ${plan.ordersFilled}/${plan.ordersTotal}\n` +
            `💰 Beli: ${plan.perOrderSol} SOL → ${result.outputAmount.toFixed(2)} token\n` +
            `📍 Entry: ${entryPrice.toFixed(8)} SOL\n` +
            `🛑 Stop Loss: ${stopLossPrice.toFixed(8)} SOL (-${plan.stopLossPct}%)\n` +
            `🎯 Take Profit: ${takeProfitPrice.toFixed(8)} SOL (+${plan.takeProfitPct}%)\n` +
            `🔗 <a href="https://solscan.io/tx/${result.txid}">Solscan</a>`;

        await sendToChannel(msg);
        return result;

    } catch (err) {
        console.error(`❌ DCA order gagal [${plan.symbol}]:`, err.message);
        await sendToChannel(`❌ <b>DCA ORDER GAGAL</b>\n🪙 ${esc(plan.symbol)}\n⚠️ ${esc(err.message)}`);
        return null;
    }
}

// ============================================================
// TICK — dipanggil setiap menit oleh scheduler
// ============================================================
async function tick() {
    const now = Date.now();
    for (const plan of dcaPlans.values()) {
        if (!plan.active) continue;
        if (now < plan.nextOrderAt) continue;
        await executeDcaOrder(plan);
    }
}

// ============================================================
// GETTERS
// ============================================================
function getAllPlans()    { return [...dcaPlans.values()]; }
function getPlan(id)     { return dcaPlans.get(id) || null; }
function cancelPlan(id)  {
    const p = dcaPlans.get(id);
    if (p) { p.active = false; saveDcaPlans(); }
    return !!p;
}

module.exports = { loadDcaPlans, createDcaPlan, cancelPlan, getAllPlans, getPlan, tick };