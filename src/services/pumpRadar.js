'use strict';
const WebSocket = require('ws');
const { Markup } = require('telegraf');

const CONFIG  = require('../config');
const state   = require('../config/state');
const scorer  = require('../trading/signalScorer');
const { sendToChannel } = require('./telegram');
const tradingEngine = require('../trading/tradingEngine');
const log = require('../utils/logger');

const WS_URL = 'wss://pumpportal.fun/api/data';
let activeWs = null;

const PUMP_STREAM_STRONG_SOL = 0.03;
const PUMP_STREAM_WEAK_SOL   = 0.012;
const STREAM_MARK_MIN_RATIO  = 0.3;
const STREAM_MARK_MAX_RATIO  = 3.5;
const SPOT_REFRESH_DEBOUNCE_MS = 320;

const lastMarkByMint    = new Map();
const spotRefreshTimers = new Map();

function markPlausible(mint, implied) {
    const prev = lastMarkByMint.get(mint);
    if (prev == null || !(prev > 0)) return false;
    const r = implied / prev;
    return r >= STREAM_MARK_MIN_RATIO && r <= STREAM_MARK_MAX_RATIO;
}

function scheduleSpotRefresh(mint) {
    if (spotRefreshTimers.has(mint)) return;
    const t = setTimeout(() => {
        spotRefreshTimers.delete(mint);
        (async () => {
            try {
                const pump = require('../trading/pumpClient');
                const spot = await pump.getSpotSolPerToken(mint);
                if (spot != null && spot > 0 && Number.isFinite(spot)) {
                    lastMarkByMint.set(mint, spot);
                    tradingEngine.handleStreamPrice(mint, spot).catch(() => {});
                }
            } catch { /* ignore */ }
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
        isAlerted:   false,
        isDevSold:   false,
        isBundled:   false,
        alertMCapSol: 0,
        milestones:  new Set(),
    };
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

    if (event.mint && tradingEngine.posTracker.hasPosition(event.mint)) {
        updatePositionStreamMark(event.mint, solAmount, tokenAmt);
    }

    const token = state.trackedTokens.get(event.mint);
    if (!token) return;

    const timeDiffMs = Date.now() - token.startTime;

    token.volumeSol += solAmount;

    if (event.txType === 'buy') {
        token.buys++;
        if (trader) token.buyers.add(trader);
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

        // ── Kirim ke channel HANYA jika flag aktif ──────────────
        if (CONFIG.ENABLE_SIGNAL_ALERTS) {
            const message  = formatEarlySignalWithScore(event.mint, token, mcapSol, curve, scoreResult);
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.url('Beli di Axiom', `https://axiom.trade/t/${event.mint}`)],
                [Markup.button.url('Analisa di Photon', `https://photon-sol.tinyastro.io/en/lp/${event.mint}`)],
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

        return; // tidak perlu cek call confirmed pada tick yang sama
    }

    // ─── CALL CONFIRMED (profit milestone) ────────────────────
    if (token.isAlerted && token.alertMCapSol > 0 && mcapSol > 0) {
        const multiplier      = mcapSol / token.alertMCapSol;
        const wholeMultiplier = Math.floor(multiplier);

        if (wholeMultiplier >= 2 && !token.milestones.has(wholeMultiplier)) {
            token.milestones.add(wholeMultiplier);

            // ── Kirim hanya jika flag sinyal aktif ─────────────
            if (CONFIG.ENABLE_SIGNAL_ALERTS) {
                const { esc } = require('../utils/helpers');
                const solPrice    = state.currentSolPrice;
                const percent     = ((multiplier - 1) * 100).toFixed(0);
                const currentUsdM = (mcapSol * solPrice).toLocaleString(undefined, { maximumFractionDigits: 0 });
                const alertUsdM   = (token.alertMCapSol * solPrice).toLocaleString(undefined, { maximumFractionDigits: 0 });

                const msg =
                    `🔥 <b>${wholeMultiplier}x CALL CONFIRMED (+${percent}%)</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━━\n` +
                    `🚀 <b>${esc(token.name)} ($${esc(token.symbol)})</b>\n\n` +
                    `<b>Gain:</b> +${percent}% since alert (${multiplier.toFixed(1)}x)\n` +
                    `<b>MCap now:</b> $${currentUsdM}\n` +
                    `<b>MCap at alert:</b> $${alertUsdM}\n` +
                    `<b>Curve:</b> ${curve}% | <b>Volume:</b> ${token.volumeSol.toFixed(1)} SOL\n\n` +
                    `📍 <b>CA:</b> <code>${event.mint}</code>\n` +
                    `━━━━━━━━━━━━━━━━━━━━━\n` +
                    `<a href="https://pump.fun/${event.mint}">pump.fun</a> | <a href="https://solscan.io/token/${event.mint}">Solscan</a>`;

                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.url('💰 Take Profit (Axiom)', `https://axiom.trade/t/${event.mint}`)],
                    [Markup.button.url('🔭 Photon', `https://photon-sol.tinyastro.io/en/lp/${event.mint}`)],
                ]);
                await sendToChannel(msg, keyboard);
            }

            log.signal(`PROFIT: ${token.symbol} ${wholeMultiplier}x`);
        }
    }
}

// ============================================================
// FORMAT EARLY SIGNAL + SKOR
// ============================================================
function formatEarlySignalWithScore(mint, data, mcapSol, curve, scoreResult) {
    const { esc } = require('../utils/helpers');
    const solPrice  = state.currentSolPrice;
    const usdMCap   = (mcapSol * solPrice).toLocaleString(undefined, { maximumFractionDigits: 0 });
    const usdVolume = (data.volumeSol * solPrice).toLocaleString(undefined, { maximumFractionDigits: 0 });

    const filled  = Math.round(scoreResult.score / 10);
    const empty   = 10 - filled;
    const bar     = '█'.repeat(filled) + '░'.repeat(empty);

    const rating  = scoreResult.score >= 75 ? '🔥 STRONG'  :
                    scoreResult.score >= 55 ? '✅ GOOD'     :
                    scoreResult.score >= 35 ? '⚠️ WEAK'    : '❌ POOR';

    const rejectLine = scoreResult.rejects.length > 0
        ? `‼️ REJECT: ${scoreResult.rejects.join(' | ')}\n\n`
        : '';

    const autoBuyLine = scoreResult.shouldBuy
        ? `🤖 <b>AUTO-BUY TRIGGERED</b>\n\n`
        : `🚫 <i>Auto-buy dilewati (skor terlalu rendah)</i>\n\n`;

    return (
        `⚡ <b>EARLY SIGNAL</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `<b>${esc(data.name)} ($${esc(data.symbol)})</b>\n\n` +
        rejectLine +
        `<b>Score:</b> <code>${bar}</code> ${scoreResult.score}/100 ${rating}\n` +
        autoBuyLine +
        `<b>MCap:</b> $${usdMCap} | <b>Curve:</b> ${curve}%\n` +
        `<b>Volume:</b> <code>${data.volumeSol.toFixed(1)} SOL</code> (~$${usdVolume})\n` +
        `<b>Buyers:</b> ${data.buyers.size} | <b>B/S:</b> ${data.buys}/${data.sells}\n` +
        `<b>Velocity:</b> ${scoreResult.velocity} buys/min\n` +
        `<b>Whales:</b> ${data.whales} (max ${data.maxWhaleBuy.toFixed(1)} SOL)\n` +
        `<b>Dev:</b> ${data.isDevSold ? 'SOLD ❌' : 'Holding ✅'} | <b>Bundled:</b> ${data.isBundled ? 'Yes ⚠️' : 'No ✅'}\n\n` +
        `📍 <b>CA:</b> <code>${mint}</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `<a href="https://pump.fun/${mint}">pump.fun</a> | <a href="https://solscan.io/token/${mint}">Solscan</a>`
    );
}

// ============================================================
// WEBSOCKET INIT
// ============================================================
function initPumpRadar() {
    log.radar('Menghubungkan ke Pump.fun WebSocket…');
    const ws = new WebSocket(WS_URL);
    activeWs = ws;

    ws.on('open', () => {
        log.ok('Radar Pump.fun terhubung');
        ws.send(JSON.stringify({ method: 'subscribeNewToken' }));

        const openMints = tradingEngine.posTracker.getAllPositions().map(p => p.mint);
        if (openMints.length > 0) {
            log.radar(`Re-subscribe ${openMints.length} posisi terbuka`);
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
        log.radarWarn('Radar terputus — reconnect ~5s');
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
    const tid = spotRefreshTimers.get(pos.mint);
    if (tid) clearTimeout(tid);
    spotRefreshTimers.delete(pos.mint);
});

module.exports = { initPumpRadar, subscribeToMint, unsubscribeFromMint };