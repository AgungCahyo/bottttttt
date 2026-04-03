'use strict';
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { PumpFunSDK } = require('pumpdotfun-sdk');
const { AnchorProvider } = require('@coral-xyz/anchor');
const { default: axios } = require('axios');
const bs58 = require('bs58').default || require('bs58');

const SOL_MINT = 'So11111111111111111111111111111111111111112';

let connection = null;
let wallet     = null;
let sdk        = null;

// ============================================================
// INIT
// ============================================================
function init(rpcUrl, privateKeyBase58) {
    connection = new Connection(rpcUrl, 'confirmed');
    const secretKey = bs58.decode(privateKeyBase58);

    if (secretKey.length === 64) {
        wallet = Keypair.fromSecretKey(secretKey);
    } else if (secretKey.length === 32) {
        wallet = Keypair.fromSeed(secretKey);
    } else {
        throw new Error(`Kunci privat salah ukuran (${secretKey.length} bytes).`);
    }

    // AnchorProvider dibutuhkan oleh pumpdotfun-sdk
    const provider = new AnchorProvider(
        connection,
        {
            publicKey:  wallet.publicKey,
            signTransaction:     tx  => { tx.sign([wallet]); return Promise.resolve(tx); },
            signAllTransactions: txs => { txs.forEach(tx => tx.sign([wallet])); return Promise.resolve(txs); },
        },
        { commitment: 'confirmed' }
    );

    sdk = new PumpFunSDK(provider);

    console.log(`🔑 Wallet dimuat: ${wallet.publicKey.toBase58()}`);
    return wallet.publicKey.toBase58();
}

function getWalletAddress() {
    return wallet?.publicKey?.toBase58() || null;
}

// ============================================================
// GET TOKEN PRICE IN SOL (via bonding curve)
// ============================================================
async function getTokenPriceInSol(mintAddress) {
    try {
        const mint         = new PublicKey(mintAddress);
        const bondingCurve = await sdk.getBondingCurveAccount(mint);
        
        if (bondingCurve) {
            // Masih di bonding curve
            const price = bondingCurve.getSolCostToBuyTokens(BigInt(1e6));
            return Number(price) / LAMPORTS_PER_SOL;
        }

        // Sudah graduate → fallback DexScreener
        return await getTokenPriceInSolFallback(mintAddress);
    } catch {
        return null;
    }
}

// ============================================================
// GET SOL BALANCE
// ============================================================
async function getBalance(mintAddress) {
    if (!connection || !wallet) throw new Error('pumpClient belum diinisialisasi.');

    if (mintAddress === SOL_MINT) {
        const lamports = await connection.getBalance(wallet.publicKey);
        return lamports / LAMPORTS_PER_SOL;
    }

    const { getAssociatedTokenAddress }  = require('@solana/spl-token');
    const { TOKEN_PROGRAM_ID }           = require('@solana/spl-token');

    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        wallet.publicKey,
        { mint: new PublicKey(mintAddress) }
    );

    if (tokenAccounts.value.length === 0) return 0;
    return tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
}

// ============================================================
// GET TOKEN PRICE via DexScreener (fallback untuk token graduate)
// ============================================================
async function getTokenPriceInSolFallback(mintAddress) {
    try {
        await new Promise(r => setTimeout(r, 500)); // delay 500ms antar request
        const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`, {
            timeout: 5_000,
        });
        const pair = data?.pairs?.[0];
        if (!pair) return null;

        const priceUsd = parseFloat(pair.priceUsd);
        const solPrice = require('../config/state').currentSolPrice;
        if (!priceUsd || !solPrice) return null;

        return priceUsd / solPrice;
    } catch {
        return null;
    }
}

// ============================================================
// BUY TOKEN (Bonding Curve)
// ============================================================
async function executeSwap({ outputMint, amountLamports, slippageBps = 1500, isSimulation = false }) {
    if (!sdk || !wallet) throw new Error('pumpClient belum diinisialisasi.');

    const mint = new PublicKey(outputMint);
    let bondingCurve = null;

    try {
        bondingCurve = await sdk.getBondingCurveAccount(mint);
    } catch (err) {
        if (err.message.includes('401')) {
            throw new Error('RPC_AUTH_FAILED: Provider RPC (Helius) memberikan error 401 Unauthorized. Cek API Key di .env!');
        }
        throw err;
    }

    if (!bondingCurve) {
        // Lempar error khusus — ditangkap di tradingEngine untuk di-skip
        const err = new Error(`GRADUATED:${outputMint}`);
        err.graduated = true;
        throw err;
    }

    // Hitung estimasi token yang didapat
    const tokenAmount = bondingCurve.getBuyPrice(BigInt(amountLamports));

    // Mode simulasi — tidak kirim transaksi nyata
    if (isSimulation) {
        return {
            txid:         `sim_pump_${Math.random().toString(36).substring(2, 15)}`,
            inputAmount:  amountLamports / LAMPORTS_PER_SOL,
            outputAmount: Number(tokenAmount) / 1e6,
            isSimulation: true,
        };
    }

    // Eksekusi buy lewat bonding curve
    const result = await sdk.buy(
        wallet,
        mint,
        BigInt(amountLamports),
        BigInt(slippageBps),
        { unitLimit: 250_000, unitPrice: 250_000 }
    );

    if (!result.success) throw new Error(`Pump.fun buy gagal: ${result.error || 'unknown error'}`);

    return {
        txid:         result.signature,
        inputAmount:  amountLamports / LAMPORTS_PER_SOL,
        outputAmount: Number(tokenAmount) / 1e6,
        isSimulation: false,
    };
}

// ============================================================
// SELL TOKEN (Bonding Curve)
// ============================================================
async function executeSell({ inputMint, amountTokens, slippageBps = 1500, isSimulation = false }) {
    if (!sdk || !wallet) throw new Error('pumpClient belum diinisialisasi.');

    const mint = new PublicKey(inputMint);

    if (isSimulation) {
        return {
            txid:         `sim_sell_${Math.random().toString(36).substring(2, 15)}`,
            outputAmount: 0,
            isSimulation: true,
        };
    }

    const result = await sdk.sell(
        wallet,
        mint,
        BigInt(Math.floor(amountTokens * 1e6)),
        BigInt(slippageBps),
        { unitLimit: 250_000, unitPrice: 250_000 }
    );

    if (!result.success) throw new Error(`Pump.fun sell gagal: ${result.error || 'unknown error'}`);

    return {
        txid:         result.signature,
        outputAmount: result.solReceived || 0,
        isSimulation: false,
    };
}

module.exports = {
    init,
    getWalletAddress,
    getTokenPriceInSol,
    getBalance,
    executeSwap,
    executeSell,
    SOL_MINT,
};