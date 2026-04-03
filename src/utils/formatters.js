'use strict';
const { esc } = require('../utils/helpers');

// ============================================================
// NEWS FORMATTER
// ============================================================
function formatNews(article) {
    const title    = article.title       || '(tanpa judul)';
    const url      = article.link        || null;
    const source   = article.source_name || article.source_id || 'unknown';
    const keywords = Array.isArray(article.keywords) && article.keywords.length > 0
        ? article.keywords.slice(0, 4).map(k => `#${k.replace(/\s+/g, '')}`).join(' ')
        : '#Crypto #News';
    const linkPart = url ? `\n🔗 <a href="${esc(url)}">Baca Selengkapnya</a>` : '';

    return (
        `🔥 <b>NEWS UPDATE</b>\n\n` +
        `<b>${esc(title)}</b>\n\n` +
        `🌐 Sumber: ${esc(source)}` +
        linkPart + `\n\n` +
        `${keywords} #Blockchain`
    );
}

// ============================================================
// SOLANA WEBHOOK FORMATTER
// ============================================================
function formatSolanaWebhook(tx) {
    const { signature = 'N/A', type = 'UNKNOWN', source = 'N/A', description = 'Aktivitas baru di Solana.' } = tx;
    return (
        `💎 <b>SOLANA REAL-TIME MONITOR</b>\n\n` +
        `📦 <b>Activity:</b> <code>${type}</code>\n` +
        `⚡ <b>Source:</b> <code>${source}</code>\n\n` +
        `📝 <b>Info:</b>\n<i>${description}</i>\n\n` +
        `🔗 <a href="https://solscan.io/tx/${signature}">View on Solscan</a>`
    );
}

// ============================================================
// PUMP.FUN EARLY SIGNAL FORMATTER
// ============================================================
function formatEarlySignal(mint, data, mcapSol, curve, solPrice) {
    const timeElapsedSec = Math.floor((Date.now() - data.startTime) / 1000) || 1;
    const velocity  = (data.buys / (timeElapsedSec / 60)).toFixed(1);
    const usdMCap   = (mcapSol * solPrice).toLocaleString(undefined, { maximumFractionDigits: 0 });
    const usdVolume = (data.volumeSol * solPrice).toLocaleString(undefined, { maximumFractionDigits: 0 });

    // Score 0-100
    let score = 30;
    if (data.whales > 0)             score += 20;
    if (parseFloat(velocity) > 10)   score += 20;
    if (data.volumeSol > 10)         score += 20;
    if (data.isDevSold)              score -= 40;
    if (data.isBundled)              score += 10;
    score = Math.max(0, Math.min(100, score));

    // Flags
    const flags = [];
    if (parseFloat(velocity) > 20) flags.push('🚀 SPEED RUNNER');
    if (data.isDevSold)            flags.push('‼️ DEV SOLD');
    if (data.isBundled)            flags.push('‼️ BUNDLED LAUNCH');
    if (data.whales > 3)           flags.push('🐳 WHALE INTEREST');
    const flagLine = flags.length > 0 ? `${flags.join(' | ')}\n\n` : '';

    return (
        `⚡ <b>EARLY SIGNAL</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `<b>${esc(data.name)} ($${esc(data.symbol)})</b>\n\n` +
        flagLine +
        `<b>Score:</b> <code>${score}/100</code>\n` +
        `<b>MCap:</b> $${usdMCap}\n` +
        `<b>Volume:</b> <code>${data.volumeSol.toFixed(1)} SOL</code> (~$${usdVolume})\n` +
        `<b>Buyers:</b> ${data.buyers.size} | <b>B/S:</b> ${data.buys}/${data.sells}\n` +
        `<b>Velocity:</b> ${velocity} buys/min\n` +
        `<b>Curve:</b> ${curve}% | <b>Whales:</b> ${data.whales} (max ${data.maxWhaleBuy.toFixed(1)} SOL)\n` +
        `<b>Dev:</b> ${data.isDevSold ? 'Sold All ❌' : 'Active ✅'}\n\n` +
        `📍 <b>CA:</b> <code>${mint}</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `<a href="https://pump.fun/${mint}">pump.fun</a> | <a href="https://solscan.io/token/${mint}">Solscan</a>`
    );
}

// ============================================================
// PUMP.FUN CALL CONFIRMED FORMATTER
// ============================================================
function formatCallConfirmed(mint, data, currentMCapSol, multiplier, curve, solPrice) {
    const wholeMultiplier  = Math.floor(multiplier);
    const percent          = ((multiplier - 1) * 100).toFixed(0);
    const currentUsdMCap   = (currentMCapSol * solPrice).toLocaleString(undefined, { maximumFractionDigits: 0 });
    const alertUsdMCap     = (data.alertMCapSol * solPrice).toLocaleString(undefined, { maximumFractionDigits: 0 });

    return (
        `🔥 <b>${wholeMultiplier}x CALL CONFIRMED (+${percent}%)</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `🚀 <b>${esc(data.name)} ($${esc(data.symbol)})</b>\n\n` +
        `<b>Gain:</b> +${percent}% since alert (${multiplier.toFixed(1)}x)\n` +
        `<b>MCap now:</b> $${currentUsdMCap}\n` +
        `<b>MCap at alert:</b> $${alertUsdMCap}\n` +
        `<b>Curve:</b> ${curve}% | <b>Volume:</b> ${data.volumeSol.toFixed(1)} SOL\n\n` +
        `📍 <b>CA:</b> <code>${mint}</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `<a href="https://pump.fun/${mint}">pump.fun</a> | <a href="https://solscan.io/token/${mint}">Solscan</a>`
    );
}

module.exports = { formatNews, formatSolanaWebhook, formatEarlySignal, formatCallConfirmed };