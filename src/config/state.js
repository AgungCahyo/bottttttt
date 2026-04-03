'use strict';
const fs   = require('fs');
const path = require('path');

// ============================================================
// FILE CACHE
// ============================================================
const CACHE_FILE = path.join(__dirname, '../../sent_news.json');

let sentArticleIds = new Set();

function loadCache() {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            sentArticleIds = new Set(data);
            console.log(`💾 Cache dimuat: ${sentArticleIds.size} ID berita lama.`);
        }
    } catch (err) {
        console.warn('⚠️ Gagal memuat cache:', err.message);
    }
}

function saveCache() {
    try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify(Array.from(sentArticleIds)), 'utf8');
    } catch (err) {
        console.warn('⚠️ Gagal menyimpan cache:', err.message);
    }
}

function trimCache(maxSize = 1000) {
    if (sentArticleIds.size > maxSize) {
        sentArticleIds = new Set(Array.from(sentArticleIds).slice(-maxSize));
        saveCache();
    }
}

// ============================================================
// RUNTIME STATS
// ============================================================
const stats = {
    botStartTime:    Date.now(),
    newsSentCount:   0,
    webhookHitCount: 0,
    moonerAlertCount: 0,
};

// ============================================================
// POLLING STATE
// ============================================================
let isPollingActive = true;

// ============================================================
// SOL PRICE
// ============================================================
let currentSolPrice = 140.0; // fallback

// ============================================================
// TRACKED TOKENS (Pump.fun)
// ============================================================
const trackedTokens = new Map();

module.exports = {
    // Cache
    get sentArticleIds() { return sentArticleIds; },
    loadCache,
    saveCache,
    trimCache,
    addSentId(id) { sentArticleIds.add(id); },
    hasSentId(id)  { return sentArticleIds.has(id); },
    cacheSize()    { return sentArticleIds.size; },

    // Stats
    stats,

    // Polling
    get isPollingActive() { return isPollingActive; },
    pausePolling()        { isPollingActive = false; },
    resumePolling()       { isPollingActive = true;  },

    // SOL Price
    get currentSolPrice()    { return currentSolPrice; },
    setSolPrice(price)       { currentSolPrice = price; },

    // Tracked Tokens
    trackedTokens,
};