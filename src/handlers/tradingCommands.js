'use strict';
const engine  = require('../trading/tradingEngine');
const { esc, sleep } = require('../utils/helpers');
const log     = require('../utils/logger');

function registerTradingHandlers(bot, isAdmin, requireAdmin) {

    // ─── /trading_status ─────────────────────────────────────
    bot.command('trading_status', async ctx => {
        try {
            const positions = engine.posTracker.getAllPositions();
            const dcaPlans  = engine.dca.getAllPlans().filter(p => p.active);
            const gridPlans = engine.grid.getAllPlans().filter(p => p.active);
            const daily     = engine.riskManager.getDailyStats();
            const risk      = engine.riskManager.getRiskConfig();
            const trail     = engine.trailingStop;

            let msg =
                `<b>📊 Trading Status</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━\n` +
                `🔑 Wallet: <code>${engine.pump.getWalletAddress() || 'Belum init'}</code>\n` +
                `🛡️  Mode: <b>${engine.isSimMode() ? 'SIMULASI' : '⚠️ REAL TRADING'}</b>\n\n` +
                `<b>📅 Hari Ini (${daily.date}):</b>\n` +
                `  Trades    : ${daily.tradeCount}/${risk.maxTradesPerDay}\n` +
                `  Loss      : -${daily.totalLossSol.toFixed(4)} / -${risk.dailyLossLimitSol} SOL\n` +
                `  Profit    : +${daily.totalProfitSol.toFixed(4)} SOL\n` +
                `  Diblokir  : ${daily.blockedCount}x\n\n`;

            if (positions.length > 0) {
                msg += `<b>📈 Posisi Terbuka (${positions.length}):</b>\n`;
                for (const p of positions) {
                    const trailState = trail.getState(p.mint);
                    const highMult   = trailState
                        ? (trailState.highPriceSol / p.entryPriceSol).toFixed(2)
                        : '?';
                    const simMark    = p.isSimulation ? ' [SIM]' : '';
                    msg += `  • <b>${esc(p.symbol)}</b>${simMark}\n` +
                           `    Entry: ${p.entryPriceSol?.toFixed(8)} | High: ${highMult}x\n` +
                           `    SL: ${p.stopLossPriceSol?.toFixed(8)}\n`;
                }
                msg += '\n';
            } else {
                msg += `<b>📈 Posisi:</b> Tidak ada\n\n`;
            }

            if (dcaPlans.length > 0) {
                msg += `<b>🔄 DCA Aktif (${dcaPlans.length}):</b>\n`;
                for (const p of dcaPlans) {
                    msg += `  • ${esc(p.symbol)} | ${p.ordersFilled}/${p.ordersTotal} | <code>${p.id}</code>\n`;
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
        } catch (err) {
            return ctx.reply(`❌ Error: ${err.message}`);
        }
    });

    // ─── /clear_sim — hapus semua posisi simulasi ─────────────
    bot.command('clear_sim', requireAdmin, ctx => {
        const count = engine.clearSimPositions();
        return ctx.reply(`🧹 ${count} posisi simulasi dibersihkan.`);
    });

    // ─── /close_all — emergency close semua posisi ────────────
    bot.command('close_all', requireAdmin, async ctx => {
        const count = engine.posTracker.getPositionCount();
        if (count === 0) return ctx.reply('ℹ️ Tidak ada posisi terbuka.');

        await ctx.reply(`⏳ Menutup ${count} posisi... harap tunggu.`);
        try {
            const results = await engine.closeAllPositions('close_all_command');
            const ok      = results.filter(r => r.success).length;
            const fail    = results.filter(r => !r.success).length;
            return ctx.reply(
                `✅ Selesai.\n✅ Berhasil: ${ok}\n❌ Gagal: ${fail}` +
                (fail > 0 ? `\n\nCek log terminal untuk detail.` : '')
            );
        } catch (err) {
            return ctx.reply(`❌ Error: ${err.message}`);
        }
    });

    // ─── /close <mint> ────────────────────────────────────────
    bot.command('close', requireAdmin, async ctx => {
        const mint = ctx.message.text.split(' ')[1];
        if (!mint) return ctx.reply('⚠️ Format: /close <mint address>');

        await ctx.reply('⏳ Menutup posisi...');
        try {
            const result = await engine.manualClose(mint);
            return ctx.reply(
                `✅ <b>Posisi Ditutup</b>\n` +
                `🪙 ${esc(result?.symbol)}\n` +
                `💰 PnL: ${result?.pnlSol >= 0 ? '+' : ''}${result?.pnlSol?.toFixed(4)} SOL ` +
                `(${result?.pnlPct?.toFixed(1)}%)\n` +
                `🔗 <a href="https://solscan.io/tx/${result?.exitTxid}">Solscan</a>`,
                { parse_mode: 'HTML' }
            );
        } catch (err) {
            return ctx.reply(`❌ Gagal: ${err.message}`);
        }
    });

    // ─── /wallet ──────────────────────────────────────────────
    bot.command('wallet', requireAdmin, async ctx => {
        try {
            const address = engine.pump.getWalletAddress();
            const sol     = await engine.pump.getSolBalance();
            return ctx.reply(
                `<b>👛 Wallet Info</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━\n` +
                `📍 Address:\n<code>${address}</code>\n\n` +
                `💰 Saldo SOL: <b>${sol.toFixed(4)} SOL</b>\n` +
                `🔗 <a href="https://solscan.io/account/${address}">Lihat di Solscan</a>`,
                { parse_mode: 'HTML' }
            );
        } catch (err) {
            return ctx.reply(`❌ Gagal: ${err.message}`);
        }
    });

    // ─── /dca_create ─────────────────────────────────────────
    bot.command('dca_create', requireAdmin, async ctx => {
        const args = ctx.message.text.split(' ').slice(1);
        if (args.length < 5)
            return ctx.reply(
                '⚠️ Format: /dca_create &lt;mint&gt; &lt;symbol&gt; &lt;totalSOL&gt; &lt;orders&gt; &lt;intervalMenit&gt;\n\n' +
                'Contoh: /dca_create MINT123 SOL 1 5 60',
                { parse_mode: 'HTML' }
            );

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
                `💰 ${totalSol} SOL total → ${orders}x order\n` +
                `⏱ Interval: ${intervalMinutes} menit\n` +
                `🆔 <code>${plan.id}</code>`,
                { parse_mode: 'HTML' }
            );
        } catch (err) {
            return ctx.reply(`❌ Gagal: ${err.message}`);
        }
    });

    // ─── /dca_cancel ─────────────────────────────────────────
    bot.command('dca_cancel', requireAdmin, ctx => {
        const id = ctx.message.text.split(' ')[1];
        if (!id) return ctx.reply('⚠️ Format: /dca_cancel <planId>');
        const ok = engine.dca.cancelPlan(id);
        return ctx.reply(
            ok ? `✅ DCA <code>${esc(id)}</code> dibatalkan.` : '❌ Plan tidak ditemukan.',
            { parse_mode: 'HTML' }
        );
    });

    // ─── /grid_create ─────────────────────────────────────────
    bot.command('grid_create', requireAdmin, async ctx => {
        const args = ctx.message.text.split(' ').slice(1);
        if (args.length < 6)
            return ctx.reply(
                '⚠️ Format: /grid_create &lt;mint&gt; &lt;symbol&gt; &lt;totalSOL&gt; &lt;lowerPrice&gt; &lt;upperPrice&gt; &lt;gridCount&gt;\n\n' +
                'Contoh: /grid_create MINT123 SOL 1 0.00001 0.00003 10',
                { parse_mode: 'HTML' }
            );

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
                `🆔 <code>${plan.id}</code>`,
                { parse_mode: 'HTML' }
            );
        } catch (err) {
            return ctx.reply(`❌ Gagal: ${err.message}`);
        }
    });

    // ─── /grid_cancel ─────────────────────────────────────────
    bot.command('grid_cancel', requireAdmin, ctx => {
        const id = ctx.message.text.split(' ')[1];
        if (!id) return ctx.reply('⚠️ Format: /grid_cancel <planId>');
        const ok = engine.grid.cancelPlan(id);
        return ctx.reply(
            ok ? `✅ Grid <code>${esc(id)}</code> dibatalkan.` : '❌ Plan tidak ditemukan.',
            { parse_mode: 'HTML' }
        );
    });

    // ─── /risk_config ─────────────────────────────────────────
    bot.command('risk_config', ctx => {
        const r = engine.riskManager.getRiskConfig();
        return ctx.reply(
            `<b>🛡️ Risk Configuration</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `Max buy/trade    : ${r.maxBuyAmountSol} SOL\n` +
            `Min buy/trade    : ${r.minBuyAmountSol} SOL\n` +
            `Stop loss        : ${r.maxLossPerTradePct}%\n` +
            `Daily loss limit : ${r.dailyLossLimitSol} SOL\n` +
            `Max trades/hari  : ${r.maxTradesPerDay}\n` +
            `Max price impact : ${r.maxPriceImpactPct}%\n` +
            `Slippage default : ${r.defaultSlippageBps / 100}%\n` +
            `Whitelist        : ${r.whitelistEnabled ? `✅ (${r.whitelist.length} token)` : '⛔ nonaktif'}\n\n` +
            `Ubah: <code>/risk_set &lt;key&gt; &lt;value&gt;</code>`,
            { parse_mode: 'HTML' }
        );
    });

    // ─── /risk_set ────────────────────────────────────────────
    bot.command('risk_set', requireAdmin, ctx => {
        const parts = ctx.message.text.split(' ').slice(1);
        if (parts.length < 2)
            return ctx.reply(
                '⚠️ Format: /risk_set &lt;key&gt; &lt;value&gt;\n\n' +
                'Key tersedia:\nmaxBuyAmountSol, minBuyAmountSol,\ndailyLossLimitSol, maxTradesPerDay,\nmaxLossPerTradePct, maxPriceImpactPct,\ndefaultSlippageBps, whitelistEnabled',
                { parse_mode: 'HTML' }
            );

        const [key, rawVal] = parts;
        const ALLOWED = ['maxBuyAmountSol','minBuyAmountSol','dailyLossLimitSol','maxTradesPerDay',
                         'maxLossPerTradePct','maxPriceImpactPct','defaultSlippageBps','whitelistEnabled'];

        if (!ALLOWED.includes(key))
            return ctx.reply(`❌ Key tidak valid.`);

        const value = key === 'whitelistEnabled' ? rawVal === 'true' : parseFloat(rawVal);
        if (isNaN(value) && key !== 'whitelistEnabled')
            return ctx.reply('❌ Value harus berupa angka.');

        engine.riskManager.updateRiskConfig({ [key]: value });
        return ctx.reply(
            `✅ <b>${key}</b> = <code>${value}</code>`,
            { parse_mode: 'HTML' }
        );
    });

    // ─── /whitelist_add / _remove ─────────────────────────────
    bot.command('whitelist_add', requireAdmin, ctx => {
        const mint = ctx.message.text.split(' ')[1];
        if (!mint) return ctx.reply('⚠️ /whitelist_add <mint>');
        engine.riskManager.addToWhitelist(mint);
        return ctx.reply(`✅ <code>${mint}</code> ditambahkan.`, { parse_mode: 'HTML' });
    });

    bot.command('whitelist_remove', requireAdmin, ctx => {
        const mint = ctx.message.text.split(' ')[1];
        if (!mint) return ctx.reply('⚠️ /whitelist_remove <mint>');
        engine.riskManager.removeFromWhitelist(mint);
        return ctx.reply(`✅ <code>${mint}</code> dihapus.`, { parse_mode: 'HTML' });
    });

    log.ok('Trading command handlers terdaftar');
}

module.exports = { registerTradingHandlers };