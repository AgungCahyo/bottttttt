'use strict';
const express = require('express');
const CONFIG  = require('../config');
const state   = require('../config/state');
const { formatUptime }          = require('../utils/helpers');
const { formatSolanaWebhook }   = require('../utils/formatters');
const { sendToChannel }         = require('../services/telegram');

const router = express.Router();

// ============================================================
// WEBHOOK SECRET VALIDATOR
// ============================================================
function isValidWebhook(req) {
    if (!CONFIG.WEBHOOK_SECRET) return true;
    const secret = req.headers['x-webhook-secret'] || req.headers['authorization'];
    return secret === CONFIG.WEBHOOK_SECRET;
}

// ============================================================
// POST /solana-webhook
// ============================================================
router.post('/solana-webhook', async (req, res) => {
    if (!CONFIG.ENABLE_SOLANA_STREAM) {
        return res.status(200).send('Solana Stream is currently disabled.');
    }
    if (!isValidWebhook(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const transactions = req.body;
        if (!Array.isArray(transactions) || transactions.length === 0) {
            return res.status(200).send('OK');
        }

        console.log(`⛓️ Menerima ${transactions.length} transaksi Solana...`);

        for (const tx of transactions) {
            await sendToChannel(formatSolanaWebhook(tx));
            state.stats.webhookHitCount++;
        }

        return res.status(200).send('Webhook received.');
    } catch (err) {
        console.error('❌ Solana webhook error:', err.message);
        return res.status(500).send('Internal Server Error');
    }
});

// ============================================================
// GET /health
// ============================================================
router.get('/health', (_req, res) => {
    res.json({
        status:       'ok',
        uptime:       formatUptime(state.stats.botStartTime),
        news_sent:    state.stats.newsSentCount,
        webhook_hits: state.stats.webhookHitCount,
        mooner_alerts: state.stats.moonerAlertCount,
        polling:      state.isPollingActive,
        cache_size:   state.cacheSize(),
        sol_price:    state.currentSolPrice,
        tracked_tokens: state.trackedTokens.size,
    });
});

module.exports = router;