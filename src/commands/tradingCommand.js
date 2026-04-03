'use strict';
const engine      = require('../trading/tradingEngine');
const { esc }     = require('../utils/helpers');

// ============================================================
// REGISTER TRADING COMMANDS
// ============================================================
function registerTradingHandlers(bot, isAdmin, requireAdmin) {

    // ─── /trading_status ─────────────────────────────────────
    bot.command('trading_status', async ctx => {
        const positions  = engine.posTracker.getAllPositions();
        const dcaPlans   = engine.dca.getAllPlans().filter(p => p.active);
        const gridPlans  = engine.grid.getAllPlans().filter(p => p.active);
        const daily      = engine.riskManager.getDailyStats();
        const risk       = engine.riskManager.getRiskConfig();

        let msg =
            `<b>📊 Trading Status</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `🔑 Wallet: <code>${engine.jupiter.getWalletAddress() || 'Belum init'}</code>\n\n` +
            `<b>📅 Hari Ini (${daily.date}):</b>\n` +
            `  Trades     : ${daily.tradeCount}/${risk.maxTradesPerDay}\n` +
            `  Loss       : -${daily.totalLossSol.toFixed(4)} SOL / -${risk.dailyLossLimitSol} SOL\n` +
            `  Profit     : +${daily.totalProfitSol.toFixed(4)} SOL\n` +
            `  Diblokir   : ${daily.blockedCount}x\n\n`;

        if (positions.length > 0) {
            msg += `<b>📈 Posisi Terbuka (${positions.length}):</b>\n`;
            for (const p of positions) {
                msg += `  • ${esc(p.symbol)} | Entry: ${p.entryPriceSol?.toFixed(8)} | SL: ${p.stopLossPriceSol?.toFixed(8)}\n`;
            }
            msg += '\n';
        } else {
            msg += `<b>📈 Posisi:</b> Tidak ada\n\n`;
        }

        if (dcaPlans.length > 0) {
            msg += `<b>🔄 DCA Aktif (${dcaPlans.length}):</b>\n`;
            for (const p of dcaPlans) {
                msg += `  • ${esc(p.symbol)} | ${p.ordersFilled}/${p.ordersTotal} | ID: <code>${p.id}</code>\n`;
            }
            msg += '\n';
        }

        if (gridPlans.length > 0) {
            msg += `<b>📐 Grid Aktif (${gridPlans.length}):</b>\n`;
            for (const p of gridPlans) {
                msg += `  • ${esc(p.symbol)} | ${p.trades} trades | PnL: ${p.totalPnlSol >= 0 ? '+' : ''}${p.totalPnlSol.toFixed(4)} SOL\n`;
            }
        }

        return ctx.reply(msg, { parse_mode: 'HTML' });
    });

    // ─── /dca_create <mint> <symbol> <totalSOL> <orders> <intervalMenit> ───
    bot.command('dca_create', requireAdmin, async ctx => {
        const args = ctx.message.text.split(' ').slice(1);
        if (args.length < 5)
            return ctx.reply('⚠️ Format: /dca_create <mint> <symbol> <totalSOL> <orders> <intervalMenit>\n\nContoh: /dca_create So111... SOL 1 5 60');

        const [mint, symbol, totalSol, orders, intervalMinutes] = args;

        try {
            const plan = engine.dca.createDcaPlan({
                mint,
                symbol,
                totalSol:        parseFloat(totalSol),
                orders:          parseInt(orders),
                intervalMinutes: parseInt(intervalMinutes),
            });
            return ctx.reply(
                `✅ <b>DCA Plan Dibuat</b>\n` +
                `🪙 ${esc(symbol)}\n` +
                `💰 ${totalSol} SOL total, ${orders}x order\n` +
                `⏱ Interval: ${intervalMinutes} menit\n` +
                `🆔 ID: <code>${plan.id}</code>`,
                { parse_mode: 'HTML' }
            );
        } catch (err) {
            return ctx.reply(`❌ Gagal: ${err.message}`);
        }
    });

    // ─── /dca_cancel <planId> ─────────────────────────────────
    bot.command('dca_cancel', requireAdmin, ctx => {
        const id = ctx.message.text.split(' ')[1];
        if (!id) return ctx.reply('⚠️ Format: /dca_cancel <planId>');
        const ok = engine.dca.cancelPlan(id);
        return ctx.reply(ok ? `✅ DCA plan <code>${id}</code> dibatalkan.` : '❌ Plan tidak ditemukan.', { parse_mode: 'HTML' });
    });

    // ─── /grid_create <mint> <symbol> <totalSOL> <lowerPrice> <upperPrice> <gridCount> ───
    bot.command('grid_create', requireAdmin, async ctx => {
        const args = ctx.message.text.split(' ').slice(1);
        if (args.length < 6)
            return ctx.reply('⚠️ Format: /grid_create <mint> <symbol> <totalSOL> <lowerPrice> <upperPrice> <gridCount>\n\nContoh: /grid_create So111... SOL 1 0.00001 0.00003 10');

        const [mint, symbol, totalSol, lowerPrice, upperPrice, gridCount] = args;

        try {
            const plan = engine.grid.createGridPlan({
                mint,
                symbol,
                totalSol:   parseFloat(totalSol),
                lowerPrice: parseFloat(lowerPrice),
                upperPrice: parseFloat(upperPrice),
                gridCount:  parseInt(gridCount),
            });
            return ctx.reply(
                `✅ <b>Grid Plan Dibuat</b>\n` +
                `🪙 ${esc(symbol)}\n` +
                `💰 ${totalSol} SOL | ${gridCount} level\n` +
                `📊 Range: ${lowerPrice} – ${upperPrice} SOL\n` +
                `🆔 ID: <code>${plan.id}</code>`,
                { parse_mode: 'HTML' }
            );
        } catch (err) {
            return ctx.reply(`❌ Gagal: ${err.message}`);
        }
    });

    // ─── /grid_cancel <planId> ────────────────────────────────
    bot.command('grid_cancel', requireAdmin, ctx => {
        const id = ctx.message.text.split(' ')[1];
        if (!id) return ctx.reply('⚠️ Format: /grid_cancel <planId>');
        const ok = engine.grid.cancelPlan(id);
        return ctx.reply(ok ? `✅ Grid plan <code>${id}</code> dibatalkan.` : '❌ Plan tidak ditemukan.', { parse_mode: 'HTML' });
    });

    // ─── /close <mint> ───────────────────────────────────────
    bot.command('close', requireAdmin, async ctx => {
        const mint = ctx.message.text.split(' ')[1];
        if (!mint) return ctx.reply('⚠️ Format: /close <mint address>');

        await ctx.reply('⏳ Menutup posisi...');
        try {
            const result = await engine.manualClose(mint);
            return ctx.reply(
                `✅ <b>Posisi Ditutup</b>\n` +
                `🪙 ${esc(result?.symbol)}\n` +
                `💰 PnL: ${result?.pnlSol >= 0 ? '+' : ''}${result?.pnlSol?.toFixed(4)} SOL (${result?.pnlPct?.toFixed(1)}%)\n` +
                `🔗 <a href="https://solscan.io/tx/${result?.exitTxid}">Solscan</a>`,
                { parse_mode: 'HTML' }
            );
        } catch (err) {
            return ctx.reply(`❌ Gagal: ${err.message}`);
        }
    });

    // ─── /risk_config ─────────────────────────────────────────
    bot.command('risk_config', requireAdmin, ctx => {
        const r = engine.riskManager.getRiskConfig();
        return ctx.reply(
            `<b>🛡️ Risk Configuration</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `Max buy/trade   : ${r.maxBuyAmountSol} SOL\n` +
            `Min buy/trade   : ${r.minBuyAmountSol} SOL\n` +
            `Stop loss       : ${r.maxLossPerTradePct}%\n` +
            `Daily loss limit: ${r.dailyLossLimitSol} SOL\n` +
            `Max trades/hari : ${r.maxTradesPerDay}\n` +
            `Max price impact: ${r.maxPriceImpactPct}%\n` +
            `Slippage default: ${r.defaultSlippageBps / 100}%\n` +
            `Whitelist       : ${r.whitelistEnabled ? `✅ (${r.whitelist.length} token)` : '⛔ nonaktif'}\n\n` +
            `Untuk ubah: /risk_set <key> <value>`,
            { parse_mode: 'HTML' }
        );
    });

    // ─── /risk_set <key> <value> ──────────────────────────────
    bot.command('risk_set', requireAdmin, ctx => {
        const parts = ctx.message.text.split(' ').slice(1);
        if (parts.length < 2) return ctx.reply('⚠️ Format: /risk_set <key> <value>\n\nKey: maxBuyAmountSol, dailyLossLimitSol, maxTradesPerDay, maxLossPerTradePct, maxPriceImpactPct, whitelistEnabled');

        const [key, rawVal] = parts;
        const ALLOWED_KEYS  = ['maxBuyAmountSol', 'minBuyAmountSol', 'dailyLossLimitSol', 'maxTradesPerDay', 'maxLossPerTradePct', 'maxPriceImpactPct', 'defaultSlippageBps', 'whitelistEnabled'];

        if (!ALLOWED_KEYS.includes(key))
            return ctx.reply(`❌ Key tidak valid. Pilih dari: ${ALLOWED_KEYS.join(', ')}`);

        let value = key === 'whitelistEnabled' ? rawVal === 'true' : parseFloat(rawVal);
        engine.riskManager.updateRiskConfig({ [key]: value });
        return ctx.reply(`✅ Risk config diperbarui: <b>${key}</b> = <code>${value}</code>`, { parse_mode: 'HTML' });
    });

    // ─── /whitelist_add / _remove ─────────────────────────────
    bot.command('whitelist_add', requireAdmin, ctx => {
        const mint = ctx.message.text.split(' ')[1];
        if (!mint) return ctx.reply('⚠️ Format: /whitelist_add <mint>');
        engine.riskManager.addToWhitelist(mint);
        return ctx.reply(`✅ <code>${mint}</code> ditambahkan ke whitelist.`, { parse_mode: 'HTML' });
    });

    bot.command('whitelist_remove', requireAdmin, ctx => {
        const mint = ctx.message.text.split(' ')[1];
        if (!mint) return ctx.reply('⚠️ Format: /whitelist_remove <mint>');
        engine.riskManager.removeFromWhitelist(mint);
        return ctx.reply(`✅ <code>${mint}</code> dihapus dari whitelist.`, { parse_mode: 'HTML' });
    });

    console.log('✅ Trading command handlers terdaftar.');
}

module.exports = { registerTradingHandlers };