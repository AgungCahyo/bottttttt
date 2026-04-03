'use strict';
const pump         = require('./pumpClient');
const riskManager  = require('./risk/riskManager');
const posTracker   = require('./positionTracker');
const trailingStop = require('./trailingStop');
const scorer       = require('./signalScorer');
const dca          = require('./strategies/dca');
const grid         = require('./strategies/grid');
const { sendToChannel } = require('../services/telegram');
const { esc, sleep }    = require('../utils/helpers');

// ============================================================
// CONSTANTS
// ============================================================
const PRICE_CHECK_INTERVAL_MS  = 20_000;  // cek harga tiap 20 detik
const DCA_TICK_INTERVAL_MS     = 60_000;
const MAX_POSITIONS            = 10;       // maksimal posisi terbuka bersamaan
const PRICE_REQUEST_DELAY_MS   = 1_200;   // jeda antar token saat cek harga
const MAX_POSITION_AGE_MS      = 3_600_000; // auto-close posisi simulasi > 1 jam

const buyLockSet = new Set();
let initialized  = false;
let isSimMode    = true; // ditentukan saat init

// ============================================================
// INIT
// ============================================================
function init({ rpcUrl, privateKeyBase58 }) {
    if (initialized) return;

    const CONFIG = require('../config');
    isSimMode = CONFIG.ENABLE_SIMULATION_MODE;

    const walletAddress = pump.init(rpcUrl, privateKeyBase58);

    riskManager.loadRiskConfig();
    posTracker.loadPositions();
    dca.loadDcaPlans();
    grid.loadGridPlans();

    // Bersihkan posisi simulasi lama jika sekarang mode REAL
    if (!isSimMode) {
        _cleanupSimPositions();
    }

    // Bersihkan posisi yang terlalu tua (>1 jam) — kemungkinan sudah mati
    _cleanupStalePositions();

    // Restore trailing stop untuk posisi valid
    let restored = 0;
    for (const pos of posTracker.getAllPositions()) {
        if (pos.entryPriceSol > 0) {
            trailingStop.initTrail(pos.mint, pos.entryPriceSol);
            restored++;
        }
    }
    if (restored > 0) console.log(`♻️  Trailing stop restored: ${restored} posisi`);

    // Tampilkan ringkasan posisi
    const allPos = posTracker.getAllPositions();
    console.log(`📊 Posisi aktif: ${allPos.length} | Mode: ${isSimMode ? 'SIMULASI' : 'REAL TRADING'}`);

    setInterval(dcaTick, DCA_TICK_INTERVAL_MS);
    setInterval(priceMonitorTick, PRICE_CHECK_INTERVAL_MS);

    initialized = true;
    console.log(`✅ Trading Engine aktif — wallet: ${walletAddress}`);
}

// ============================================================
// CLEANUP HELPERS
// ============================================================
function _cleanupSimPositions() {
    const all = posTracker.getAllPositions();
    const simPos = all.filter(p => p.isSimulation);
    if (simPos.length === 0) return;

    console.log(`🧹 Membersihkan ${simPos.length} posisi simulasi lama (mode REAL aktif)...`);
    for (const pos of simPos) {
        posTracker.closePosition(pos.mint, { exitPriceSol: pos.entryPriceSol, reason: 'cleanup_sim' });
        trailingStop.removeTrail(pos.mint);
    }
}

function _cleanupStalePositions() {
    const all  = posTracker.getAllPositions();
    const now  = Date.now();
    let cleaned = 0;
    for (const pos of all) {
        if (pos.openedAt && (now - pos.openedAt) > MAX_POSITION_AGE_MS && pos.isSimulation) {
            posTracker.closePosition(pos.mint, { exitPriceSol: pos.entryPriceSol, reason: 'stale_cleanup' });
            trailingStop.removeTrail(pos.mint);
            cleaned++;
        }
    }
    if (cleaned > 0) console.log(`🧹 ${cleaned} posisi simulasi kadaluarsa dibersihkan`);
}

// ============================================================
// DCA TICK
// ============================================================
async function dcaTick() {
    try { await dca.tick(); }
    catch (err) { console.error('❌ DCA tick error:', err.message); }
}

// ============================================================
// PRICE MONITOR — Rate-limited, sequential per posisi
// ============================================================
async function priceMonitorTick() {
    const positions = posTracker.getAllPositions();
    if (positions.length === 0) return;

    for (const pos of positions) {
        try {
            const currentPrice = await pump.getTokenPriceInSol(pos.mint);
            if (!currentPrice || currentPrice <= 0) {
                await sleep(PRICE_REQUEST_DELAY_MS);
                continue;
            }

            // Grid strategy tick
            await grid.tick(pos.mint, currentPrice);

            // Trailing stop + partial TP
            const action = trailingStop.update(pos.mint, currentPrice);
            if (action) await handleTrailAction(pos, action, currentPrice);

            // Jeda antar token untuk hindari rate limit
            await sleep(PRICE_REQUEST_DELAY_MS);

        } catch (err) {
            if (!err.message?.includes('GRADUATED') && !err.message?.includes('429')) {
                console.error(`❌ Price monitor [${pos.symbol}]:`, err.message);
            }
            await sleep(PRICE_REQUEST_DELAY_MS * 2); // backoff jika error
        }
    }
}

// ============================================================
// HANDLE TRAIL ACTION (Partial Sell / Trail Stop / Breakeven)
// ============================================================
async function handleTrailAction(pos, action, currentPriceSol) {
    const CONFIG = require('../config');

    try {
        const balance = await pump.getBalance(pos.mint);
        if (!balance || balance <= 0) {
            // Token habis, tutup posisi saja
            posTracker.closePosition(pos.mint, { exitPriceSol: currentPriceSol, reason: 'zero_balance' });
            trailingStop.removeTrail(pos.mint);
            return;
        }

        // Hitung jumlah token yang dijual
        const sellTokens = balance * action.sellPct;
        if (sellTokens <= 0) return;

        const result = await pump.executeSell({
            inputMint:    pos.mint,
            amountTokens: sellTokens,
            slippageBps:  2500,
            isSimulation: pos.isSimulation || CONFIG.ENABLE_SIMULATION_MODE,
        });

        const pnlSol = (currentPriceSol - pos.entryPriceSol) * sellTokens;
        const pnlPct = ((currentPriceSol / pos.entryPriceSol) - 1) * 100;
        const simTag = (pos.isSimulation || CONFIG.ENABLE_SIMULATION_MODE) ? ' <b>(SIM)</b>' : '';

        // Tutup posisi jika sisa sudah habis
        if (action.remaining <= 0.02) {
            posTracker.closePosition(pos.mint, {
                exitPriceSol: currentPriceSol,
                reason:       action.phase,
                txid:         result.txid,
            });
            trailingStop.removeTrail(pos.mint);
            riskManager.recordTrade({ pnlSol });
        }

        const emoji = action.action === 'PARTIAL_SELL' ? '🎯' :
                      action.action === 'TRAIL_STOP'   ? '📉' : '⚖️';

        await sendToChannel(
            `${emoji} <b>${action.phase}</b>${simTag}\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `🪙 <b>${esc(pos.symbol)}</b>\n` +
            `📊 <b>${action.multiplier}x</b> dari entry\n` +
            `💰 Dijual: ${(action.sellPct * 100).toFixed(0)}% posisi\n` +
            `📈 PnL batch: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPct.toFixed(1)}%)\n` +
            (action.remaining > 0.02
                ? `📦 Sisa: ${(action.remaining * 100).toFixed(0)}% masih trailing\n`
                : `✅ Posisi DITUTUP PENUH\n`) +
            (action.stopPrice ? `🛑 Trail stop baru: ${action.stopPrice.toFixed(8)} SOL\n` : '') +
            `🔗 <a href="https://solscan.io/tx/${result.txid}">Solscan</a>`
        );

        console.log(`${emoji} ${action.phase}: ${pos.symbol} @${action.multiplier}x | -${(action.sellPct*100).toFixed(0)}%`);

    } catch (err) {
        console.error(`❌ Trail action gagal [${pos.symbol}]:`, err.message);
        // Notif admin jika gagal (bisa berarti token sudah mati)
        if (!err.message?.includes('GRADUATED') && !err.message?.includes('0')) {
            await sendToChannel(
                `⚠️ <b>TRAIL ACTION GAGAL</b>\n` +
                `🪙 ${esc(pos.symbol)}\n` +
                `❗ ${esc(err.message)}\n` +
                `<i>Cek posisi manual dengan /trading_status</i>`
            );
        }
    }
}

// ============================================================
// AUTO BUY — dipanggil dari pumpRadar
// ============================================================
async function executeAutoBuy(mint, symbol, token, scoreResult) {
    const CONFIG = require('../config');

    // Guard: jangan beli ulang
    if (buyLockSet.has(mint)) return null;
    if (posTracker.hasPosition(mint)) return null;

    // Guard: batas maksimum posisi terbuka
    if (posTracker.getPositionCount() >= MAX_POSITIONS) {
        console.warn(`⛔ Max posisi (${MAX_POSITIONS}) tercapai, skip ${symbol}`);
        return null;
    }

    buyLockSet.add(mint);
    setTimeout(() => buyLockSet.delete(mint), 60_000); // cooldown 1 menit

    const amountSol = CONFIG.AUTO_BUY_AMOUNT_SOL;
    const risk      = riskManager.getRiskConfig();

    // Validasi risk
    const validation = riskManager.validateBuy({ mint, amountSol });
    if (!validation.allowed) {
        console.warn(`⛔ Auto-buy dibatalkan [${symbol}]: ${validation.reason}`);
        buyLockSet.delete(mint);
        return null;
    }

    // Cek saldo SOL jika mode real
    if (!CONFIG.ENABLE_SIMULATION_MODE) {
        try {
            const solBal = await pump.getSolBalance();
            const needed = amountSol + 0.02; // buffer fee
            if (solBal < needed) {
                console.warn(`⛔ Saldo SOL tidak cukup: ${solBal.toFixed(4)} < ${needed.toFixed(4)}`);
                buyLockSet.delete(mint);
                return null;
            }
        } catch (err) {
            console.error('❌ Gagal cek saldo SOL:', err.message);
            buyLockSet.delete(mint);
            return null;
        }
    }

    const modeTag = CONFIG.ENABLE_SIMULATION_MODE ? '[SIM]' : '[REAL]';
    console.log(`🤖 ${modeTag} AUTO-BUY: ${symbol} | score=${scoreResult.score} | ${amountSol} SOL`);

    try {
        const result = await pump.executeSwap({
            outputMint:     mint,
            amountLamports: Math.floor(amountSol * 1e9),
            slippageBps:    CONFIG.AUTO_BUY_SLIPPAGE_BPS,
            isSimulation:   CONFIG.ENABLE_SIMULATION_MODE,
        });

        if (!result || result.outputAmount <= 0) throw new Error('Output 0 token — trade rejected');

        const entryPriceSol    = amountSol / result.outputAmount;
        const stopLossPriceSol = entryPriceSol * (1 - risk.maxLossPerTradePct / 100);

        posTracker.openPosition({
            mint,
            symbol,
            entryPriceSol,
            stopLossPriceSol,
            takeProfitPriceSol: null,   // diganti trailing
            amountToken:        result.outputAmount,
            amountSol,
            strategy:           'AUTO',
            txid:               result.txid,
            isSimulation:       !!result.isSimulation,
            scoreAtEntry:       scoreResult.score,
        });

        trailingStop.initTrail(mint, entryPriceSol);
        riskManager.recordTrade({ pnlSol: 0 }); // catat trade count

        const simTag = result.isSimulation ? ' <b>(SIMULASI)</b>' : '';
        await sendToChannel(
            `🤖 <b>AUTO-BUY EXECUTED</b>${simTag}\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `🪙 <b>${esc(symbol)}</b>\n` +
            `🎯 Score: <b>${scoreResult.score}/100</b> | Velocity: ${scoreResult.velocity} buys/min\n` +
            `💰 ${amountSol} SOL → ${result.outputAmount.toFixed(0)} token\n` +
            `📍 Entry: <code>${entryPriceSol.toFixed(8)}</code> SOL\n` +
            `🛑 SL Awal: <code>${stopLossPriceSol.toFixed(8)}</code> (-${risk.maxLossPerTradePct}%)\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `🎯 TP1: 1.5x → jual 40% | SL → BEP\n` +
            `🎯 TP2: 3.0x → jual 35% | trail -20%\n` +
            `🎯 TP3: 5.0x+ → trail -15% sampai moon\n` +
            `🔗 <a href="https://solscan.io/tx/${result.txid}">Solscan</a>`
        );

        return result;

    } catch (err) {
        buyLockSet.delete(mint);
        if (err.graduated) {
            console.log(`⏭️  Skip [${symbol}]: token graduate ke DEX`);
        } else {
            console.error(`❌ Auto-buy gagal [${symbol}]:`, err.message);
        }
        return null;
    }
}

// ============================================================
// MANUAL CLOSE
// ============================================================
async function manualClose(mint) {
    const CONFIG = require('../config');
    const pos = posTracker.getPosition(mint);
    if (!pos) throw new Error('Posisi tidak ditemukan');

    const balance = await pump.getBalance(mint);
    if (balance <= 0) {
        // Posisi kosong — tutup saja di tracker
        const closed = posTracker.closePosition(mint, {
            exitPriceSol: pos.entryPriceSol,
            reason: 'manual_empty',
        });
        trailingStop.removeTrail(mint);
        return { ...closed, txid: 'no_token' };
    }

    const result = await pump.executeSell({
        inputMint:    mint,
        amountTokens: balance,
        slippageBps:  2000,
        isSimulation: pos.isSimulation || CONFIG.ENABLE_SIMULATION_MODE,
    });

    const currentPrice = await pump.getTokenPriceInSol(mint) || pos.entryPriceSol;
    const closed = posTracker.closePosition(mint, {
        exitPriceSol: currentPrice,
        reason:       'manual',
        txid:         result.txid,
    });

    trailingStop.removeTrail(mint);
    if (closed) riskManager.recordTrade({ pnlSol: closed.pnlSol || 0 });
    return { ...closed, txid: result.txid };
}

// ============================================================
// CLOSE ALL POSITIONS (emergency)
// ============================================================
async function closeAllPositions(reason = 'emergency') {
    const positions = posTracker.getAllPositions();
    const results   = [];
    for (const pos of positions) {
        try {
            const r = await manualClose(pos.mint);
            results.push({ symbol: pos.symbol, success: true, ...r });
        } catch (err) {
            results.push({ symbol: pos.symbol, success: false, error: err.message });
        }
        await sleep(1_500); // jeda antar sell
    }
    return results;
}

// ============================================================
// CLEAR SIMULATION POSITIONS (command helper)
// ============================================================
function clearSimPositions() {
    const all = posTracker.getAllPositions();
    let count = 0;
    for (const pos of all) {
        if (pos.isSimulation) {
            posTracker.closePosition(pos.mint, { exitPriceSol: pos.entryPriceSol, reason: 'manual_clear' });
            trailingStop.removeTrail(pos.mint);
            count++;
        }
    }
    return count;
}

module.exports = {
    init,
    executeAutoBuy,
    manualClose,
    closeAllPositions,
    clearSimPositions,
    isSimMode: () => isSimMode,
    dca,
    grid,
    posTracker,
    riskManager,
    trailingStop,
    scorer,
    pump,
};