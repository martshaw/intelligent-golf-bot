import { cancelBooking, getBookings } from 'requests/golfBooking';
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
        const request = await getOrCreateSession(query.from.id, credentials.username, credentials.password);
        const cancelled = await cancelBooking(request, { bookingId });

        if (cancelled) {
          await ctx.deleteMessage();
          await ctx.answerCallbackQuery('✅ Booking deleted');
        } else {
          await ctx.answerCallbackQuery('❌ Deletion failed');
        }
      } catch (error) {
        console.error('Booking deletion error:', error);
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
      const startTime = Date.now();
      const request = await getOrCreateSession(msg.from.id, credentials.username, credentials.password);
      const bookingsResponse = await getBookings(request);
      const duration = Date.now() - startTime;

      if (bookingsResponse.length === 0) {
        await ctx.reply('📅 No upcoming bookings');
        return;
      }

      await ctx.reply(`<b>📅 Upcoming Bookings</b> (fetched in ${duration}ms)`, {
        parse_mode: 'HTML'
      });

      await Promise.all(
        bookingsResponse.map(async (booking) => {
          const details = booking.moreDetails;

          const message = `\n<b>Date:</b> ${booking.date}\n<b>Time:</b> ${
            booking.time
          }\n<b>Course:</b> ${
            details.startingTee.split(' ')[0]
          }\n<b>Participants:</b> ${details.participants.join(', ')}`;

          await ctx.reply(message, {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    callback_data: `bookings:${booking.id}`,
                    text: '🗑️ Delete'
                  }
                ]
              ]
            }
          });
        })
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      console.error('Bookings error:', error);
      await ctx.reply(`❌ Error: ${msg}`);
    }
  });
}
