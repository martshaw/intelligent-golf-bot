import { getBookings } from 'requests/golfBooking';
import { getLogin } from 'storage/logins';
import { getOrCreateSession } from 'shared/sessionCache';
import { Bot } from 'grammy';

export function partnersCommand(bot: Bot): void {
  bot.on('message').command('partners', async (ctx) => {
    const msg = ctx.msg;
    const credentials = await getLogin(msg.from.id);

    if (!credentials) {
      await ctx.reply('❌ Not authenticated. Use /login first.');
      return;
    }

    try {
      const startTime = Date.now();
      const request = await getOrCreateSession(msg.from.id, credentials.username, credentials.password);
      const bookings = await getBookings(request);
      const duration = Date.now() - startTime;

      if (bookings.length === 0) {
        await ctx.reply('📊 No upcoming bookings found');
        return;
      }

      // Aggregate all participants
      const participantMap = new Map<string, number>();

      bookings.forEach((booking) => {
        booking.moreDetails.participants.forEach((participant) => {
          const count = participantMap.get(participant) || 0;
          participantMap.set(participant, count + 1);
        });
      });

      // Sort by frequency
      const sorted = Array.from(participantMap.entries())
        .sort((a, b) => b[1] - a[1]);

      if (sorted.length === 0) {
        await ctx.reply('👥 No participants found in bookings');
        return;
      }

      let message = `👥 <b>Golf Partners</b>\n`;
      message += `<b>Total Bookings:</b> ${bookings.length}\n`;
      message += `<b>Unique Partners:</b> ${sorted.length}\n\n`;
      message += `<b>Most Frequent:</b>\n`;

      sorted.slice(0, 10).forEach((entry, idx) => {
        const [name, count] = entry;
        message += `${idx + 1}. <b>${name}</b> - ${count} booking${count > 1 ? 's' : ''}\n`;
      });

      message += `\n<i>Fetched in ${duration}ms</i>`;

      await ctx.reply(message, { parse_mode: 'HTML' });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      console.error('partners error:', error);
      await ctx.reply(`❌ Error: ${msg}`);
    }
  });
}
