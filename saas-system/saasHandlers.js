'use strict';

// ============================================================
// SAAS TELEGRAM BOT — Admin & User Commands
//
// ADMIN commands (hanya admin):
//   /adduser @username plan   — buat user baru
//   /users                   — list semua user
//   /userinfo @username       — detail user
//   /suspend @username reason — suspend user
//   /setconfig @user key val  — ubah config bot user
//   /stats                   — statistik bisnis
//   /checkpayment            — trigger cek payment manual
//
// USER commands:
//   /start   — welcome & info pembayaran
//   /status  — status license & info wallet
//   /mykey   — lihat license key
//   /plans   — lihat daftar harga paket
//   /config  — lihat konfigurasi bot
//   /support — kontak admin
// ============================================================

const license        = require('./licenseManager');
const { checkNow }   = require('./paymentMonitor');

const ADMIN_IDS = (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

function isAdmin(ctx) {
    if (ADMIN_IDS.length === 0) return true;
    return ADMIN_IDS.includes(String(ctx.from?.id));
}

function requireAdmin(ctx, next) {
    if (!isAdmin(ctx)) return ctx.reply('⛔ Hanya untuk admin.');
    return next();
}

// ── FORMAT HELPERS ───────────────────────────────────────
function fmtStatus(status) {
    return {
        active:    '🟢 Aktif',
        pending:   '🟡 Menunggu Pembayaran',
        expired:   '🔴 Expired',
        suspended: '⛔ Disuspend',
    }[status] || status;
}

function fmtDate(ts) {
    if (!ts) return '-';
    return new Date(ts).toLocaleDateString('id-ID', {
        day: '2-digit', month: 'short', year: 'numeric'
    });
}

function fmtSOL(n) {
    return `${parseFloat(n || 0).toFixed(4)} SOL`;
}

// ── USER COMMANDS ────────────────────────────────────────

function registerUserCommands(bot) {

    // /start — welcome
    bot.command('start', async (ctx) => {
        const user = license.getUserByTelegramId(ctx.from.id);

        if (user) {
            // User sudah terdaftar
            const planInfo = license.PLANS[user.plan];
            return ctx.reply(
                `👋 Halo <b>${ctx.from.first_name}</b>!\n\n` +
                `Kamu sudah terdaftar di <b>CryptoRadar Bot</b>.\n\n` +
                `Status: ${fmtStatus(user.status)}\n` +
                `Paket: ${planInfo?.name || user.plan}\n\n` +
                `Ketik /status untuk detail lengkap.`,
                { parse_mode: 'HTML' }
            );
        }

        // User baru — tampilkan info
        return ctx.reply(
            `🤖 <b>Selamat datang di CryptoRadar Bot!</b>\n\n` +
            `Bot trading otomatis untuk Pump.fun & Solana.\n` +
            `Sinyal real-time, auto-buy, trailing stop — semua otomatis.\n\n` +
            `<b>Paket tersedia:</b>\n\n` +
            `🔹 <b>Signal Channel</b> — 0.5 SOL/bulan\n` +
            `   Dapat sinyal pump.fun real-time\n\n` +
            `🔸 <b>Bot Managed</b> — 1.5 SOL/bulan\n` +
            `   Bot trading otomatis atas nama kamu\n\n` +
            `💎 <b>Bot Dedicated</b> — 5 SOL/bulan\n` +
            `   Instance khusus + konfigurasi custom\n\n` +
            `Untuk mendaftar, hubungi admin: /support`,
            { parse_mode: 'HTML' }
        );
    });

    // /plans — daftar harga
    bot.command('plans', async (ctx) => {
        return ctx.reply(
            `📋 <b>DAFTAR PAKET CRYPTORADAR BOT</b>\n` +
            `${'─'.repeat(32)}\n\n` +
            `🔹 <b>Signal Channel</b>\n` +
            `   Harga: <code>0.5 SOL / bulan</code>\n` +
            `   • Sinyal pump.fun real-time\n` +
            `   • Alert buy/sell otomatis\n` +
            `   • Win rate tracking\n\n` +
            `🔸 <b>Bot Managed</b>\n` +
            `   Harga: <code>1.5 SOL / bulan</code>\n` +
            `   • Semua fitur Signal\n` +
            `   • Auto-buy & auto-sell\n` +
            `   • Stop loss & trailing stop\n` +
            `   • Wallet isolated per user\n\n` +
            `💎 <b>Bot Dedicated</b>\n` +
            `   Harga: <code>5 SOL / bulan</code>\n` +
            `   • Semua fitur Managed\n` +
            `   • Konfigurasi custom (SL, amount, dll)\n` +
            `   • Prioritas support\n` +
            `   • Laporan harian\n\n` +
            `Daftar: /support`,
            { parse_mode: 'HTML' }
        );
    });

    // /status — status license user
    bot.command('status', async (ctx) => {
        const user = license.getUserByTelegramId(ctx.from.id);
        if (!user) {
            return ctx.reply(
                '❌ Kamu belum terdaftar.\n\nHubungi admin untuk mendaftar: /support'
            );
        }

        const planInfo = license.PLANS[user.plan];
        const balance  = await license.checkWalletBalance(user.walletPublicKey);
        const daysLeft = user.expiresAt
            ? Math.max(0, Math.ceil((user.expiresAt - Date.now()) / 86400000))
            : null;

        let expiryLine = '';
        if (user.expiresAt) {
            expiryLine = `Expired: <b>${fmtDate(user.expiresAt)}</b>`;
            if (daysLeft !== null) expiryLine += ` (${daysLeft} hari lagi)`;
            expiryLine += '\n';
        }

        let paymentInfo = '';
        if (user.status === 'pending') {
            paymentInfo =
                `\n💳 <b>CARA PEMBAYARAN:</b>\n` +
                `Transfer tepat <code>${planInfo?.priceSOL} SOL</code> ke:\n` +
                `<code>${user.walletPublicKey}</code>\n\n` +
                `Pembayaran terdeteksi otomatis dalam 1-2 menit.\n` +
                `Saldo wallet saat ini: <code>${balance !== null ? fmtSOL(balance) : 'gagal cek'}</code>`;
        }

        return ctx.reply(
            `📊 <b>STATUS LICENSE KAMU</b>\n` +
            `${'─'.repeat(28)}\n\n` +
            `Nama: <b>${ctx.from.first_name}</b>\n` +
            `Paket: <b>${planInfo?.name || user.plan}</b>\n` +
            `Status: ${fmtStatus(user.status)}\n` +
            (user.activatedAt ? `Aktif sejak: ${fmtDate(user.activatedAt)}\n` : '') +
            expiryLine +
            `Total bayar: <code>${fmtSOL(user.totalPaidSOL)}</code>\n\n` +
            `Wallet kamu:\n<code>${user.walletPublicKey}</code>\n` +
            `Saldo: <code>${balance !== null ? fmtSOL(balance) : '(gagal cek)'}</code>` +
            paymentInfo,
            { parse_mode: 'HTML' }
        );
    });

    // /mykey — tampilkan license key
    bot.command('mykey', async (ctx) => {
        const user = license.getUserByTelegramId(ctx.from.id);
        if (!user) return ctx.reply('❌ Kamu belum terdaftar.');

        if (user.status !== 'active') {
            return ctx.reply('⚠️ License key hanya tersedia untuk akun aktif.\n\nStatus: ' + fmtStatus(user.status));
        }

        return ctx.reply(
            `🔑 <b>LICENSE KEY KAMU</b>\n\n` +
            `<code>${user.licenseKey}</code>\n\n` +
            `⚠️ Jangan bagikan key ini ke siapapun!\n` +
            `Key ini digunakan oleh bot engine untuk autentikasi.`,
            { parse_mode: 'HTML' }
        );
    });

    // /config — lihat konfigurasi bot
    bot.command('config', async (ctx) => {
        const user = license.getUserByTelegramId(ctx.from.id);
        if (!user) return ctx.reply('❌ Kamu belum terdaftar.');

        const c = user.botConfig;
        return ctx.reply(
            `⚙️ <b>KONFIGURASI BOT KAMU</b>\n` +
            `${'─'.repeat(28)}\n\n` +
            `Auto-buy amount: <code>${c.autoBuyAmountSOL} SOL</code>\n` +
            `Min score sinyal: <code>${c.signalMinScore}/100</code>\n` +
            `Max loss per trade: <code>${c.riskMaxLossPct}%</code>\n` +
            `Max trades/hari: <code>${c.maxTradesPerDay}</code>\n` +
            `Mode: <code>${c.simulationMode ? 'SIMULASI' : 'LIVE TRADING'}</code>\n\n` +
            `Untuk ubah konfigurasi, hubungi admin: /support`,
            { parse_mode: 'HTML' }
        );
    });

    // /support — kontak admin
    bot.command('support', async (ctx) => {
        const adminUsername = process.env.ADMIN_USERNAME || 'admin';
        return ctx.reply(
            `📞 <b>HUBUNGI SUPPORT</b>\n\n` +
            `Admin: @${adminUsername}\n\n` +
            `Sertakan informasi:\n` +
            `• Username Telegram kamu\n` +
            `• Masalah yang dihadapi\n` +
            `• Screenshot jika perlu\n\n` +
            `Response time: biasanya < 1 jam (jam aktif 08.00-22.00 WIB)`,
            { parse_mode: 'HTML' }
        );
    });
}

// ── ADMIN COMMANDS ───────────────────────────────────────

function registerAdminCommands(bot) {

    // /adduser @username plan
    bot.command('adduser', requireAdmin, async (ctx) => {
        const parts = ctx.message.text.split(' ').slice(1);
        if (parts.length < 2) {
            return ctx.reply(
                'Usage: /adduser <telegram_id> <plan>\n\n' +
                'Plans: signal | managed | dedicated\n\n' +
                'Contoh: /adduser 123456789 managed'
            );
        }

        const [telegramId, plan] = parts;
        const telegramUsername = parts[2] || '';

        const result = license.createUser({ telegramId, telegramUsername, plan });

        if (result.error) {
            return ctx.reply(`⚠️ ${result.error}`);
        }

        const { user, priceSOL, planName } = result;

        // Notif ke admin
        await ctx.reply(
            `✅ <b>USER BERHASIL DIBUAT</b>\n\n` +
            `Telegram ID: <code>${user.telegramId}</code>\n` +
            `Plan: <b>${planName}</b>\n` +
            `License Key: <code>${user.licenseKey}</code>\n` +
            `Wallet: <code>${user.walletPublicKey}</code>\n\n` +
            `Harga: <b>${priceSOL} SOL</b>/bulan\n\n` +
            `Kirimkan info ini ke user — minta mereka chat bot ini.`,
            { parse_mode: 'HTML' }
        );

        // Notif ke user
        try {
            await bot.telegram.sendMessage(telegramId,
                `🎉 <b>Akun CryptoRadar Bot kamu sudah dibuat!</b>\n\n` +
                `Paket: <b>${planName}</b>\n` +
                `Harga: <b>${priceSOL} SOL / bulan</b>\n\n` +
                `💳 <b>CARA AKTIVASI:</b>\n` +
                `Transfer <b>${priceSOL} SOL</b> ke wallet khusus kamu:\n\n` +
                `<code>${user.walletPublicKey}</code>\n\n` +
                `Pembayaran terdeteksi otomatis dalam 1-2 menit setelah transfer.\n\n` +
                `Ketik /status untuk cek status kapan saja.`,
                { parse_mode: 'HTML' }
            );
        } catch (e) {
            await ctx.reply(`⚠️ Gagal kirim pesan ke user: ${e.message}\nKirimkan info wallet secara manual.`);
        }
    });

    // /users — list semua user
    bot.command('users', requireAdmin, async (ctx) => {
        const users = license.getAllUsers();
        if (users.length === 0) return ctx.reply('Belum ada user.');

        const lines = users.map((u, i) => {
            const status = { active: '🟢', pending: '🟡', expired: '🔴', suspended: '⛔' }[u.status] || '❓';
            return `${i + 1}. ${status} @${u.telegramUsername || u.telegramId} — ${u.plan}`;
        });

        return ctx.reply(
            `👥 <b>DAFTAR USER (${users.length})</b>\n\n` +
            lines.join('\n') + '\n\n' +
            'Detail: /userinfo <telegram_id>',
            { parse_mode: 'HTML' }
        );
    });

    // /userinfo <telegram_id>
    bot.command('userinfo', requireAdmin, async (ctx) => {
        const telegramId = ctx.message.text.split(' ')[1];
        if (!telegramId) return ctx.reply('Usage: /userinfo <telegram_id>');

        const user = license.getUserByTelegramId(telegramId);
        if (!user) return ctx.reply('User tidak ditemukan.');

        const balance  = await license.checkWalletBalance(user.walletPublicKey);
        const planInfo = license.PLANS[user.plan];

        return ctx.reply(
            `👤 <b>INFO USER</b>\n\n` +
            `ID Telegram: <code>${user.telegramId}</code>\n` +
            `Username: @${user.telegramUsername || '-'}\n` +
            `Plan: <b>${planInfo?.name || user.plan}</b>\n` +
            `Status: ${fmtStatus(user.status)}\n` +
            `License: <code>${user.licenseKey}</code>\n\n` +
            `Wallet: <code>${user.walletPublicKey}</code>\n` +
            `Saldo: <code>${balance !== null ? fmtSOL(balance) : 'error'}</code>\n` +
            `Total bayar: <code>${fmtSOL(user.totalPaidSOL)}</code>\n\n` +
            `Dibuat: ${fmtDate(user.createdAt)}\n` +
            `Aktif: ${fmtDate(user.activatedAt)}\n` +
            `Expired: ${fmtDate(user.expiresAt)}\n\n` +
            `<b>Bot Config:</b>\n` +
            `• Buy: ${user.botConfig?.autoBuyAmountSOL} SOL\n` +
            `• Score min: ${user.botConfig?.signalMinScore}\n` +
            `• SL: ${user.botConfig?.riskMaxLossPct}%\n` +
            `• Mode: ${user.botConfig?.simulationMode ? 'SIM' : 'LIVE'}`,
            { parse_mode: 'HTML' }
        );
    });

    // /suspend <telegram_id> <reason>
    bot.command('suspend', requireAdmin, async (ctx) => {
        const parts = ctx.message.text.split(' ').slice(1);
        if (parts.length < 1) return ctx.reply('Usage: /suspend <telegram_id> [reason]');

        const telegramId = parts[0];
        const reason     = parts.slice(1).join(' ') || 'Suspended by admin';
        const user       = license.getUserByTelegramId(telegramId);
        if (!user) return ctx.reply('User tidak ditemukan.');

        license.suspendUser(user.id, reason);
        await ctx.reply(`✅ User ${user.telegramId} disuspend.\nAlasan: ${reason}`);

        try {
            await bot.telegram.sendMessage(telegramId,
                `⛔ <b>Akun kamu disuspend.</b>\n\nAlasan: ${reason}\n\nHubungi admin untuk info lebih lanjut.`,
                { parse_mode: 'HTML' }
            );
        } catch { /* silent */ }
    });

    // /setconfig <telegram_id> <key> <value>
    bot.command('setconfig', requireAdmin, async (ctx) => {
        const parts = ctx.message.text.split(' ').slice(1);
        if (parts.length < 3) {
            return ctx.reply(
                'Usage: /setconfig <telegram_id> <key> <value>\n\n' +
                'Keys: autoBuyAmountSOL | signalMinScore | riskMaxLossPct | maxTradesPerDay | simulationMode'
            );
        }

        const [telegramId, key, rawVal] = parts;
        const user = license.getUserByTelegramId(telegramId);
        if (!user) return ctx.reply('User tidak ditemukan.');

        const ALLOWED = ['autoBuyAmountSOL', 'signalMinScore', 'riskMaxLossPct', 'maxTradesPerDay', 'simulationMode'];
        if (!ALLOWED.includes(key)) return ctx.reply(`Key tidak valid. Gunakan: ${ALLOWED.join(', ')}`);

        let value;
        if (key === 'simulationMode') {
            value = rawVal === 'true' || rawVal === '1';
        } else {
            value = parseFloat(rawVal);
            if (isNaN(value)) return ctx.reply('Value harus angka.');
        }

        license.updateUserConfig(user.id, { [key]: value });
        await ctx.reply(`✅ Config diupdate:\n${key} = ${value}`);
    });

    // /stats — statistik bisnis
    bot.command('stats', requireAdmin, async (ctx) => {
        const s = license.getStats();
        return ctx.reply(
            `📈 <b>STATISTIK BISNIS</b>\n` +
            `${'─'.repeat(28)}\n\n` +
            `Total user: <b>${s.total}</b>\n` +
            `🟢 Aktif: <b>${s.active}</b>\n` +
            `🟡 Pending: <b>${s.pending}</b>\n` +
            `🔴 Expired: <b>${s.expired}</b>\n` +
            `⛔ Suspended: <b>${s.suspended}</b>\n\n` +
            `<b>Per Paket:</b>\n` +
            `• Signal: ${s.plans.signal}\n` +
            `• Managed: ${s.plans.managed}\n` +
            `• Dedicated: ${s.plans.dedicated}\n\n` +
            `💰 Total revenue: <b>${s.totalRevenue} SOL</b>`,
            { parse_mode: 'HTML' }
        );
    });

    // /checkpayment — trigger cek payment manual
    bot.command('checkpayment', requireAdmin, async (ctx) => {
        await ctx.reply('🔄 Mengecek semua wallet...');
        try {
            await checkNow();
            await ctx.reply('✅ Pengecekan selesai.');
        } catch (e) {
            await ctx.reply(`❌ Error: ${e.message}`);
        }
    });

    // /adminhelp
    bot.command('adminhelp', requireAdmin, async (ctx) => {
        return ctx.reply(
            `🔧 <b>ADMIN COMMANDS</b>\n\n` +
            `/adduser &lt;id&gt; &lt;plan&gt; — tambah user baru\n` +
            `/users — list semua user\n` +
            `/userinfo &lt;id&gt; — detail user\n` +
            `/suspend &lt;id&gt; &lt;reason&gt; — suspend user\n` +
            `/setconfig &lt;id&gt; &lt;key&gt; &lt;val&gt; — ubah config\n` +
            `/stats — statistik bisnis\n` +
            `/checkpayment — cek payment manual\n\n` +
            `Plans: signal | managed | dedicated`,
            { parse_mode: 'HTML' }
        );
    });
}

// ── REGISTER ALL ─────────────────────────────────────────
function registerSaasHandlers(bot) {
    registerUserCommands(bot);
    registerAdminCommands(bot);
    console.log('[saas] Handlers registered');
}

module.exports = { registerSaasHandlers };
