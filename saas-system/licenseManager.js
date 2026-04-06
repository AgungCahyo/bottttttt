'use strict';

// ============================================================
// LICENSE MANAGER — Sistem SaaS Bot Trading
//
// Flow:
//   1. Admin buat user baru via Telegram command /adduser
//   2. Sistem generate wallet SOL unik untuk user tsb
//   3. Sistem generate license key unik
//   4. User deposit SOL ke wallet mereka
//   5. Bot monitor payment, aktifkan license otomatis
//   6. Setiap startup bot user, ping ke sini untuk validasi
//
// Storage: JSON file (bisa upgrade ke DB nanti)
// ============================================================

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const {
    Keypair, Connection, PublicKey, LAMPORTS_PER_SOL
} = require('@solana/web3.js');
const bs58 = require('bs58').default || require('bs58');

const DB_FILE  = path.join(__dirname, 'licenses.json');
const RPC_URL  = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

// ── HARGA PAKET (dalam SOL) ───────────────────────────────
const PLANS = {
    signal:    { name: 'Signal Channel',   priceSOL: 0.5,  durationDays: 30 },
    managed:   { name: 'Bot Managed',      priceSOL: 1.5,  durationDays: 30 },
    dedicated: { name: 'Bot Dedicated',    priceSOL: 5.0,  durationDays: 30 },
};

// ── LOAD/SAVE DB ─────────────────────────────────────────
let db = { users: {}, payments: [] };

function loadDb() {
    try {
        if (fs.existsSync(DB_FILE)) {
            db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            console.log(`[license] DB loaded: ${Object.keys(db.users).length} users`);
        }
    } catch (e) {
        console.warn('[license] DB load failed, starting fresh:', e.message);
    }
}

function saveDb() {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

loadDb();

// ── GENERATE LICENSE KEY ─────────────────────────────────
// Format: CRYPT-XXXX-XXXX-XXXX-XXXX
function generateLicenseKey() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const seg = () => Array.from(
        { length: 4 },
        () => chars[Math.floor(Math.random() * chars.length)]
    ).join('');
    return `CRYPT-${seg()}-${seg()}-${seg()}-${seg()}`;
}

// ── GENERATE WALLET SOLANA BARU ──────────────────────────
function generateWallet() {
    const kp = Keypair.generate();
    return {
        publicKey:  kp.publicKey.toBase58(),
        privateKey: bs58.encode(kp.secretKey),  // disimpan terenkripsi di DB
    };
}

// ── ENKRIPSI PRIVATE KEY (AES-256-GCM) ──────────────────
// Key enkripsi dari env — WAJIB diset di .env
function getEncKey() {
    const k = process.env.LICENSE_ENC_KEY;
    if (!k || k.length < 32) {
        throw new Error('LICENSE_ENC_KEY di .env harus minimal 32 karakter!');
    }
    return crypto.scryptSync(k, 'salt_cripto_saas_v1', 32);
}

function encryptPrivKey(privKeyBase58) {
    const key = getEncKey();
    const iv  = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc  = Buffer.concat([cipher.update(privKeyBase58, 'utf8'), cipher.final()]);
    const tag  = cipher.getAuthTag();
    return [iv.toString('hex'), enc.toString('hex'), tag.toString('hex')].join(':');
}

function decryptPrivKey(encrypted) {
    const [ivHex, encHex, tagHex] = encrypted.split(':');
    const key    = getEncKey();
    const iv     = Buffer.from(ivHex, 'hex');
    const enc    = Buffer.from(encHex, 'hex');
    const tag    = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc) + decipher.final('utf8');
}

// ── CREATE USER BARU ─────────────────────────────────────
function createUser({ telegramId, telegramUsername, plan = 'signal' }) {
    if (!PLANS[plan]) throw new Error(`Plan tidak valid: ${plan}`);

    // Cek duplikat
    const existing = getUserByTelegramId(telegramId);
    if (existing) return { error: 'User sudah ada', user: existing };

    const wallet     = generateWallet();
    const licenseKey = generateLicenseKey();

    const user = {
        id:              crypto.randomUUID(),
        telegramId:      String(telegramId),
        telegramUsername: telegramUsername || '',
        licenseKey,
        plan,
        status:          'pending',      // pending → active → expired → suspended
        walletPublicKey: wallet.publicKey,
        walletPrivKeyEnc: encryptPrivKey(wallet.privateKey),
        createdAt:       Date.now(),
        activatedAt:     null,
        expiresAt:       null,
        totalPaidSOL:    0,
        lastChecked:     null,
        botConfig: {                     // konfigurasi per user
            autoBuyAmountSOL: 0.05,
            signalMinScore:   80,
            riskMaxLossPct:   10,
            maxTradesPerDay:  10,
            simulationMode:   true,      // default simulasi dulu
        },
    };

    db.users[user.id] = user;
    saveDb();

    return {
        user,
        walletPrivKey: wallet.privateKey, // hanya return sekali, tidak disimpan plain
        priceSOL: PLANS[plan].priceSOL,
        planName: PLANS[plan].name,
    };
}

// ── GETTER HELPERS ───────────────────────────────────────
function getUserByTelegramId(telegramId) {
    return Object.values(db.users).find(u => u.telegramId === String(telegramId)) || null;
}

function getUserByLicenseKey(key) {
    return Object.values(db.users).find(u => u.licenseKey === key) || null;
}

function getUserByWallet(publicKey) {
    return Object.values(db.users).find(u => u.walletPublicKey === publicKey) || null;
}

function getAllUsers() {
    return Object.values(db.users);
}

// ── AKTIVASI LICENSE ─────────────────────────────────────
function activateLicense(userId, paidSOL) {
    const user = db.users[userId];
    if (!user) throw new Error('User tidak ditemukan');

    const plan = PLANS[user.plan];
    const now  = Date.now();
    const durationMs = plan.durationDays * 24 * 60 * 60 * 1000;

    // Jika sudah aktif, extend dari expiry sekarang
    const base = (user.status === 'active' && user.expiresAt > now)
        ? user.expiresAt
        : now;

    user.status      = 'active';
    user.activatedAt = user.activatedAt || now;
    user.expiresAt   = base + durationMs;
    user.totalPaidSOL += paidSOL;

    db.payments.push({
        userId,
        amountSOL: paidSOL,
        timestamp: now,
        type: 'activation',
    });

    saveDb();
    return user;
}

// ── SUSPEND / EXPIRE ─────────────────────────────────────
function suspendUser(userId, reason = '') {
    const user = db.users[userId];
    if (!user) return false;
    user.status = 'suspended';
    user.suspendReason = reason;
    saveDb();
    return true;
}

function checkExpiredUsers() {
    const now = Date.now();
    let expired = 0;
    for (const user of Object.values(db.users)) {
        if (user.status === 'active' && user.expiresAt && user.expiresAt < now) {
            user.status = 'expired';
            expired++;
        }
    }
    if (expired > 0) saveDb();
    return expired;
}

// ── UPDATE BOT CONFIG USER ───────────────────────────────
function updateUserConfig(userId, config) {
    const user = db.users[userId];
    if (!user) throw new Error('User tidak ditemukan');
    user.botConfig = { ...user.botConfig, ...config };
    saveDb();
    return user.botConfig;
}

// ── VALIDATE LICENSE (dipanggil saat bot user startup) ───
function validateLicense(licenseKey) {
    const user = getUserByLicenseKey(licenseKey);
    if (!user) return { valid: false, reason: 'License key tidak ditemukan' };

    checkExpiredUsers(); // pastikan status up-to-date

    if (user.status === 'pending')
        return { valid: false, reason: 'License belum aktif — silakan lakukan pembayaran' };

    if (user.status === 'expired')
        return { valid: false, reason: 'License sudah expired — perpanjang untuk melanjutkan' };

    if (user.status === 'suspended')
        return { valid: false, reason: `License disuspend: ${user.suspendReason || 'hubungi admin'}` };

    if (user.status !== 'active')
        return { valid: false, reason: 'Status tidak valid' };

    // Update last checked
    user.lastChecked = Date.now();
    saveDb();

    const daysLeft = Math.ceil((user.expiresAt - Date.now()) / (1000 * 60 * 60 * 24));

    return {
        valid:       true,
        userId:      user.id,
        telegramId:  user.telegramId,
        plan:        user.plan,
        daysLeft,
        expiresAt:   new Date(user.expiresAt).toISOString(),
        botConfig:   user.botConfig,
    };
}

// ── CEK SALDO WALLET USER ────────────────────────────────
async function checkWalletBalance(publicKey) {
    try {
        const conn = new Connection(RPC_URL, 'confirmed');
        const bal  = await conn.getBalance(new PublicKey(publicKey));
        return bal / LAMPORTS_PER_SOL;
    } catch (e) {
        console.warn('[license] Balance check error:', e.message);
        return null;
    }
}

// ── GET PRIVATE KEY USER (untuk bot engine) ──────────────
function getUserPrivateKey(userId) {
    const user = db.users[userId];
    if (!user) throw new Error('User tidak ditemukan');
    return decryptPrivKey(user.walletPrivKeyEnc);
}

// ── STATISTIK ────────────────────────────────────────────
function getStats() {
    const users = Object.values(db.users);
    return {
        total:     users.length,
        active:    users.filter(u => u.status === 'active').length,
        pending:   users.filter(u => u.status === 'pending').length,
        expired:   users.filter(u => u.status === 'expired').length,
        suspended: users.filter(u => u.status === 'suspended').length,
        totalRevenue: db.payments.reduce((s, p) => s + p.amountSOL, 0).toFixed(4),
        plans: {
            signal:    users.filter(u => u.plan === 'signal').length,
            managed:   users.filter(u => u.plan === 'managed').length,
            dedicated: users.filter(u => u.plan === 'dedicated').length,
        },
    };
}

module.exports = {
    PLANS,
    createUser,
    getUserByTelegramId,
    getUserByLicenseKey,
    getUserByWallet,
    getAllUsers,
    activateLicense,
    suspendUser,
    checkExpiredUsers,
    updateUserConfig,
    validateLicense,
    checkWalletBalance,
    getUserPrivateKey,
    getStats,
    db,
};
