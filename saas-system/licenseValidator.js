'use strict';

// ============================================================
// LICENSE VALIDATOR — Integrasi ke bot engine user
//
// Cara pakai di index.js / tradingEngine:
//
//   const { checkLicense } = require('./licenseValidator');
//   const result = await checkLicense(process.env.LICENSE_KEY);
//   if (!result.valid) { console.error(result.reason); process.exit(1); }
//
// Validator ini ping ke server kamu (atau cek file lokal jika offline).
// Untuk SaaS managed (kamu yang host), ini tidak perlu karena
// kamu yang kontrol server. Tapi berguna untuk tier dedicated
// dimana user punya akses ke servernya sendiri.
// ============================================================

const fs   = require('fs');
const path = require('path');
const license = require('./licenseManager');

// ── LOCAL VALIDATION (karena kamu yang host) ────────────────
// Untuk arsitektur SaaS managed: validasi lokal di server kamu
function checkLicense(licenseKey) {
    if (!licenseKey) {
        return { valid: false, reason: 'LICENSE_KEY tidak ditemukan di environment' };
    }

    return license.validateLicense(licenseKey);
}

// ── MIDDLEWARE UNTUK TRADING ENGINE ─────────────────────────
// Inject ke trading engine agar auto-stop jika license expired
function createLicenseGuard(licenseKey, onExpired) {
    // Cek setiap 5 menit
    const CHECK_INTERVAL = 5 * 60 * 1000;

    function check() {
        const result = checkLicense(licenseKey);

        if (!result.valid) {
            console.error(`\n❌ LICENSE TIDAK VALID: ${result.reason}`);
            if (typeof onExpired === 'function') {
                onExpired(result.reason);
            }
            return false;
        }

        // Warning jika hampir expired
        if (result.daysLeft <= 3) {
            console.warn(`⚠️  License akan expired dalam ${result.daysLeft} hari!`);
        }

        return true;
    }

    // Cek pertama kali
    const initialCheck = check();

    // Schedule cek berkala
    const interval = setInterval(() => {
        const ok = check();
        if (!ok) clearInterval(interval);
    }, CHECK_INTERVAL);

    return { initialValid: initialCheck, stop: () => clearInterval(interval) };
}

// ── INJECT KE INDEX.JS ──────────────────────────────────────
// Contoh cara pakai di bot engine user:
//
// const { createLicenseGuard } = require('./licenseValidator');
// const guard = createLicenseGuard(process.env.LICENSE_KEY, (reason) => {
//     // Kirim notif ke Telegram user, stop semua position
//     bot.telegram.sendMessage(userId, `Bot dihentikan: ${reason}`);
//     process.exit(0);
// });
// if (!guard.initialValid) process.exit(1);

module.exports = { checkLicense, createLicenseGuard };
