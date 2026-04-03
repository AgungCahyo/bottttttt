const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');

async function check() {
    const address = '63zKL5VGTzYLbfCtDKWjZQxnwRyUrejrgwo6Z4rV5Z1d';
    const rpcUrls = [
        'https://api.mainnet-beta.solana.com',
        'https://solana-mainnet.rpc.extrnode.com',
        'https://rpc.ankr.com/solana'
    ];

    for (const rpcUrl of rpcUrls) {
        console.log(`Checking RPC: ${rpcUrl}`);
        try {
            const connection = new Connection(rpcUrl, 'confirmed');
            const balance = await connection.getBalance(new PublicKey(address));
            console.log(`  Balance: ${balance / LAMPORTS_PER_SOL} SOL`);
        } catch (err) {
            console.error(`  Error: ${err.message}`);
        }
    }
}

check();
