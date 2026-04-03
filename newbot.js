require('dotenv').config();
const { Telegraf, Markup } = require('telegraf'); // Tambah Markup
const axios = require('axios');
const express = require('express');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws'); // Tambah WebSocket

// ============================================================
// VALIDASI ENVIRONMENT
// ============================================================
const REQUIRED_ENV = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHANNEL_ID'];
const missingEnv = REQUIRED_ENV.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
    console.error(`❌ ERROR: Variable berikut belum diisi di .env:\n  ${missingEnv.join('\n  ')}`);
    process.exit(1);
}

// ============================================================
// KONFIGURASI
// ============================================================
const CONFIG = {
    BOT_TOKEN:          process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHANNEL_ID: process.env.TELEGRAM_CHANNEL_ID,
    NEWSDATA_API_KEY:   process.env.NEWSDATA_API_KEY || null,   // Daftar gratis: https://newsdata.io
    ADMIN_USER_IDS:     (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
    PORT:               parseInt(process.env.PORT, 10) || 3000,
    NEWS_INTERVAL_MS:   900000,
    MAX_RETRIES:        3,
    RETRY_DELAY_MS:     2000,
    WEBHOOK_SECRET:     process.env.WEBHOOK_SECRET || null,
    
    // --- KONFIGURASI RADAR MOONER (BARU) ---
    PUMP_MIN_VOLUME_SOL: 5.0,    // Min volume SOL dalam 5 menit
    PUMP_MIN_BUYERS:     10,     // Min pembeli unik
    PUMP_TRACK_WINDOW:   300000, // Lacak koin selama 5 menit (ms)

    // --- TOGGLE FITUR ---
    ENABLE_SOLANA_STREAM: false, // Setel ke true untuk mengaktifkan kembali
};

console.log('🔧 Konfigurasi:');
console.log(`   Channel    : ${CONFIG.TELEGRAM_CHANNEL_ID}`);
console.log(`   Port       : ${CONFIG.PORT}`);
console.log(`   News poll  : ${CONFIG.NEWS_INTERVAL_MS / 60000} menit`);
console.log(`   NewsData   : ${CONFIG.NEWSDATA_API_KEY ? '✅' : '⚠️  tidak dikonfigurasi (daftar di newsdata.io)'}`);

// ============================================================
// INISIALISASI
// ============================================================
const bot = new Telegraf(CONFIG.BOT_TOKEN);
const app = express();
app.use(express.json());

// ============================================================
// STATE & CACHE (DIPERBAIKI DENGAN FILE PERSISTENCE)
// ============================================================
const CACHE_FILE = path.join(__dirname, 'sent_news.json');
let sentArticleIds = new Set();
let isPollingActive  = true;
const botStartTime   = Date.now();
let newsSentCount    = 0;
let webhookHitCount  = 0;

// --- STATE RADAR MOONER ---
const trackedTokens = new Map(); // mint -> { data }
let moonerAlertCount = 0;
let currentSolPrice = 140.0; // Harga default jika API gagal

// Konstanta Tokenomics Pump.fun
const PUMP_TOTAL_SUPPLY = 1000000000; // 1 Miliar Token
const PUMP_CURVE_TARGET_SOL = 85;     // Target SOL untuk migrasi Raydium
const MIN_WHALE_SOL = 1.0;            // Minimal SOL untuk dianggap whale interest
const BUNDLED_WINDOW_MS = 2000;       // Waktu (2 detik) untuk deteksi bundled launch

// Fungsi Load Cache
function loadCache() {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            sentArticleIds = new Set(data);
            console.log(`💾 Cache dimuat: ${sentArticleIds.size} ID berita lama diingat.`);
        }
    } catch (err) {
        console.warn('⚠️ Gagal memuat cache:', err.message);
    }
}

// Fungsi Save Cache
function saveCache() {
    try {
        const data = JSON.stringify(Array.from(sentArticleIds));
        fs.writeFileSync(CACHE_FILE, data, 'utf8');
    } catch (err) {
        console.warn('⚠️ Gagal menyimpan cache:', err.message);
    }
}

// Load cache saat startup
loadCache();

// ============================================================
// HELPER: RETRY
// ============================================================
async function withRetry(fn, label = 'operasi', maxRetries = CONFIG.MAX_RETRIES) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const isLast = attempt === maxRetries;
            console.warn(`⚠️  [${label}] Percobaan ${attempt}/${maxRetries} gagal: ${err.message}`);
            if (isLast) throw err;
            await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY_MS * attempt));
        }
    }
}

// ============================================================
// HELPER: ESCAPE HTML
// ============================================================
function esc(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function formatNewsMessage(article) {
    const title      = article.title       || '(tanpa judul)';
    const url        = article.link        || null;
    const source     = article.source_name || article.source_id || 'unknown';
    const keywords   = Array.isArray(article.keywords) && article.keywords.length > 0
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
// HELPER: SOLANA MESSAGE FORMATTER
// ============================================================
function formatSolanaMessage(tx) {
    const signature = tx.signature || 'N/A';
    const type      = tx.type || 'UNKNOWN';
    const source    = tx.source || 'N/A';
    const description = tx.description || 'Aktivitas baru di network Solana.';

    return (
        `💎 <b>SOLANA REAL-TIME MONITOR</b>\n\n` +
        `📦 <b>Activity:</b> <code>${type}</code>\n` +
        `⚡ <b>Source:</b> <code>${source}</code>\n\n` +
        `📝 <b>Info:</b>\n<i>${description}</i>\n\n` +
        `🔗 <a href="https://solscan.io/tx/${signature}">View on Solscan</a>`
    );
}

// ============================================================
// SOLANA WEBHOOK (PUSH DATA DARI HELIUS)
// ============================================================
function isValidWebhook(req) {
    if (!CONFIG.WEBHOOK_SECRET) return true;
    const secret = req.headers['x-webhook-secret'] || req.headers['authorization'];
    return secret === CONFIG.WEBHOOK_SECRET;
}

app.post('/solana-webhook', async (req, res) => {
    if (!CONFIG.ENABLE_SOLANA_STREAM) {
        return res.status(200).send('Solana Stream is currently Disabled');
    }
    
    if (!isValidWebhook(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const transactions = req.body;
        if (!Array.isArray(transactions) || transactions.length === 0) {
            return res.status(200).send('OK');
        }

        console.log(`⛓️ Menerima ${transactions.length} transaksi dari Solana Stream...`);

        for (const tx of transactions) {
            const message = formatSolanaMessage(tx);
            await sendToChannel(message);
            webhookHitCount++;
        }

        res.status(200).send('Webhook Received');
    } catch (err) {
        console.error('❌ Solana Webhook Error:', err.message);
        res.status(500).send('Internal Server Error');
    }
});
// ============================================================
// HELPER: HARGA SOL (USD)
// ============================================================
async function updateSolPrice() {
    try {
        const { data } = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', { timeout: 10000 });
        if (data && data.price) {
            currentSolPrice = parseFloat(data.price);
            console.log(`💰 Harga SOL Terkini: $${currentSolPrice.toFixed(2)}`);
        }
    } catch (err) {
        console.warn('⚠️ Gagal update harga SOL, menggunakan data lama.');
    }
}

// ============================================================
// HELPER: KIRIM KE CHANNEL
// ============================================================
async function sendToChannel(html, keyboard = null) {
    if (!CONFIG.TELEGRAM_CHANNEL_ID) {
        console.warn('⚠️  Gagal kirim: TELEGRAM_CHANNEL_ID tidak ditemukan di .env');
        return;
    }
    
    try {
        const options = { parse_mode: 'HTML' };
        if (keyboard) options.reply_markup = keyboard.reply_markup;

        const result = await bot.telegram.sendMessage(
            CONFIG.TELEGRAM_CHANNEL_ID,
            html,
            options
        );

        // DEBUG: Tampilkan detail pengiriman
        console.log(`✅ PESAN TERKIRIM!`);
        console.log(`   ID Pesan: ${result.message_id}`);
        console.log(`   ID Chat : ${result.chat.id}`);
        console.log(`   Username: ${result.chat.username || 'N/A'}`);
        
        return result;
    } catch (err) {
        console.error('❌ GAGAL KIRIM KE TELEGRAM:', err.message);
        if (err.description) console.error('   Detail:', err.description);
    }
}

// ============================================================
// POLLING BERITA — NewsData.io
// Docs: https://newsdata.io/documentation
// Free tier: 200 request/hari, 10 artikel/request
// ============================================================
async function fetchCryptoNews() {
    if (!CONFIG.NEWSDATA_API_KEY) {
        console.warn('⚠️  NEWSDATA_API_KEY tidak diisi, polling dilewati.');
        return;
    }
    if (!isPollingActive) {
        console.log('⏸️  Polling di-pause.');
        return;
    }

    try {
        console.log('🔍 Mengecek berita TERBARU dari NewsData.io...');

        const params = {
            apikey:   CONFIG.NEWSDATA_API_KEY,
            q:        'crypto OR bitcoin OR ethereum OR blockchain',
            language: 'en',
            category: 'business,technology',
            // Kita hapus 'page' (nextPageToken) agar selalu ambil halaman 1 (paling baru)
        };

        const { data } = await withRetry(
            () => axios.get('https://newsdata.io/api/1/news', { timeout: 15000, params }),
            'fetchCryptoNews'
        );

        if (data.status !== 'success') {
            console.error('❌ API NewsData.io error:', data.message || JSON.stringify(data));
            return;
        }

        const articles = data.results;
        if (!articles || articles.length === 0) {
            console.log('ℹ️  Tidak ada artikel baru.');
            return;
        }

        // Filter artikel yang benar-benar belum pernah dikirim (cek cache)
        const newArticles = articles.filter(a => a.article_id && !sentArticleIds.has(a.article_id));

        if (newArticles.length === 0) {
            console.log('ℹ️  Semua berita di halaman depan sudah pernah dikirim.');
            return;
        }

        console.log(`📰 Menemukan ${newArticles.length} berita baru.`);

        // Jika ini pertama kali bot jalan (cache masih kosong), jangan spam.
        // Tandai semua sebagai "sudah dibaca" tapi hanya kirim 2 berita terbaru saja.
        const isFirstRun = sentArticleIds.size === 0;
        const toSend = isFirstRun ? newArticles.slice(0, 2) : newArticles;

        if (isFirstRun) {
            console.log('🆕 Inisialisasi pertama: Menandai berita lama dan kirim 2 terbaru.');
            // Tandai SEMUA artikel yang didapat saat ini sebagai "sudah dibaca"
            articles.forEach(a => sentArticleIds.add(a.article_id));
        }

        for (const article of toSend.reverse()) {
            const message = formatNewsMessage(article);
            const res = await sendToChannel(message);

            if (res) {
                sentArticleIds.add(article.article_id);
                newsSentCount++;
                // Log baris tunggal sudah ada di sendToChannel
            }
            await new Promise(r => setTimeout(r, 1000)); // Jeda antar kiriman
        }

        // Simpan cache ke file agar permanen
        saveCache();

        // Bersihkan cache lama jika sudah terlalu menumpuk (simpan 1000 ID saja)
        if (sentArticleIds.size > 1000) {
            const idsArray = Array.from(sentArticleIds);
            sentArticleIds = new Set(idsArray.slice(-1000));
            saveCache();
        }

        console.log(`✅ Update selesai. Total terkirim sesi ini: ${toSend.length}`);

    } catch (err) {
        console.error('❌ Error fetchCryptoNews:', err.message);
    }
}

// Route Solana Webhook sudah ada di atas (Line 150)

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/health', (_req, res) => {
    const s = Math.floor((Date.now() - botStartTime) / 1000);
    res.json({
        status: 'ok', uptime_sec: s,
        news_sent: newsSentCount, webhook_hits: webhookHitCount,
        polling: isPollingActive, cache_size: sentArticleIds.size,
    });
});

// ============================================================
// MIDDLEWARE & ADMIN
// ============================================================
bot.use(async (ctx, next) => {
    const user = ctx.from ? `@${ctx.from.username || ctx.from.id}` : 'unknown';
    console.log(`📩 [${user}] ${ctx.message?.text || ctx.updateType}`);
    return next();
});

function isAdmin(ctx) {
    if (CONFIG.ADMIN_USER_IDS.length === 0) return true;
    return CONFIG.ADMIN_USER_IDS.includes(String(ctx.from?.id || ''));
}
function requireAdmin(ctx, next) {
    if (!isAdmin(ctx)) return ctx.reply('🚫 Hanya untuk admin.');
    return next();
}

// ============================================================
// COMMANDS
// ============================================================
bot.command('debug', async (ctx) => {
    ctx.reply('🔍 Sedang mengetes kiriman ke channel...');
    const res = await sendToChannel('<b>DEBUG:</b> Pesan tes dari perintah /debug.');
    if (res) {
        ctx.reply(`✅ Tes Berhasil! Pesan ID: ${res.message_id} dikirim ke channel.`);
    } else {
        ctx.reply('❌ Tes Gagal! Periksa log di terminal.');
    }
});

bot.command('status', requireAdmin, (ctx) => {
    const s = Math.floor((Date.now() - botStartTime) / 1000);
    return ctx.reply(
        `<b>📊 Status Bot</b>\n\n` +
        `⏱ Uptime: ${Math.floor(s/3600)}j ${Math.floor((s%3600)/60)}m ${s%60}d\n` +
        `📰 Berita terkirim: ${newsSentCount}\n` +
        `📡 Webhook hits: ${webhookHitCount}\n` +
        `🔄 Polling: ${isPollingActive ? 'Aktif' : 'Pause'}\n` +
        `💾 Cache: ${sentArticleIds.size} artikel\n` +
        `📢 Channel: ${CONFIG.TELEGRAM_CHANNEL_ID}`,
        { parse_mode: 'HTML' }
    );
});

bot.command('start', ctx => ctx.reply(
    '👋 <b>Bot Berita Crypto & Solana</b>\n\n' +
    '📰 Polling berita crypto otomatis\n' +
    '💎 Solana stream via Helius Webhook\n\n' +
    'Ketik /help untuk daftar perintah.',
    { parse_mode: 'HTML' }
));

bot.command('help', ctx => ctx.reply(
    '<b>Perintah:</b>\n\n' +
    '/test — Kirim pesan test ke channel\n' +
    '/help — Bantuan ini' +
    (isAdmin(ctx) ? '\n\n<b>Admin:</b>\n/pause /resume /forcenews /status /broadcast' : ''),
    { parse_mode: 'HTML' }
));

bot.command('test', async ctx => {
    try {
        await sendToChannel('✅ <b>Test berhasil!</b> Bot aktif dan terhubung ke channel.');
        return ctx.reply('✅ Pesan test dikirim.');
    } catch (err) {
        return ctx.reply(`❌ Gagal: ${err.message}`);
    }
});

bot.command('pause',     requireAdmin, ctx => { isPollingActive = false; return ctx.reply('⏸️ Polling dihentikan.'); });
bot.command('resume',    requireAdmin, ctx => { isPollingActive = true;  return ctx.reply('▶️ Polling dilanjutkan.'); });
bot.command('forcenews', requireAdmin, async ctx => {
    await ctx.reply('🔄 Memaksa cek berita...');
    await fetchCryptoNews();
    return ctx.reply('✅ Selesai.');
});
bot.command('status', requireAdmin, ctx => {
    const s = Math.floor((Date.now() - botStartTime) / 1000);
    return ctx.reply(
        `<b>📊 Status Bot</b>\n\n` +
        `⏱ Uptime: ${Math.floor(s/3600)}j ${Math.floor((s%3600)/60)}m ${s%60}d\n` +
        `📰 Berita terkirim: ${newsSentCount}\n` +
        `📡 Webhook hits: ${webhookHitCount}\n` +
        `🔄 Polling: ${isPollingActive ? 'Aktif' : 'Pause'}\n` +
        `💾 Cache: ${sentArticleIds.size} artikel\n` +
        `📢 Channel: ${CONFIG.TELEGRAM_CHANNEL_ID}`,
        { parse_mode: 'HTML' }
    );
});
bot.command('broadcast', requireAdmin, async ctx => {
    const text = ctx.message.text.replace('/broadcast', '').trim();
    if (!text) return ctx.reply('⚠️ Gunakan: /broadcast <pesan>');
    try {
        await bot.telegram.sendMessage(CONFIG.TELEGRAM_CHANNEL_ID, text);
        return ctx.reply('✅ Disiarkan.');
    } catch (err) {
        return ctx.reply(`❌ Gagal: ${err.message}`);
    }
});

bot.on('text', ctx => {
    if (ctx.message.text.startsWith('/'))
        return ctx.reply('❓ Perintah tidak dikenal. Ketik /help.');
});

// ============================================================
// RADAR MOONER PUMP.FUN (WEBSOCKET)
// ============================================================
function initPumpRadar() {
    console.log('📡 Menghubungkan ke Radar Pump.fun...');
    const ws = new WebSocket('wss://pumpportal.fun/api/data');

    ws.on('open', () => {
        console.log('✅ Radar Pump.fun TERKONEKSI!');
        // 1. Subscribe ke pembuatan koin baru saja dulu
        ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    });

    ws.on('message', async (data) => {
        try {
            const event = JSON.parse(data);
            
            // 1. Jika ada KOIN BARU (Event: Create)
            if (event.mint && (event.txType === 'create' || !event.txType)) {
                process.stdout.write('.'); 
                
                trackedTokens.set(event.mint, {
                    symbol:       event.symbol || '???',
                    name:         event.name || 'Unknown',
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
                    milestones:   new Set()
                });

                ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [event.mint] }));

                setTimeout(() => {
                    trackedTokens.delete(event.mint);
                    ws.send(JSON.stringify({ method: "unsubscribeTokenTrade", keys: [event.mint] }));
                }, 3600000);
                return;
            }

            // 2. Jika ada TRANSAKSI (Event: Buy/Sell)
            if (event.txType && event.mint) {
                const token = trackedTokens.get(event.mint);
                if (!token) return;

                const solAmount = parseFloat(event.solAmount || 0);
                const tokenAmount = parseFloat(event.tokenAmount || 0);
                const trader = event.traderPublicKey;
                const timeDiffMs = Date.now() - token.startTime;

                // --- LOGIKA ANALYSIS ---
                token.volumeSol += solAmount;
                
                if (event.txType === 'buy') {
                    token.buys++;
                    if (trader) token.buyers.add(trader);
                    
                    // Deteksi Whale (> 1 SOL)
                    if (solAmount >= MIN_WHALE_SOL) {
                        token.whales++;
                        if (solAmount > token.maxWhaleBuy) token.maxWhaleBuy = solAmount;
                    }

                    // Deteksi Bundled (Banyak buy di 2 detik pertama)
                    if (timeDiffMs < BUNDLED_WINDOW_MS && token.buys > 5) {
                        token.isBundled = true;
                    }
                } else if (event.txType === 'sell') {
                    token.sells++;
                    // Deteksi Dev Sold (Jika trader adalah Dev)
                    if (trader === token.dev) {
                        token.isDevSold = true;
                    }
                }

                // Kalkulasi MCap & Curve (Dipakai untuk Alert & Profit)
                let mcapSol = 0;
                if (tokenAmount > 0) {
                    const pricePerToken = solAmount / tokenAmount;
                    mcapSol = pricePerToken * PUMP_TOTAL_SUPPLY;
                }
                const curveProgress = Math.min((token.volumeSol / PUMP_CURVE_TARGET_SOL) * 100, 100).toFixed(0);

                // --- A. ALERT PERTAMA (EARLY SIGNAL) ---
                if (!token.isAlerted && 
                    token.volumeSol >= CONFIG.PUMP_MIN_VOLUME_SOL && 
                    token.buyers.size >= CONFIG.PUMP_MIN_BUYERS) {
                    
                    token.isAlerted = true;
                    token.alertMCapSol = mcapSol;
                    await sendEarlySignal(event.mint, token, mcapSol, curveProgress);
                    console.log(`\n🪐 SIGNAL: ${token.symbol} DETECTED!`);
                }

                // --- B. PROFIT TRACKER (CALL CONFIRMED) ---
                if (token.isAlerted && token.alertMCapSol > 0) {
                    const multiplier = mcapSol / token.alertMCapSol;
                    const wholeMultiplier = Math.floor(multiplier);

                    if (wholeMultiplier >= 2 && !token.milestones.has(wholeMultiplier)) {
                        token.milestones.add(wholeMultiplier);
                        await sendCallConfirmed(event.mint, token, mcapSol, multiplier, curveProgress);
                        console.log(`🔥 PROFIT: ${token.symbol} ${wholeMultiplier}x!`);
                    }
                }
            }
        } catch (err) { }
    });

    ws.on('close', () => {
        console.warn('⚠️  Radar Terputus. Menghubungkan ulang...');
        setTimeout(initPumpRadar, 5000);
    });

    ws.on('error', (err) => {
        console.error('❌ Radar Error:', err.message);
    });
}

// FORMAT & KIRIM EARLY SIGNAL (UPGRADED)
async function sendEarlySignal(mint, data, mcapSol, curve) {
    const timeElapsedSec = Math.floor((Date.now() - data.startTime) / 1000) || 1;
    const velocity = (data.buys / (timeElapsedSec / 60)).toFixed(1);
    const usdMCap = mcapSol * currentSolPrice;
    const usdVolume = data.volumeSol * currentSolPrice;
    
    // Hitung Score Sederhana (0-100)
    let score = 30; // Base score
    if (data.whales > 0) score += 20;
    if (parseFloat(velocity) > 10) score += 20;
    if (data.volumeSol > 10) score += 20;
    if (data.isDevSold) score -= 40;
    if (data.isBundled) score += 10;
    score = Math.max(0, Math.min(100, score));

    // Flags
    let flags = [];
    if (parseFloat(velocity) > 20) flags.push('🚀 SPEED RUNNER');
    if (data.isDevSold) flags.push('!! DEV SOLD');
    if (data.isBundled) flags.push('!! BUNDLED LAUNCH');
    if (data.whales > 3) flags.push('++ WHALE INTEREST');
    
    const flagLine = flags.length > 0 ? `${flags.join(' | ')}\n\n` : '';

    const message = 
        `* <b>EARLY SIGNAL</b>\n` +
        `---------------------\n` +
        `<b>${esc(data.name)} ($${esc(data.symbol)})</b>\n\n` +
        flagLine +
        `<b>Score:</b> <code>${score.toFixed(1)}/100</code>\n` +
        `<b>Price:</b> <code>New Listing</code> | <b>MCap:</b> $${usdMCap.toLocaleString(undefined, { maximumFractionDigits: 0 })}\n` +
        `<b>Volume:</b> <code>${data.volumeSol.toFixed(1)} SOL</code> (~$${usdVolume.toLocaleString(undefined, { maximumFractionDigits: 0 })})\n` +
        `<b>Buyers:</b> ${data.buyers.size} | <b>B/S:</b> ${data.buys}/${data.sells}\n` +
        `<b>Velocity:</b> ${velocity} buys/min\n` +
        `<b>Curve:</b> ${curve}% | <b>Whales:</b> ${data.whales} (max ${data.maxWhaleBuy.toFixed(1)} SOL)\n` +
        `<b>Dev:</b> ${data.isDevSold ? 'Sold All' : 'Active'}\n\n` +
        `📍 <b>CA:</b> <code>${mint}</code>\n` +
        `---------------------\n` +
        `<a href="https://pump.fun/${mint}">pump.fun</a> | <a href="https://solscan.io/token/${mint}">Solscan</a>\n`;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.url('Beli di Axiom', `https://axiom.trade/t/${mint}`)],
        [Markup.button.url('Analisa di Photon', `https://photon-sol.tinyastro.io/en/lp/${mint}`)]
    ]);

    await sendToChannel(message, keyboard);
}

// FORMAT & KIRIM CALL CONFIRMED
async function sendCallConfirmed(mint, data, currentMCapSol, multiplier, curve) {
    const percent = ((multiplier - 1) * 100).toFixed(0);
    const multiplierStr = multiplier.toFixed(1);
    const wholeMultiplier = Math.floor(multiplier);
    const currentUsdMCap = currentMCapSol * currentSolPrice;
    const alertUsdMCap   = data.alertMCapSol * currentSolPrice;

    const message = 
        `+++ <b>${wholeMultiplier}x CALL CONFIRMED (+${percent}%)</b>\n` +
        `---------------------\n` +
        `🚀 <b>${esc(data.name)} ($${esc(data.symbol)})</b>\n\n` +
        `<b>Now:</b> +${percent}% since alert (${multiplierStr}x)\n` +
        `<b>MCap:</b> $${currentUsdMCap.toLocaleString(undefined, { maximumFractionDigits: 0 })}\n` +
        `<b>MCap at alert:</b> $${alertUsdMCap.toLocaleString(undefined, { maximumFractionDigits: 0 })}\n` +
        `<b>Curve:</b> ${curve}%\n` +
        `<b>Volume:</b> ${data.volumeSol.toFixed(1)} SOL\n\n` +
        `📍 <b>CA:</b> <code>${mint}</code>\n` +
        `---------------------\n` +
        `<a href="https://pump.fun/${mint}">pump.fun</a> | <a href="https://solscan.io/token/${mint}">Solscan</a>`;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.url('💰 Take Profit (Axiom)', `https://axiom.trade/t/${mint}`)],
        [Markup.button.url('🔭 Photon', `https://photon-sol.tinyastro.io/en/lp/${mint}`)]
    ]);

    await sendToChannel(message, keyboard);
}

// ============================================================
// START
// ============================================================
async function startBot() {
    // 0. Update Harga SOL dulu
    await updateSolPrice();
    setInterval(updateSolPrice, 120000); // Tiap 2 menit
    // 1. Mulai Radar Pump.fun
    initPumpRadar();

    // 2. Fitur NewsData dimatikan sesuai permintaan user
    /*
    console.log('--- INISIALISASI BERITA ---');
    if (CONFIG.NEWSDATA_API_KEY) {
        console.log(`📰 Polling berita dimulai (setiap ${CONFIG.NEWS_INTERVAL_MS / 60000} menit)`);
        fetchCryptoNews();
        setInterval(fetchCryptoNews, CONFIG.NEWS_INTERVAL_MS);
    }
    */

    // 3. Mulai koneksi Telegram
    console.log('--- INISIALISASI TELEGRAM ---');
    try {
        console.log('🧹 Langkah 1: Menghapus webhook lama...');
        await bot.telegram.deleteWebhook({ drop_pending_updates: true })
            .catch(() => {});
        
        console.log('🚀 Langkah 2: Meluncurkan bot...');
        await bot.launch();
        console.log('✅ Bot Telegram AKTIF!');
    } catch (err) {
        console.error('❌ Gagal meluncurkan bot:', err.message);
    }
}

app.listen(CONFIG.PORT, () => {
    console.log(`📡 Server Express berjalan di port ${CONFIG.PORT}`);
    console.log(`   URL Health : http://localhost:${CONFIG.PORT}/health`);
    console.log(`   URL Webhook: http://localhost:${CONFIG.PORT}/solana-webhook`);
    startBot(); // Panggil fungsi startup
});

['SIGINT', 'SIGTERM'].forEach(sig => process.once(sig, () => {
    console.log(`\n🛑 ${sig}, menghentikan bot...`);
    bot.stop(sig); process.exit(0);
}));
process.on('uncaughtException',  err => console.error('💥', err));
process.on('unhandledRejection', err => console.error('💥', err));