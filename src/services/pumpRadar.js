'use strict';
const WebSocket = require('ws');
const { Markup } = require('telegraf');

const CONFIG  = require('../config');
const state   = require('../config/state');
const scorer  = require('../trading/signalScorer');
const f       = require('../utils/tgFormat');
const { sendToChannel } = require('./telegram');
const tradingEngine = require('../trading/tradingEngine');
const copyTrader    = require('./copyTrader');
const log = require('../utils/logger');

const WS_URL = 'wss://pumpportal.fun/api/data';
let activeWs = null;

const PUMP_STREAM_STRONG_SOL = 0.03;
const PUMP_STREAM_WEAK_SOL   = 0.012;
const STREAM_MARK_MIN_RATIO  = 0.3;
const STREAM_MARK_MAX_RATIO  = 3.5;
const SPOT_REFRESH_DEBOUNCE_MS = Math.max(250, Number(CONFIG.STREAM_SPOT_REFRESH_DEBOUNCE_MS) || 1200);
const SPOT_MIN_REFRESH_INTERVAL_MS = Math.max(500, Number(CONFIG.STREAM_SPOT_MIN_REFRESH_INTERVAL_MS) || 3000);

const lastMarkByMint    = new Map();
const spotRefreshTimers = new Map();
const spotRefreshInflight = new Set();
const lastSpotRefreshAt = new Map();

function markPlausible(mint, implied) {
    const prev = lastMarkByMint.get(mint);
    if (prev == null || !(prev > 0)) return false;
    const r = implied / prev;
    return r >= STREAM_MARK_MIN_RATIO && r <= STREAM_MARK_MAX_RATIO;
}

function scheduleSpotRefresh(mint) {
    if (spotRefreshTimers.has(mint)) return;
    if (spotRefreshInflight.has(mint)) return;
    const last = lastSpotRefreshAt.get(mint) || 0;
    if (Date.now() - last < SPOT_MIN_REFRESH_INTERVAL_MS) return;
    const t = setTimeout(() => {
        spotRefreshTimers.delete(mint);
        (async () => {
            if (spotRefreshInflight.has(mint)) return;
            spotRefreshInflight.add(mint);
            try {
                const pump = require('../trading/pumpClient');
                const spot = await pump.getSpotSolPerToken(mint);
                if (spot != null && spot > 0 && Number.isFinite(spot)) {
                    lastMarkByMint.set(mint, spot);
                    lastSpotRefreshAt.set(mint, Date.now());
                    tradingEngine.handleStreamPrice(mint, spot).catch(() => {});
                }
            } catch { /* ignore */ }
            finally {
                spotRefreshInflight.delete(mint);
            }
        })();
    }, SPOT_REFRESH_DEBOUNCE_MS);
    spotRefreshTimers.set(mint, t);
}

function updatePositionStreamMark(mint, solAmount, tokenAmt) {
    if (!mint) return;

    if (tokenAmt <= 0 || solAmount <= 0) {
        scheduleSpotRefresh(mint);
        return;
    }

    const implied = solAmount / tokenAmt;

    if (solAmount >= PUMP_STREAM_STRONG_SOL) {
        lastMarkByMint.set(mint, implied);
        tradingEngine.handleStreamPrice(mint, implied).catch(() => {});
        return;
    }

    if (solAmount >= PUMP_STREAM_WEAK_SOL && markPlausible(mint, implied)) {
        lastMarkByMint.set(mint, implied);
        tradingEngine.handleStreamPrice(mint, implied).catch(() => {});
        return;
    }

    scheduleSpotRefresh(mint);
}

// ============================================================
// TOKEN TRACKING FACTORY
// ============================================================
function createTokenEntry(event) {
    return {
        symbol:      event.symbol || '???',
        name:        event.name   || 'Unknown',
        dev:         event.traderPublicKey || 'unknown',
        startTime:   Date.now(),
        volumeSol:   0,
        buyers:      new Set(),
        buys:        0,
        sells:       0,
        whales:      0,
        maxWhaleBuy: 0,
        recentBuys:  0,
        isAlerted:   false,
        isDevSold:   false,
        isBundled:   false,
        alertMCapSol: 0,
        milestones:  new Set(),
        tradeTape:   [], // { ts, type, sol, trader }
        buySolByWallet: new Map(),
    };
}

function pruneTradeTape(token, now = Date.now()) {
    // Keep last 2 minutes only; enough for momentum windows.
    const minTs = now - 120_000;
    token.tradeTape = token.tradeTape.filter(t => t.ts >= minTs);
}

function calcMCapSol(solAmount, tokenAmount) {
    if (!tokenAmount || tokenAmount === 0) return 0;
    return (solAmount / tokenAmount) * CONFIG.PUMP_TOTAL_SUPPLY;
}

function calcCurveProgress(volumeSol) {
    return Math.min((volumeSol / CONFIG.PUMP_CURVE_TARGET_SOL) * 100, 100).toFixed(0);
}

// ============================================================
// HANDLE NEW TOKEN
// ============================================================
function handleNewToken(event, ws) {
    process.stdout.write(log.paint(log.C.gray, '.'));
    state.trackedTokens.set(event.mint, createTokenEntry(event));
    ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [event.mint] }));

    setTimeout(() => {
        state.trackedTokens.delete(event.mint);
        ws.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: [event.mint] }));
    }, CONFIG.PUMP_TRACK_WINDOW_MS);
}

// ============================================================
// HANDLE TRADE
// ============================================================
async function handleTrade(event) {
    const solAmount = parseFloat(event.solAmount || 0);
    const tokenAmt  = parseFloat(event.tokenAmount || 0);
    const trader    = event.traderPublicKey;

    // Optional: copy-trading (Trojan-style) based on watched wallets
    copyTrader.handlePumpPortalTrade(event).catch(() => {});

    if (event.mint && tradingEngine.posTracker.hasPosition(event.mint)) {
        updatePositionStreamMark(event.mint, solAmount, tokenAmt);
    }

    const token = state.trackedTokens.get(event.mint);
    if (!token) return;

    const timeDiffMs = Date.now() - token.startTime;
    const now = Date.now();

    token.volumeSol += solAmount;
    token.tradeTape.push({
        ts: now,
        type: event.txType,
        sol: Number.isFinite(solAmount) ? solAmount : 0,
        trader: trader || null,
    });
    pruneTradeTape(token, now);

    if (event.txType === 'buy') {
        token.buys++;
        if (trader) token.buyers.add(trader);
        if (trader) {
            const prev = token.buySolByWallet.get(trader) || 0;
            token.buySolByWallet.set(trader, prev + (Number.isFinite(solAmount) ? solAmount : 0));
        }
        if (solAmount >= CONFIG.MIN_WHALE_SOL) {
            token.whales++;
            if (solAmount > token.maxWhaleBuy) token.maxWhaleBuy = solAmount;
        }
        if (timeDiffMs < CONFIG.BUNDLED_WINDOW_MS && token.buys > 5) {
            token.isBundled = true;
        }
    } else if (event.txType === 'sell') {
        token.sells++;
        if (trader === token.dev) token.isDevSold = true;
    }

    // Rolling recent buys in last 30s (used by scorer)
    const minTs30 = now - 30_000;
    token.recentBuys = token.tradeTape.reduce((acc, t) => {
        if (t.ts < minTs30) return acc;
        return acc + (t.type === 'buy' ? 1 : 0);
    }, 0);

    const mcapSol = calcMCapSol(solAmount, tokenAmt);
    const curve   = calcCurveProgress(token.volumeSol);

    // ─── EARLY SIGNAL CHECK ────────────────────────────────────
    if (!token.isAlerted &&
        token.volumeSol   >= CONFIG.PUMP_MIN_VOLUME_SOL &&
        token.buyers.size >= CONFIG.PUMP_MIN_BUYERS)
    {
        const scoreResult = scorer.evaluate(token);

        token.isAlerted    = true;
        token.alertMCapSol = mcapSol;
        state.stats.moonerAlertCount++;

        if (CONFIG.ENABLE_SIGNAL_ALERTS) {
            const message  = formatEarlySignalWithScore(event.mint, token, mcapSol, curve, scoreResult);
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.url('axiom.trade', `https://axiom.trade/t/${event.mint}`)],
                [Markup.button.url('photon', `https://photon-sol.tinyastro.io/en/lp/${event.mint}`)],
            ]);
            await sendToChannel(message, keyboard);
        }

        const scoreTag = `[${scoreResult.score}/100]`;
        if (scoreResult.shouldBuy) {
            log.signal(`${scoreTag} AUTO-BUY: ${token.symbol}`);
            tradingEngine.executeAutoBuy(event.mint, token.symbol, token, scoreResult);
        } else {
            const why = scoreResult.rejects.length > 0
                ? scoreResult.rejects.join(', ')
                : `score ${scoreResult.score} < ${scoreResult.minScore}`;
            log.skip(`${scoreTag} ${token.symbol} — ${why}`);
        }

        return;
    }

    // ─── CALL CONFIRMED (profit milestone) ────────────────────
    if (token.isAlerted && token.alertMCapSol > 0 && mcapSol > 0) {
        const multiplier      = mcapSol / token.alertMCapSol;
        const wholeMultiplier = Math.floor(multiplier);

        if (wholeMultiplier >= 2 && !token.milestones.has(wholeMultiplier)) {
            token.milestones.add(wholeMultiplier);

            if (CONFIG.ENABLE_SIGNAL_ALERTS) {
                const solPrice    = state.currentSolPrice;
                const percent     = ((multiplier - 1) * 100).toFixed(0);
                const currentUsdM = (mcapSol * solPrice).toLocaleString('en-US', { maximumFractionDigits: 0 });
                const alertUsdM   = (token.alertMCapSol * solPrice).toLocaleString('en-US', { maximumFractionDigits: 0 });

                const msg =
                    `${f.header(`CALL CONFIRMED  ${wholeMultiplier}x  +${percent}%`)}\n` +
                    `${f.sep()}\n` +
                    `<b>${f.esc(token.name)}</b>  <code>$${f.esc(token.symbol)}</code>\n\n` +
                    `${f.row('Gain', `+${percent}%  (${multiplier.toFixed(1)}x from alert)`)}\n` +
                    `${f.row('MCap now', `$${currentUsdM}`)}\n` +
                    `${f.row('MCap at alert', `$${alertUsdM}`)}\n` +
                    `${f.row('Curve', `${curve}%  |  Volume  ${token.volumeSol.toFixed(1)} SOL`)}\n\n` +
                    `${f.row('CA', event.mint, true)}\n` +
                    `${f.sep()}\n` +
                    `${f.tokenLink(event.mint)}`;

                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.url('take profit  (axiom)', `https://axiom.trade/t/${event.mint}`)],
                    [Markup.button.url('photon', `https://photon-sol.tinyastro.io/en/lp/${event.mint}`)],
                ]);
                await sendToChannel(msg, keyboard);
            }

            log.signal(`PROFIT: ${token.symbol} ${wholeMultiplier}x`);
        }
    }
}

// ============================================================
// FORMAT EARLY SIGNAL + SCORE
// ============================================================
function formatEarlySignalWithScore(mint, data, mcapSol, curve, scoreResult) {
    const solPrice  = state.currentSolPrice;
    const usdMCap   = (mcapSol * solPrice).toLocaleString('en-US', { maximumFractionDigits: 0 });
    const usdVolume = (data.volumeSol * solPrice).toLocaleString('en-US', { maximumFractionDigits: 0 });

    // Score bar: 10 chars
    const filled = Math.round(scoreResult.score / 10);
    const bar    = '#'.repeat(filled) + '-'.repeat(10 - filled);

    const rating =
        scoreResult.score >= 75 ? 'STRONG' :
        scoreResult.score >= 55 ? 'GOOD'   :
        scoreResult.score >= 35 ? 'WEAK'   : 'POOR';

    // Flags
    const flags = [];
    if (data.isDevSold)                      flags.push('DEV SOLD');
    if (data.isBundled)                      flags.push('BUNDLED LAUNCH');
    if (data.whales > 3)                     flags.push('WHALE CLUSTER');
    if (parseFloat(scoreResult.velocity) > 20) flags.push('SPEED RUNNER');

    const rejectLine = scoreResult.rejects.length > 0
        ? `${f.row('REJECT', scoreResult.rejects.join(' | '))}\n\n`
        : '';

    const autoBuyLine = scoreResult.shouldBuy
        ? `${f.row('Auto-buy', 'TRIGGERED')}\n\n`
        : `${f.row('Auto-buy', `skipped  (min score ${scoreResult.minScore})`)}\n\n`;

    return (
        `${f.header('EARLY SIGNAL')}\n` +
        `${f.sep()}\n` +
        `<b>${f.esc(data.name)}</b>  <code>$${f.esc(data.symbol)}</code>\n\n` +
        rejectLine +
        (flags.length > 0 ? `${f.row('Flags', flags.join('  |  '))}\n\n` : '') +
        `${f.rowRaw('Score', `<code>${bar}</code>  ${scoreResult.score}/100  ${rating}`)}\n\n` +
        autoBuyLine +
        `${f.row('MCap', `$${usdMCap}  |  Curve  ${curve}%`)}\n` +
        `${f.row('Volume', `${data.volumeSol.toFixed(1)} SOL  (~$${usdVolume})`)}\n` +
        `${f.row('Buyers', `${data.buyers.size}  |  B/S  ${data.buys}/${data.sells}`)}\n` +
        `${f.row('Velocity', `${scoreResult.velocity} buys/min`)}\n` +
        `${f.row('Whales', `${data.whales}  (max ${data.maxWhaleBuy.toFixed(1)} SOL)`)}\n` +
        `${f.row('Dev', data.isDevSold ? 'SOLD' : 'Holding')}\n` +
        `${f.row('Bundled', data.isBundled ? 'Yes' : 'No')}\n\n` +
        `${f.row('CA', mint, true)}\n` +
        `${f.sep()}\n` +
        `${f.tokenLink(mint)}`
    );
}

// ============================================================
// WEBSOCKET INIT
// ============================================================
function initPumpRadar() {
    log.radar('Connecting to Pump.fun WebSocket...');
    const ws = new WebSocket(WS_URL);
    activeWs = ws;

    ws.on('open', () => {
        log.ok('Pump.fun radar connected');
        ws.send(JSON.stringify({ method: 'subscribeNewToken' }));

        const openMints = tradingEngine.posTracker.getAllPositions().map(p => p.mint);
        if (openMints.length > 0) {
            log.radar(`Re-subscribing ${openMints.length} open position(s)`);
            ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: openMints }));
        }
    });

    ws.on('message', async (raw) => {
        try {
            const event = JSON.parse(raw);
            if (event.mint && (event.txType === 'create' || !event.txType)) {
                handleNewToken(event, ws);
            } else if (event.txType && event.mint) {
                await handleTrade(event);
            }
        } catch { /* ignore */ }
    });

    ws.on('close', () => {
        activeWs = null;
        log.radarWarn('Radar disconnected — reconnecting in 5s');
        setTimeout(initPumpRadar, 5_000);
    });

    ws.on('error', err => log.radarErr(err.message));
}

function subscribeToMint(mint) {
    if (activeWs && activeWs.readyState === WebSocket.OPEN) {
        activeWs.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
    }
}

function unsubscribeFromMint(mint) {
    if (state.trackedTokens.has(mint)) return;
    if (activeWs && activeWs.readyState === WebSocket.OPEN) {
        activeWs.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: [mint] }));
    }
}

const posTracker = require('../trading/positionTracker');
posTracker.on('opened', (pos) => {
    if (pos?.mint && pos.entryPriceSol > 0) lastMarkByMint.set(pos.mint, pos.entryPriceSol);
});
posTracker.on('closed', (pos) => {
    if (!pos?.mint) return;
    lastMarkByMint.delete(pos.mint);
    lastSpotRefreshAt.delete(pos.mint);
    spotRefreshInflight.delete(pos.mint);
    const tid = spotRefreshTimers.get(pos.mint);
    if (tid) clearTimeout(tid);
    spotRefreshTimers.delete(pos.mint);
});

module.exports = { initPumpRadar, subscribeToMint, unsubscribeFromMint };