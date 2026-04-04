'use strict';
const WebSocket = require('ws');
const { Markup } = require('telegraf');

const CONFIG  = require('../config');
const state   = require('../config/state');
const scorer  = require('../trading/signalScorer');
const { formatEarlySignal, formatCallConfirmed } = require('../utils/formatters');
const { sendToChannel } = require('./telegram');
const tradingEngine = require('../trading/tradingEngine');

const WS_URL = 'wss://pumpportal.fun/api/data';
let activeWs = null;

// ============================================================
// TOKEN TRACKING FACTORY
// ============================================================
function createTokenEntry(event) {
    return {
        symbol:       event.symbol || '???',
        name:         event.name   || 'Unknown',
        dev:          event.traderPublicKey || 'unknown',
        startTime:    Date.now(),
        volumeSol:    0,
        buyers:       new Set(),
        buys:         0,
        sells:        0,
        whales:       0,
        maxWhaleBuy:  0,
        isAlerted:    false,
        isDevSold:    false,
        isBundled:    false,
        alertMCapSol: 0,
        milestones:   new Set(),
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
    process.stdout.write('.');
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
    const token = state.trackedTokens.get(event.mint);
    if (!token) return;

    const solAmount  = parseFloat(event.solAmount  || 0);
    const tokenAmt   = parseFloat(event.tokenAmount || 0);
    const trader     = event.traderPublicKey;
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
        // Evaluasi dengan scorer
        const scoreResult = scorer.evaluate(token);

        token.isAlerted    = true;
        token.alertMCapSol = mcapSol;
        state.stats.moonerAlertCount++;

        // Format pesan signal dengan info skor
        const message  = formatEarlySignalWithScore(event.mint, token, mcapSol, curve, scoreResult);
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.url('Beli di Axiom', `https://axiom.trade/t/${event.mint}`)],
            [Markup.button.url('Analisa di Photon', `https://photon-sol.tinyastro.io/en/lp/${event.mint}`)],
        ]);
        await sendToChannel(message, keyboard);

        const scoreTag = `[${scoreResult.score}/100]`;
        if (scoreResult.shouldBuy) {
            console.log(`\n🟢 SIGNAL ${scoreTag} AUTO-BUY: ${token.symbol}`);
            // Kirim ke trading engine hanya jika lolos filter
            tradingEngine.executeAutoBuy(event.mint, token.symbol, token, scoreResult);
        } else {
            const why = scoreResult.rejects.length > 0
                ? scoreResult.rejects.join(', ')
                : `score ${scoreResult.score} < ${scoreResult.minScore}`;
            console.log(`\n🟡 SIGNAL ${scoreTag} SKIP: ${token.symbol} — ${why}`);
        }
    }

    // ─── STREAMING PRICE UPDATE ────────────────────────────────
    // Jika koin ini sedang kita pegang (posisi terbuka), langsung gas update harga
    if (tradingEngine.posTracker.hasPosition(event.mint)) {
        tradingEngine.handleStreamPrice(event.mint, mcapSol / CONFIG.PUMP_TOTAL_SUPPLY);
    }
}

// ============================================================
// FORMAT SIGNAL + SKOR (Extended dari formatters.js)
// ============================================================
function formatEarlySignalWithScore(mint, data, mcapSol, curve, scoreResult) {
    const { esc } = require('../utils/helpers');
    const solPrice    = state.currentSolPrice;
    const usdMCap     = (mcapSol * solPrice).toLocaleString(undefined, { maximumFractionDigits: 0 });
    const usdVolume   = (data.volumeSol * solPrice).toLocaleString(undefined, { maximumFractionDigits: 0 });

    // Bar visual skor
    const filled  = Math.round(scoreResult.score / 10);
    const empty   = 10 - filled;
    const bar     = '█'.repeat(filled) + '░'.repeat(empty);

    // Rating label
    const rating  = scoreResult.score >= 75 ? '🔥 STRONG'  :
                    scoreResult.score >= 55 ? '✅ GOOD'     :
                    scoreResult.score >= 35 ? '⚠️ WEAK'    : '❌ POOR';

    // Hard reject flags
    const rejectLine = scoreResult.rejects.length > 0
        ? `‼️ REJECT: ${scoreResult.rejects.join(' | ')}\n\n`
        : '';

    // Auto-buy indicator
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
    console.log('📡 Menghubungkan ke Radar Pump.fun...');
    const ws = new WebSocket(WS_URL);
    activeWs = ws;

    ws.on('open', () => {
        console.log('✅ Radar Pump.fun TERKONEKSI!');
        ws.send(JSON.stringify({ method: 'subscribeNewToken' }));

        // Re-subscribe ke posisi terbuka jika ada (setelah restart)
        const openMints = tradingEngine.posTracker.getAllPositions().map(p => p.mint);
        if (openMints.length > 0) {
            console.log(`📡 Re-subscribing ke ${openMints.length} posisi terbuka...`);
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
        console.warn('⚠️  Radar terputus. Reconnect dalam 5 detik...');
        setTimeout(initPumpRadar, 5_000);
    });

    ws.on('error', err => console.error('❌ Radar error:', err.message));
}

function subscribeToMint(mint) {
    if (activeWs && activeWs.readyState === WebSocket.OPEN) {
        activeWs.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
    }
}

function unsubscribeFromMint(mint) {
    // HANYA unsubscribe jika koin tidak sedang di-track oleh radar (state.trackedTokens)
    if (state.trackedTokens.has(mint)) return;

    if (activeWs && activeWs.readyState === WebSocket.OPEN) {
        activeWs.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: [mint] }));
    }
}

module.exports = { initPumpRadar, subscribeToMint, unsubscribeFromMint };