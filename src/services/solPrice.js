'use strict';
const axios = require('axios');
const state = require('../config/state');

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

async function updateSolPrice() {
    for (const source of PRICE_SOURCES) {
        try {
            const { data } = await axios.get(source.url, { timeout: 8_000 });
            const price = source.parse(data);
            if (price && price > 0) {
                state.setSolPrice(price);
                console.log(`💰 Harga SOL: $${price.toFixed(2)} (via ${source.name})`);
                return; // berhasil, stop
            }
        } catch {
            console.warn(`⚠️ ${source.name} gagal, mencoba sumber berikutnya...`);
        }
    }
    console.warn(`⚠️ Semua sumber harga SOL gagal, menggunakan nilai lama ($${state.currentSolPrice.toFixed(2)})`);
}

function startPriceUpdater(intervalMs = 120_000) {
    updateSolPrice();
    setInterval(updateSolPrice, intervalMs);
}

module.exports = { updateSolPrice, startPriceUpdater };