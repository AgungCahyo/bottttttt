'use strict';
const axios = require('axios');
const state = require('../config/state');
const log = require('../utils/logger');

// Coba beberapa sumber secara berurutan
const PRICE_SOURCES = [
    {
        name: 'CoinGecko',
        url:  'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
        parse: (data) => data?.solana?.usd,
    },
    {
        name: 'Binance',
        url:  'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT',
        parse: (data) => data?.price ? parseFloat(data.price) : null,
    },
    {
        name: 'KuCoin',
        url:  'https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=SOL-USDT',
        parse: (data) => data?.data?.price ? parseFloat(data.data.price) : null,
    },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function safeGet(url, label) {
    const CONFIG = require('../config');
    const maxRetry = Math.max(0, Number(CONFIG.HTTP_MAX_RETRIES_429) || 4);
    for (let i = 0; i <= maxRetry; i++) {
        try {
            return await axios.get(url, { timeout: 8_000 });
        } catch (e) {
            const status = e?.response?.status;
            if (status !== 429 || i >= maxRetry) throw e;
            const retryAfter = Number(e?.response?.headers?.['retry-after']);
            const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
                ? Math.ceil(retryAfter * 1000)
                : Math.min(5000, 500 * (2 ** i));
            log.warn(`Harga SOL: ${label} 429, retry ${waitMs}ms`);
            await sleep(waitMs + Math.floor(Math.random() * 100));
        }
    }
}

async function updateSolPrice() {
    for (const source of PRICE_SOURCES) {
        try {
            const { data } = await safeGet(source.url, source.name);
            const price = source.parse(data);
            if (price && price > 0) {
                state.setSolPrice(price);
                log.price(`SOL $${price.toFixed(2)} (${source.name})`);
                return; // berhasil, stop
            }
        } catch {
            log.warn(`Harga SOL: ${source.name} gagal, coba sumber lain…`);
        }
    }
    log.warn(`Semua sumber harga SOL gagal — pakai nilai lama $${state.currentSolPrice.toFixed(2)}`);
}

function startPriceUpdater(intervalMs = 120_000) {
    updateSolPrice();
    setInterval(updateSolPrice, intervalMs);
}

module.exports = { updateSolPrice, startPriceUpdater };