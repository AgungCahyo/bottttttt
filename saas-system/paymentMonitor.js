'use strict';

// ============================================================
// PAYMENT MONITOR — Auto-detect SOL payment & aktivasi license
//
// Flow:
//   1. Setiap interval, cek saldo semua wallet user pending/expired
//   2. Jika saldo >= harga plan, aktivasi otomatis
//   3. Kirim notif ke user via Telegram
//   4. Kirim notif ke admin
//
// Toleransi: saldo bisa lebih dari harga (kelebihan dianggap extend)
// ============================================================

const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const license = require('./licenseManager');

const RPC_URL       = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const CHECK_INTERVAL_MS = 60_000; // cek setiap 1 menit

// Track saldo terakhir per wallet untuk deteksi payment baru
const lastBalanceCache = new Map();

let _bot = null; // Telegraf bot instance
let _adminChatId = null;

function init(bot, adminChatId) {
    _bot = bot;
    _adminChatId = adminChatId;
}

// ── SEND TELEGRAM MESSAGE ────────────────────────────────
async function sendMsg(chatId, text) {
    if (!_bot || !chatId) return;
    try {
        await _bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML' });
    } catch (e) {
        console.warn('[payment] Send msg error:', e.message);
    }
}

// ── CEK SALDO SATU WALLET ────────────────────────────────
async function getBalance(publicKey) {
    try {
        const conn = new Connection(RPC_URL, 'confirmed');
        const bal  = await conn.getBalance(new PublicKey(publicKey));
        return bal / LAMPORTS_PER_SOL;
    } catch (e) {
        return null;
    }
}

// ── FORMAT DAYS REMAINING ────────────────────────────────
function fmtDays(ms) {
    return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

// ── PROSES PAYMENT SATU USER ────────────────────────────
async function processUserPayment(user) {
    const planInfo = license.PLANS[user.plan];
    if (!planInfo) return;

    const currentBalance = await getBalance(user.walletPublicKey);
    if (currentBalance === null) return; // RPC error, skip

    const prevBalance = lastBalanceCache.get(user.walletPublicKey) ?? 0;
    lastBalanceCache.set(user.walletPublicKey, currentBalance);

    // Deteksi payment baru: saldo naik
    const received = currentBalance - prevBalance;

    // User pending: cek apakah saldo sudah cukup untuk aktivasi
    if (user.status === 'pending' || user.status === 'expired') {
        if (currentBalance >= planInfo.priceSOL) {
            // Aktivasi!
            const activated = license.activateLicense(user.id, currentBalance);
            const daysLeft  = fmtDays(activated.expiresAt - Date.now());

            console.log(`[payment] ACTIVATED: ${user.telegramUsername} | ${currentBalance} SOL | ${planInfo.name}`);

            // Notif ke user
            await sendMsg(user.telegramId,
                `✅ <b>PEMBAYARAN DITERIMA!</b>\n\n` +
                `Paket: <b>${planInfo.name}</b>\n` +
                `Jumlah: <code>${currentBalance.toFixed(4)} SOL</code>\n` +
                `Aktif hingga: <b>${new Date(activated.expiresAt).toLocaleDateString('id-ID')}</b>\n` +
                `Sisa: <b>${daysLeft} hari</b>\n\n` +
                `License key kamu:\n<code>${user.licenseKey}</code>\n\n` +
                `Bot sudah aktif. Ketik /status untuk cek kondisi.`
            );

            // Notif ke admin
            await sendMsg(_adminChatId,
                `💰 <b>PAYMENT MASUK</b>\n\n` +
                `User: @${user.telegramUsername} (${user.telegramId})\n` +
                `Plan: ${planInfo.name}\n` +
                `Jumlah: ${currentBalance.toFixed(4)} SOL\n` +
                `Wallet: <code>${user.walletPublicKey}</code>`
            );
        } else if (currentBalance > 0) {
            // Ada deposit tapi kurang — ingatkan user
            const kurang = (planInfo.priceSOL - currentBalance).toFixed(4);
            console.log(`[payment] PARTIAL: ${user.telegramUsername} | ${currentBalance}/${planInfo.priceSOL} SOL`);

            // Hanya kirim notif jika ini payment baru (received > 0)
            if (received > 0.001) {
                await sendMsg(user.telegramId,
                    `⚠️ <b>Deposit diterima tapi kurang</b>\n\n` +
                    `Diterima: <code>${currentBalance.toFixed(4)} SOL</code>\n` +
                    `Dibutuhkan: <code>${planInfo.priceSOL} SOL</code>\n` +
                    `Kurang: <code>${kurang} SOL</code>\n\n` +
                    `Silakan top up ke wallet yang sama:\n<code>${user.walletPublicKey}</code>`
                );
            }
        }
        return;
    }

    // User aktif: deteksi renewal payment
    if (user.status === 'active' && received >= planInfo.priceSOL * 0.98) {
        // Extend subscription
        const extended = license.activateLicense(user.id, received);
        const daysLeft  = fmtDays(extended.expiresAt - Date.now());

        console.log(`[payment] RENEWED: ${user.telegramUsername} | +${received.toFixed(4)} SOL`);

        await sendMsg(user.telegramId,
            `🔄 <b>SUBSCRIPTION DIPERPANJANG!</b>\n\n` +
            `Jumlah: <code>${received.toFixed(4)} SOL</code>\n` +
            `Aktif hingga: <b>${new Date(extended.expiresAt).toLocaleDateString('id-ID')}</b>\n` +
            `Sisa: <b>${daysLeft} hari</b>`
        );

        await sendMsg(_adminChatId,
            `🔄 <b>RENEWAL</b> — @${user.telegramUsername}\n` +
            `+${received.toFixed(4)} SOL | ${daysLeft} hari`
        );
    }
}

// ── REMINDER EXPIRY ──────────────────────────────────────
async function sendExpiryReminders() {
    const now  = Date.now();
    const day3 = 3 * 24 * 60 * 60 * 1000;
    const day1 = 1 * 24 * 60 * 60 * 1000;

    for (const user of license.getAllUsers()) {
        if (user.status !== 'active') continue;

        const remaining = user.expiresAt - now;
        const planInfo  = license.PLANS[user.plan];

        // Reminder 3 hari sebelum expired
        if (remaining > 0 && remaining <= day3 && remaining > day3 - CHECK_INTERVAL_MS) {
            await sendMsg(user.telegramId,
                `⏰ <b>Subscription kamu akan expired dalam 3 hari!</b>\n\n` +
                `Plan: ${planInfo.name}\n` +
                `Expired: ${new Date(user.expiresAt).toLocaleDateString('id-ID')}\n\n` +
                `Untuk perpanjang, transfer <b>${planInfo.priceSOL} SOL</b> ke:\n` +
                `<code>${user.walletPublicKey}</code>\n\n` +
                `Pembayaran otomatis terdeteksi dalam 1-2 menit.`
            );
        }

        // Reminder 1 hari
        if (remaining > 0 && remaining <= day1 && remaining > day1 - CHECK_INTERVAL_MS) {
            await sendMsg(user.telegramId,
                `🚨 <b>Subscription expired BESOK!</b>\n\n` +
                `Segera perpanjang ke:\n<code>${user.walletPublicKey}</code>\n` +
                `Jumlah: <b>${planInfo.priceSOL} SOL</b>`
            );
        }
    }
}

// ── MAIN MONITOR TICK ────────────────────────────────────
async function monitorTick() {
    // Cek expired
    const expired = license.checkExpiredUsers();
    if (expired > 0) {
        console.log(`[payment] ${expired} user expired`);
        // Notif user yang baru expired
        for (const user of license.getAllUsers()) {
            if (user.status === 'expired' && user.expiresAt) {
                const justExpired = Date.now() - user.expiresAt < CHECK_INTERVAL_MS * 2;
                if (justExpired) {
                    await sendMsg(user.telegramId,
                        `❌ <b>Subscription kamu sudah expired!</b>\n\n` +
                        `Bot dihentikan sementara.\n\n` +
                        `Untuk reaktivasi, transfer ke:\n<code>${user.walletPublicKey}</code>\n` +
                        `Jumlah: <b>${license.PLANS[user.plan]?.priceSOL || '?'} SOL</b>`
                    );
                }
            }
        }
    }

    // Proses payment semua user pending/expired/active
    const usersToCheck = license.getAllUsers().filter(
        u => ['pending', 'expired', 'active'].includes(u.status)
    );

    for (const user of usersToCheck) {
        await processUserPayment(user);
        await new Promise(r => setTimeout(r, 500)); // jeda antar request RPC
    }

    // Kirim reminder expiry
    await sendExpiryReminders();
}

// ── START MONITOR ────────────────────────────────────────
function startMonitor(bot, adminChatId) {
    init(bot, adminChatId);
    console.log(`[payment] Monitor started (interval: ${CHECK_INTERVAL_MS / 1000}s)`);

    // Jalankan langsung sekali, lalu interval
    setTimeout(() => {
        monitorTick().catch(e => console.error('[payment] Tick error:', e.message));
    }, 5000);

    setInterval(() => {
        monitorTick().catch(e => console.error('[payment] Tick error:', e.message));
    }, CHECK_INTERVAL_MS);
}

// ── MANUAL TRIGGER (untuk testing) ──────────────────────
async function checkNow() {
    return monitorTick();
}

module.exports = { startMonitor, checkNow };
