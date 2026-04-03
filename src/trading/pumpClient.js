'use strict';
// ============================================================
// PUMP CLIENT — Tanpa pumpdotfun-sdk
// Menggunakan @solana/web3.js langsung + DexScreener untuk harga
// Kompatibel dengan Pump.fun bonding curve & PumpSwap (AMM baru)
// ============================================================

const {
    Connection, Keypair, PublicKey, Transaction,
    SystemProgram, LAMPORTS_PER_SOL,
    TransactionInstruction, ComputeBudgetProgram,
    sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {
    getAssociatedTokenAddress,
    createAssociatedTokenAccountInstruction,
    TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SYSVAR_RENT_PUBKEY
} = require('@solana/spl-token');
const axios = require('axios');
const bs58  = require('bs58').default || require('bs58');

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Pump.fun Program IDs
const PUMP_PROGRAM_ID    = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_FEE_RECIPIENT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgznyQHeP2FN93ViVuPMkR');
const GLOBAL_STATE_PDA   = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
const EVENT_AUTH_PDA     = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');

let connection    = null;
let wallet        = null;

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
    else throw new Error(`Private key salah ukuran: ${secretKey.length} bytes`);

    console.log(`🔑 Wallet: ${wallet.publicKey.toBase58()}`);
    return wallet.publicKey.toBase58();
}

function getWalletAddress() { return wallet?.publicKey?.toBase58() || null; }

// ============================================================
// BALANCES
// ============================================================
async function getSolBalance() {
    if (!connection || !wallet) throw new Error('pumpClient belum init');
    const lamports = await connection.getBalance(wallet.publicKey);
    return lamports / LAMPORTS_PER_SOL;
}

async function getBalance(mintAddress) {
    if (!connection || !wallet) throw new Error('pumpClient belum init');
    if (mintAddress === SOL_MINT) return getSolBalance();

    try {
        const mint   = new PublicKey(mintAddress);
        const ata    = await getAssociatedTokenAddress(mint, wallet.publicKey);
        const info   = await connection.getTokenAccountBalance(ata);
        return info?.value?.uiAmount || 0;
    } catch {
        return 0;
    }
}

// ============================================================
// HARGA TOKEN
// ============================================================
async function getTokenPriceInSol(mintAddress) {
    const solPrice = require('../config/state').currentSolPrice;
    if (!solPrice || solPrice <= 0) return null;

    try {
        const { data } = await axios.get(
            `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`,
            { timeout: 6_000 }
        );
        const pair = data?.pairs?.[0];
        if (pair?.priceUsd) {
            return parseFloat(pair.priceUsd) / solPrice;
        }
    } catch { /* lanjut ke fallback */ }

    try {
        const { data } = await axios.get(
            `https://price.jup.ag/v6/price?ids=${mintAddress}&vsToken=So11111111111111111111111111111111111111112`,
            { timeout: 6_000 }
        );
        const price = data?.data?.[mintAddress]?.price;
        if (price) return parseFloat(price);
    } catch { /* ignore */ }

    return null;
}
// ============================================================
// ULTRA SAFE ERROR HANDLER
// ============================================================
function createSafeError(message, details = {}) {
    const safeError = new Error(message);
    safeError.logs = Array.isArray(details.logs) ? details.logs : ['Transaction error'];
    safeError.txid = details.txid || null;
    safeError.mint = details.mint || null;
    safeError.code = details.code || 'UNKNOWN';
    safeError.message = message; // Force string
    safeError.toString = () => message; // OVERRIDE toString()
    return safeError;
}

// ============================================================
// FIXED executeSwap - BULLETPROOF
// ============================================================
async function executeSwap({ outputMint, amountLamports, slippageBps = 1500, isSimulation = false }) {
    if (!connection || !wallet) {
        throw createSafeError('pumpClient belum init', { code: 'NOT_INIT' });
    }

    const solAmount = amountLamports / LAMPORTS_PER_SOL;
    const mint = new PublicKey(outputMint);
    const mintStr = mint.toBase58().slice(0, 8) + '...';

    if (isSimulation) {
        return {
            txid: `sim_${Date.now()}`,
            inputAmount: solAmount,
            outputAmount: Math.floor(solAmount * 1000 * (0.8 + Math.random() * 0.4)),
            isSimulation: true,
        };
    }

    console.log(`🔍 [${mintStr}] Smart polling token...`);
    
    // SAFE MINT CHECK
    let mintInfo;
    try {
        for (let i = 0; i < 15; i++) {
            mintInfo = await connection.getAccountInfo(mint);
            if (mintInfo?.owner?.equals(TOKEN_PROGRAM_ID)) {
                console.log(`✅ [${mintStr}] Token ready!`);
                await new Promise(r => setTimeout(r, 1000));
                break;
            }
            await new Promise(r => setTimeout(r, 400));
        }
    } catch (e) {
        throw createSafeError(`Mint check failed: ${e?.message || 'unknown'}`, {
            code: 'MINT_ERROR',
            mint: mint.toBase58()
        });
    }

    if (!mintInfo) {
        throw createSafeError('Token tidak terdeteksi setelah 6 detik', {
            code: 'TOKEN_NOT_FOUND',
            mint: mint.toBase58()
        });
    }

    // SAFE BALANCE CHECK
    let balance;
    try {
        balance = await getSolBalance();
    } catch (e) {
        throw createSafeError('Gagal cek saldo SOL', { code: 'BALANCE_ERROR' });
    }

    if (balance < solAmount + 0.015) {
        throw createSafeError(
            `Saldo kurang: ${balance.toFixed(4)} SOL (butuh ${(solAmount + 0.015).toFixed(4)})`, 
            { code: 'INSUFFICIENT_FUNDS' }
        );
    }

    // BUILD TX - SAFE
    const buyerAta = await getAssociatedTokenAddress(mint, wallet.publicKey);
    const instructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 })
    ];

    try {
        const ataInfo = await connection.getAccountInfo(buyerAta);
        if (!ataInfo) {
            instructions.push(createAssociatedTokenAccountInstruction(
                wallet.publicKey, buyerAta, wallet.publicKey, mint
            ));
        }
    } catch (e) {
        console.warn(`⚠️ ATA creation skipped: ${e.message}`);
    }

    // Bonding curve PDAs
    const [bondingCurvePda] = PublicKey.findProgramAddressSync(
        [Buffer.from('bonding-curve'), mint.toBuffer()], PUMP_PROGRAM_ID
    );
    const [bondingCurveAtaPda] = PublicKey.findProgramAddressSync(
        [bondingCurvePda.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], 
        ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const minTokenOut = BigInt(Math.floor(1000 * (1 - slippageBps / 10000)));
    const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
    const dataBuffer = Buffer.alloc(24);
    BUY_DISCRIMINATOR.copy(dataBuffer, 0);
    dataBuffer.writeBigUInt64LE(minTokenOut, 8);
    dataBuffer.writeBigUInt64LE(BigInt(amountLamports), 16);

    instructions.push(new TransactionInstruction({
        programId: PUMP_PROGRAM_ID,
        keys: [
            { pubkey: GLOBAL_STATE_PDA, isSigner: false, isWritable: false },
            { pubkey: PUMP_FEE_RECIPIENT, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: bondingCurvePda, isSigner: false, isWritable: true },
            { pubkey: bondingCurveAtaPda, isSigner: false, isWritable: true },
            { pubkey: buyerAta, isSigner: false, isWritable: true },
            { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: EVENT_AUTH_PDA, isSigner: false, isWritable: false },
            { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: dataBuffer,
    }));

    const tx = new Transaction().add(...instructions);

    // BULLETPROOF TX EXECUTION v2.0
let txid = null;
try {
    console.log(`🚀 [${mintStr}] Broadcasting ${solAmount.toFixed(4)} SOL...`);
    
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;

    // 🔥 ULTRA SAFE sendAndConfirmTransaction
    txid = await sendAndConfirmTransaction(connection, tx, [wallet], {
        commitment: 'confirmed',
        maxRetries: 3,
        skipPreflight: true,
    });

    console.log(`✅ [${mintStr}] SUCCESS: ${txid ? txid.slice(0, 8) + '...' : 'unknown'}`);
    
    await new Promise(r => setTimeout(r, 2000));
    const tokensOut = await getBalance(outputMint).catch(() => 0);

    return {
        txid: txid || 'unknown',
        inputAmount: solAmount,
        outputAmount: tokensOut,
        isSimulation: false,
        mint: outputMint
    };

} catch (rawError) {
    // 🛡️ ABSOLUTE FAILSAFE v2 - NO CRASH EVER
    console.error(`❌ [${mintStr}] Raw error object:`, rawError);
    
    let errorMessage = 'Transaction failed';
    let errorLogs = [];
    
    try {
        // SAFE ERROR EXTRACTION
        if (rawError) {
            if (typeof rawError === 'object') {
                errorMessage = rawError.message || 
                              (rawError.toString && rawError.toString()) || 
                              JSON.stringify(rawError).slice(0, 200);
                errorLogs = Array.isArray(rawError.logs) ? rawError.logs : [];
            } else {
                errorMessage = rawError.toString();
            }
        }
    } catch (parseErr) {
        errorMessage = 'Error parsing failed (corrupted RPC response)';
        console.error('Parse error:', parseErr);
    }
    
    console.error(`❌ [${mintStr}] FINAL ERROR: ${errorMessage}`);
    
    throw createSafeError(errorMessage, {
        logs: errorLogs.length ? errorLogs : ['RPC/Network error'],
        txid: txid || null,
        mint: outputMint,
        code: 'RPC_ERROR'
    });
}
}

// ============================================================
// SELL TOKEN - FIXED
// ============================================================
async function executeSell({ inputMint, amountTokens, slippageBps = 1500, isSimulation = false }) {
    if (!connection || !wallet) throw new Error('pumpClient belum init');

    if (isSimulation) {
        return {
            txid: `sim_sell_${Date.now().toString(36)}`,
            outputAmount: 0,
            isSimulation: true,
        };
    }

    let balance;
    try {
        balance = await getBalance(inputMint);
    } catch(e) {
        const error = new Error(`Gagal cek saldo token: ${e.message}`);
        error.logs = ['Token balance check failed'];
        error.txid = null;
        throw error;
    }

    if (balance <= 0) {
        const error = new Error('Saldo token 0');
        error.logs = ['No token balance'];
        error.txid = null;
        throw error;
    }

    const actualSell = Math.min(amountTokens, balance);
    const mint = new PublicKey(inputMint);
    const mintStr = mint.toBase58();
    const sellerAta = await getAssociatedTokenAddress(mint, wallet.publicKey);
    const lamports = BigInt(Math.floor(actualSell * 1e6));

    const slippageMult = 1 - slippageBps / 10_000;
    const minSolOut = BigInt(Math.floor(100_000 * slippageMult));

    const [bondingCurvePda] = PublicKey.findProgramAddressSync(
        [Buffer.from('bonding-curve'), mint.toBuffer()], PUMP_PROGRAM_ID
    );
    const [bondingCurveAtaPda] = PublicKey.findProgramAddressSync(
        [bondingCurvePda.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], 
        ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);
    const dataBuffer = Buffer.alloc(24);
    SELL_DISCRIMINATOR.copy(dataBuffer, 0);
    dataBuffer.writeBigUInt64LE(lamports, 8);
    dataBuffer.writeBigUInt64LE(minSolOut, 16);

    const instructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 })
    ];

    instructions.push(new TransactionInstruction({
        programId: PUMP_PROGRAM_ID,
        keys: [
            { pubkey: GLOBAL_STATE_PDA, isSigner: false, isWritable: false },
            { pubkey: PUMP_FEE_RECIPIENT, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: bondingCurvePda, isSigner: false, isWritable: true },
            { pubkey: bondingCurveAtaPda, isSigner: false, isWritable: true },
            { pubkey: sellerAta, isSigner: false, isWritable: true },
            { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: EVENT_AUTH_PDA, isSigner: false, isWritable: false },
            { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: dataBuffer,
    }));

    const tx = new Transaction().add(...instructions);
    let txid, solBefore;

    try {
        solBefore = await getSolBalance();
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        tx.feePayer = wallet.publicKey;

        console.log(`💸 [${mintStr.slice(0,6)}...] Selling ${actualSell.toFixed(2)} tokens...`);
        txid = await sendAndConfirmTransaction(connection, tx, [wallet], {
            commitment: 'confirmed',
            maxRetries: 5,
            skipPreflight: true,
            preflightCommitment: 'confirmed',
        });
    } catch (err) {
        console.error(`❌ [${mintStr.slice(0,6)}...] SELL FAILED:`, err.message);
        
        const safeError = new Error(`Sell Failed: ${err.message || 'Unknown error'}`);
        safeError.logs = Array.isArray(err.logs) ? err.logs : ['Sell transaction failed'];
        safeError.txid = txid || null;
        safeError.mint = mintStr;
        throw safeError;
    }

    await new Promise(r => setTimeout(r, 2000));
    const solAfter = await getSolBalance();
    const solReceived = Math.max(0, solAfter - (solBefore || 0));

    return {
        txid,
        outputAmount: solReceived,
        isSimulation: false,
        mint: mintStr
    };
}

module.exports = {
    init,
    getWalletAddress,
    getSolBalance,
    getBalance,
    getTokenPriceInSol,
    executeSwap,
    executeSell,
    SOL_MINT,
    createSafeError,
};