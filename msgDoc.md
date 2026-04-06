# 📡 Dokumentasi Pesan Channel Telegram — Crypto Radar Bot

> Versi: v3 (Feb 2026 layout)  
> File ini menjelaskan **semua pesan** yang dikirim bot ke channel Telegram, cara membacanya, dan artinya.

---

## Daftar Isi

1. [Early Signal](#1-early-signal)
2. [Call Confirmed](#2-call-confirmed)
3. [Auto-Buy Executed](#3-auto-buy-executed)
4. [Auto-Buy Failed](#4-auto-buy-failed)
5. [Stop Loss](#5-stop-loss)
6. [Stop Loss Failed](#6-stop-loss-failed)
7. [Trailing Stop / Partial Take Profit](#7-trailing-stop--partial-take-profit)
8. [Trail Failed](#8-trail-failed)
9. [DCA Order Executed](#9-dca-order-executed)
10. [DCA Order Failed](#10-dca-order-failed)
11. [Grid Buy](#11-grid-buy)
12. [Grid Sell](#12-grid-sell)
13. [Grid Stop Loss](#13-grid-stop-loss)
14. [News Update](#14-news-update)
15. [Solana Webhook Monitor](#15-solana-webhook-monitor)
16. [Pesan Admin / System](#16-pesan-admin--system)
17. [Referensi Cepat: Kode Warna & Istilah](#17-referensi-cepat-kode-warna--istilah)

---

## 1. Early Signal

**Sumber file:** `src/services/pumpRadar.js`  
**Trigger:** Token baru memenuhi threshold minimum — `PUMP_MIN_VOLUME_SOL` (default 5 SOL) + `PUMP_MIN_BUYERS` (default 10 buyer unik).

### Contoh Pesan

```
[ EARLY SIGNAL ]
................................................................................
The Block  $THEBLOCK

REJECT  DEV_SOLD
Flags  DEV SOLD  |  SPEED RUNNER
Score  #######---  67/100  GOOD

Auto-buy  skipped  (min score 75)

MCap  $2,711  |  Curve  17%
Volume  14.5 SOL  (~$1,155)
Buyers  10  |  B/S  14/9
Velocity  70.7 buys/min
Whales  1  (max 2.0 SOL)
Dev  SOLD
Bundled  No

CA  4FjLfAFRWtEhnVaAn9UiLL5eKHTa3pbFwNBfnitXU5fx
................................................................................
pump.fun | solscan
```

### Penjelasan Field

| Field | Penjelasan |
|-------|-----------|
| **Nama Token `$TICKER`** | Nama lengkap dan ticker/simbol token |
| **REJECT** | Hard reject — alasan bot TIDAK auto-buy. Lihat tabel reject di bawah |
| **Flags** | Tanda peringatan atau keunggulan tambahan |
| **Score `##/100`** | Skor kualitas sinyal 0–100. Bar `#` = terisi, `-` = kosong |
| **Auto-buy** | `TRIGGERED` = bot beli otomatis. `skipped` = tidak beli + alasannya |
| **MCap** | Market capitalization saat sinyal dalam USD |
| **Curve** | Persentase bonding curve terisi. 100% = migrasi ke PumpSwap/Raydium |
| **Volume** | Total SOL yang sudah diperdagangkan sejak launch |
| **Buyers** | Jumlah wallet unik yang pernah beli |
| **B/S** | Jumlah transaksi Buy vs Sell |
| **Velocity** | Kecepatan pembelian per menit |
| **Whales** | Jumlah transaksi ≥ 1 SOL, dan nilai pembelian whale terbesar |
| **Dev** | `Holding` = aman. `SOLD` = developer sudah jual = bahaya |
| **Bundled** | `Yes` = terdeteksi manipulasi saat launch |
| **CA** | Contract Address / mint address token |

### Tabel REJECT (Hard Reject)

| Kode | Artinya | Bahaya |
|------|---------|--------|
| `DEV_SOLD` | Developer sudah jual semua token | 🔴 Sangat Tinggi |
| `HIGH_SELL_RATIO` | Lebih dari 40% transaksi adalah sell | 🟠 Tinggi |
| `SUSPICIOUS_WHALE_CLUSTER` | Lebih dari 5 whale masuk di 30 detik pertama | 🟠 Tinggi (kemungkinan insider) |
| `LOW_UNIQUE_BUYERS` | Volume > 20 SOL tapi buyer unik < 8 | 🟠 Tinggi (wash trading) |

> **Catatan:** Token dengan REJECT tidak akan pernah di-auto-buy bot, meski skornya tinggi.

### Tabel Flags

| Flag | Artinya |
|------|---------|
| `SPEED RUNNER` | Velocity > 20 buy/menit — pump sangat cepat |
| `DEV SOLD` | Developer sudah jual |
| `BUNDLED LAUNCH` | Banyak buy di 2 detik pertama (manipulasi) |
| `WHALE CLUSTER` | Ada 3+ whale masuk sekaligus |

### Sistem Skor (0–100)

| Komponen | Bobot Maks | Keterangan |
|----------|-----------|-----------|
| Momentum (velocity) | 25 | Makin cepat buy/menit, makin tinggi |
| Buyer Diversity | 20 | Makin banyak wallet unik, makin organik |
| Volume Quality | 20 | Volume per buyer (komitmen rata-rata) |
| Whale Signal | 15 | Ada whale = big money percaya token ini |
| Buy/Sell Ratio | 10 | Makin dominan buy, makin positif |
| Speed (waktu launch) | 10 | Makin cepat pump sejak launch |
| **Penalti Bundled** | **-15** | Dikurangi jika terdeteksi bundled |

### Rating Skor

| Range | Rating | Auto-Buy? |
|-------|--------|-----------|
| 75–100 | `STRONG` | ✅ Ya (jika tidak ada reject) |
| 55–74 | `GOOD` | ✅ Ya (tergantung `SIGNAL_MIN_SCORE`) |
| 35–54 | `WEAK` | ❌ Tidak |
| 0–34 | `POOR` | ❌ Tidak |

> `SIGNAL_MIN_SCORE` diatur di `.env`. Default: 55.

### Tombol Inline

- **axiom.trade** → Link beli langsung di Axiom
- **photon** → Link analisa di Photon

---

## 2. Call Confirmed

**Sumber file:** `src/services/pumpRadar.js`  
**Trigger:** Harga token naik ke kelipatan 2x, 3x, 4x, dst. dari harga saat sinyal pertama dikirim.

### Contoh Pesan

```
[ CALL CONFIRMED  3x  +200% ]
................................................................................
The Block  $THEBLOCK

Gain  +200%  (3.0x from alert)
MCap now  $8,133
MCap at alert  $2,711
Curve  52%  |  Volume  44.2 SOL

CA  4FjLfAFRWtEhnVaAn9UiLL5eKHTa3pbFwNBfnitXU5fx
................................................................................
pump.fun | solscan
```

### Penjelasan Field

| Field | Penjelasan |
|-------|-----------|
| **Header `Nx +Y%`** | Kelipatan keuntungan dari harga saat alert pertama dikirim |
| **Gain** | Persentase kenaikan dan multiplier persisnya |
| **MCap now** | Market cap saat ini dalam USD |
| **MCap at alert** | Market cap saat sinyal pertama dikirim |
| **Curve** | Progress bonding curve saat ini |

> **Contoh baca:** Header `3x +200%` artinya harga sudah naik 3 kali lipat (300% dari harga awal alert, atau +200% profit).

### Tombol Inline

- **take profit (axiom)** → Link jual / ambil profit
- **photon** → Link analisa

---

## 3. Auto-Buy Executed

**Sumber file:** `src/trading/tradingEngine.js`  
**Trigger:** Bot berhasil membeli token secara otomatis setelah sinyal memenuhi kriteria skor dan risk management.

### Contoh Pesan

```
[ AUTO-BUY EXECUTED ]          ← atau [ AUTO-BUY EXECUTED  [ SIM ] ] jika simulasi
................................................................................
Token  The Block
Score  72 / 100
Spent  0.1 SOL
Received  1,250,000 tokens
Entry price  0.00000008
Stop loss   0.00000006
................................................................................
solscan.io/tx/abc123...
```

### Penjelasan Field

| Field | Penjelasan |
|-------|-----------|
| **`[ SIM ]`** | Tag ini muncul jika mode simulasi aktif. Tidak ada SOL nyata yang digunakan |
| **Score** | Skor sinyal saat pembelian |
| **Spent** | Jumlah SOL yang digunakan (sesuai `AUTO_BUY_AMOUNT_SOL` di `.env`) |
| **Received** | Jumlah token yang diterima |
| **Entry price** | Harga beli per token dalam SOL |
| **Stop loss** | Harga otomatis untuk cut loss (dihitung dari `RISK_MAX_LOSS_PCT`) |
| **Link Solscan** | Link transaksi on-chain |

---

## 4. Auto-Buy Failed

**Sumber file:** `src/trading/tradingEngine.js`  
**Trigger:** Bot mencoba beli tapi gagal (RPC error, slippage, dana kurang, dll.).

### Contoh Pesan

```
[ AUTO-BUY FAILED ]
................................................................................
Token  The Block
Score  72
Error  SOL kurang: 0.0200 (butuh 0.1200)
Code   INSUFFICIENT_FUNDS
```

### Kode Error Umum

| Code | Artinya |
|------|---------|
| `INSUFFICIENT_FUNDS` | Saldo SOL tidak cukup untuk beli + buffer |
| `GRADUATED` | Token sudah migrasi ke AMM, bukan di bonding curve lagi |
| `TOKEN_NOT_FOUND` | Token belum terdaftar di chain (RPC delay) |
| `BC_NOT_FOUND` | Bonding curve tidak ditemukan |
| `ZERO_QUOTE` | Quote mengembalikan 0 token |
| `TX_ERROR` | Transaksi gagal dikirim |

---

## 5. Stop Loss

**Sumber file:** `src/trading/tradingEngine.js`  
**Trigger:** Harga turun ke atau di bawah level stop loss yang ditetapkan saat beli.

### Contoh Pesan

```
[ STOP LOSS ]          ← atau [ STOP LOSS  [ SIM ] ] jika simulasi
................................................................................
Token     The Block
Price     0.00000006
SL level  0.00000006
PnL       -0.0150 SOL
................................................................................
solscan.io/tx/abc123...
```

### Penjelasan Field

| Field | Penjelasan |
|-------|-----------|
| **Price** | Harga saat stop loss terpicu |
| **SL level** | Level harga stop loss yang ditetapkan |
| **PnL** | Profit/Loss dalam SOL. Angka negatif = rugi |

---

## 6. Stop Loss Failed

**Sumber file:** `src/trading/tradingEngine.js`  
**Trigger:** Bot mencoba jual karena stop loss tapi transaksi gagal. Perlu perhatian manual!

### Contoh Pesan

```
[ STOP LOSS FAILED ]
................................................................................
Token  The Block
Error  BC_SELL_ERR: ...
```

> ⚠️ Jika pesan ini muncul, segera cek posisi dan jual manual via Axiom/Photon.

---

## 7. Trailing Stop / Partial Take Profit

**Sumber file:** `src/trading/tradingEngine.js` + `src/trading/trailingStop.js`  
**Trigger:** Harga mencapai level take profit atau trailing stop terpicu.

### Fase-fase Trailing Stop

| Phase | Trigger | Aksi |
|-------|---------|------|
| `TP1 (1.3x)` | Harga = 1.3x dari entry | Jual 40% posisi awal |
| `TP2 (2x)` | Harga = 2x dari entry | Jual 30% posisi awal |
| `TP3 (4x, trail ketat)` | Harga = 4x dari entry | Aktifkan trail 10%, tidak jual |
| `TRAILING_STOP` | Harga turun X% dari high | Jual sisa posisi |
| `BREAKEVEN` | Harga kembali ke entry setelah TP1 | Jual sisa (lindungi modal) |

### Contoh Pesan TP1

```
[ TP1 (1.3x) ]          ← atau dengan [ SIM ]
................................................................................
Token      The Block
Multiplier 1.3x from entry
Sold       40% of initial
PnL batch  +0.0520 SOL  (+30.0%)
Remaining  60% (trailing)
................................................................................
solscan.io/tx/abc123...
```

### Contoh Pesan Trailing Stop

```
[ TRAILING_STOP ]
................................................................................
Token      The Block
Multiplier 1.8x from entry
Sold       remaining
PnL batch  +0.0900 SOL  (+80.0%)
Status     POSITION CLOSED
Trail stop 0.00000144
................................................................................
solscan.io/tx/abc123...
```

### Penjelasan Field

| Field | Penjelasan |
|-------|-----------|
| **Multiplier** | Berapa kali lipat dari harga entry saat ini |
| **Sold** | Berapa persen posisi awal yang dijual di fase ini |
| **PnL batch** | Profit/loss dari batch jual ini saja (bukan total) |
| **Remaining** | Sisa posisi yang masih open (dalam persen) |
| **Status** | `POSITION CLOSED` = posisi sudah ditutup penuh |
| **Trail stop** | Level harga trailing stop saat ini |

---

## 8. Trail Failed

**Sumber file:** `src/trading/tradingEngine.js`  
**Trigger:** Bot mencoba jual di fase trailing tapi gagal.

### Contoh Pesan

```
[ TRAIL FAILED ]
................................................................................
Token  The Block
Error  BC_SELL_ERR: slippage exceeded
```

> ⚠️ Sama seperti Stop Loss Failed, perlu intervensi manual jika muncul.

---

## 9. DCA Order Executed

**Sumber file:** `src/trading/strategies/dca.js`  
**Trigger:** Salah satu order dalam rencana Dollar Cost Averaging berhasil dieksekusi.

### Contoh Pesan

```
[ DCA ORDER EXECUTED ]
................................................................................
Token        SOL
Order        2 / 5
Spent        0.2 SOL
Received     2,500,000 tokens
Entry        0.00000008
Stop loss    0.00000007
Take profit  0.00000012
................................................................................
solscan.io/tx/abc123...
```

### Penjelasan Field

| Field | Penjelasan |
|-------|-----------|
| **Order `X / Y`** | Order ke-X dari total Y order dalam rencana DCA |
| **Spent** | SOL yang digunakan di order ini |
| **Received** | Token yang diterima |
| **Entry** | Harga beli order ini |
| **Stop loss** | Level cut loss untuk posisi ini |
| **Take profit** | Level target profit |

---

## 10. DCA Order Failed

**Sumber file:** `src/trading/strategies/dca.js`  
**Trigger:** Salah satu order DCA gagal dieksekusi.

### Contoh Pesan

```
[ DCA ORDER FAILED ]
................................................................................
Token  SOL
Error  SOL kurang: 0.0200 (butuh 0.2200)
```

---

## 11. Grid Buy

**Sumber file:** `src/trading/strategies/grid.js`  
**Trigger:** Harga turun ke level grid bawah, bot membeli.

### Contoh Pesan

```
🟢 GRID BUY — THEBLOCK
📊 Level 3/10
💰 0.1 SOL → 1,250,000 token
📍 Price: 0.00000008 SOL
🔗 Solscan
```

### Penjelasan Field

| Field | Penjelasan |
|-------|-----------|
| **Level X/Y** | Level grid ke-X dari total Y level |
| **SOL → token** | SOL yang dipakai dan token yang diterima |
| **Price** | Harga beli saat ini |

---

## 12. Grid Sell

**Sumber file:** `src/trading/strategies/grid.js`  
**Trigger:** Harga naik ke level grid atas, bot menjual.

### Contoh Pesan

```
🔴 GRID SELL — THEBLOCK
📊 Level 3 → 4
💰 1,250,000 token → 0.1150 SOL
📈 PnL grid: +0.0150 SOL
📊 Total PnL: +0.0430 SOL
🔗 Solscan
```

### Penjelasan Field

| Field | Penjelasan |
|-------|-----------|
| **Level X → Y** | Bot jual dari level X ke level Y (naik satu level) |
| **PnL grid** | Profit/loss dari transaksi sell ini saja |
| **Total PnL** | Akumulasi profit/loss semua grid trade sejak plan dibuat |

---

## 13. Grid Stop Loss

**Sumber file:** `src/trading/strategies/grid.js`  
**Trigger:** Harga turun di bawah level stop loss seluruh grid plan. Grid dinonaktifkan.

### Contoh Pesan

```
🛑 GRID STOP LOSS
🪙 THEBLOCK
Harga: 0.00000005 SOL
Total PnL: -0.0200 SOL
```

> Setelah pesan ini, grid plan untuk token tersebut tidak aktif lagi. Gunakan `/grid_cancel` untuk membersihkan atau buat plan baru.

---

## 14. News Update

**Sumber file:** `src/services/news.js`  
**Trigger:** Ada berita crypto baru dari NewsData.io yang belum pernah dikirim.

### Contoh Pesan

```
[ NEWS UPDATE ]
................................................................................
Bitcoin Hits New All-Time High Amid Institutional Demand

Sumber  CoinDesk
Baca selengkapnya (link)

#Bitcoin #Crypto #Blockchain #News
```

> Berita hanya dikirim jika `ENABLE_NEWS_POLLING=true` dan `NEWSDATA_API_KEY` diisi di `.env`.

---

## 15. Solana Webhook Monitor

**Sumber file:** `src/handlers/routes.js`  
**Trigger:** Menerima data transaksi dari Helius Webhook (jika `ENABLE_SOLANA_STREAM=true`).

### Contoh Pesan

```
[ SOLANA MONITOR ]
................................................................................
Activity  SWAP
Source    RAYDIUM

Deskripsi transaksi...

solscan.io/tx/abc123...
```

> Fitur ini dinonaktifkan secara default. Aktifkan dengan `ENABLE_SOLANA_STREAM=true` di `.env` dan konfigurasi Helius webhook.

---

## 16. Pesan Admin / System

Pesan ini hanya muncul saat admin menjalankan command tertentu, biasanya via chat bot (bukan channel). Tapi beberapa bisa dikirim ke channel via `/broadcast`.

| Command | Deskripsi |
|---------|-----------|
| `/test` | Kirim pesan tes ke channel |
| `/debug` | Kirim pesan debug ke channel |
| `/broadcast <pesan>` | Kirim pesan bebas ke channel |
| `/forcenews` | Paksa cek berita sekarang |

---

## 17. Referensi Cepat: Kode Warna & Istilah

### Istilah Teknis

| Istilah | Penjelasan |
|---------|-----------|
| **Bonding Curve** | Mekanisme harga otomatis Pump.fun sebelum token migrasi |
| **Curve %** | Seberapa penuh bonding curve. 100% = siap migrasi ke PumpSwap |
| **PumpSwap / AMM** | DEX tempat token berdagang setelah lulus bonding curve |
| **MCap** | Market Capitalization = harga × total supply |
| **Whale** | Pembelian ≥ 1 SOL dalam satu transaksi |
| **Bundled** | Launch yang terdeteksi ada banyak buy dalam 2 detik pertama (mencurigakan) |
| **Velocity** | Jumlah transaksi buy per menit |
| **Entry Price** | Harga beli awal per token dalam SOL |
| **SL (Stop Loss)** | Harga minimum, jika harga turun ke sini posisi otomatis dijual |
| **TP (Take Profit)** | Harga target, jika tercapai sebagian posisi dijual |
| **Trail** | Trailing stop — SL bergerak mengikuti harga naik |
| **DCA** | Dollar Cost Averaging — beli bertahap dalam beberapa order |
| **Grid** | Strategi beli di level rendah dan jual di level tinggi secara otomatis |

### Tag `[ SIM ]`

Setiap pesan yang mengandung `[ SIM ]` di headernya berarti **mode simulasi aktif**. Tidak ada SOL nyata yang digunakan. Untuk beralih ke live trading, set `ENABLE_SIMULATION_MODE=false` di `.env`.

### Level Urgency Pesan

| Jenis Pesan | Tindakan yang Direkomendasikan |
|------------|-------------------------------|
| `EARLY SIGNAL` | Analisa manual, putuskan beli atau tidak |
| `CALL CONFIRMED Nx` | Pertimbangkan ambil profit sebagian |
| `AUTO-BUY EXECUTED` | Pantau posisi, trailing stop sudah aktif |
| `TP1 / TP2 / TP3` | Info saja, bot sudah jual sebagian otomatis |
| `TRAILING_STOP` | Posisi ditutup, tidak perlu tindakan |
| `STOP LOSS` | Posisi ditutup dengan rugi, evaluasi strategi |
| `STOP LOSS FAILED` | ⚠️ **Perlu tindakan manual segera!** |
| `TRAIL FAILED` | ⚠️ **Perlu tindakan manual segera!** |
| `GRID STOP LOSS` | Grid plan nonaktif, evaluasi kondisi pasar |
| `DCA ORDER FAILED` | Cek saldo SOL dan koneksi RPC |
| `AUTO-BUY FAILED` | Biasanya otomatis retry, pantau log |

---

## Konfigurasi yang Mempengaruhi Pesan

Semua diatur di file `.env`:

```env
# Trading Mode
ENABLE_SIMULATION_MODE=true       # true = SIM, false = LIVE

# Kontrol Notifikasi (true/false)
ENABLE_SIGNAL_ALERTS=true         # Early Signal & Call Confirmed
ENABLE_PROFIT_ALERTS=true         # TP1, TP2, Trailing Stop
ENABLE_STOPLOSS_ALERTS=true       # Stop Loss
ENABLE_BUY_ALERTS=true            # Auto-Buy Executed/Failed

# Threshold Signal
SIGNAL_MIN_SCORE=55               # Skor minimum untuk auto-buy

# Auto Buy
AUTO_BUY_AMOUNT_SOL=0.1           # SOL per trade

# Risk
RISK_MAX_LOSS_PCT=15              # % loss sebelum stop loss triggered
```

---

*Dokumentasi ini dibuat otomatis berdasarkan analisis kode sumber bot. Perbarui jika ada perubahan pada `pumpRadar.js`, `tradingEngine.js`, `dca.js`, atau `grid.js`.*