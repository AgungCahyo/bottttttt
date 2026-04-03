'use strict';
const WebSocket = require('ws');
const { Markup } = require('telegraf');

const CONFIG  = require('../config');
const state   = require('../config/state');
const { formatEarlySignal, formatCallConfirmed } = require('../utils/formatters');
const { sendToChannel } = require('./telegram');
const tradingEngine     = require('../trading/tradingEngine');

const WS_URL = 'wss://pumpportal.fun/api/data';

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

// ============================================================
// MCap CALCULATOR
// ============================================================
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
    const token = createTokenEntry(event);
    state.trackedTokens.set(event.mint, token);

    // Subscribe to trades for this token
    ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [event.mint] }));

    // Auto-cleanup after track window
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

    const solAmount   = parseFloat(event.solAmount   || 0);
    const tokenAmount = parseFloat(event.tokenAmount || 0);
    const trader      = event.traderPublicKey;
    const timeDiffMs  = Date.now() - token.startTime;

    // --- Update state ---
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

    const mcapSol = calcMCapSol(solAmount, tokenAmount);
    const curve   = calcCurveProgress(token.volumeSol);

    // --- A. EARLY SIGNAL (first alert) ---
    if (!token.isAlerted &&
        token.volumeSol  >= CONFIG.PUMP_MIN_VOLUME_SOL &&
        token.buyers.size >= CONFIG.PUMP_MIN_BUYERS)
    {
        token.isAlerted    = true;
        token.alertMCapSol = mcapSol;

        const message  = formatEarlySignal(event.mint, token, mcapSol, curve, state.currentSolPrice);
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.url('Beli di Axiom', `https://axiom.trade/t/${event.mint}`)],
            [Markup.button.url('Analisa di Photon', `https://photon-sol.tinyastro.io/en/lp/${event.mint}`)],
        ]);
        await sendToChannel(message, keyboard);
        state.stats.moonerAlertCount++;
        console.log(`\n🪐 SIGNAL: ${token.symbol}`);

        // --- AUTO-BUY TRIGGER ---
        tradingEngine.executeAutoBuy(event.mint, token.symbol, CONFIG.AUTO_BUY_AMOUNT_SOL);
    }

    // --- B. PROFIT TRACKER (milestone alerts) ---
    if (token.isAlerted && token.alertMCapSol > 0) {
        const multiplier      = mcapSol / token.alertMCapSol;
        const wholeMultiplier = Math.floor(multiplier);

        if (wholeMultiplier >= 2 && !token.milestones.has(wholeMultiplier)) {
            token.milestones.add(wholeMultiplier);

            const message  = formatCallConfirmed(event.mint, token, mcapSol, multiplier, curve, state.currentSolPrice);
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.url('💰 Take Profit (Axiom)', `https://axiom.trade/t/${event.mint}`)],
                [Markup.button.url('🔭 Photon', `https://photon-sol.tinyastro.io/en/lp/${event.mint}`)],
            ]);
            await sendToChannel(message, keyboard);
            console.log(`🔥 PROFIT: ${token.symbol} ${wholeMultiplier}x`);
        }
    }
}

// ============================================================
// WEBSOCKET INIT (with auto-reconnect)
// ============================================================
function initPumpRadar() {
    console.log('📡 Menghubungkan ke Radar Pump.fun...');
    const ws = new WebSocket(WS_URL);

    ws.on('open', () => {
        console.log('✅ Radar Pump.fun TERKONEKSI!');
        ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    });

    ws.on('message', async (raw) => {
        try {
            const event = JSON.parse(raw);

            if (event.mint && (event.txType === 'create' || !event.txType)) {
                handleNewToken(event, ws);
            } else if (event.txType && event.mint) {
                await handleTrade(event);
            }
        } catch { /* ignore parse errors */ }
    });

    ws.on('close', () => {
        console.warn('⚠️  Radar terputus. Menghubungkan ulang dalam 5 detik...');
        setTimeout(initPumpRadar, 5_000);
    });

    ws.on('error', (err) => {
        console.error('❌ Radar WebSocket error:', err.message);
    });
}

module.exports = { initPumpRadar };