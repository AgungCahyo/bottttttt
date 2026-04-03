'use strict';
const axios   = require('axios');
const CONFIG  = require('../config');
const state   = require('../config/state');
const { withRetry, sleep } = require('../utils/helpers');
const { formatNews }       = require('../utils/formatters');
const { sendToChannel }    = require('./telegram');

// ============================================================
// POLLING BERITA — NewsData.io
// Docs  : https://newsdata.io/documentation
// Free  : 200 req/hari, 10 artikel/req
// ============================================================
async function fetchCryptoNews() {
    if (!CONFIG.NEWSDATA_API_KEY) {
        console.warn('⚠️  NEWSDATA_API_KEY tidak diisi, polling dilewati.');
        return;
    }
    if (!state.isPollingActive) {
        console.log('⏸️  Polling di-pause.');
        return;
    }

    try {
        console.log('🔍 Mengecek berita terbaru dari NewsData.io...');

        const { data } = await withRetry(
            () => axios.get('https://newsdata.io/api/1/news', {
                timeout: 15_000,
                params: {
                    apikey:   CONFIG.NEWSDATA_API_KEY,
                    q:        'crypto OR bitcoin OR ethereum OR blockchain',
                    language: 'en',
                    category: 'business,technology',
                },
            }),
            'fetchCryptoNews'
        );

        if (data.status !== 'success') {
            console.error('❌ API NewsData.io error:', data.message || JSON.stringify(data));
            return;
        }

        const articles    = data.results || [];
        const newArticles = articles.filter(a => a.article_id && !state.hasSentId(a.article_id));

        if (newArticles.length === 0) {
            console.log('ℹ️  Semua berita di halaman depan sudah pernah dikirim.');
            return;
        }

        console.log(`📰 Menemukan ${newArticles.length} berita baru.`);

        // Pertama kali jalan: jangan spam, hanya kirim 2 terbaru
        const isFirstRun = state.cacheSize() === 0;
        if (isFirstRun) {
            console.log('🆕 Inisialisasi pertama: tandai semua, kirim 2 terbaru.');
            articles.forEach(a => state.addSentId(a.article_id));
        }

        const toSend = isFirstRun ? newArticles.slice(0, 2) : newArticles;

        for (const article of toSend.reverse()) {
            const result = await sendToChannel(formatNews(article));
            if (result) {
                state.addSentId(article.article_id);
                state.stats.newsSentCount++;
            }
            await sleep(1_000);
        }

        state.saveCache();
        state.trimCache(1_000);

        console.log(`✅ Berita selesai. Dikirim: ${toSend.length}`);

    } catch (err) {
        console.error('❌ fetchCryptoNews error:', err.message);
    }
}

// ============================================================
// START POLLING
// ============================================================
function startNewsPolling() {
    fetchCryptoNews();
    setInterval(fetchCryptoNews, CONFIG.NEWS_INTERVAL_MS);
    console.log(`📰 News polling aktif (setiap ${CONFIG.NEWS_INTERVAL_MS / 60_000} menit)`);
}

module.exports = { fetchCryptoNews, startNewsPolling };