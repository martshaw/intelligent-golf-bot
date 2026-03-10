import { Course } from 'requests/golfBooking';
import { getGolfClubName } from 'shared/env';
import { deleteMonitor, getUsersMonitors, Monitor } from 'storage/monitors';
import { Bot } from 'grammy';

function formatMonitorLine(monitor: Monitor, index: number): string {
  const course = Course[monitor.course] ?? getGolfClubName();
  const dateStr = monitor.startDate.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  });
  const start = monitor.startDate.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit'
  });
  const end = monitor.endDate.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit'
  });
  return `${index + 1}. ${dateStr} ${start}–${end} (${course})`;
}

export function monitorsCommand(bot: Bot): void {
  bot.on('callback_query', async (ctx, next) => {
    const query = ctx.callbackQuery;
    if (query.data && query.data.startsWith('monitor:')) {
      const payload = query.data.slice('monitor:'.length);
      const userId = query.from?.id;
      if (!userId) {
        await ctx.answerCallbackQuery('Could not identify you');
        return next();
      }
      if (payload === 'all') {
        const monitors = await getUsersMonitors(userId);
        if (!monitors?.length) {
          await ctx.answerCallbackQuery('No monitors to remove');
          return next();
        }
        let removed = 0;
        for (const m of monitors) {
          if (await deleteMonitor(m.id, userId)) removed++;
        }
        await ctx.deleteMessage().catch(() => {});
        await ctx.answerCallbackQuery(
          removed === 1 ? 'Monitor removed' : `${removed} monitors removed`
        );
        return next();
      }
      const id = payload;
      if (!(await deleteMonitor(id, userId))) {
        await ctx.answerCallbackQuery('Remove failed');
        return next();
      }
      await ctx.deleteMessage().catch(() => {});
      await ctx.answerCallbackQuery('Monitor removed');
      return next();
    }
    await next();
  });

  bot.on('message').command('monitors', async (ctx) => {
    const userId = ctx.msg.from?.id;
    if (!userId) return;

    const monitors = await getUsersMonitors(userId);

    if (!monitors || monitors.length === 0) {
      await ctx.reply(
        'No active monitors.\nAdd one with: /monitor (date) from (start) - (end)\nExample: /monitor tomorrow from 08:00 - 10:00'
      );
      return;
    }

    let message = `<b>Active monitors</b> (${monitors.length})\n\n`;
    message += monitors.map((m, i) => formatMonitorLine(m, i)).join('\n');
    message +=
      '\n\nTap <b>Remove</b> under a monitor to delete it, or <b>Remove all</b> to clear everything.';

    const keyboard: { callback_data: string; text: string }[][] = monitors.map(
      (monitor) => [
        {
          callback_data: `monitor:${monitor.id}`,
          text: `Remove: ${monitor.startDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${monitor.startDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
        }
      ]
    );
    if (monitors.length > 1) {
      keyboard.push([{ callback_data: 'monitor:all', text: 'Remove all' }]);
    }

    await ctx.reply(message, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    });
  });
}
