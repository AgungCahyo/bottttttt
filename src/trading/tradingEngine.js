'use strict';
const pump         = require('./pumpClient');
const riskManager  = require('./risk/riskManager');
const posTracker   = require('./positionTracker');
const trailingStop = require('./trailingStop');
const scorer       = require('./signalScorer');
const dca          = require('./strategies/dca');
const grid         = require('./strategies/grid');
const { sendToChannel } = require('../services/telegram');
const f                 = require('../utils/tgFormat');
const { esc, sleep }    = require('../utils/helpers');
const log               = require('../utils/logger');

// ============================================================
// CONSTANTS
// ============================================================
const PRICE_CHECK_INTERVAL_MS = 2_000;
const DCA_TICK_INTERVAL_MS    = 60_000;
const MAX_POSITIONS           = 10;
const PRICE_REQUEST_DELAY_MS  = 800;
const MAX_POSITION_AGE_MS     = 3_600_000;

const buyLockSet       = new Set();
const stopLossInflight = new Set();
const streamPriceBuffer = new Map();
let initialized = false;
let isSimMode   = true;

// ─── Helpers ─────────────────────────────────────────────────
function _streamSlParams() {
    const c = require('../config');
    const window     = Math.max(2, Number(c.STREAM_SL_AVG_WINDOW)  || 3);
    const minSamples = Math.min(Math.max(2, Number(c.STREAM_SL_MIN_SAMPLES) || 2), window);
    return { window, minSamples };
}

function _pushStreamPrice(mint, price) {
    if (!mint || !(price > 0)) return;
    const { window } = _streamSlParams();
    let buf = streamPriceBuffer.get(mint) || [];
    buf.push(price);
    if (buf.length > window) buf = buf.slice(-window);
    streamPriceBuffer.set(mint, buf);
}

function _streamAvgForSl(mint) {
    const buf = streamPriceBuffer.get(mint) || [];
    if (buf.length === 0) return null;
    return buf.reduce((a, b) => a + b, 0) / buf.length;
}

function priorityMicroForPos(pos) {
    const c = require('../config');
    const s = pos?.scoreAtEntry;
    if (typeof s === 'number' && s >= c.PRIORITY_SCORE_HIGH) return c.PRIORITY_MICRO_LAMPORTS_HIGH;
    return c.PRIORITY_MICRO_LAMPORTS_DEFAULT;
}

async function executeSellWithDustPasses(inputMint, amountTokens, { slippageBps, isSimulation, priorityMicroLamports }, dustSweep = false) {
    const CONFIG = require('../config');
    const sellOnce = (amt) => pump.executeSell({
        inputMint, amountTokens: amt, slippageBps, isSimulation, priorityMicroLamports,
    });
    const bal0     = await pump.getBalance(inputMint);
    const firstAmt = Math.min(amountTokens, bal0 > 0 ? bal0 : amountTokens);
    let result     = await sellOnce(firstAmt);
    if (!dustSweep || isSimulation || CONFIG.SELL_DUST_EXTRA_ROUNDS <= 0) return result;
    for (let r = 0; r < CONFIG.SELL_DUST_EXTRA_ROUNDS; r++) {
        await sleep(1200);
        const bal = await pump.getBalance(inputMint);
        if (!bal || bal <= CONFIG.TOKEN_DUST_THRESHOLD_UI) break;
        try { result = await sellOnce(bal); } catch { break; }
    }
    return result;
}

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

    if (!isSimMode) _cleanupSimPositions();
    _cleanupStalePositions();

    let restored = 0;
    for (const pos of posTracker.getAllPositions()) {
        if (pos.entryPriceSol > 0) {
            trailingStop.initTrail(pos.mint, pos.entryPriceSol);
            restored++;
        }
    }
    if (restored > 0) log.info(`Trailing stop restored: ${restored} position(s)`);

    const allPos = posTracker.getAllPositions();
    log.info(`Open positions: ${allPos.length}  |  mode: ${isSimMode ? 'SIMULATION' : 'LIVE'}`);

    setInterval(dcaTick, DCA_TICK_INTERVAL_MS);
    setInterval(priceMonitorTick, PRICE_CHECK_INTERVAL_MS);

    initialized = true;
    log.engine(`Active — wallet: ${walletAddress}`);

    posTracker.on('opened', (pos) => {
        try {
            const radar = require('../services/pumpRadar');
            radar.subscribeToMint(pos.mint);
        } catch { /* silent */ }
    });

    posTracker.on('closed', (pos) => {
        streamPriceBuffer.delete(pos.mint);
        try {
            const radar = require('../services/pumpRadar');
            radar.unsubscribeFromMint(pos.mint);
        } catch { /* silent */ }
    });
}

// ============================================================
// CLEANUP
// ============================================================
function _cleanupSimPositions() {
    const simPos = posTracker.getAllPositions().filter(p => p.isSimulation);
    if (simPos.length === 0) return;
    log.clean(`Removing ${simPos.length} simulation position(s) (LIVE mode)...`);
    for (const pos of simPos) {
        posTracker.closePosition(pos.mint, { exitPriceSol: pos.entryPriceSol, reason: 'cleanup_sim' });
        trailingStop.removeTrail(pos.mint);
    }
}

function _cleanupStalePositions() {
    const now = Date.now();
    let cleaned = 0;
    for (const pos of posTracker.getAllPositions()) {
        if (pos.openedAt && (now - pos.openedAt) > MAX_POSITION_AGE_MS && pos.isSimulation) {
            posTracker.closePosition(pos.mint, { exitPriceSol: pos.entryPriceSol, reason: 'stale_cleanup' });
            trailingStop.removeTrail(pos.mint);
            cleaned++;
        }
    }
    if (cleaned > 0) log.clean(`${cleaned} stale simulation position(s) removed`);
}

// ============================================================
// DCA TICK
// ============================================================
async function dcaTick() {
    try { await dca.tick(); }
    catch (err) { log.err(`DCA tick: ${err.message}`); }
}

// ============================================================
// STREAM PRICE HANDLER
// ============================================================
async function handleStreamPrice(mint, currentPrice) {
    if (!initialized) return;
    const pos = posTracker.getPosition(mint);
    if (!pos) return;

    try {
        _pushStreamPrice(mint, currentPrice);
        const { minSamples } = _streamSlParams();
        const buf = streamPriceBuffer.get(mint) || [];
        const avg = _streamAvgForSl(mint);

        if (pos.stopLossPriceSol && buf.length >= minSamples && avg != null && avg <= pos.stopLossPriceSol) {
            if (stopLossInflight.has(mint)) return;
            log.stream(`SL (avg ${avg.toFixed(8)} <= SL) ${pos.symbol}`);
            await executeStopLossClose(pos, avg);
            return;
        }

        await grid.tick(mint, currentPrice);

        const action = trailingStop.update(mint, currentPrice);
        if (action) {
            log.stream(`Trail: ${pos.symbol} -> ${action.action}`);
            await handleTrailAction(pos, action, currentPrice);
        }
    } catch { /* fail silently in stream */ }
}

// ============================================================
// PRICE MONITOR (Polling Backup)
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

            if (pos.stopLossPriceSol && currentPrice <= pos.stopLossPriceSol) {
                if (!stopLossInflight.has(pos.mint)) {
                    await executeStopLossClose(pos, currentPrice);
                }
                await sleep(PRICE_REQUEST_DELAY_MS);
                continue;
            }

            await grid.tick(pos.mint, currentPrice);

            const action = trailingStop.update(pos.mint, currentPrice);
            if (action) await handleTrailAction(pos, action, currentPrice);

            await sleep(PRICE_REQUEST_DELAY_MS);
        } catch (err) {
            if (!err.message?.includes('GRADUATED') && !err.message?.includes('429')) {
                log.err(`Price monitor [${pos.symbol}]: ${err.message}`);
            }
            await sleep(PRICE_REQUEST_DELAY_MS * 2);
        }
    }
}

// ============================================================
// STOP LOSS
// ============================================================
async function executeStopLossClose(pos, currentPriceSol) {
    const CONFIG = require('../config');
    const mint   = pos.mint;
    if (stopLossInflight.has(mint)) return;
    stopLossInflight.add(mint);
    trailingStop.removeTrail(mint);

    const prioMicro = priorityMicroForPos(pos);
    const isSim     = pos.isSimulation || CONFIG.ENABLE_SIMULATION_MODE;
    const simTag    = isSim ? '  [ SIM ]' : '';

    try {
        const balance = await pump.getBalance(mint);
        if (!balance || balance <= 0) {
            posTracker.closePosition(mint, { exitPriceSol: currentPriceSol, reason: 'stop_loss_empty' });
            return;
        }
        const result = await executeSellWithDustPasses(mint, balance, {
            slippageBps: 3000, isSimulation: isSim, priorityMicroLamports: prioMicro,
        }, true);

        const pnlSol = (currentPriceSol - pos.entryPriceSol) * balance;
        posTracker.closePosition(mint, { exitPriceSol: currentPriceSol, reason: 'stop_loss', txid: result.txid });
        riskManager.recordTrade({ pnlSol });

        if (CONFIG.ENABLE_STOPLOSS_ALERTS) {
            await sendToChannel(
                `${f.header('STOP LOSS' + simTag)}\n` +
                `${f.sep()}\n` +
                `${f.row('Token', esc(pos.symbol))}\n` +
                `${f.row('Price', currentPriceSol.toFixed(8), true)}\n` +
                `${f.row('SL level', pos.stopLossPriceSol?.toFixed(8), true)}\n` +
                `${f.row('PnL', `${f.signed(pnlSol)} SOL`)}\n` +
                `${f.sep()}\n` +
                `${f.txLink(result.txid)}`
            ).catch(() => {});
        }

        log.stopLoss(`${pos.symbol}  |  PnL ${pnlSol.toFixed(4)} SOL`);
    } catch (e) {
        const msg = e?.message || String(e);
        log.err(`Stop loss failed [${pos.symbol}]: ${msg}`);
        if (CONFIG.ENABLE_STOPLOSS_ALERTS) {
            await sendToChannel(
                `${f.header('STOP LOSS FAILED')}\n` +
                `${f.sep()}\n` +
                `${f.row('Token', esc(pos.symbol))}\n` +
                `${f.row('Error', msg.slice(0, 120))}`
            ).catch(() => {});
        }
    } finally {
        stopLossInflight.delete(mint);
    }
}

// ============================================================
// TRAILING STOP / PARTIAL TP
// ============================================================
async function handleTrailAction(pos, action, currentPriceSol) {
    const CONFIG = require('../config');

    try {
        const balance = await pump.getBalance(pos.mint);
        if (!balance || balance <= 0) {
            posTracker.closePosition(pos.mint, { exitPriceSol: currentPriceSol, reason: 'zero_balance' });
            trailingStop.removeTrail(pos.mint);
            return;
        }

        let sellTokens;
        if (action.action === 'TRAIL_STOP' || action.action === 'BREAKEVEN_STOP') {
            sellTokens = balance;
        } else {
            const initial = pos.initialAmountToken ?? pos.amountToken;
            sellTokens = Math.min(balance, initial * action.sellPct);
        }
        if (sellTokens <= 0) return;

        const dustSweep =
            action.action === 'TRAIL_STOP' ||
            action.action === 'BREAKEVEN_STOP' ||
            (action.action === 'PARTIAL_SELL' && action.remaining <= 0.02);

        const result = dustSweep
            ? await executeSellWithDustPasses(pos.mint, sellTokens, {
                slippageBps: 2500,
                isSimulation: pos.isSimulation || CONFIG.ENABLE_SIMULATION_MODE,
                priorityMicroLamports: priorityMicroForPos(pos),
            }, true)
            : await pump.executeSell({
                inputMint: pos.mint, amountTokens: sellTokens, slippageBps: 2500,
                isSimulation: pos.isSimulation || CONFIG.ENABLE_SIMULATION_MODE,
                priorityMicroLamports: priorityMicroForPos(pos),
            });

        const pnlSol = (currentPriceSol - pos.entryPriceSol) * sellTokens;
        const pnlPct = ((currentPriceSol / pos.entryPriceSol) - 1) * 100;
        const simTag = (pos.isSimulation || CONFIG.ENABLE_SIMULATION_MODE) ? '  [ SIM ]' : '';

        if (action.remaining > 0.02) {
            const newBal = await pump.getBalance(pos.mint);
            posTracker.patchPosition(pos.mint, { amountToken: newBal });
        }

        if (action.remaining <= 0.02) {
            posTracker.closePosition(pos.mint, { exitPriceSol: currentPriceSol, reason: action.phase, txid: result.txid });
            trailingStop.removeTrail(pos.mint);
            riskManager.recordTrade({ pnlSol });
        }

        if (CONFIG.ENABLE_PROFIT_ALERTS) {
            const sellLabel = action.action === 'PARTIAL_SELL'
                ? `${(action.sellPct * 100).toFixed(0)}% of initial`
                : 'remaining';

            const statusLine = action.remaining > 0.02
                ? `${f.row('Remaining', `${(action.remaining * 100).toFixed(0)}% (trailing)`)}\n`
                : `${f.row('Status', 'POSITION CLOSED')}\n`;

            await sendToChannel(
                `${f.header(action.phase + simTag)}\n` +
                `${f.sep()}\n` +
                `${f.row('Token', esc(pos.symbol))}\n` +
                `${f.row('Multiplier', `${action.multiplier}x from entry`)}\n` +
                `${f.row('Sold', sellLabel)}\n` +
                `${f.row('PnL batch', `${f.signed(pnlSol)} SOL  (${pnlPct.toFixed(1)}%)`)}\n` +
                statusLine +
                (action.stopPrice ? `${f.row('Trail stop', action.stopPrice.toFixed(8), true)}\n` : '') +
                `${f.sep()}\n` +
                `${f.txLink(result.txid)}`
            );
        }

        log.trade(`[${action.action}] ${action.phase}: ${pos.symbol} @ ${action.multiplier}x`);

    } catch (rawError) {
        const errorMsg = rawError?.message || rawError?.toString?.() || 'Trail action failed';
        log.err(`Trail action failed [${pos.symbol}]: ${errorMsg}`);
        if (!errorMsg.includes('GRADUATED') && !errorMsg.includes('0')) {
            const CONFIG = require('../config');
            if (CONFIG.ENABLE_PROFIT_ALERTS) {
                await sendToChannel(
                    `${f.header('TRAIL FAILED')}\n` +
                    `${f.sep()}\n` +
                    `${f.row('Token', esc(pos.symbol))}\n` +
                    `${f.row('Error', errorMsg.slice(0, 100))}`
                ).catch(() => {});
            }
        }
    }
}

// ============================================================
// AUTO BUY
// ============================================================
async function executeAutoBuy(mint, symbol, token, scoreResult) {
    const CONFIG = require('../config');

    if (buyLockSet.has(mint))           return null;
    if (posTracker.hasPosition(mint))   return null;
    if (posTracker.getPositionCount() >= MAX_POSITIONS) {
        log.warn(`Max positions (${MAX_POSITIONS}), skipping ${symbol}`);
        return null;
    }

    buyLockSet.add(mint);
    setTimeout(() => buyLockSet.delete(mint), 60_000);

    const amountSol = CONFIG.AUTO_BUY_AMOUNT_SOL;
    const risk      = riskManager.getRiskConfig();

    const validation = riskManager.validateBuy({ mint, amountSol });
    if (!validation.allowed) {
        log.warn(`Risk rejected [${symbol}]: ${validation.reason}`);
        buyLockSet.delete(mint);
        return null;
    }

    if (!CONFIG.ENABLE_SIMULATION_MODE) {
        try {
            const solBal = await pump.getSolBalance();
            const needed = amountSol + CONFIG.MIN_SOL_BUFFER_SOL;
            if (solBal < needed) {
                log.warn(`Insufficient SOL: ${solBal.toFixed(4)} < ${needed.toFixed(4)}`);
                buyLockSet.delete(mint);
                return null;
            }
        } catch (e) {
            log.err(`SOL balance check: ${e?.message || 'unknown'}`);
            buyLockSet.delete(mint);
            return null;
        }
    }

    const modeTag = CONFIG.ENABLE_SIMULATION_MODE ? '[SIM]' : '[LIVE]';
    log.trade(`${modeTag} AUTO-BUY: ${symbol}  score=${scoreResult.score}  ${amountSol} SOL`);

    let result;
    try {
        const swapOpts = {
            outputMint:     mint,
            amountLamports: Math.floor(amountSol * 1e9),
            slippageBps:    CONFIG.AUTO_BUY_SLIPPAGE_BPS,
            isSimulation:   CONFIG.ENABLE_SIMULATION_MODE,
        };
        if (!CONFIG.ENABLE_SIMULATION_MODE) {
            swapOpts.priorityMicroLamports = scoreResult.score >= CONFIG.PRIORITY_SCORE_HIGH
                ? CONFIG.PRIORITY_MICRO_LAMPORTS_HIGH
                : CONFIG.PRIORITY_MICRO_LAMPORTS_DEFAULT;
        }
        result = await pump.executeSwap(swapOpts);

        if (!result || typeof result !== 'object') throw new Error('Invalid swap result');
        if (!result.txid || result.outputAmount <= 0)
            throw new Error(`Zero output: ${result.outputAmount || 0} tokens`);

        const entryPriceSol    = amountSol / result.outputAmount;
        const stopLossPriceSol = entryPriceSol * (1 - risk.maxLossPerTradePct / 100);

        posTracker.openPosition({
            mint, symbol,
            entryPriceSol, stopLossPriceSol,
            takeProfitPriceSol:  null,
            amountToken:         result.outputAmount,
            initialAmountToken:  result.outputAmount,
            amountSol,
            strategy:            'AUTO',
            txid:                result.txid,
            isSimulation:        !!result.isSimulation,
            scoreAtEntry:        scoreResult.score,
        });

        trailingStop.initTrail(mint, entryPriceSol);
        riskManager.recordTrade({ pnlSol: 0 });

        if (CONFIG.ENABLE_BUY_ALERTS) {
            const simTag = result.isSimulation ? '  [ SIM ]' : '';
            await sendToChannel(
                `${f.header('AUTO-BUY EXECUTED' + simTag)}\n` +
                `${f.sep()}\n` +
                `${f.row('Token', esc(symbol))}\n` +
                `${f.row('Score', `${scoreResult.score} / 100`)}\n` +
                `${f.row('Spent', `${amountSol} SOL`)}\n` +
                `${f.row('Received', `${result.outputAmount.toFixed(0)} tokens`)}\n` +
                `${f.row('Entry price', entryPriceSol.toFixed(8), true)}\n` +
                `${f.row('Stop loss', stopLossPriceSol.toFixed(8), true)}\n` +
                `${f.sep()}\n` +
                `${f.txLink(result.txid)}`
            );
        }

        log.ok(`AUTO-BUY OK: ${symbol}  |  ${result.outputAmount.toFixed(0)} tokens`);
        return result;

    } catch (rawError) {
        buyLockSet.delete(mint);

        let errorMsg  = 'Unknown error';
        let errorLogs = [];
        let errorCode = 'UNKNOWN';

        if (rawError && typeof rawError === 'object') {
            errorMsg  = rawError.message || rawError.toString?.() || errorMsg;
            errorLogs = Array.isArray(rawError.logs) ? rawError.logs : errorLogs;
            errorCode = rawError.code || errorCode;
        } else {
            errorMsg = rawError?.toString?.() || errorMsg;
        }

        if (errorMsg.includes('GRADUATED')) { log.info(`Skip [${symbol}]: graduated`); return null; }
        if (errorMsg.includes('Token tidak terdeteksi')) { log.info(`Skip [${symbol}]: RPC delay`); return null; }

        log.err(`Auto-buy failed [${symbol}]: ${errorMsg}`);
        if (errorLogs.length > 0) log.txLogs(errorLogs.join('\n'));

        if (!errorMsg.includes('Max posisi') && !errorMsg.includes('Risk rejected')) {
            if (CONFIG.ENABLE_BUY_ALERTS) {
                await sendToChannel(
                    `${f.header('AUTO-BUY FAILED')}\n` +
                    `${f.sep()}\n` +
                    `${f.row('Token', esc(symbol))}\n` +
                    `${f.row('Score', scoreResult.score)}\n` +
                    `${f.row('Error', errorMsg.slice(0, 120))}\n` +
                    `${f.row('Code', errorCode)}`
                ).catch(() => {});
            }
        }
        return null;
    }
}

// ============================================================
// MANUAL CLOSE
// ============================================================
async function manualClose(mint) {
    const CONFIG = require('../config');
    const pos    = posTracker.getPosition(mint);
    if (!pos) throw new Error('Position not found');

    const balance = await pump.getBalance(mint);
    if (balance <= 0) {
        const closed = posTracker.closePosition(mint, { exitPriceSol: pos.entryPriceSol, reason: 'manual_empty' });
        trailingStop.removeTrail(mint);
        return { ...closed, txid: 'no_token' };
    }

    const result = await executeSellWithDustPasses(mint, balance, {
        slippageBps: 2000,
        isSimulation: pos.isSimulation || CONFIG.ENABLE_SIMULATION_MODE,
        priorityMicroLamports: priorityMicroForPos(pos),
    }, true);

    const currentPrice = await pump.getTokenPriceInSol(mint) || pos.entryPriceSol;
    const closed = posTracker.closePosition(mint, { exitPriceSol: currentPrice, reason: 'manual', txid: result.txid });

    trailingStop.removeTrail(mint);
    if (closed) riskManager.recordTrade({ pnlSol: closed.pnlSol || 0 });
    return { ...closed, txid: result.txid };
}

// ============================================================
// CLOSE ALL POSITIONS
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
        await sleep(1_500);
    }
    return results;
}

// ============================================================
// CLEAR SIM POSITIONS
// ============================================================
function clearSimPositions() {
    let count = 0;
    for (const pos of posTracker.getAllPositions()) {
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
    handleStreamPrice,
    isSimMode: () => isSimMode,
    dca,
    grid,
    posTracker,
    riskManager,
    trailingStop,
    scorer,
    pump,
};