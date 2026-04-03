const { Connection, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58').default || require('bs58');
require('dotenv').config();

async function check() {
    const rpcUrl = process.env.SOLANA_RPC_URL;
    const privateKeyBase58 = process.env.WALLET_PRIVATE_KEY;

    console.log('RPC URL:', rpcUrl);
    
    try {
        const secretKey = bs58.decode(privateKeyBase58);
        let wallet;
        if (secretKey.length === 64)       wallet = Keypair.fromSecretKey(secretKey);
        else if (secretKey.length === 32)  wallet = Keypair.fromSeed(secretKey);
        
        const publicKey = wallet.publicKey.toBase58();
        console.log('Public Key:', publicKey);
        
        const connection = new Connection(rpcUrl, 'confirmed');
        const balance = await connection.getBalance(wallet.publicKey);
        console.log('Balance (confirmed):', balance / LAMPORTS_PER_SOL, 'SOL');

        const balanceF = await connection.getBalance(wallet.publicKey, 'finalized');
        console.log('Balance (finalized):', balanceF / LAMPORTS_PER_SOL, 'SOL');
        
    } catch (err) {
        console.error('Error:', err.message);
    }
}

check();
