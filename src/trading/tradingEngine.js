'use strict';
const pump      = require('./pumpClient');
const riskManager  = require('./risk/riskManager');
const posTracker   = require('./positionTracker');
const dca          = require('./strategies/dca');
const grid         = require('./strategies/grid');
const { sendToChannel } = require('../services/telegram');
const { esc } = require('../utils/helpers');

const PRICE_CHECK_INTERVAL_MS = 120_000; // Cek harga tiap 120 detik
const DCA_TICK_INTERVAL_MS    = 60_000; // DCA tick tiap 1 menit

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

    // Stop loss / take profit event listeners
    posTracker.on('stopLossTriggered', handleStopLoss);
    posTracker.on('takeProfitTriggered', handleTakeProfit);

    // Scheduler
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
// Cek stop loss & take profit untuk semua posisi terbuka
// ============================================================
async function priceMonitorTick() {
    const positions = posTracker.getAllPositions();
    if (positions.length === 0) return;

    for (const pos of positions) {
        try {
            const currentPrice = await pump.getTokenPriceInSol(pos.mint);
            if (!currentPrice) continue;

            // Grid tick
            await grid.tick(pos.mint, currentPrice);

            // Stop loss check
            posTracker.checkStopLoss(pos.mint, currentPrice);
            posTracker.checkTakeProfit(pos.mint, currentPrice);
        } catch (err) {
            console.error(`❌ Price monitor error [${pos.symbol}]:`, err.message);
        }
    }
}

// ============================================================
// STOP LOSS HANDLER
// ============================================================
async function handleStopLoss(pos) {
    console.log(`🛑 STOP LOSS TRIGGERED: ${pos.symbol} @ ${pos.currentPriceSol?.toFixed(8)} SOL`);
    try {
        const balance = await pump.getBalance(pos.mint);
        if (balance <= 0) return;

        const result = await pump.executeSell({
            inputMint:     pos.mint,
            amountTokens:  balance,
            slippageBps:   300,
            isSimulation:  pos.isSimulation
        });

        const closed = posTracker.closePosition(pos.mint, {
            exitPriceSol: pos.currentPriceSol,
            reason: 'stop_loss',
            txid: result.txid,
        });

        riskManager.recordTrade({ pnlSol: closed?.pnlSol || 0 });

        await sendToChannel(
            `🛑 <b>STOP LOSS EXECUTED</b> ${pos.isSimulation ? '(SIMULASI)' : ''}\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `🪙 <b>${esc(pos.symbol)}</b>\n` +
            `📍 Entry: ${pos.entryPriceSol?.toFixed(8)} SOL\n` +
            `📉 Exit:  ${pos.currentPriceSol?.toFixed(8)} SOL\n` +
            `💸 PnL: ${closed?.pnlSol >= 0 ? '+' : ''}${closed?.pnlSol?.toFixed(4)} SOL (${closed?.pnlPct?.toFixed(1)}%)\n` +
            `🔗 <a href="https://solscan.io/tx/${result.txid}">Solscan</a>`
        );
    } catch (err) {
        console.error('❌ Stop loss eksekusi gagal:', err.message);
        await sendToChannel(`❌ <b>STOP LOSS GAGAL DIEKSEKUSI!</b>\n🪙 ${esc(pos.symbol)}\n⚠️ ${esc(err.message)}\n\n<b>Harap manual close posisi!</b>`);
    }
}

// ============================================================
// TAKE PROFIT HANDLER
// ============================================================
async function handleTakeProfit(pos) {
    console.log(`🎯 TAKE PROFIT TRIGGERED: ${pos.symbol}`);
    try {
        const balance = await pump.getBalance(pos.mint);
        if (balance <= 0) return;

        const result = await pump.executeSell({
            inputMint:     pos.mint,
            amountTokens:  balance,
            slippageBps:   200,
            isSimulation:  pos.isSimulation
        });

        const closed = posTracker.closePosition(pos.mint, {
            exitPriceSol: pos.currentPriceSol,
            reason: 'take_profit',
            txid: result.txid,
        });

        riskManager.recordTrade({ pnlSol: closed?.pnlSol || 0 });

        await sendToChannel(
            `🎯 <b>TAKE PROFIT EXECUTED</b> ${pos.isSimulation ? '(SIMULASI)' : ''}\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `🪙 <b>${esc(pos.symbol)}</b>\n` +
            `📍 Entry: ${pos.entryPriceSol?.toFixed(8)} SOL\n` +
            `📈 Exit:  ${pos.currentPriceSol?.toFixed(8)} SOL\n` +
            `💰 PnL: +${closed?.pnlSol?.toFixed(4)} SOL (+${closed?.pnlPct?.toFixed(1)}%)\n` +
            `🔗 <a href="https://solscan.io/tx/${result.txid}">Solscan</a>`
        );
    } catch (err) {
        console.error('❌ Take profit eksekusi gagal:', err.message);
    }
}

// ============================================================
// MANUAL CLOSE POSITION
// ============================================================
async function manualClose(mint) {
    const pos = posTracker.getPosition(mint);
    if (!pos) throw new Error('Posisi tidak ditemukan.');

    const balance = await pump.getBalance(mint);
    if (balance <= 0) throw new Error('Saldo token 0.');

    const result = await pump.executeSell({
        inputMint:     mint,
        amountTokens:  balance,
        slippageBps:   200,
        isSimulation:  pos.isSimulation
    });

    const currentPrice = pos.entryPriceSol * (result.outputAmount / pos.amountSol);
    const closed = posTracker.closePosition(mint, {
        exitPriceSol: currentPrice,
        reason: 'manual',
        txid: result.txid,
    });

    riskManager.recordTrade({ pnlSol: closed?.pnlSol || 0 });
    return { ...closed, txid: result.txid };
}

// ============================================================
// AUTO BUY (Pump.fun Mooner Trigger)
// ============================================================
async function executeAutoBuy(mint, symbol, amountSol) {
    const CONFIG = require('../config');
    const risk   = riskManager.getRiskConfig();

    // Cegah double-buy
    if (posTracker.hasPosition(mint)) {
        console.log(`⏭️  Skip [${symbol}]: Posisi sudah terbuka`);
        return null;
    }

    console.log(`🤖 [${CONFIG.ENABLE_SIMULATION_MODE ? 'SIMULASI' : 'REAL'}] Mencoba AUTO-BUY: ${symbol} (${amountSol} SOL)`);

    // 1. Validasi risk management
    const validation = riskManager.validateBuy({ mint, amountSol });
    if (!validation.allowed) {
        console.warn(`⚠️ Auto-buy dibatalkan: ${validation.reason}`);
        return null;
    }

    try {
        // 2. Eksekusi swap (pump SDK)
        const result = await pump.executeSwap({
            outputMint:    mint,
            amountLamports: Math.floor(amountSol * 1e9),
            slippageBps:   CONFIG.AUTO_BUY_SLIPPAGE_BPS,
            isSimulation:  CONFIG.ENABLE_SIMULATION_MODE
        });

        // 3. Hitung harga entry & SL/TP
        const entryPriceSol      = amountSol / result.outputAmount;
        const stopLossPriceSol   = entryPriceSol * (1 - (risk.maxLossPerTradePct / 100));
        const takeProfitPriceSol = entryPriceSol * 2; // Target 2x (Moonshot)

        // 4. Buka posisi di tracker
        posTracker.openPosition({
            mint,
            symbol,
            entryPriceSol,
            stopLossPriceSol,
            takeProfitPriceSol,
            amountToken:  result.outputAmount,
            amountSol:    amountSol,
            txid:         result.txid,
            isSimulation: !!result.isSimulation
        });

        // 5. Notifikasi Telegram
        await sendToChannel(
            `🤖 <b>AUTO-BUY EXECUTED</b> ${CONFIG.ENABLE_SIMULATION_MODE ? '(SIMULASI)' : ''}\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `🪙 <b>${esc(symbol)}</b>\n` +
            `💰 Amount: ${amountSol} SOL\n` +
            `📊 Entry:  ${entryPriceSol.toFixed(8)} SOL\n` +
            `🛑 SL:     ${stopLossPriceSol.toFixed(8)} SOL (-${risk.maxLossPerTradePct}%)\n` +
            `🎯 TP:     ${takeProfitPriceSol.toFixed(8)} SOL (2x)\n` +
            `🔗 <a href="https://solscan.io/tx/${result.txid}">Solscan</a>`
        );

        return result;
    } catch (err) {
    // Token sudah graduate ke DEX — skip diam-diam
    if (err.graduated) {
        console.log(`⏭️  Skip [${symbol}]: Token sudah graduate ke DEX`);
        return null;
    }
    console.error(`❌ Auto-buy gagal [${symbol}]:`, err.message);
    return null;
}
}

module.exports = {
    init,
    manualClose,
    executeAutoBuy,
    dca,
    grid,
    posTracker,
    riskManager,
    pump,
};