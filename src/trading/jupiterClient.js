'use strict';
const axios = require('axios');
const {
    Connection, Keypair, VersionedTransaction, PublicKey
} = require('@solana/web3.js');
const bs58 = require('bs58').default || require('bs58');
const log  = require('../utils/logger');

const JUPITER_API = 'https://api.jup.ag/swap/v1';
const SOL_MINT    = 'So11111111111111111111111111111111111111112';
const USDC_MINT   = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ============================================================
// INIT CONNECTION & WALLET
// ============================================================
let connection = null;
let wallet     = null;

function init(rpcUrl, privateKeyBase58) {
    connection = new Connection(rpcUrl, 'confirmed');
    const secretKey = bs58.decode(privateKeyBase58);

    if (secretKey.length === 64) {
        wallet = Keypair.fromSecretKey(secretKey);
    } else if (secretKey.length === 32) {
        wallet = Keypair.fromSeed(secretKey);
    } else {
        throw new Error(`Kunci privat salah ukuran (${secretKey.length} bytes). Harus 32 atau 64 bytes.`);
    }

    log.wallet(`Jupiter client: ${wallet.publicKey.toBase58()}`);
    return wallet.publicKey.toBase58();
}

function getWalletAddress() {
    return wallet?.publicKey?.toBase58() || null;
}

// ============================================================
// GET QUOTE
// Returns: { inAmount, outAmount, priceImpactPct, routePlan }
// ============================================================
async function getQuote({ inputMint, outputMint, amountLamports, slippageBps = 50 }) {
    try {
        const { data } = await axios.get(`${JUPITER_API}/quote`, {
            params: {
                inputMint,
                outputMint,
                amount:      amountLamports,
                slippageBps,
                onlyDirectRoutes: false,
            },
            timeout: 10_000,
        });
        return data;
    } catch (err) {
        if (err.response?.status === 401) {
            throw new Error(`JUPITER_AUTH_FAILED: Jupiter API memberikan error 401. Cek apakah ada restriksi IP atau API Key yang dibutuhkan.`);
        }
        throw new Error(`Jupiter Quote Error: ${err.message}`);
    }
}

// ============================================================
// EXECUTE SWAP
// Returns: { txid, inputAmount, outputAmount, priceImpact }
// ============================================================
async function executeSwap({ inputMint, outputMint, amountLamports, slippageBps = 100 }) {
    if (!connection || !wallet) throw new Error('jupiterClient belum diinisialisasi.');

    // 1. Dapatkan quote (selalu lakukan ini untuk harga asli)
    const quote = await getQuote({ inputMint, outputMint, amountLamports, slippageBps });

    // 2. Jika Mode SIMULASI Aktif -> Berhenti di sini dan kembalikan data palsu
    const CONFIG = require('../config');
    if (CONFIG.ENABLE_SIMULATION_MODE) {
        return {
            txid: `sim_tx_${Math.random().toString(36).substring(2, 15)}`,
            inputAmount:  parseFloat(quote.inAmount)  / 1e9,
            outputAmount: parseFloat(quote.outAmount) / 1e9,
            priceImpact:  parseFloat(quote.priceImpactPct || 0),
            isSimulation: true
        };
    }

    // 3. Minta swap transaction dari Jupiter
    const { data: swapData } = await axios.post(`${JUPITER_API}/swap`, {
        quoteResponse:         quote,
        userPublicKey:         wallet.publicKey.toBase58(),
        wrapAndUnwrapSol:      true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
    }, { timeout: 15_000 });

    // 4. Deserialize & sign
    const swapTx = VersionedTransaction.deserialize(
        Buffer.from(swapData.swapTransaction, 'base64')
    );
    swapTx.sign([wallet]);

    // 5. Kirim transaksi
    const txid = await connection.sendTransaction(swapTx, { maxRetries: 3 });

    // 6. Tunggu konfirmasi
    await connection.confirmTransaction(txid, 'confirmed');

    return {
        txid,
        inputAmount:  parseFloat(quote.inAmount)  / 1e9,
        outputAmount: parseFloat(quote.outAmount) / 1e9,
        priceImpact:  parseFloat(quote.priceImpactPct || 0),
        isSimulation: false
    };
}

// ============================================================
// GET TOKEN BALANCE (dalam unit token, bukan lamports)
// ============================================================
async function getBalance(mintAddress) {
    if (!connection || !wallet) throw new Error('jupiterClient belum diinisialisasi.');

    if (mintAddress === SOL_MINT) {
        const lamports = await connection.getBalance(wallet.publicKey);
        return lamports / 1e9;
    }

    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        wallet.publicKey,
        { mint: new PublicKey(mintAddress) }
    );

    if (tokenAccounts.value.length === 0) return 0;
    return tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
}

// ============================================================
// GET TOKEN PRICE IN SOL via Jupiter
// ============================================================
async function getTokenPriceInSol(mintAddress, testAmountSol = 0.01) {
    try {
        const lamports = Math.floor(testAmountSol * 1e9);
        const quote = await getQuote({
            inputMint:     SOL_MINT,
            outputMint:    mintAddress,
            amountLamports: lamports,
        });
        // berapa token yang didapat per SOL
        const tokensPerSol = parseFloat(quote.outAmount) / testAmountSol;
        return 1 / tokensPerSol; // harga 1 token dalam SOL
    } catch {
        return null;
    }
}

module.exports = {
    init,
    getWalletAddress,
    getQuote,
    executeSwap,
    getBalance,
    getTokenPriceInSol,
    SOL_MINT,
    USDC_MINT,
};