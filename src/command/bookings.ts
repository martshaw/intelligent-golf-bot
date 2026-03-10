import { cancelBooking, getBookings } from 'requests/golfBooking';
import { getSafeUserMessage, logError } from 'shared/errorHandling';
import { getLogin } from 'storage/logins';
import { getOrCreateSession } from 'shared/sessionCache';
import { Bot } from 'grammy';

export function bookingsCommand(bot: Bot): void {
  bot.on('callback_query', async (ctx, next) => {
    const query = ctx.callbackQuery;
    if (query.data && query.data.startsWith('bookings')) {
      const bookingId = query.data.split(':')[1];

      const credentials = await getLogin(query.from.id);

      if (!credentials) {
        await ctx.answerCallbackQuery('❌ Not authenticated');
        return;
      }

      try {
        const request = await getOrCreateSession(
          query.from.id,
          credentials.username,
          credentials.password
        );
        const cancelled = await cancelBooking(request, { bookingId });

        if (cancelled) {
          await ctx.deleteMessage();
          await ctx.answerCallbackQuery('✅ Booking deleted');
        } else {
          await ctx.answerCallbackQuery('❌ Deletion failed');
        }
      } catch (error) {
        logError('Booking deletion', error);
        await ctx.answerCallbackQuery('❌ Error deleting booking');
      }
    }
    await next();
  });

  bot.on('message').command('bookings', async (ctx) => {
    const msg = ctx.msg;

    const credentials = await getLogin(msg.from.id);

    if (!credentials) {
      await ctx.reply('❌ Not authenticated. Use /login first.');
      return;
    }

    try {
      await ctx.reply('⏳ Fetching your bookings...');
      const startTime = Date.now();
      const request = await getOrCreateSession(
        msg.from.id,
        credentials.username,
        credentials.password
      );
      const bookingsResponse = await getBookings(request);
      const duration = Date.now() - startTime;

      if (bookingsResponse.length === 0) {
        await ctx.reply('📅 No upcoming bookings');
        return;
      }

      const lines: string[] = [
        `<b>📅 Upcoming Bookings</b> (${bookingsResponse.length}) — ${duration}ms`,
        ''
      ];
      const inline_keyboard: { callback_data: string; text: string }[][] = [];

      bookingsResponse.forEach((booking) => {
        const details = booking.moreDetails;
        const course = details.startingTee.split(' ')[0];
        const participants = details.participants.join(', ');
        lines.push(`<b>${booking.date}</b> ${booking.time} · ${course}`);
        lines.push(`  ${participants}`);
        lines.push('');
        inline_keyboard.push([
          {
            callback_data: `bookings:${booking.id}`,
            text: `🗑️ Delete ${booking.date} ${booking.time}`
          }
        ]);
      });

      await ctx.reply(lines.join('\n').trim(), {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard }
      });
    } catch (error) {
      logError('Bookings', error);
      await ctx.reply(`❌ Error: ${getSafeUserMessage(error)}`);
    }
  });
}
