'use strict';
const CONFIG = require('../config');
const log    = require('../utils/logger');
const engine = require('../trading/tradingEngine');

function _parseWalletList(raw) {
    return String(raw || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
}

function isEnabled() {
    return !!CONFIG.ENABLE_COPY_TRADER;
}

function getWatchedWallets() {
    return _parseWalletList(CONFIG.COPY_TRADER_WALLETS);
}

function _isWatchedWallet(pubkey) {
    if (!pubkey) return false;
    const list = getWatchedWallets();
    if (list.length === 0) return false;
    return list.includes(pubkey);
}

const sellLock = new Set();

async function handlePumpPortalTrade(event) {
    if (!isEnabled()) return;

    const mint   = event?.mint;
    const txType = event?.txType;
    const trader = event?.traderPublicKey;
    if (!mint || !txType || !trader) return;

    if (!_isWatchedWallet(trader)) return;

    // Copy BUY
    if (txType === 'buy') {
        const amountSol = Number(CONFIG.COPY_TRADER_BUY_AMOUNT_SOL);
        if (!Number.isFinite(amountSol) || amountSol <= 0) return;

        const sym = event?.symbol || 'COPY';
        log.trade(`[COPY] ${trader.slice(0, 6)}… buy -> ${mint.slice(0, 8)}… (${sym})`);

        // scoreResult minimal agar kompatibel dengan engine logging & priority
        const scoreResult = { score: 99 };
        return engine.executeAutoBuy(mint, sym, null, scoreResult, {
            amountSolOverride: amountSol,
            strategyLabel: 'COPY-BUY',
            strategyCode: 'COPY',
        });
    }

    // Copy SELL (optional): jika wallet yang diikuti sell, kita close posisi yang sama
    if (txType === 'sell' && CONFIG.ENABLE_COPY_TRADER_COPY_SELL) {
        if (!engine.posTracker.hasPosition(mint)) return;
        if (sellLock.has(mint)) return;
        sellLock.add(mint);
        setTimeout(() => sellLock.delete(mint), 30_000);

        const pos = engine.posTracker.getPosition(mint);
        log.trade(`[COPY] ${trader.slice(0, 6)}… sell -> closing ${pos?.symbol || mint.slice(0, 8)}…`);
        try {
            await engine.manualClose(mint);
        } catch (e) {
            log.warn(`[COPY] close failed: ${e?.message || e}`);
        }
    }
}

module.exports = {
    isEnabled,
    getWatchedWallets,
    handlePumpPortalTrade,
};

