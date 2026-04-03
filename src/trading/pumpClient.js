'use strict';
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { PumpFunSDK } = require('pumpdotfun-sdk');
const { AnchorProvider } = require('@coral-xyz/anchor');
const axios = require('axios');
const bs58  = require('bs58').default || require('bs58');

const SOL_MINT = 'So11111111111111111111111111111111111111112';

let connection = null;
let wallet     = null;
let sdk        = null;

// ============================================================
// INIT
// ============================================================
function init(rpcUrl, privateKeyBase58) {
    if (!rpcUrl)            throw new Error('SOLANA_RPC_URL tidak diset di .env');
    if (!privateKeyBase58)  throw new Error('WALLET_PRIVATE_KEY tidak diset di .env');

    connection = new Connection(rpcUrl, {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 60_000,
    });

    const secretKey = bs58.decode(privateKeyBase58);
    if (secretKey.length === 64)       wallet = Keypair.fromSecretKey(secretKey);
    else if (secretKey.length === 32)  wallet = Keypair.fromSeed(secretKey);
    else throw new Error(`Private key salah ukuran: ${secretKey.length} bytes`);

    const provider = new AnchorProvider(
        connection,
        {
            publicKey: wallet.publicKey,
            signTransaction:     tx  => { tx.sign([wallet]); return Promise.resolve(tx); },
            signAllTransactions: txs => { txs.forEach(tx => tx.sign([wallet])); return Promise.resolve(txs); },
        },
        { commitment: 'confirmed' }
    );

    sdk = new PumpFunSDK(provider);
    console.log(`🔑 Wallet: ${wallet.publicKey.toBase58()}`);
    return wallet.publicKey.toBase58();
}

function getWalletAddress() { return wallet?.publicKey?.toBase58() || null; }

// ============================================================
// SOL BALANCE
// ============================================================
async function getSolBalance() {
    if (!connection || !wallet) throw new Error('pumpClient belum init');
    const lamports = await connection.getBalance(wallet.publicKey);
    return lamports / LAMPORTS_PER_SOL;
}

// ============================================================
// TOKEN BALANCE
// ============================================================
async function getBalance(mintAddress) {
    if (!connection || !wallet) throw new Error('pumpClient belum init');

    if (mintAddress === SOL_MINT) return getSolBalance();

    try {
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
            wallet.publicKey,
            { mint: new PublicKey(mintAddress) }
        );
        if (tokenAccounts.value.length === 0) return 0;
        return tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
    } catch {
        return 0;
    }
}

// ============================================================
// GET TOKEN PRICE IN SOL
// Priority: bonding curve → DexScreener fallback
// ============================================================
async function getTokenPriceInSol(mintAddress) {
    if (!sdk) return null;
    try {
        const mint         = new PublicKey(mintAddress);
        const bondingCurve = await sdk.getBondingCurveAccount(mint);

        if (bondingCurve) {
            // Hitung harga 1 token (1e6 = 1 token dengan 6 desimal)
            const costLamports = bondingCurve.getSolCostToBuyTokens(BigInt(1_000_000));
            return Number(costLamports) / LAMPORTS_PER_SOL;
        }
        // Token sudah graduate → DexScreener
        return await getTokenPriceInSolFallback(mintAddress);
    } catch {
        return null;
    }
}

async function getTokenPriceInSolFallback(mintAddress) {
    try {
        const { data } = await axios.get(
            `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`,
            { timeout: 6_000 }
        );
        const pair = data?.pairs?.[0];
        if (!pair?.priceUsd) return null;

        const { currentSolPrice } = require('../config/state');
        if (!currentSolPrice) return null;
        return parseFloat(pair.priceUsd) / currentSolPrice;
    } catch {
        return null;
    }
}

// ============================================================
// BUY via Pump.fun Bonding Curve
// ============================================================
async function executeSwap({ outputMint, amountLamports, slippageBps = 1500, isSimulation = false }) {
    if (!sdk || !wallet) throw new Error('pumpClient belum init');

    const mint = new PublicKey(outputMint);

    // Validasi bonding curve
    let bondingCurve;
    try {
        bondingCurve = await sdk.getBondingCurveAccount(mint);
    } catch (err) {
        if (err.message?.includes('401')) {
            throw new Error('RPC_AUTH_FAILED: API Key Helius tidak valid atau expired');
        }
        throw err;
    }

    if (!bondingCurve) {
        const err = new Error(`GRADUATED:${outputMint}`);
        err.graduated = true;
        throw err;
    }

    // Estimasi token output
    const tokenAmount = bondingCurve.getBuyPrice(BigInt(amountLamports));
    const outputTokens = Number(tokenAmount) / 1e6;

    if (isSimulation) {
        return {
            txid:         `sim_${Date.now().toString(36)}`,
            inputAmount:  amountLamports / LAMPORTS_PER_SOL,
            outputAmount: outputTokens,
            isSimulation: true,
        };
    }

    // === REAL TRADE ===
    // Cek saldo SOL dulu
    const solBalance = await getSolBalance();
    const neededSol  = (amountLamports / LAMPORTS_PER_SOL) + 0.01; // 0.01 untuk fee
    if (solBalance < neededSol) {
        throw new Error(`Saldo SOL tidak cukup: punya ${solBalance.toFixed(4)}, butuh ${neededSol.toFixed(4)}`);
    }

    const result = await sdk.buy(
        wallet,
        mint,
        BigInt(amountLamports),
        BigInt(slippageBps),
        { unitLimit: 300_000, unitPrice: 300_000 }
    );

    if (!result.success) throw new Error(`Buy gagal: ${result.error || 'unknown'}`);

    return {
        txid:         result.signature,
        inputAmount:  amountLamports / LAMPORTS_PER_SOL,
        outputAmount: outputTokens,
        isSimulation: false,
    };
}

// ============================================================
// SELL via Pump.fun Bonding Curve
// ============================================================
async function executeSell({ inputMint, amountTokens, slippageBps = 1500, isSimulation = false }) {
    if (!sdk || !wallet) throw new Error('pumpClient belum init');

    if (isSimulation) {
        return {
            txid:         `sim_sell_${Date.now().toString(36)}`,
            outputAmount: 0,
            isSimulation: true,
        };
    }

    // Validasi balance sebelum sell
    const balance = await getBalance(inputMint);
    if (balance <= 0) throw new Error('Saldo token 0, tidak bisa sell');

    const actualSell = Math.min(amountTokens, balance);
    const mint       = new PublicKey(inputMint);

    const result = await sdk.sell(
        wallet,
        mint,
        BigInt(Math.floor(actualSell * 1e6)),
        BigInt(slippageBps),
        { unitLimit: 300_000, unitPrice: 300_000 }
    );

    if (!result.success) throw new Error(`Sell gagal: ${result.error || 'unknown'}`);

    return {
        txid:         result.signature,
        outputAmount: result.solReceived || 0,
        isSimulation: false,
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
};