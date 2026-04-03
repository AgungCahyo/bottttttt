'use strict';
const pump         = require('./pumpClient');
const riskManager  = require('./risk/riskManager');
const posTracker   = require('./positionTracker');
const trailingStop = require('./trailingStop');
const scorer       = require('./signalScorer');
const dca          = require('./strategies/dca');
const grid         = require('./strategies/grid');
const { sendToChannel } = require('../services/telegram');
const { esc } = require('../utils/helpers');

const PRICE_CHECK_INTERVAL_MS = 15_000;
const DCA_TICK_INTERVAL_MS    = 60_000;

const buyLockSet = new Set(); // cooldown per mint

let initialized = false;

// ============================================================
// INIT
// ============================================================
function init({ rpcUrl, privateKeyBase58 }) {
    if (initialized) return;

    const walletAddress = pump.init(rpcUrl, privateKeyBase58);
    riskManager.loadRiskConfig();
    posTracker.loadPositions();
    dca.loadDcaPlans();
    grid.loadGridPlans();

    // Restore trailing state dari posisi yang sudah ada
    for (const pos of posTracker.getAllPositions()) {
        trailingStop.initTrail(pos.mint, pos.entryPriceSol);
        console.log(`♻️  Trail restored: ${pos.symbol}`);
    }

    setInterval(dcaTick, DCA_TICK_INTERVAL_MS);
    setInterval(priceMonitorTick, PRICE_CHECK_INTERVAL_MS);

    initialized = true;
    console.log(`✅ Trading Engine aktif — wallet: ${walletAddress}`);
}

// ============================================================
// DCA TICK
// ============================================================
async function dcaTick() {
    try { await dca.tick(); }
    catch (err) { console.error('❌ DCA tick error:', err.message); }
}

// ============================================================
// PRICE MONITOR TICK
// ============================================================
async function priceMonitorTick() {
    const positions = posTracker.getAllPositions();
    if (positions.length === 0) return;

    for (const pos of positions) {
        try {
            const currentPrice = await pump.getTokenPriceInSol(pos.mint);
            if (!currentPrice || currentPrice <= 0) continue;

            await grid.tick(pos.mint, currentPrice);

            const action = trailingStop.update(pos.mint, currentPrice);
            if (action) await handleTrailAction(pos, action, currentPrice);

        } catch (err) {
            if (!err.message?.includes('GRADUATED')) {
                console.error(`❌ Price monitor [${pos.symbol}]:`, err.message);
            }
        }
    }
}

// ============================================================
// HANDLE TRAIL ACTION
// ============================================================
async function handleTrailAction(pos, action, currentPriceSol) {
    const CONFIG = require('../config');

    try {
        const balance = await pump.getBalance(pos.mint);
        if (balance <= 0) return;

        const sellTokens = Math.floor(balance * action.sellPct);
        if (sellTokens <= 0) return;

        const result = await pump.executeSell({
            inputMint:    pos.mint,
            amountTokens: sellTokens,
            slippageBps:  2000,
            isSimulation: CONFIG.ENABLE_SIMULATION_MODE,
        });

        const pnlSol = (currentPriceSol - pos.entryPriceSol) * sellTokens;
        const pnlPct = ((currentPriceSol / pos.entryPriceSol) - 1) * 100;

        if (action.remaining <= 0.02) {
            posTracker.closePosition(pos.mint, {
                exitPriceSol: currentPriceSol,
                reason: action.phase,
                txid: result.txid,
            });
            trailingStop.removeTrail(pos.mint);
            riskManager.recordTrade({ pnlSol });
        }

        const emoji  = action.action === 'PARTIAL_SELL' ? '🎯' :
                       action.action === 'TRAIL_STOP'   ? '📉' : '⚖️';
        const simTag = CONFIG.ENABLE_SIMULATION_MODE ? ' <b>(SIM)</b>' : '';

        await sendToChannel(
            `${emoji} <b>${action.phase}</b>${simTag}\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `🪙 <b>${esc(pos.symbol)}</b>\n` +
            `📊 Multiplier: <b>${action.multiplier}x</b>\n` +
            `💰 Dijual: ${(action.sellPct * 100).toFixed(0)}% posisi\n` +
            `📈 PnL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPct.toFixed(1)}%)\n` +
            (action.remaining > 0.02
                ? `📦 Sisa: ${(action.remaining * 100).toFixed(0)}% masih trailing\n`
                : `✅ Posisi ditutup\n`) +
            (action.stopPrice ? `🛑 Trail stop: ${action.stopPrice.toFixed(8)} SOL\n` : '') +
            `🔗 <a href="https://solscan.io/tx/${result.txid}">Solscan</a>`
        );

        console.log(`${emoji} ${action.phase}: ${pos.symbol} ${action.multiplier}x | sold ${(action.sellPct*100).toFixed(0)}%`);

    } catch (err) {
        console.error(`❌ Trail action gagal [${pos.symbol}]:`, err.message);
    }
}

// ============================================================
// AUTO BUY
// ============================================================
async function executeAutoBuy(mint, symbol, token, scoreResult) {
    const CONFIG = require('../config');

    if (buyLockSet.has(mint)) return null;
    if (posTracker.hasPosition(mint)) return null;

    buyLockSet.add(mint);
    setTimeout(() => buyLockSet.delete(mint), 30_000);

    const amountSol = CONFIG.AUTO_BUY_AMOUNT_SOL;
    const risk      = riskManager.getRiskConfig();

    const validation = riskManager.validateBuy({ mint, amountSol });
    if (!validation.allowed) {
        console.warn(`⚠️  Auto-buy dibatalkan [${symbol}]: ${validation.reason}`);
        buyLockSet.delete(mint);
        return null;
    }

    console.log(`🤖 [${CONFIG.ENABLE_SIMULATION_MODE ? 'SIM' : 'REAL'}] AUTO-BUY: ${symbol} score=${scoreResult.score} | ${amountSol} SOL`);

    try {
        const result = await pump.executeSwap({
            outputMint:     mint,
            amountLamports: Math.floor(amountSol * 1e9),
            slippageBps:    CONFIG.AUTO_BUY_SLIPPAGE_BPS,
            isSimulation:   CONFIG.ENABLE_SIMULATION_MODE,
        });

        if (!result || result.outputAmount <= 0) throw new Error('Output 0 token');

        const entryPriceSol    = amountSol / result.outputAmount;
        const stopLossPriceSol = entryPriceSol * (1 - risk.maxLossPerTradePct / 100);

        posTracker.openPosition({
            mint, symbol,
            entryPriceSol,
            stopLossPriceSol,
            takeProfitPriceSol: null,
            amountToken:  result.outputAmount,
            amountSol,
            strategy:    'AUTO',
            txid:        result.txid,
            isSimulation: !!result.isSimulation,
        });

        trailingStop.initTrail(mint, entryPriceSol);

        const simTag = CONFIG.ENABLE_SIMULATION_MODE ? ' <b>(SIMULASI)</b>' : '';
        await sendToChannel(
            `🤖 <b>AUTO-BUY EXECUTED</b>${simTag}\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `🪙 <b>${esc(symbol)}</b>\n` +
            `🎯 Score: <b>${scoreResult.score}/100</b>\n` +
            `⚡ Velocity: ${scoreResult.velocity} buys/min\n` +
            `💰 Buy: ${amountSol} SOL → ${result.outputAmount.toFixed(0)} token\n` +
            `📍 Entry: ${entryPriceSol.toFixed(8)} SOL\n` +
            `🛑 SL: -${risk.maxLossPerTradePct}% (→ BEP setelah TP1)\n` +
            `🎯 TP1: 1.5x → jual 40% | TP2: 3x → jual 35% | TP3: 5x+ trail 15%\n` +
            `🔗 <a href="https://solscan.io/tx/${result.txid}">Solscan</a>`
        );

        return result;

    } catch (err) {
        buyLockSet.delete(mint);
        if (err.graduated) {
            console.log(`⏭️  Skip [${symbol}]: Token graduate ke DEX`);
            return null;
        }
        console.error(`❌ Auto-buy gagal [${symbol}]:`, err.message);
        return null;
    }
}

// ============================================================
// MANUAL CLOSE
// ============================================================
async function manualClose(mint) {
    const CONFIG = require('../config');
    const pos = posTracker.getPosition(mint);
    if (!pos) throw new Error('Posisi tidak ditemukan.');

    const balance = await pump.getBalance(mint);
    if (balance <= 0) throw new Error('Saldo token 0.');

    const result = await pump.executeSell({
        inputMint:    mint,
        amountTokens: balance,
        slippageBps:  300,
        isSimulation: CONFIG.ENABLE_SIMULATION_MODE,
    });

    const currentPrice = await pump.getTokenPriceInSol(mint) || pos.entryPriceSol;
    const closed = posTracker.closePosition(mint, {
        exitPriceSol: currentPrice,
        reason: 'manual',
        txid: result.txid,
    });

    trailingStop.removeTrail(mint);
    riskManager.recordTrade({ pnlSol: closed?.pnlSol || 0 });
    return { ...closed, txid: result.txid };
}

module.exports = {
    init,
    executeAutoBuy,
    manualClose,
    dca,
    grid,
    posTracker,
    riskManager,
    trailingStop,
    scorer,
    pump,
};