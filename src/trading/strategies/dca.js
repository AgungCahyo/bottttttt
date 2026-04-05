'use strict';
const fs   = require('fs');
const path = require('path');

const jupiter      = require('../jupiterClient');
const riskManager  = require('../risk/riskManager');
const posTracker   = require('../positionTracker');
const { sendToChannel } = require('../../services/telegram');
const f   = require('../../utils/tgFormat');
const { esc } = require('../../utils/helpers');
const log = require('../../utils/logger');

const DCA_FILE = path.join(__dirname, '../../../trading_dca.json');

let dcaPlans = new Map();

function loadDcaPlans() {
    try {
        if (fs.existsSync(DCA_FILE)) {
            const arr = JSON.parse(fs.readFileSync(DCA_FILE, 'utf8'));
            dcaPlans = new Map(arr.map(p => [p.id, p]));
            log.load(`DCA plans: ${dcaPlans.size}`);
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
        id, mint,
        symbol:       symbol || mint.slice(0, 8),
        totalSol, perOrderSol,
        intervalMs:   intervalMinutes * 60_000,
        ordersTotal:  orders,
        ordersFilled: 0,
        stopLossPct, takeProfitPct,
        active:       true,
        createdAt:    Date.now(),
        nextOrderAt:  Date.now(),
    };

    dcaPlans.set(id, plan);
    saveDcaPlans();
    log.plan(`DCA ${symbol} — ${orders}x ${perOrderSol.toFixed(3)} SOL / ${intervalMinutes} min`);
    return plan;
}

// ============================================================
// EXECUTE ONE DCA ORDER
// ============================================================
async function executeDcaOrder(plan) {
    const risk = riskManager.getRiskConfig();

    const check = riskManager.validateBuy({ mint: plan.mint, amountSol: plan.perOrderSol });
    if (!check.allowed) {
        log.dcaWarn(`[${plan.symbol}] blocked: ${check.reason}`);
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

        const entryPrice       = plan.perOrderSol / result.outputAmount;
        const stopLossPrice    = entryPrice * (1 - plan.stopLossPct / 100);
        const takeProfitPrice  = entryPrice * (1 + plan.takeProfitPct / 100);

        if (!posTracker.hasPosition(plan.mint)) {
            posTracker.openPosition({
                mint:               plan.mint,
                symbol:             plan.symbol,
                entryPriceSol:      entryPrice,
                stopLossPriceSol:   stopLossPrice,
                takeProfitPriceSol: takeProfitPrice,
                amountToken:        result.outputAmount,
                amountSol:          plan.perOrderSol,
                strategy:           'DCA',
                txid:               result.txid,
            });
        }

        plan.ordersFilled++;
        plan.nextOrderAt = Date.now() + plan.intervalMs;
        if (plan.ordersFilled >= plan.ordersTotal) plan.active = false;
        saveDcaPlans();

        await sendToChannel(
            `${f.header('DCA ORDER EXECUTED')}\n` +
            `${f.sep()}\n` +
            `${f.row('Token', esc(plan.symbol))}\n` +
            `${f.row('Order', `${plan.ordersFilled} / ${plan.ordersTotal}`)}\n` +
            `${f.row('Spent', `${plan.perOrderSol} SOL`)}\n` +
            `${f.row('Received', `${result.outputAmount.toFixed(2)} tokens`)}\n` +
            `${f.row('Entry', entryPrice.toFixed(8), true)}\n` +
            `${f.row('Stop loss', stopLossPrice.toFixed(8), true)}\n` +
            `${f.row('Take profit', takeProfitPrice.toFixed(8), true)}\n` +
            `${f.sep()}\n` +
            `${f.txLink(result.txid)}`
        );

        return result;

    } catch (err) {
        log.dcaErr(`Order failed [${plan.symbol}]: ${err.message}`);
        await sendToChannel(
            `${f.header('DCA ORDER FAILED')}\n` +
            `${f.sep()}\n` +
            `${f.row('Token', esc(plan.symbol))}\n` +
            `${f.row('Error', esc(err.message))}`
        );
        return null;
    }
}

// ============================================================
// TICK
// ============================================================
async function tick() {
    const now = Date.now();
    for (const plan of dcaPlans.values()) {
        if (!plan.active) continue;
        if (now < plan.nextOrderAt) continue;
        await executeDcaOrder(plan);
    }
}

function getAllPlans()   { return [...dcaPlans.values()]; }
function getPlan(id)    { return dcaPlans.get(id) || null; }
function cancelPlan(id) {
    const p = dcaPlans.get(id);
    if (p) { p.active = false; saveDcaPlans(); }
    return !!p;
}

module.exports = { loadDcaPlans, createDcaPlan, cancelPlan, getAllPlans, getPlan, tick };