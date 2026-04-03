'use strict';
const fs   = require('fs');
const path = require('path');
const EventEmitter = require('events');

const POSITIONS_FILE = path.join(__dirname, '../../../trading_positions.json');

// ============================================================
// POSITION STORE
// key: mint address
// value: { mint, symbol, entryPriceSol, stopLossPriceSol,
//          takeProfitPriceSol, amountToken, amountSol,
//          strategy, openedAt, txid }
// ============================================================
let positions = new Map();
const emitter = new EventEmitter();

function loadPositions() {
    try {
        if (fs.existsSync(POSITIONS_FILE)) {
            const arr = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8'));
            positions = new Map(arr.map(p => [p.mint, p]));
            console.log(`📂 Posisi dimuat: ${positions.size} posisi terbuka.`);
        }
    } catch (err) {
        console.warn('⚠️ Gagal load posisi:', err.message);
    }
}

function savePositions() {
    try {
        fs.writeFileSync(POSITIONS_FILE, JSON.stringify([...positions.values()], null, 2), 'utf8');
    } catch (err) {
        console.warn('⚠️ Gagal simpan posisi:', err.message);
    }
}

// ============================================================
// CRUD POSITIONS
// ============================================================
function openPosition(data) {
    positions.set(data.mint, {
        ...data,
        openedAt: Date.now(),
        status: 'open',
    });
    savePositions();
    console.log(`📈 Posisi dibuka: ${data.symbol} @ ${data.entryPriceSol?.toFixed(8)} SOL`);
    emitter.emit('opened', data);
}

function closePosition(mint, { exitPriceSol, reason = 'manual', txid = null }) {
    const pos = positions.get(mint);
    if (!pos) return null;

    const pnlSol = (exitPriceSol - pos.entryPriceSol) * pos.amountToken;
    const pnlPct = ((exitPriceSol / pos.entryPriceSol) - 1) * 100;

    const closed = { ...pos, exitPriceSol, pnlSol, pnlPct, closedAt: Date.now(), reason, exitTxid: txid, status: 'closed' };
    positions.delete(mint);
    savePositions();

    console.log(`📉 Posisi ditutup: ${pos.symbol} | PnL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPct.toFixed(1)}%) — ${reason}`);
    emitter.emit('closed', closed);
    return closed;
}

function getPosition(mint)    { return positions.get(mint) || null; }
function getAllPositions()     { return [...positions.values()]; }
function hasPosition(mint)    { return positions.has(mint); }
function getPositionCount()   { return positions.size; }

// ============================================================
// STOP LOSS / TAKE PROFIT CHECK
// Dipanggil oleh price monitor secara periodik
// ============================================================
function checkStopLoss(mint, currentPriceSol) {
    const pos = positions.get(mint);
    if (!pos) return false;

    if (pos.stopLossPriceSol && currentPriceSol <= pos.stopLossPriceSol) {
        emitter.emit('stopLossTriggered', { ...pos, currentPriceSol });
        return true;
    }
    return false;
}

function checkTakeProfit(mint, currentPriceSol) {
    const pos = positions.get(mint);
    if (!pos || !pos.takeProfitPriceSol) return false;

    if (currentPriceSol >= pos.takeProfitPriceSol) {
        emitter.emit('takeProfitTriggered', { ...pos, currentPriceSol });
        return true;
    }
    return false;
}

// ============================================================
// EVENT EMITTER EXPORT
// ============================================================
module.exports = {
    loadPositions,
    openPosition,
    closePosition,
    getPosition,
    getAllPositions,
    hasPosition,
    getPositionCount,
    checkStopLoss,
    checkTakeProfit,
    on: (event, cb) => emitter.on(event, cb),
};