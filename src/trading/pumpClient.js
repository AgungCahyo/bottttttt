'use strict';
// ============================================================
// PUMP CLIENT v3 — Up-to-date dengan semua breaking changes
//
// Referensi:
//   Pump Bonding Curve : 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
//   PumpSwap AMM       : pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
//   Fee Program        : pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ
//
// Changelog per update resmi:
//   Aug 01 2025 — Buy BC: idx 12 (global_vol_acc) + 13 (user_vol_acc) [WRITABLE]
//   Sep 01 2025 — Buy BC: idx 14 (fee_config) + 15 (fee_program) [READONLY]
//   Nov 04 2025 — PumpSwap pool idx 0 harus MUTABLE
//   Feb 2026    — BREAKING: creator_vault di idx 9 (bukan event_authority!),
//                 bonding_curve_v2 WAJIB di idx 16 buy / akhir sell,
//                 cashback_enabled di byte[82] → layout sell berbeda,
//                 Token-2022: token_program di idx 8 = Token-2022 program
// ============================================================

const {
    Connection, Keypair, PublicKey, Transaction,
    SystemProgram, LAMPORTS_PER_SOL,
    TransactionInstruction, ComputeBudgetProgram,
    sendAndConfirmTransaction,
} = require('@solana/web3.js');
const BN = require('bn.js');
const {
    PUMP_SDK,
    getPumpProgram,
    getBuyTokenAmountFromSolAmount,
    getSellSolAmountFromTokenAmount,
    BONDING_CURVE_NEW_SIZE,
} = require('@pump-fun/pump-sdk');

const offlinePumpProgram = getPumpProgram(null);
const {
    getAssociatedTokenAddress,
    createAssociatedTokenAccountInstruction,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    createSyncNativeInstruction,
    createCloseAccountInstruction,
} = require('@solana/spl-token');
const axios = require('axios');
const bs58  = require('bs58').default || require('bs58');
const log   = require('../utils/logger');

// ============================================================
// CONSTANTS
// ============================================================
const SOL_MINT           = 'So11111111111111111111111111111111111111112';
const WSOL_MINT          = new PublicKey(SOL_MINT);
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

const PUMP_PROGRAM_ID     = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMPSWAP_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const FEE_PROGRAM_ID      = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');

// PDA Pump Global State
const GLOBAL_STATE_PDA = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');

// Fee config seed khusus bonding curve program
const FEE_CONFIG_KEY = Buffer.from([
    1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170,
    81, 137, 203, 151, 245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176,
]);

// Discriminators
const DISC_BUY  = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const DISC_SELL = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

// ============================================================
// STATE
// ============================================================
let connection = null;
let wallet     = null;

// ============================================================
// INIT
// ============================================================
function init(rpcUrl, privateKeyBase58) {
    if (!rpcUrl)           throw new Error('SOLANA_RPC_URL belum diset');
    if (!privateKeyBase58) throw new Error('WALLET_PRIVATE_KEY belum diset');

    connection = new Connection(rpcUrl, {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 60_000,
    });

    const secretKey = bs58.decode(privateKeyBase58);
    if      (secretKey.length === 64) wallet = Keypair.fromSecretKey(secretKey);
    else if (secretKey.length === 32) wallet = Keypair.fromSeed(secretKey);
    else throw new Error(`Private key ukuran salah: ${secretKey.length} bytes`);

    log.wallet(wallet.publicKey.toBase58());
    return wallet.publicKey.toBase58();
}

function getWalletAddress() { return wallet?.publicKey?.toBase58() || null; }

// ============================================================
// SAFE ERROR
// ============================================================
function createSafeError(message, details = {}) {
    const err    = new Error(message);
    err.logs     = Array.isArray(details.logs) ? details.logs : [];
    err.txid     = details.txid || null;
    err.mint     = details.mint || null;
    err.code     = details.code || 'UNKNOWN';
    err.toString = () => message;
    return err;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Kurangi angka sim (token atau SOL) agar lebih konservatif vs eksekusi real. */
function applySimExtraImpact(raw, extraBps) {
    if (!(raw > 0) || !Number.isFinite(raw)) return raw;
    const bps = Math.min(7500, Math.max(0, Math.floor(extraBps)));
    return raw * (10000 - bps) / 10000;
}

// ============================================================
// BALANCES
// ============================================================
async function getSolBalance() {
    if (!connection || !wallet) throw new Error('pumpClient belum init');
    return (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL;
}

async function getBalance(mintAddress) {
    if (!connection || !wallet) throw new Error('pumpClient belum init');
    if (mintAddress === SOL_MINT) return getSolBalance();
    const CONFIG = require('../config');
    if (CONFIG.ENABLE_SIMULATION_MODE) {
        const posTracker = require('./positionTracker');
        const pos = posTracker.getPosition(mintAddress);
        const amt = pos?.amountToken;
        if (typeof amt === 'number' && amt > 0) return amt;
    }
    try {
        const mint = new PublicKey(mintAddress);
        for (const prog of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM]) {
            try {
                const ata  = await getAssociatedTokenAddress(mint, wallet.publicKey, false, prog);
                const info = await connection.getTokenAccountBalance(ata);
                if (info?.value?.uiAmount != null) return info.value.uiAmount;
            } catch { /* next */ }
        }
        return 0;
    } catch { return 0; }
}

// ============================================================
// PARSE BONDING CURVE
// Layout setelah Feb 2026 (151 bytes):
//   [0-7]   discriminator
//   [8-15]  virtual_token_reserves (u64)
//   [16-23] virtual_sol_reserves   (u64)
//   [24-31] real_token_reserves    (u64)
//   [32-39] real_sol_reserves      (u64)
//   [40-47] token_total_supply     (u64)
//   [48]    complete               (bool)
//   [49-80] creator                (Pubkey, 32 bytes)
//   [81]    reserved               (u8)
//   [82]    cashback_enabled       (bool) ← KEY
// ============================================================
async function fetchBondingCurve(mintAddress) {
    const mint = new PublicKey(mintAddress);
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('bonding-curve'), mint.toBuffer()], PUMP_PROGRAM_ID
    );

    const info = await connection.getAccountInfo(pda);
    if (!info || info.data.length < 49) {
        return {
            complete: true, cashbackEnabled: false, creator: null, pda,
            isMayhemMode: false, accountInfo: info || null,
        };
    }

    const d               = info.data;
    const realTokenRes    = d.readBigUInt64LE(24);
    const complete        = d[48] === 1 || realTokenRes === 0n;
    let creator           = d.length >= 81 ? new PublicKey(d.slice(49, 81)) : null;
    const cashbackEnabled = d.length > 82 && d[82] !== 0;
    let isMayhemMode      = false;
    try {
        if (info.data.length >= 83) {
            const dec = PUMP_SDK.decodeBondingCurve(info);
            isMayhemMode = !!dec.isMayhemMode;
            if (dec.creator) creator = dec.creator;
        }
    } catch { /* tetap manual */ }

    return {
        complete, cashbackEnabled, creator, pda, isMayhemMode, accountInfo: info,
    };
}

async function isGraduated(mintAddress) {
    try {
        const bc = await fetchBondingCurve(mintAddress);
        return bc.complete;
    } catch { return false; }
}

// ============================================================
// PDA HELPERS
// ============================================================
function pda(seeds, program) {
    const [key] = PublicKey.findProgramAddressSync(seeds, program);
    return key;
}

function bondingCurvePda(mint)   { return pda([Buffer.from('bonding-curve'), mint.toBuffer()], PUMP_PROGRAM_ID); }
function bondingCurveV2Pda(mint) { return pda([Buffer.from('bonding-curve-v2'), mint.toBuffer()], PUMP_PROGRAM_ID); }
function creatorVaultPda(creator){ return pda([Buffer.from('creator-vault'), creator.toBuffer()], PUMP_PROGRAM_ID); }
function eventAuthPda(program)   { return pda([Buffer.from('__event_authority')], program); }
function globalVolPda(program)   { return pda([Buffer.from('global_volume_accumulator')], program); }
function userVolPda(user, prog)  { return pda([Buffer.from('user_volume_accumulator'), user.toBuffer()], prog); }
function feeConfigPda()          { return pda([Buffer.from('fee_config'), FEE_CONFIG_KEY], FEE_PROGRAM_ID); }
function pswapGlobalConfigPda()  { return pda([Buffer.from('global_config')], PUMPSWAP_PROGRAM_ID); }
function pswapFeeConfigPda()     { return pda([Buffer.from('fee_config')], FEE_PROGRAM_ID); }

// ============================================================
// BONDING CURVE BUY — Feb 2026 layout (17 accounts)
// 0.  global                    (readonly)
// 1.  fee_recipient             (writable)
// 2.  mint                      (readonly)
// 3.  bonding_curve             (writable)
// 4.  associated_bonding_curve  (writable)
// 5.  user_ata                  (writable)
// 6.  user                      (writable, signer)
// 7.  system_program
// 8.  token_program             ← SPL atau Token-2022 sesuai mint
// 9.  creator_vault             (writable) ← Feb 2026: gantikan rent sysvar!
// 10. event_authority           (readonly)
// 11. pump_program              (readonly)
// 12. global_volume_accumulator (readonly) ← Aug 2025
// 13. user_volume_accumulator   (writable) ← Aug 2025
// 14. fee_config                (readonly) ← Sep 2025
// 15. fee_program               (readonly) ← Sep 2025
// 16. bonding_curve_v2          (readonly) ← Feb 2026, SELALU TERAKHIR
// ============================================================
async function bondingCurveBuy({ outputMint, amountLamports, slippageBps = 1500, priorityMicroLamports = 1_000_000 }) {
    const mint    = new PublicKey(outputMint);
    const mintStr = mint.toBase58().slice(0, 8) + '...';
    const solAmt  = amountLamports / LAMPORTS_PER_SOL;

    log.rpc(`[BC] Buy ${solAmt.toFixed(4)} SOL → ${mintStr}`);

    const CONFIG = require('../config');
    const bufSol = CONFIG.MIN_SOL_BUFFER_SOL;
    const bal = await getSolBalance();
    if (bal < solAmt + bufSol) {
        throw createSafeError(`SOL kurang: ${bal.toFixed(4)} (butuh ${(solAmt + bufSol).toFixed(4)})`, { code: 'INSUFFICIENT_FUNDS' });
    }

    let mintInfo = null;
    for (let i = 0; i < 20; i++) {
        mintInfo = await connection.getAccountInfo(mint);
        if (mintInfo) break;
        await sleep(400);
    }
    if (!mintInfo) throw createSafeError(`Token belum ada: ${mintStr}`, { code: 'TOKEN_NOT_FOUND' });

    const tokenProgram = mintInfo.owner.equals(TOKEN_2022_PROGRAM)
        ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM_ID;

    const bc = await fetchBondingCurve(outputMint);
    if (bc.complete) {
        throw createSafeError('Bonding curve graduated / selesai', { code: 'GRADUATED' });
    }

    const bcAcc = bc.accountInfo;
    if (!bcAcc) {
        throw createSafeError(`Bonding curve tidak ada: ${mintStr}`, { code: 'BC_NOT_FOUND' });
    }

    const creator = bc.creator || wallet.publicKey;

    const bcPda   = bondingCurvePda(mint);
    const bcV2Pda = bondingCurveV2Pda(mint);
    const cvPda   = creatorVaultPda(creator);
    const fcPda   = feeConfigPda();

    const userAta = await getAssociatedTokenAddress(mint, wallet.publicKey, false, tokenProgram);

    const globalInfo = await connection.getAccountInfo(GLOBAL_STATE_PDA);
    if (!globalInfo?.data) {
        throw createSafeError('Global pump state tidak ditemukan', { code: 'GLOBAL_NOT_FOUND' });
    }

    let global;
    try {
        global = PUMP_SDK.decodeGlobal(globalInfo);
    } catch (e) {
        throw createSafeError(`Decode global gagal: ${e?.message || e}`, { code: 'GLOBAL_DECODE' });
    }

    let bondingCurveDecoded;
    try {
        bondingCurveDecoded = PUMP_SDK.decodeBondingCurve(bcAcc);
    } catch (e) {
        throw createSafeError(`Decode bonding curve gagal: ${e?.message || e}`, { code: 'BC_DECODE' });
    }

    let feeConfig = null;
    try {
        const fcInfo = await connection.getAccountInfo(fcPda);
        if (fcInfo?.data) feeConfig = PUMP_SDK.decodeFeeConfig(fcInfo);
    } catch { /* optional */ }

    // Quote dari state kurva terbaru (setelah semua fetch di atas) — kurangi 6042 saat volatil
    const bcFresh = await connection.getAccountInfo(bcPda);
    if (!bcFresh?.data?.length) {
        throw createSafeError(`Bonding curve hilang saat quote: ${mintStr}`, { code: 'BC_NOT_FOUND' });
    }
    try {
        bondingCurveDecoded = PUMP_SDK.decodeBondingCurve(bcFresh);
    } catch (e) {
        throw createSafeError(`Decode BC fresh gagal: ${e?.message || e}`, { code: 'BC_DECODE' });
    }
    if (bondingCurveDecoded.complete) {
        throw createSafeError('Bonding curve graduated (saat quote)', { code: 'GRADUATED' });
    }

    const spendBn = new BN(amountLamports);
    const expectedTokens = getBuyTokenAmountFromSolAmount({
        global,
        feeConfig,
        mintSupply: bondingCurveDecoded.tokenTotalSupply,
        bondingCurve: bondingCurveDecoded,
        amount: spendBn,
    });
    if (expectedTokens.lten(0)) {
        throw createSafeError('Quote token = 0', { code: 'ZERO_QUOTE' });
    }

    // Slippage user + buffer eksekusi (ATAs, antrian RPC, pergerakan kurva) — hindari 6042
    const latencyCushionBps = 400;
    const slipBps = Math.min(Math.max(0, slippageBps) + latencyCushionBps, 9990);
    let minTokensOut = expectedTokens.mul(new BN(10000 - slipBps)).div(new BN(10000));
    if (minTokensOut.lten(0)) minTokensOut = new BN(1);

    const feeRecipient = await getFeeRecipient({ mayhemMode: !!bondingCurveDecoded.isMayhemMode });

    const prio = Math.max(1, Math.floor(priorityMicroLamports));
    const instructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: prio }),
    ];

    if (bcFresh.data.length < BONDING_CURVE_NEW_SIZE) {
        instructions.push(
            await offlinePumpProgram.methods.extendAccount().accountsPartial({
                account: bcPda,
                user: wallet.publicKey,
            }).instruction()
        );
    }

    const userAtaInfo = await connection.getAccountInfo(userAta);
    if (!userAtaInfo) {
        instructions.push(
            createAssociatedTokenAccountInstruction(wallet.publicKey, userAta, wallet.publicKey, mint, tokenProgram)
        );
    }

    const buyIx = await offlinePumpProgram.methods
        .buyExactSolIn(spendBn, minTokensOut, { 0: true })
        .accountsPartial({
            feeRecipient,
            mint,
            associatedUser: userAta,
            user: wallet.publicKey,
            creatorVault: cvPda,
            tokenProgram,
        })
        .remainingAccounts([
            { pubkey: bcV2Pda, isWritable: false, isSigner: false },
        ])
        .instruction();

    instructions.push(buyIx);

    return await sendTx(instructions, outputMint, solAmt, 'bonding_curve');
}

// ============================================================
// BONDING CURVE SELL — Anchor + quote (selaras @pump-fun/pump-sdk)
// Cashback coin: remainingAccounts [user_vol_acc, bonding_curve_v2]
// ============================================================
async function bondingCurveSell({ inputMint, amountTokens, slippageBps = 1500, priorityMicroLamports = 1_000_000 }) {
    const mint    = new PublicKey(inputMint);
    const mintStr = mint.toBase58().slice(0, 8) + '...';

    const mintInfo     = await connection.getAccountInfo(mint);
    const tokenProgram = (mintInfo?.owner?.equals(TOKEN_2022_PROGRAM))
        ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM_ID;

    const bc      = await fetchBondingCurve(inputMint);
    const creator = bc.creator || wallet.publicKey;

    const bcPda   = bondingCurvePda(mint);
    const bcV2Pda = bondingCurveV2Pda(mint);
    const cvPda   = creatorVaultPda(creator);
    const fcPda   = feeConfigPda();

    const userAta = await getAssociatedTokenAddress(mint, wallet.publicKey, false, tokenProgram);

    const bcAcc = bc.accountInfo || await connection.getAccountInfo(bcPda);
    if (!bcAcc?.data?.length) {
        throw createSafeError(`Bonding curve tidak ada: ${mintStr}`, { code: 'BC_NOT_FOUND' });
    }

    const globalInfo = await connection.getAccountInfo(GLOBAL_STATE_PDA);
    if (!globalInfo?.data) {
        throw createSafeError('Global pump state tidak ditemukan', { code: 'GLOBAL_NOT_FOUND' });
    }

    let global;
    try {
        global = PUMP_SDK.decodeGlobal(globalInfo);
    } catch (e) {
        throw createSafeError(`Decode global gagal: ${e?.message || e}`, { code: 'GLOBAL_DECODE' });
    }

    let bondingCurveDecoded;
    try {
        bondingCurveDecoded = PUMP_SDK.decodeBondingCurve(bcAcc);
    } catch (e) {
        throw createSafeError(`Decode bonding curve gagal: ${e?.message || e}`, { code: 'BC_DECODE' });
    }

    const cashback = !!bondingCurveDecoded.isCashbackCoin;

    let feeConfig = null;
    try {
        const fcInfo = await connection.getAccountInfo(fcPda);
        if (fcInfo?.data) feeConfig = PUMP_SDK.decodeFeeConfig(fcInfo);
    } catch { /* optional */ }

    const amountBn = new BN(Math.floor(amountTokens * 1e6));
    const expectedSolLamports = getSellSolAmountFromTokenAmount({
        global,
        feeConfig,
        mintSupply: bondingCurveDecoded.tokenTotalSupply,
        bondingCurve: bondingCurveDecoded,
        amount: amountBn,
    });

    const slipBps = Math.min(Math.max(0, slippageBps), 9999);
    let minSolBn = expectedSolLamports.mul(new BN(10000 - slipBps)).div(new BN(10000));
    if (minSolBn.lten(0)) minSolBn = new BN(1);

    const feeRecipient = await getFeeRecipient({ mayhemMode: !!bondingCurveDecoded.isMayhemMode });

    const prio = Math.max(1, Math.floor(priorityMicroLamports));
    const instructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: prio }),
    ];

    if (bcAcc.data.length < BONDING_CURVE_NEW_SIZE) {
        instructions.push(
            await offlinePumpProgram.methods.extendAccount().accountsPartial({
                account: bcPda,
                user: wallet.publicKey,
            }).instruction()
        );
    }

    const sellIx = await offlinePumpProgram.methods
        .sell(amountBn, minSolBn)
        .accountsPartial({
            feeRecipient,
            mint,
            associatedUser: userAta,
            user: wallet.publicKey,
            creatorVault: cvPda,
            tokenProgram,
        })
        .remainingAccounts(
            cashback
                ? [
                    { pubkey: userVolPda(wallet.publicKey, PUMP_PROGRAM_ID), isWritable: true, isSigner: false },
                    { pubkey: bcV2Pda, isWritable: false, isSigner: false },
                ]
                : [{ pubkey: bcV2Pda, isWritable: false, isSigner: false }]
        )
        .instruction();

    instructions.push(sellIx);

    const minSolUi = Number(minSolBn.toString()) / LAMPORTS_PER_SOL;
    log.rpc(`[BC] Sell ${amountTokens.toFixed(2)} tok | cashback=${cashback} | minSOL≈${minSolUi.toFixed(6)}`);

    const solBefore = await getSolBalance();
    let txid = null;
    try {
        txid = await sendAndConfirmFresh(instructions, 'bonding_curve_sell');

        await sleep(2000);
        const solReceived = Math.max(0, (await getSolBalance()) - solBefore);
        log.txOk(`[BC] Sell +${solReceived.toFixed(4)} SOL`);
        return { txid, outputAmount: solReceived, isSimulation: false, route: 'bonding_curve' };
    } catch (err) {
        let logs = err?.logs;
        if (logs == null && typeof err?.getLogs === 'function') {
            try {
                logs = await err.getLogs(connection);
            } catch {
                logs = [];
            }
        }
        throw createSafeError(err?.message || String(err), { logs: Array.isArray(logs) ? logs : [], txid, code: 'BC_SELL_ERR' });
    }
}

// ============================================================
// PUMPSWAP AMM BUY (Nov 2025 + creator fee + Sep 2025)
// ============================================================
async function pumpswapBuy({ outputMint, amountLamports, slippageBps = 1500, priorityMicroLamports = 1_000_000 }) {
    const baseMint = new PublicKey(outputMint);
    const solAmt   = amountLamports / LAMPORTS_PER_SOL;
    log.rpc(`[AMM] PumpSwap buy ${solAmt.toFixed(4)} SOL → ${baseMint.toBase58().slice(0, 8)}…`);

    const CONFIG = require('../config');
    const bufSol = CONFIG.MIN_SOL_BUFFER_SOL;
    const bal = await getSolBalance();
    if (bal < solAmt + bufSol) throw createSafeError(`SOL kurang: ${bal.toFixed(4)} (butuh ${(solAmt + bufSol).toFixed(4)})`, { code: 'INSUFFICIENT_FUNDS' });

    const pool = await findPool(baseMint);

    const gcPda   = pswapGlobalConfigPda();
    const eaPda   = eventAuthPda(PUMPSWAP_PROGRAM_ID);
    const gvPda   = globalVolPda(PUMPSWAP_PROGRAM_ID);
    const uvPda   = userVolPda(wallet.publicKey, PUMPSWAP_PROGRAM_ID);
    const fcPda   = pswapFeeConfigPda();

    const pswapConfig  = await fetchPswapConfig();
    const feeRecipient = pswapConfig.feeRecipients[0];
    const protoFeeAta  = await getAssociatedTokenAddress(WSOL_MINT, feeRecipient, false, TOKEN_PROGRAM_ID);

    const coinCreator = pool.coin_creator || pool.creator;
    const [ccVaultAuth] = PublicKey.findProgramAddressSync(
        [Buffer.from('creator_vault'), coinCreator.toBuffer()], PUMPSWAP_PROGRAM_ID
    );
    const ccVaultAta = await getAssociatedTokenAddress(WSOL_MINT, ccVaultAuth, true, TOKEN_PROGRAM_ID);

    const mintInfo     = await connection.getAccountInfo(baseMint);
    const baseTokenPrg = (mintInfo?.owner?.equals(TOKEN_2022_PROGRAM)) ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM_ID;
    const userBaseAta  = await getAssociatedTokenAddress(baseMint, wallet.publicKey, false, baseTokenPrg);
    const userQuoteAta = await getAssociatedTokenAddress(WSOL_MINT, wallet.publicKey, false, TOKEN_PROGRAM_ID);

    // Estimasi token out
    let baseAmountOut = 1n;
    try {
        const br = await connection.getTokenAccountBalance(pool.pool_base_token_account);
        const qr = await connection.getTokenAccountBalance(pool.pool_quote_token_account);
        const B  = BigInt(br.value.amount), Q = BigInt(qr.value.amount), I = BigInt(amountLamports);
        if (B > 0n && Q > 0n) {
            baseAmountOut = ((I * B) / (Q + I)) * BigInt(10000 - slippageBps) / 10000n;
            if (baseAmountOut < 1n) baseAmountOut = 1n;
        }
    } catch { /* fallback */ }

    const maxQuoteIn = BigInt(Math.floor(amountLamports * (1 + slippageBps / 10000)));

    const data = Buffer.alloc(24);
    DISC_BUY.copy(data, 0);
    data.writeBigUInt64LE(baseAmountOut, 8);
    data.writeBigUInt64LE(maxQuoteIn, 16);

    const prio = Math.max(1, Math.floor(priorityMicroLamports));
    const instructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 450_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: prio }),
    ];

    // Extend pool jika < 300 bytes
    if (pool.dataLen < 300) {
        const extDisc = Buffer.from([234, 102, 194, 203, 150, 72, 62, 229]);
        instructions.push(new TransactionInstruction({
            programId: PUMPSWAP_PROGRAM_ID,
            keys: [
                { pubkey: pool.pubkey,             isSigner: false, isWritable: true  },
                { pubkey: wallet.publicKey,        isSigner: true,  isWritable: true  },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                { pubkey: eaPda,                   isSigner: false, isWritable: false },
                { pubkey: PUMPSWAP_PROGRAM_ID,     isSigner: false, isWritable: false },
            ],
            data: extDisc,
        }));
    }

    // Buat ATAs jika perlu + wrap SOL
    if (!await connection.getAccountInfo(userBaseAta)) {
        instructions.push(createAssociatedTokenAccountInstruction(
            wallet.publicKey, userBaseAta, wallet.publicKey, baseMint, baseTokenPrg
        ));
    }
    if (!await connection.getAccountInfo(userQuoteAta)) {
        instructions.push(createAssociatedTokenAccountInstruction(
            wallet.publicKey, userQuoteAta, wallet.publicKey, WSOL_MINT
        ));
    }
    instructions.push(
        SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: userQuoteAta, lamports: amountLamports + 10_000 }),
        createSyncNativeInstruction(userQuoteAta)
    );

    instructions.push(new TransactionInstruction({
        programId: PUMPSWAP_PROGRAM_ID,
        keys: [
            { pubkey: pool.pubkey,                   isSigner: false, isWritable: true  }, // 0 MUTABLE
            { pubkey: wallet.publicKey,              isSigner: true,  isWritable: true  }, // 1
            { pubkey: gcPda,                         isSigner: false, isWritable: false }, // 2
            { pubkey: baseMint,                      isSigner: false, isWritable: false }, // 3
            { pubkey: WSOL_MINT,                     isSigner: false, isWritable: false }, // 4
            { pubkey: userBaseAta,                   isSigner: false, isWritable: true  }, // 5
            { pubkey: userQuoteAta,                  isSigner: false, isWritable: true  }, // 6
            { pubkey: pool.pool_base_token_account,  isSigner: false, isWritable: true  }, // 7
            { pubkey: pool.pool_quote_token_account, isSigner: false, isWritable: true  }, // 8
            { pubkey: feeRecipient,                  isSigner: false, isWritable: false }, // 9
            { pubkey: protoFeeAta,                   isSigner: false, isWritable: true  }, // 10
            { pubkey: baseTokenPrg,                  isSigner: false, isWritable: false }, // 11
            { pubkey: TOKEN_PROGRAM_ID,              isSigner: false, isWritable: false }, // 12
            { pubkey: SystemProgram.programId,       isSigner: false, isWritable: false }, // 13
            { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,   isSigner: false, isWritable: false }, // 14
            { pubkey: eaPda,                         isSigner: false, isWritable: false }, // 15
            { pubkey: PUMPSWAP_PROGRAM_ID,           isSigner: false, isWritable: false }, // 16
            { pubkey: ccVaultAta,                    isSigner: false, isWritable: true  }, // 17
            { pubkey: ccVaultAuth,                   isSigner: false, isWritable: false }, // 18
            { pubkey: gvPda,                         isSigner: false, isWritable: true  }, // 19
            { pubkey: uvPda,                         isSigner: false, isWritable: true  }, // 20
            { pubkey: fcPda,                         isSigner: false, isWritable: false }, // 21
            { pubkey: FEE_PROGRAM_ID,                isSigner: false, isWritable: false }, // 22
        ],
        data,
    }));

    return await sendTx(instructions, outputMint, solAmt, 'pumpswap_amm');
}

// ============================================================
// PUMPSWAP AMM SELL
// ============================================================
async function pumpswapSell({ inputMint, amountTokens, slippageBps = 1500, priorityMicroLamports = 1_000_000 }) {
    const baseMint = new PublicKey(inputMint);
    const pool     = await findPool(baseMint);

    const gcPda = pswapGlobalConfigPda();
    const eaPda = eventAuthPda(PUMPSWAP_PROGRAM_ID);
    const gvPda = globalVolPda(PUMPSWAP_PROGRAM_ID);
    const uvPda = userVolPda(wallet.publicKey, PUMPSWAP_PROGRAM_ID);
    const fcPda = pswapFeeConfigPda();

    const pswapConfig  = await fetchPswapConfig();
    const feeRecipient = pswapConfig.feeRecipients[0];
    const protoFeeAta  = await getAssociatedTokenAddress(WSOL_MINT, feeRecipient, false, TOKEN_PROGRAM_ID);

    const coinCreator = pool.coin_creator || pool.creator;
    const [ccVaultAuth] = PublicKey.findProgramAddressSync(
        [Buffer.from('creator_vault'), coinCreator.toBuffer()], PUMPSWAP_PROGRAM_ID
    );
    const ccVaultAta = await getAssociatedTokenAddress(WSOL_MINT, ccVaultAuth, true, TOKEN_PROGRAM_ID);

    const mintInfo     = await connection.getAccountInfo(baseMint);
    const baseTokenPrg = (mintInfo?.owner?.equals(TOKEN_2022_PROGRAM)) ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM_ID;
    const userBaseAta  = await getAssociatedTokenAddress(baseMint, wallet.publicKey, false, baseTokenPrg);
    const userQuoteAta = await getAssociatedTokenAddress(WSOL_MINT, wallet.publicKey, false, TOKEN_PROGRAM_ID);

    const baseAmountIn = BigInt(Math.floor(amountTokens * 1e6));
    const data = Buffer.alloc(24);
    DISC_SELL.copy(data, 0);
    data.writeBigUInt64LE(baseAmountIn, 8);
    data.writeBigUInt64LE(1n, 16);

    const prio = Math.max(1, Math.floor(priorityMicroLamports));
    const instructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 450_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: prio }),
    ];

    if (pool.dataLen < 300) {
        const extDisc = Buffer.from([234, 102, 194, 203, 150, 72, 62, 229]);
        instructions.push(new TransactionInstruction({
            programId: PUMPSWAP_PROGRAM_ID,
            keys: [
                { pubkey: pool.pubkey,             isSigner: false, isWritable: true  },
                { pubkey: wallet.publicKey,        isSigner: true,  isWritable: true  },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                { pubkey: eaPda,                   isSigner: false, isWritable: false },
                { pubkey: PUMPSWAP_PROGRAM_ID,     isSigner: false, isWritable: false },
            ],
            data: extDisc,
        }));
    }

    if (!await connection.getAccountInfo(userQuoteAta)) {
        instructions.push(createAssociatedTokenAccountInstruction(
            wallet.publicKey, userQuoteAta, wallet.publicKey, WSOL_MINT
        ));
    }

    instructions.push(new TransactionInstruction({
        programId: PUMPSWAP_PROGRAM_ID,
        keys: [
            { pubkey: pool.pubkey,                   isSigner: false, isWritable: true  },
            { pubkey: wallet.publicKey,              isSigner: true,  isWritable: true  },
            { pubkey: gcPda,                         isSigner: false, isWritable: false },
            { pubkey: baseMint,                      isSigner: false, isWritable: false },
            { pubkey: WSOL_MINT,                     isSigner: false, isWritable: false },
            { pubkey: userBaseAta,                   isSigner: false, isWritable: true  },
            { pubkey: userQuoteAta,                  isSigner: false, isWritable: true  },
            { pubkey: pool.pool_base_token_account,  isSigner: false, isWritable: true  },
            { pubkey: pool.pool_quote_token_account, isSigner: false, isWritable: true  },
            { pubkey: feeRecipient,                  isSigner: false, isWritable: false },
            { pubkey: protoFeeAta,                   isSigner: false, isWritable: true  },
            { pubkey: baseTokenPrg,                  isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID,              isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId,       isSigner: false, isWritable: false },
            { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,   isSigner: false, isWritable: false },
            { pubkey: eaPda,                         isSigner: false, isWritable: false },
            { pubkey: PUMPSWAP_PROGRAM_ID,           isSigner: false, isWritable: false },
            { pubkey: ccVaultAta,                    isSigner: false, isWritable: true  },
            { pubkey: ccVaultAuth,                   isSigner: false, isWritable: false },
            { pubkey: gvPda,                         isSigner: false, isWritable: true  },
            { pubkey: uvPda,                         isSigner: false, isWritable: true  },
            { pubkey: fcPda,                         isSigner: false, isWritable: false },
            { pubkey: FEE_PROGRAM_ID,                isSigner: false, isWritable: false },
        ],
        data,
    }));

    // Unwrap WSOL → SOL
    instructions.push(createCloseAccountInstruction(userQuoteAta, wallet.publicKey, wallet.publicKey));

    log.rpc(`[AMM] PumpSwap sell ${amountTokens.toFixed(2)} tok`);
    const solBefore = await getSolBalance();
    let txid = null;
    try {
        const tx = new Transaction().add(...instructions);
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        tx.feePayer = wallet.publicKey;
        txid = await sendAndConfirmTransaction(connection, tx, [wallet], {
            commitment: 'confirmed', maxRetries: 3, skipPreflight: true,
        });
        await sleep(2000);
        const solReceived = Math.max(0, (await getSolBalance()) - solBefore);
        return { txid, outputAmount: solReceived, isSimulation: false, route: 'pumpswap_amm' };
    } catch (err) {
        throw createSafeError(err?.message || String(err), { logs: err?.logs || [], txid, code: 'PSWAP_SELL_ERR' });
    }
}

// ============================================================
// JUPITER FALLBACK
// ============================================================
async function jupiterBuy({ outputMint, amountLamports, slippageBps }) {
    log.jupiter('Fallback buy…');
    const { data: q } = await axios.get('https://api.jup.ag/swap/v1/quote', {
        params: { inputMint: SOL_MINT, outputMint, amount: amountLamports, slippageBps }, timeout: 10_000,
    });
    const { data: s } = await axios.post('https://api.jup.ag/swap/v1/swap', {
        quoteResponse: q, userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto',
    }, { timeout: 15_000 });

    const { VersionedTransaction } = require('@solana/web3.js');
    const tx = VersionedTransaction.deserialize(Buffer.from(s.swapTransaction, 'base64'));
    tx.sign([wallet]);
    const txid = await connection.sendTransaction(tx, { maxRetries: 3 });
    await connection.confirmTransaction(txid, 'confirmed');
    await sleep(2000);
    const tokensOut = await getBalance(outputMint).catch(() => 0);
    return { txid, inputAmount: amountLamports / LAMPORTS_PER_SOL, outputAmount: tokensOut, isSimulation: false, route: 'jupiter' };
}

async function jupiterSell({ inputMint, amountTokens, slippageBps }) {
    log.jupiter('Fallback sell…');
    const amount = Math.floor(amountTokens * 1e6);
    const { data: q } = await axios.get('https://api.jup.ag/swap/v1/quote', {
        params: { inputMint, outputMint: SOL_MINT, amount, slippageBps }, timeout: 10_000,
    });
    const { data: s } = await axios.post('https://api.jup.ag/swap/v1/swap', {
        quoteResponse: q, userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto',
    }, { timeout: 15_000 });

    const { VersionedTransaction } = require('@solana/web3.js');
    const tx = VersionedTransaction.deserialize(Buffer.from(s.swapTransaction, 'base64'));
    tx.sign([wallet]);
    const solBefore = await getSolBalance();
    const txid = await connection.sendTransaction(tx, { maxRetries: 3 });
    await connection.confirmTransaction(txid, 'confirmed');
    await sleep(2000);
    return { txid, outputAmount: Math.max(0, (await getSolBalance()) - solBefore), isSimulation: false, route: 'jupiter' };
}

// ============================================================
// HELPERS: Fee recipient, PumpSwap config, Pool finder
// ============================================================
let _cachedGlobalDecoded = null;
let _cachedGlobalAt      = 0;
const GLOBAL_CACHE_MS    = 60_000;
const FALLBACK_FEE_RECIPIENT = new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV');

async function getFeeRecipient({ mayhemMode = false } = {}) {
    if (!connection) return FALLBACK_FEE_RECIPIENT;
    const now = Date.now();
    let global;
    try {
        if (_cachedGlobalDecoded && now - _cachedGlobalAt < GLOBAL_CACHE_MS) {
            global = _cachedGlobalDecoded;
        } else {
            const info = await connection.getAccountInfo(GLOBAL_STATE_PDA);
            if (!info?.data?.length) return FALLBACK_FEE_RECIPIENT;
            global = PUMP_SDK.decodeGlobal(info);
            _cachedGlobalDecoded = global;
            _cachedGlobalAt      = now;
        }
        if (mayhemMode) {
            const r = [global.reservedFeeRecipient, ...(global.reservedFeeRecipients || [])];
            if (r.length) return r[Math.floor(Math.random() * r.length)];
        }
        const r = [global.feeRecipient, ...(global.feeRecipients || [])];
        if (r.length) return r[Math.floor(Math.random() * r.length)];
    } catch { /* fallthrough */ }
    return FALLBACK_FEE_RECIPIENT;
}

let _pswapConfig = null;
async function fetchPswapConfig() {
    if (_pswapConfig) return _pswapConfig;
    try {
        const info = await connection.getAccountInfo(pswapGlobalConfigPda());
        if (info?.data?.length >= 312) {
            const d = info.data, recipients = [];
            for (let i = 0; i < 8; i++) recipients.push(new PublicKey(d.slice(56 + i * 32, 88 + i * 32)));
            _pswapConfig = { feeRecipients: recipients };
            return _pswapConfig;
        }
    } catch { /* fallback */ }
    _pswapConfig = { feeRecipients: [new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV')] };
    return _pswapConfig;
}

async function findPool(baseMint) {
    const MIGRATION_AUTH = new PublicKey('39azUYFWPz3VHgKCf3VChL9EXLZM5JaL1GCKZiL1GJ35');
    const idxBuf = Buffer.alloc(2);
    idxBuf.writeUInt16LE(0);
    const [poolPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('pool'), idxBuf, MIGRATION_AUTH.toBuffer(), baseMint.toBuffer(), WSOL_MINT.toBuffer()],
        PUMPSWAP_PROGRAM_ID
    );
    const info = await connection.getAccountInfo(poolPda);
    if (info) return parsePool(poolPda, info.data);

    try {
        const { data } = await axios.get(
            `https://api.dexscreener.com/latest/dex/tokens/${baseMint.toBase58()}`, { timeout: 8_000 }
        );
        const pair = (data?.pairs || []).find(p => ['pumpswap','pump'].includes(p.dexId));
        if (pair?.pairAddress) {
            const pKey = new PublicKey(pair.pairAddress);
            const pInfo = await connection.getAccountInfo(pKey);
            if (pInfo) return parsePool(pKey, pInfo.data);
        }
    } catch { /* ignore */ }

    throw createSafeError(`Pool tidak ditemukan: ${baseMint.toBase58().slice(0, 8)}`, { code: 'POOL_NOT_FOUND' });
}

function parsePool(pubkey, d) {
    let o = 8 + 1 + 2; // disc + bump + index
    const creator              = new PublicKey(d.slice(o, o+32)); o+=32;
    const base_mint            = new PublicKey(d.slice(o, o+32)); o+=32;
    const quote_mint           = new PublicKey(d.slice(o, o+32)); o+=32;
    const lp_mint              = new PublicKey(d.slice(o, o+32)); o+=32;
    const pool_base_token_account  = new PublicKey(d.slice(o, o+32)); o+=32;
    const pool_quote_token_account = new PublicKey(d.slice(o, o+32)); o+=32;
    o += 8; // lp_supply
    const coin_creator = d.length >= o+32 ? new PublicKey(d.slice(o, o+32)) : null;
    return { pubkey, creator, base_mint, quote_mint, lp_mint, pool_base_token_account, pool_quote_token_account, coin_creator, dataLen: d.length };
}

// ============================================================
// SEND TX HELPER (+ retry jika blockhash kedaluwarsa)
// ============================================================
function _isBlockhashExpiredError(err) {
    const m = err?.message || String(err);
    return m.includes('expired') || m.includes('block height exceeded') || m.includes('Block height exceeded');
}

async function sendAndConfirmFresh(instructions, route) {
    const confirmOpts = {
        commitment: 'confirmed', maxRetries: 5, skipPreflight: true,
    };
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const tx = new Transaction().add(...instructions);
            const { blockhash } = await connection.getLatestBlockhash('confirmed');
            tx.recentBlockhash = blockhash;
            tx.feePayer = wallet.publicKey;
            return await sendAndConfirmTransaction(connection, tx, [wallet], confirmOpts);
        } catch (err) {
            lastErr = err;
            if (attempt === 0 && _isBlockhashExpiredError(err)) {
                log.slot(`[${route}] Blockhash kedaluwarsa — kirim ulang`);
                continue;
            }
            throw err;
        }
    }
    throw lastErr;
}

async function sendTx(instructions, outputMint, solAmt, route) {
    let txid = null;
    try {
        txid = await sendAndConfirmFresh(instructions, route);
        log.txOk(`[${route}] ${txid.slice(0, 8)}…`);
        await sleep(2000);
        const tokensOut = await getBalance(outputMint).catch(() => 0);
        return { txid, inputAmount: solAmt, outputAmount: tokensOut, isSimulation: false, route };
    } catch (err) {
        let logs = err?.logs;
        if (logs == null && typeof err?.getLogs === 'function') {
            try {
                logs = await err.getLogs(connection);
            } catch {
                logs = [];
            }
        }
        const msg = err?.message || String(err);
        if (Array.isArray(logs) && logs.length) {
            const preview = logs.slice(0, 8).join('\n   ');
            log.txErr(`[${route}] program logs:\n   ${preview}${logs.length > 8 ? '\n   …' : ''}`);
        }
        log.txErr(`[${route}] FAILED: ${msg}`);
        throw createSafeError(msg, { logs: Array.isArray(logs) ? logs : [], txid, code: 'TX_ERROR' });
    }
}

// ============================================================
// SIMULASI = DRY-RUN QUOTE (proses routing sama persis; tanpa kirim TX)
// Buy/sell nyata bisa sedikit beda karena slippage & antrian; tidak ada jaminan profit.
// ============================================================
async function quoteBondingCurveBuyUi(outputMint, amountLamports) {
    const mint    = new PublicKey(outputMint);
    const mintStr = mint.toBase58().slice(0, 8) + '...';

    let mintInfo = null;
    for (let i = 0; i < 20; i++) {
        mintInfo = await connection.getAccountInfo(mint);
        if (mintInfo) break;
        await sleep(400);
    }
    if (!mintInfo) throw createSafeError(`Token belum ada: ${mintStr}`, { code: 'TOKEN_NOT_FOUND' });

    const bc = await fetchBondingCurve(outputMint);
    if (bc.complete) {
        throw createSafeError('Bonding curve graduated / selesai', { code: 'GRADUATED' });
    }

    const bcPda = bondingCurvePda(mint);
    const fcPda = feeConfigPda();

    const globalInfo = await connection.getAccountInfo(GLOBAL_STATE_PDA);
    if (!globalInfo?.data) {
        throw createSafeError('Global pump state tidak ditemukan', { code: 'GLOBAL_NOT_FOUND' });
    }

    let global;
    try {
        global = PUMP_SDK.decodeGlobal(globalInfo);
    } catch (e) {
        throw createSafeError(`Decode global gagal: ${e?.message || e}`, { code: 'GLOBAL_DECODE' });
    }

    const bcFresh = await connection.getAccountInfo(bcPda);
    if (!bcFresh?.data?.length) {
        throw createSafeError(`Bonding curve tidak ada: ${mintStr}`, { code: 'BC_NOT_FOUND' });
    }

    let bondingCurveDecoded;
    try {
        bondingCurveDecoded = PUMP_SDK.decodeBondingCurve(bcFresh);
    } catch (e) {
        throw createSafeError(`Decode BC fresh gagal: ${e?.message || e}`, { code: 'BC_DECODE' });
    }
    if (bondingCurveDecoded.complete) {
        throw createSafeError('Bonding curve graduated (saat quote)', { code: 'GRADUATED' });
    }

    let feeConfig = null;
    try {
        const fcInfo = await connection.getAccountInfo(fcPda);
        if (fcInfo?.data) feeConfig = PUMP_SDK.decodeFeeConfig(fcInfo);
    } catch { /* optional */ }

    const spendBn = new BN(amountLamports);
    const expectedTokens = getBuyTokenAmountFromSolAmount({
        global,
        feeConfig,
        mintSupply: bondingCurveDecoded.tokenTotalSupply,
        bondingCurve: bondingCurveDecoded,
        amount: spendBn,
    });
    if (expectedTokens.lten(0)) {
        throw createSafeError('Quote token = 0', { code: 'ZERO_QUOTE' });
    }

    return Number(expectedTokens.toString()) / 1e6;
}

async function quoteBondingCurveSellSol(inputMint, amountTokens) {
    const mint    = new PublicKey(inputMint);
    const mintStr = mint.toBase58().slice(0, 8) + '...';

    const bc    = await fetchBondingCurve(inputMint);
    const bcPda = bondingCurvePda(mint);
    const fcPda = feeConfigPda();

    const bcAcc = bc.accountInfo || await connection.getAccountInfo(bcPda);
    if (!bcAcc?.data?.length) {
        throw createSafeError(`Bonding curve tidak ada: ${mintStr}`, { code: 'BC_NOT_FOUND' });
    }

    const globalInfo = await connection.getAccountInfo(GLOBAL_STATE_PDA);
    if (!globalInfo?.data) {
        throw createSafeError('Global pump state tidak ditemukan', { code: 'GLOBAL_NOT_FOUND' });
    }

    let global;
    try {
        global = PUMP_SDK.decodeGlobal(globalInfo);
    } catch (e) {
        throw createSafeError(`Decode global gagal: ${e?.message || e}`, { code: 'GLOBAL_DECODE' });
    }

    let bondingCurveDecoded;
    try {
        bondingCurveDecoded = PUMP_SDK.decodeBondingCurve(bcAcc);
    } catch (e) {
        throw createSafeError(`Decode bonding curve gagal: ${e?.message || e}`, { code: 'BC_DECODE' });
    }

    let feeConfig = null;
    try {
        const fcInfo = await connection.getAccountInfo(fcPda);
        if (fcInfo?.data) feeConfig = PUMP_SDK.decodeFeeConfig(fcInfo);
    } catch { /* optional */ }

    const amountBn = new BN(Math.floor(amountTokens * 1e6));
    const expectedSolLamports = getSellSolAmountFromTokenAmount({
        global,
        feeConfig,
        mintSupply: bondingCurveDecoded.tokenTotalSupply,
        bondingCurve: bondingCurveDecoded,
        amount: amountBn,
    });

    return Math.max(0, Number(expectedSolLamports.toString()) / LAMPORTS_PER_SOL);
}

async function quotePumpSwapBuyUi(outputMint, amountLamports, slippageBps = 1500) {
    const baseMint = new PublicKey(outputMint);
    const pool     = await findPool(baseMint);
    const br       = await connection.getTokenAccountBalance(pool.pool_base_token_account);
    const qr       = await connection.getTokenAccountBalance(pool.pool_quote_token_account);
    const B        = BigInt(br.value.amount);
    const Q        = BigInt(qr.value.amount);
    const I        = BigInt(amountLamports);
    if (B <= 0n || Q <= 0n) throw createSafeError('Pool kosong', { code: 'POOL_EMPTY' });
    let baseAmountOut = ((I * B) / (Q + I)) * BigInt(10000 - Math.min(Math.max(0, slippageBps), 9999)) / 10000n;
    if (baseAmountOut < 1n) baseAmountOut = 1n;
    return Number(baseAmountOut) / 1e6;
}

async function quotePumpSwapSellSol(inputMint, amountTokens, slippageBps = 1500) {
    const baseMint = new PublicKey(inputMint);
    const pool     = await findPool(baseMint);
    const br       = await connection.getTokenAccountBalance(pool.pool_base_token_account);
    const qr       = await connection.getTokenAccountBalance(pool.pool_quote_token_account);
    const B        = BigInt(br.value.amount);
    const Q        = BigInt(qr.value.amount);
    const baseIn   = BigInt(Math.floor(amountTokens * 1e6));
    if (B <= 0n || Q <= 0n || baseIn <= 0n) throw createSafeError('Pool/sell invalid', { code: 'POOL_EMPTY' });
    const quoteOut = (baseIn * Q) / (B + baseIn);
    const adj      = quoteOut * BigInt(10000 - Math.min(Math.max(0, slippageBps), 9999)) / 10000n;
    return Math.max(0, Number(adj) / LAMPORTS_PER_SOL);
}

function _jupiterOutTokenUi(q) {
    if (!q?.outAmount) return 0;
    const raw = BigInt(q.outAmount);
    const dec = Number(q.outputMintInfo?.decimals ?? q.outDecimals ?? 6);
    return Number(raw) / 10 ** dec;
}

function _jupiterOutSol(q) {
    if (!q?.outAmount) return 0;
    return Number(BigInt(q.outAmount)) / LAMPORTS_PER_SOL;
}

async function quoteJupiterBuyUi(outputMint, amountLamports, slippageBps = 1500) {
    const { data: q } = await axios.get('https://api.jup.ag/swap/v1/quote', {
        params: { inputMint: SOL_MINT, outputMint, amount: amountLamports, slippageBps },
        timeout: 12_000,
    });
    if (!q?.outAmount) throw createSafeError('Jupiter quote buy kosong', { code: 'JUP_QUOTE' });
    const ui = _jupiterOutTokenUi(q);
    if (ui <= 0) throw createSafeError('Jupiter quote buy = 0', { code: 'JUP_QUOTE' });
    return ui;
}

async function quoteJupiterSellSol(inputMint, amountTokens, slippageBps = 1500) {
    const amount = Math.floor(amountTokens * 1e6);
    const { data: q } = await axios.get('https://api.jup.ag/swap/v1/quote', {
        params: { inputMint, outputMint: SOL_MINT, amount, slippageBps },
        timeout: 12_000,
    });
    if (!q?.outAmount) throw createSafeError('Jupiter quote sell kosong', { code: 'JUP_QUOTE' });
    const sol = _jupiterOutSol(q);
    if (sol <= 0) throw createSafeError('Jupiter quote sell = 0', { code: 'JUP_QUOTE' });
    return sol;
}

async function executeSwapSimulated({ outputMint, amountLamports, slippageBps = 1500 }) {
    const CONFIG = require('../config');
    const impactBps = CONFIG.SIM_EXTRA_IMPACT_BPS || 0;
    const solAmt = amountLamports / LAMPORTS_PER_SOL;
    const txid   = `sim_${Date.now().toString(36)}`;
    const graduated = await isGraduated(outputMint);

    if (!graduated) {
        try {
            const rawTok = await quoteBondingCurveBuyUi(outputMint, amountLamports);
            const tokensUi = applySimExtraImpact(rawTok, impactBps);
            log.sim(`Quote BC buy → ${tokensUi.toFixed(2)} tok | ${outputMint.slice(0, 8)}…`);
            return { txid, inputAmount: solAmt, outputAmount: tokensUi, isSimulation: true, route: 'bonding_curve' };
        } catch (e) {
            const code = e?.code || '';
            const msg  = e?.message || '';
            if (code !== 'GRADUATED' && !String(msg).includes('GRADUATED')) throw e;
            log.sim('BC graduated saat quote → AMM/Jupiter');
        }
    }

    try {
        const rawTok = await quotePumpSwapBuyUi(outputMint, amountLamports, slippageBps);
        if (rawTok > 0) {
            const tokensUi = applySimExtraImpact(rawTok, impactBps);
            log.sim(`Quote PumpSwap buy → ${tokensUi.toFixed(2)} tok`);
            return { txid, inputAmount: solAmt, outputAmount: tokensUi, isSimulation: true, route: 'pumpswap_amm' };
        }
    } catch (e) {
        log.warn(`[SIM] PumpSwap quote: ${e?.message?.slice(0, 72) || e}`);
    }

    const rawJ = await quoteJupiterBuyUi(outputMint, amountLamports, slippageBps);
    const tokensUi = applySimExtraImpact(rawJ, impactBps);
    log.sim(`Quote Jupiter buy → ${tokensUi.toFixed(2)} tok`);
    return { txid, inputAmount: solAmt, outputAmount: tokensUi, isSimulation: true, route: 'jupiter' };
}

async function executeSellSimulated({ inputMint, amountTokens, slippageBps = 1500 }) {
    const CONFIG = require('../config');
    const impactBps = CONFIG.SIM_EXTRA_IMPACT_BPS || 0;
    const txid = `sim_sell_${Date.now().toString(36)}`;

    const balance = await getBalance(inputMint);
    if (balance <= 0) {
        const e = new Error('Saldo token 0');
        e.logs = [];
        throw e;
    }
    const actualSell = Math.min(amountTokens, balance);
    const graduated  = await isGraduated(inputMint);

    if (!graduated) {
        try {
            const rawSol = await quoteBondingCurveSellSol(inputMint, actualSell);
            const solOut = applySimExtraImpact(rawSol, impactBps);
            log.sim(`Quote BC sell → ${solOut.toFixed(6)} SOL`);
            return { txid, outputAmount: solOut, isSimulation: true, route: 'bonding_curve' };
        } catch (e) {
            const code = e?.code || '';
            const msg  = e?.message || '';
            if (code !== 'GRADUATED' && !String(msg).includes('GRADUATED')) throw e;
            log.sim('BC graduated saat sell quote → AMM/Jupiter');
        }
    }

    try {
        const rawSol = await quotePumpSwapSellSol(inputMint, actualSell, slippageBps);
        if (rawSol > 0) {
            const solOut = applySimExtraImpact(rawSol, impactBps);
            log.sim(`Quote PumpSwap sell → ${solOut.toFixed(6)} SOL`);
            return { txid, outputAmount: solOut, isSimulation: true, route: 'pumpswap_amm' };
        }
    } catch (e) {
        log.warn(`[SIM] PumpSwap sell quote: ${e?.message?.slice(0, 72) || e}`);
    }

    const rawJ = await quoteJupiterSellSol(inputMint, actualSell, slippageBps);
    const solOut = applySimExtraImpact(rawJ, impactBps);
    log.sim(`Quote Jupiter sell → ${solOut.toFixed(6)} SOL`);
    return { txid, outputAmount: solOut, isSimulation: true, route: 'jupiter' };
}

// ============================================================
// HARGA TOKEN
// ============================================================
async function getTokenPriceInSol(mintAddress) {
    const solPrice = require('../config/state').currentSolPrice;
    if (!solPrice || solPrice <= 0) return null;
    try {
        const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`, { timeout: 6_000 });
        const pair = data?.pairs?.[0];
        if (pair?.priceUsd) return parseFloat(pair.priceUsd) / solPrice;
    } catch { /* next */ }
    try {
        const { data } = await axios.get(`https://api.jup.ag/price/v2?ids=${mintAddress}`, { timeout: 6_000 });
        const price = data?.data?.[mintAddress]?.price;
        if (price) return parseFloat(price) / solPrice;
    } catch { /* ignore */ }
    return null;
}

/** Mark harga SOL/token: BC dari quote SDK (realtime on-chain), atau DexScreener/Jupiter jika sudah graduate. */
async function getSpotSolPerToken(mintAddress) {
    const graduated = await isGraduated(mintAddress).catch(() => true);
    if (!graduated) {
        try {
            const probeLamports = 150_000; // ~0.00015 SOL — cukup untuk marginal price tanpa membebani kurva
            const tokensUi = await quoteBondingCurveBuyUi(mintAddress, probeLamports);
            if (tokensUi > 0) return (probeLamports / LAMPORTS_PER_SOL) / tokensUi;
        } catch { /* race graduate / RPC */ }
    }
    return getTokenPriceInSol(mintAddress);
}

// ============================================================
// MAIN APIs — AUTO ROUTER
// ============================================================
async function executeSwap({ outputMint, amountLamports, slippageBps = 1500, isSimulation = false, priorityMicroLamports } = {}) {
    if (!connection || !wallet) throw createSafeError('pumpClient belum init', { code: 'NOT_INIT' });
    const solAmt = amountLamports / LAMPORTS_PER_SOL;

    if (isSimulation) {
        return executeSwapSimulated({ outputMint, amountLamports, slippageBps });
    }

    const CONFIG = require('../config');
    const prio = (priorityMicroLamports != null && priorityMicroLamports > 0)
        ? Math.floor(priorityMicroLamports)
        : CONFIG.PRIORITY_MICRO_LAMPORTS_DEFAULT;

    const graduated = await isGraduated(outputMint);
    log.rpc(`${outputMint.slice(0, 8)}… | graduate: ${graduated}`);

    if (!graduated) return await bondingCurveBuy({ outputMint, amountLamports, slippageBps, priorityMicroLamports: prio });

    try {
        return await pumpswapBuy({ outputMint, amountLamports, slippageBps, priorityMicroLamports: prio });
    } catch (e) {
        const msg = e?.message || '';
        if (msg.includes('INSUFFICIENT_FUNDS') || msg.includes('POOL_NOT_FOUND')) throw e;
        log.warn(`PumpSwap gagal → Jupiter: ${msg.slice(0, 80)}`);
        return await jupiterBuy({ outputMint, amountLamports, slippageBps });
    }
}

async function executeSell({ inputMint, amountTokens, slippageBps = 1500, isSimulation = false, priorityMicroLamports } = {}) {
    if (!connection || !wallet) throw new Error('pumpClient belum init');

    if (isSimulation) {
        return executeSellSimulated({ inputMint, amountTokens, slippageBps });
    }

    const CONFIG = require('../config');
    const prio = (priorityMicroLamports != null && priorityMicroLamports > 0)
        ? Math.floor(priorityMicroLamports)
        : CONFIG.PRIORITY_MICRO_LAMPORTS_DEFAULT;

    const balance = await getBalance(inputMint);
    if (balance <= 0) { const e = new Error('Saldo token 0'); e.logs = []; throw e; }

    const actualSell = Math.min(amountTokens, balance);
    const graduated  = await isGraduated(inputMint);
    log.rpc(`Sell ${inputMint.slice(0, 8)}… | graduate: ${graduated}`);

    if (!graduated) return await bondingCurveSell({ inputMint, amountTokens: actualSell, slippageBps, priorityMicroLamports: prio });

    try {
        return await pumpswapSell({ inputMint, amountTokens: actualSell, slippageBps, priorityMicroLamports: prio });
    } catch (e) {
        log.warn(`PumpSwap sell → Jupiter: ${e?.message?.slice(0, 80)}`);
        return await jupiterSell({ inputMint, amountTokens: actualSell, slippageBps });
    }
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
    init, getWalletAddress, getSolBalance, getBalance,
    getTokenPriceInSol, getSpotSolPerToken, executeSwap, executeSell, isGraduated,
    SOL_MINT, createSafeError,
};