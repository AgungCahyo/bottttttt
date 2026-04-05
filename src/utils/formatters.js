'use strict';

const { esc } = require('./helpers');
const f = require('./tgFormat');

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
    const linkPart = url
        ? `\n<a href="${esc(url)}">Baca selengkapnya</a>`
        : '';

    return (
        `${f.header('NEWS UPDATE')}\n` +
        `${f.sep()}\n` +
        `<b>${esc(title)}</b>\n\n` +
        `${f.row('Sumber', source)}` +
        linkPart + `\n\n` +
        `<i>${keywords} #Blockchain</i>`
    );
}

// ============================================================
// SOLANA WEBHOOK FORMATTER
// ============================================================
function formatSolanaWebhook(tx) {
    const { signature = 'N/A', type = 'UNKNOWN', source = 'N/A', description = 'Aktivitas baru di Solana.' } = tx;
    return (
        `${f.header('SOLANA MONITOR')}\n` +
        `${f.sep()}\n` +
        `${f.row('Activity', type, true)}\n` +
        `${f.row('Source', source, true)}\n\n` +
        `<i>${esc(description)}</i>\n\n` +
        `${f.txLink(signature)}`
    );
}

// ============================================================
// PUMP.FUN EARLY SIGNAL FORMATTER (legacy — tanpa skor)
// ============================================================
function formatEarlySignal(mint, data, mcapSol, curve, solPrice) {
    const timeElapsedSec = Math.max(Math.floor((Date.now() - data.startTime) / 1000), 1);
    const velocity  = (data.buys / (timeElapsedSec / 60)).toFixed(1);
    const usdMCap   = (mcapSol  * solPrice).toLocaleString('en-US', { maximumFractionDigits: 0 });
    const usdVolume = (data.volumeSol * solPrice).toLocaleString('en-US', { maximumFractionDigits: 0 });

    let score = 30;
    if (data.whales > 0)           score += 20;
    if (parseFloat(velocity) > 10) score += 20;
    if (data.volumeSol > 10)       score += 20;
    if (data.isDevSold)            score -= 40;
    if (data.isBundled)            score += 10;
    score = Math.max(0, Math.min(100, score));

    const flags = [];
    if (parseFloat(velocity) > 20) flags.push('SPEED RUNNER');
    if (data.isDevSold)            flags.push('DEV SOLD');
    if (data.isBundled)            flags.push('BUNDLED LAUNCH');
    if (data.whales > 3)           flags.push('WHALE INTEREST');
    const flagLine = flags.length > 0 ? `<b>FLAGS</b>  ${flags.join(' | ')}\n\n` : '';

    return (
        `${f.header('EARLY SIGNAL')}\n` +
        `${f.sep()}\n` +
        `<b>${esc(data.name)}</b>  <code>$${esc(data.symbol)}</code>\n\n` +
        flagLine +
        `${f.row('Score', `${score}/100`)}\n` +
        `${f.row('MCap', `$${usdMCap}`)}\n` +
        `${f.row('Volume', `${data.volumeSol.toFixed(1)} SOL  (~$${usdVolume})`)}\n` +
        `${f.row('Buyers', `${data.buyers.size}  |  B/S  ${data.buys}/${data.sells}`)}\n` +
        `${f.row('Velocity', `${velocity} buys/min`)}\n` +
        `${f.row('Curve', `${curve}%  |  Whales  ${data.whales}  (max ${data.maxWhaleBuy.toFixed(1)} SOL)`)}\n` +
        `${f.row('Dev', data.isDevSold ? 'SOLD' : 'Holding')}\n\n` +
        `${f.row('CA', mint, true)}\n` +
        `${f.sep()}\n` +
        `${f.tokenLink(mint)}`
    );
}

// ============================================================
// PUMP.FUN CALL CONFIRMED FORMATTER
// ============================================================
function formatCallConfirmed(mint, data, currentMCapSol, multiplier, curve, solPrice) {
    const wholeMultiplier = Math.floor(multiplier);
    const percent         = ((multiplier - 1) * 100).toFixed(0);
    const currentUsdMCap  = (currentMCapSol    * solPrice).toLocaleString('en-US', { maximumFractionDigits: 0 });
    const alertUsdMCap    = (data.alertMCapSol * solPrice).toLocaleString('en-US', { maximumFractionDigits: 0 });

    return (
        `${f.header(`CALL CONFIRMED  ${wholeMultiplier}x  +${percent}%`)}\n` +
        `${f.sep()}\n` +
        `<b>${esc(data.name)}</b>  <code>$${esc(data.symbol)}</code>\n\n` +
        `${f.row('Gain', `+${percent}%  (${multiplier.toFixed(1)}x from alert)`)}\n` +
        `${f.row('MCap now', `$${currentUsdMCap}`)}\n` +
        `${f.row('MCap at alert', `$${alertUsdMCap}`)}\n` +
        `${f.row('Curve', `${curve}%  |  Volume  ${data.volumeSol.toFixed(1)} SOL`)}\n\n` +
        `${f.row('CA', mint, true)}\n` +
        `${f.sep()}\n` +
        `${f.tokenLink(mint)}`
    );
}

module.exports = { formatNews, formatSolanaWebhook, formatEarlySignal, formatCallConfirmed };