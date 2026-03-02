import { parse as parseDate } from 'chrono-node';

import { Course } from 'requests/golfBooking';
import {
  getDaysAheadToBook,
  getBookingOpensHour,
  getBookingOpensMinute,
  getGolfClubName
} from 'shared/env';
import { getLogin } from 'storage/logins';
import { Bot } from 'grammy';
import { addRecurringBooking } from 'storage/recurringBookings';

export function addRecurringBookingCommand(bot: Bot): void {
  bot.on('message').command('addrecurringbooking', async (ctx) => {
    const msg = ctx.msg;
    const command = msg.text;
    const match = /\/addrecurringbooking\s+(.*)/i.exec(command);

    if (!match?.[1]) {
      await ctx.reply(
        'Usage: /addrecurringbooking (date) from (startTime) to (endTime) [with golfers]\nExample: /addrecurringbooking next Friday from 07:00 to 09:00\nAdd "with golfers" to use names from autoBookingConfig.json'
      );
      return;
    }

    const course = Course.Kilspindie;
    const raw = match[1].trim();
    const useConfigGolfers = /\bwith\s+golfers\b/i.test(raw);
    const dateString = raw.replace(/\bwith\s+golfers\b/gi, '').trim();
    const date = parseDate(dateString);

    const start = date[0].start.date();
    const end =
      date[0].end?.date() ??
      date[1]?.start.date() ??
      new Date(new Date(start).setUTCHours(23, 59, 59));

    if (!date[0].end?.date() && !date[1]?.start.date()) {
      start.setUTCHours(0, 0, 0);
    }

    if (
      start.getUTCDate() !== end.getUTCDate() ||
      start.getUTCMonth() !== end.getUTCMonth()
    ) {
      await ctx.reply('You must specify a start and end date on the same day');
      return;
    }

    const credentials = await getLogin(msg.from.id);

    if (!credentials) {
      await ctx.reply('You are not authenticated');
      return;
    }

    await addRecurringBooking(msg.from.id, course, start, end, {
      useConfigGolfers
    });

    const dayName = start.toLocaleDateString('en-GB', {
      weekday: 'long'
    });
    const daysAhead = getDaysAheadToBook();
    const bookingHour = getBookingOpensHour();
    const bookingMin = getBookingOpensMinute();

    let message = '<b>✅ Recurring Booking Added</b>\n';
    message += `<b>Course:</b> ${getGolfClubName()}\n`;
    message += `<b>Day:</b> Every ${dayName}\n`;
    message += `<b>Window:</b> ${start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} – ${end.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}\n`;
    message += `\nAuto-booking will be created ${daysAhead} days before each ${dayName} and executed at ${String(bookingHour).padStart(2, '0')}:${String(bookingMin).padStart(2, '0')} when bookings open.`;

    await ctx.reply(message, { parse_mode: 'HTML' });
  });
}
