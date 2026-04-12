'use strict';
const engine = require('../trading/tradingEngine');
const f      = require('../utils/tgFormat');
const { esc } = require('../utils/helpers');
const log    = require('../utils/logger');

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
                `${f.header('TRADING STATUS')}\n` +
                `${f.sep()}\n` +
                `${f.row('Wallet', engine.pump.getWalletAddress() || 'not initialized', true)}\n` +
                `${f.row('Mode', engine.isSimMode() ? 'SIMULATION' : 'LIVE TRADING')}\n` +
                `${f.sep()}\n` +
                `<b>Today  ${daily.date}</b>\n` +
                `${f.row('Trades', `${daily.tradeCount} / ${risk.maxTradesPerDay}`)}\n` +
                `${f.row('Loss', `${daily.totalLossSol.toFixed(4)} / ${risk.dailyLossLimitSol} SOL`)}\n` +
                `${f.row('Profit', `${f.signed(daily.totalProfitSol)} SOL`)}\n` +
                `${f.row('Blocked', daily.blockedCount)}\n`;

            if (positions.length > 0) {
                msg += `${f.sep()}\n<b>Open Positions  (${positions.length})</b>\n`;
                for (const p of positions) {
                    const trailState = trail.getState(p.mint);
                    const highMult   = trailState
                        ? (trailState.highPriceSol / p.entryPriceSol).toFixed(2)
                        : '-';
                    const simTag = p.isSimulation ? '  [SIM]' : '';
                    msg +=
                        `${f.sepShort()}\n` +
                        `<b>${esc(p.symbol)}</b>${simTag}\n` +
                        `${f.row('Entry', p.entryPriceSol?.toFixed(8), true)}\n` +
                        `${f.row('High', `${highMult}x`)}\n` +
                        `${f.row('SL', p.stopLossPriceSol?.toFixed(8), true)}\n`;
                }
            } else {
                msg += `${f.sep()}\n<b>Open Positions</b>  none\n`;
            }

            if (dcaPlans.length > 0) {
                msg += `${f.sep()}\n<b>DCA Plans  (${dcaPlans.length})</b>\n`;
                for (const p of dcaPlans) {
                    msg += `${f.row(esc(p.symbol), `${p.ordersFilled}/${p.ordersTotal}  |  <code>${p.id}</code>`)}\n`;
                }
            }

            if (gridPlans.length > 0) {
                msg += `${f.sep()}\n<b>Grid Plans  (${gridPlans.length})</b>\n`;
                for (const p of gridPlans) {
                    msg += `${f.row(esc(p.symbol), `${p.trades} trades  |  PnL  ${f.signed(p.totalPnlSol)} SOL`)}\n`;
                }
            }

            return ctx.reply(msg, { parse_mode: 'HTML' });
        } catch (err) {
            return ctx.reply(`Error: ${err.message}`);
        }
    });

    // ─── /wallet ─────────────────────────────────────────────
    bot.command('wallet', requireAdmin, async ctx => {
        try {
            const address = engine.pump.getWalletAddress();
            const sol     = await engine.pump.getSolBalance();
            return ctx.reply(
                `${f.header('WALLET')}\n` +
                `${f.sep()}\n` +
                `${f.row('Address', address, true)}\n` +
                `${f.row('Balance', `${sol.toFixed(4)} SOL`)}\n` +
                `${f.sep()}\n` +
                `<a href="https://solscan.io/account/${address}">solscan.io/account/${address.slice(0, 8)}...</a>`,
                { parse_mode: 'HTML' }
            );
        } catch (err) {
            return ctx.reply(`Error: ${err.message}`);
        }
    });

    // ─── /reset_daily ────────────────────────────────────────
    bot.command('reset_daily', requireAdmin, ctx => {
        try {
            const prev = engine.riskManager.resetDailyStats();
            return ctx.reply(
                `${f.header('DAILY STATS RESET')}\n` +
                `${f.sep()}\n` +
                `<b>Previous values</b>\n` +
                `${f.row('Trades', prev.tradeCount)}\n` +
                `${f.row('Loss', `${prev.totalLossSol.toFixed(4)} SOL`)}\n` +
                `${f.row('Profit', `${prev.totalProfitSol.toFixed(4)} SOL`)}\n` +
                `${f.row('Blocked', prev.blockedCount)}\n` +
                `${f.sep()}\n` +
                `All counters reset. Bot ready.`,
                { parse_mode: 'HTML' }
            );
        } catch (err) {
            return ctx.reply(`Error: ${err.message}`);
        }
    });

    // ─── /alert_config ───────────────────────────────────────
    bot.command('alert_config', async ctx => {
        const CONFIG = require('../config');
        const args   = ctx.message.text.split(' ').slice(1);

        if (args.length === 0) {
            return ctx.reply(
                `${f.header('ALERT CONFIG')}\n` +
                `${f.sep()}\n` +
                `${f.row('Signal alerts', CONFIG.ENABLE_SIGNAL_ALERTS  ? 'on' : 'off')}\n` +
                `${f.row('Profit alerts', CONFIG.ENABLE_PROFIT_ALERTS  ? 'on' : 'off')}\n` +
                `${f.row('Stop-loss alerts', CONFIG.ENABLE_STOPLOSS_ALERTS ? 'on' : 'off')}\n` +
                `${f.row('Buy alerts', CONFIG.ENABLE_BUY_ALERTS ? 'on' : 'off')}\n` +
                `${f.sep()}\n` +
                `<i>Change via .env then restart.\n` +
                `Keys: ENABLE_SIGNAL_ALERTS, ENABLE_PROFIT_ALERTS,\n` +
                `      ENABLE_STOPLOSS_ALERTS, ENABLE_BUY_ALERTS</i>`,
                { parse_mode: 'HTML' }
            );
        }

        return ctx.reply(
            `Alert flags are set via <b>.env</b> then restart.\n\n` +
            `<code>ENABLE_SIGNAL_ALERTS=true/false</code>\n` +
            `<code>ENABLE_PROFIT_ALERTS=true/false</code>\n` +
            `<code>ENABLE_STOPLOSS_ALERTS=true/false</code>\n` +
            `<code>ENABLE_BUY_ALERTS=true/false</code>`,
            { parse_mode: 'HTML' }
        );
    });

    // ─── /risk_config ────────────────────────────────────────
    bot.command('risk_config', ctx => {
        const r = engine.riskManager.getRiskConfig();
        return ctx.reply(
            `${f.header('RISK CONFIG')}\n` +
            `${f.sep()}\n` +
            `${f.row('Max buy / trade', `${r.maxBuyAmountSol} SOL`)}\n` +
            `${f.row('Min buy / trade', `${r.minBuyAmountSol} SOL`)}\n` +
            `${f.row('Stop loss', `${r.maxLossPerTradePct}%`)}\n` +
            `${f.row('Daily loss limit', `${r.dailyLossLimitSol} SOL`)}\n` +
            `${f.row('Max trades / day', r.maxTradesPerDay)}\n` +
            `${f.row('Max price impact', `${r.maxPriceImpactPct}%`)}\n` +
            `${f.row('Default slippage', `${r.defaultSlippageBps / 100}%`)}\n` +
            `${f.row('Whitelist', r.whitelistEnabled ? `on  (${r.whitelist.length} tokens)` : 'off')}\n` +
            `${f.sep()}\n` +
            `Update: <code>/risk_set &lt;key&gt; &lt;value&gt;</code>\n` +
            `Reset day: <code>/reset_daily</code>`,
            { parse_mode: 'HTML' }
        );
    });

    // ─── /risk_set ───────────────────────────────────────────
    bot.command('risk_set', requireAdmin, ctx => {
        const parts = ctx.message.text.split(' ').slice(1);
        if (parts.length < 2)
            return ctx.reply(
                `Usage: <code>/risk_set &lt;key&gt; &lt;value&gt;</code>\n\n` +
                `Keys:\nmaxBuyAmountSol, minBuyAmountSol,\ndailyLossLimitSol, maxTradesPerDay,\n` +
                `maxLossPerTradePct, maxPriceImpactPct,\ndefaultSlippageBps, whitelistEnabled`,
                { parse_mode: 'HTML' }
            );

        const [key, rawVal] = parts;
        const ALLOWED = [
            'maxBuyAmountSol', 'minBuyAmountSol', 'dailyLossLimitSol',
            'maxTradesPerDay', 'maxLossPerTradePct', 'maxPriceImpactPct',
            'defaultSlippageBps', 'whitelistEnabled',
        ];

        if (!ALLOWED.includes(key))
            return ctx.reply(`Invalid key. Options: ${ALLOWED.join(', ')}`);

        const value = key === 'whitelistEnabled' ? rawVal === 'true' : parseFloat(rawVal);
        if (isNaN(value) && key !== 'whitelistEnabled')
            return ctx.reply('Value must be a number.');

        engine.riskManager.updateRiskConfig({ [key]: value });
        return ctx.reply(
            `${f.row(key, String(value), true)}\nSaved.`,
            { parse_mode: 'HTML' }
        );
    });

    // ─── /whitelist_add / _remove ────────────────────────────
    bot.command('whitelist_add', requireAdmin, ctx => {
        const mint = ctx.message.text.split(' ')[1];
        if (!mint) return ctx.reply('Usage: /whitelist_add <mint>');
        engine.riskManager.addToWhitelist(mint);
        return ctx.reply(`Added: <code>${mint}</code>`, { parse_mode: 'HTML' });
    });

    bot.command('whitelist_remove', requireAdmin, ctx => {
        const mint = ctx.message.text.split(' ')[1];
        if (!mint) return ctx.reply('Usage: /whitelist_remove <mint>');
        engine.riskManager.removeFromWhitelist(mint);
        return ctx.reply(`Removed: <code>${mint}</code>`, { parse_mode: 'HTML' });
    });

    // ─── /clear_sim ──────────────────────────────────────────
    bot.command('clear_sim', requireAdmin, ctx => {
        const count = engine.clearSimPositions();
        return ctx.reply(`${count} simulation position(s) cleared.`);
    });

    // ─── /close_all ──────────────────────────────────────────
    bot.command('close_all', requireAdmin, async ctx => {
        const count = engine.posTracker.getPositionCount();
        if (count === 0) return ctx.reply('No open positions.');

        await ctx.reply(`Closing ${count} position(s)... please wait.`);
        try {
            const results = await engine.closeAllPositions('close_all_command');
            const ok   = results.filter(r => r.success).length;
            const fail = results.filter(r => !r.success).length;
            return ctx.reply(
                `${f.header('CLOSE ALL DONE')}\n` +
                `${f.sep()}\n` +
                `${f.row('Success', ok)}\n` +
                `${f.row('Failed', fail)}` +
                (fail > 0 ? `\n\nCheck terminal log for details.` : ''),
                { parse_mode: 'HTML' }
            );
        } catch (err) {
            return ctx.reply(`Error: ${err.message}`);
        }
    });

    // ─── /close <mint> ───────────────────────────────────────
    bot.command('close', requireAdmin, async ctx => {
        const mint = ctx.message.text.split(' ')[1];
        if (!mint) return ctx.reply('Usage: /close <mint address>');

        await ctx.reply('Closing position...');
        try {
            const result = await engine.manualClose(mint);
            return ctx.reply(
                `${f.header('POSITION CLOSED')}\n` +
                `${f.sep()}\n` +
                `${f.row('Token', esc(result?.symbol))}\n` +
                `${f.row('CA', mint, true)}\n` +
                `${f.row('PnL', `${f.signed(result?.pnlSol)} SOL  (${result?.pnlPct?.toFixed(1)}%)`)}\n` +
                `${f.sep()}\n` +
                `${f.txLink(result?.exitTxid)}`,
                { parse_mode: 'HTML' }
            );
        } catch (err) {
            return ctx.reply(`Failed: ${err.message}`);
        }
    });

    // ─── /dca_create ─────────────────────────────────────────
    bot.command('dca_create', requireAdmin, async ctx => {
        const args = ctx.message.text.split(' ').slice(1);
        if (args.length < 5)
            return ctx.reply(
                `Usage: <code>/dca_create &lt;mint&gt; &lt;symbol&gt; &lt;totalSOL&gt; &lt;orders&gt; &lt;intervalMin&gt;</code>\n\n` +
                `Example: <code>/dca_create MINT123 SOL 1 5 60</code>`,
                { parse_mode: 'HTML' }
            );

        const [mint, symbol, totalSol, orders, intervalMinutes] = args;
        try {
            const plan = engine.dca.createDcaPlan({
                mint, symbol,
                totalSol:        parseFloat(totalSol),
                orders:          parseInt(orders),
                intervalMinutes: parseInt(intervalMinutes),
            });
            return ctx.reply(
                `${f.header('DCA PLAN CREATED')}\n` +
                `${f.sep()}\n` +
                `${f.row('Token', esc(symbol))}\n` +
                `${f.row('Total', `${totalSol} SOL  over  ${orders} orders`)}\n` +
                `${f.row('Interval', `${intervalMinutes} min`)}\n` +
                `${f.row('ID', plan.id, true)}`,
                { parse_mode: 'HTML' }
            );
        } catch (err) {
            return ctx.reply(`Failed: ${err.message}`);
        }
    });

    // ─── /dca_cancel ─────────────────────────────────────────
    bot.command('dca_cancel', requireAdmin, ctx => {
        const id = ctx.message.text.split(' ')[1];
        if (!id) return ctx.reply('Usage: /dca_cancel <planId>');
        const ok = engine.dca.cancelPlan(id);
        return ctx.reply(
            ok ? `DCA plan cancelled: <code>${esc(id)}</code>` : 'Plan not found.',
            { parse_mode: 'HTML' }
        );
    });

    // ─── /grid_create ────────────────────────────────────────
    bot.command('grid_create', requireAdmin, async ctx => {
        const args = ctx.message.text.split(' ').slice(1);
        if (args.length < 6)
            return ctx.reply(
                `Usage: <code>/grid_create &lt;mint&gt; &lt;symbol&gt; &lt;totalSOL&gt; &lt;lower&gt; &lt;upper&gt; &lt;gridCount&gt;</code>\n\n` +
                `Example: <code>/grid_create MINT123 SOL 1 0.00001 0.00003 10</code>`,
                { parse_mode: 'HTML' }
            );

        const [mint, symbol, totalSol, lowerPrice, upperPrice, gridCount] = args;
        try {
            const plan = engine.grid.createGridPlan({
                mint, symbol,
                totalSol:   parseFloat(totalSol),
                lowerPrice: parseFloat(lowerPrice),
                upperPrice: parseFloat(upperPrice),
                gridCount:  parseInt(gridCount),
            });
            return ctx.reply(
                `${f.header('GRID PLAN CREATED')}\n` +
                `${f.sep()}\n` +
                `${f.row('Token', esc(symbol))}\n` +
                `${f.row('Total', `${totalSol} SOL`)}\n` +
                `${f.row('Levels', gridCount)}\n` +
                `${f.row('Range', `${lowerPrice}  -  ${upperPrice} SOL`)}\n` +
                `${f.row('ID', plan.id, true)}`,
                { parse_mode: 'HTML' }
            );
        } catch (err) {
            return ctx.reply(`Failed: ${err.message}`);
        }
    });

    // ─── /grid_cancel ────────────────────────────────────────
    bot.command('grid_cancel', requireAdmin, ctx => {
        const id = ctx.message.text.split(' ')[1];
        if (!id) return ctx.reply('Usage: /grid_cancel <planId>');
        const ok = engine.grid.cancelPlan(id);
        return ctx.reply(
            ok ? `Grid plan cancelled: <code>${esc(id)}</code>` : 'Plan not found.',
            { parse_mode: 'HTML' }
        );
    });

    log.ok('Trading command handlers registered');
}

module.exports = { registerTradingHandlers };