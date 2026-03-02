import { parse as parseDate } from 'chrono-node';

import { Course } from 'requests/golfBooking';
import {
  getDaysAheadToBook,
  getBookingOpensHour,
  getBookingOpensMinute,
  getGolfClubName
} from 'shared/env';
import { getLogin } from 'storage/logins';
import {
  getAutoBookingConfig,
  formatGolfersList
} from 'storage/autoBookingConfig';
import { Bot } from 'grammy';
import { addRecurringBooking } from 'storage/recurringBookings';

/** Parse preferred times from input like "prefer 09:12, 09:04, 08:56, 09:20" */
function parsePreferredTimes(raw: string): {
  times: string[];
  cleaned: string;
} {
  const preferMatch = /\bprefer\s+([\d:,\s]+)/i.exec(raw);
  if (!preferMatch) return { times: [], cleaned: raw };
  const timesStr = preferMatch[1];
  const times = timesStr
    .split(',')
    .map((t) => t.trim())
    .filter((t) => /^\d{1,2}:\d{2}$/.test(t))
    .map((t) => {
      const [h, m] = t.split(':');
      return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
    });
  const cleaned = raw.replace(/\bprefer\s+[\d:,\s]+/i, '').trim();
  return { times, cleaned };
}

export function addRecurringBookingCommand(bot: Bot): void {
  bot.on('message').command('addrecurringbooking', async (ctx) => {
    const msg = ctx.msg;
    const command = msg.text;
    const match = /\/addrecurringbooking\s+(.*)/i.exec(command);

    if (!match?.[1]) {
      let usage =
        'Usage: /addrecurringbooking (date) from (startTime) to (endTime) [with golfers] [prefer HH:MM, HH:MM, ...]\n\n';
      usage += 'Examples:\n';
      usage +=
        '/addrecurringbooking next Sunday from 08:45 to 09:30\n';
      usage +=
        '/addrecurringbooking next Sunday from 08:45 to 09:30 with golfers\n';
      usage +=
        '/addrecurringbooking next Sunday from 08:45 to 09:30 with golfers prefer 09:12, 09:04, 08:56, 09:20\n\n';
      usage += '"with golfers" → uses names from autoBookingConfig.json\n';
      usage +=
        '"prefer X, Y, Z" → randomly picks one target time each week';
      await ctx.reply(usage);
      return;
    }

    const course = Course.Kilspindie;
    let raw = match[1].trim();
    const useConfigGolfers = /\bwith\s+golfers\b/i.test(raw);
    raw = raw.replace(/\bwith\s+golfers\b/gi, '').trim();

    // Parse preferred times before date parsing
    const { times: preferredTimes, cleaned: dateString } =
      parsePreferredTimes(raw);

    const date = parseDate(dateString);

    if (!date || date.length === 0) {
      await ctx.reply('❌ Could not understand date/time input!');
      return;
    }

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
      useConfigGolfers,
      preferredTimes: preferredTimes.length > 0 ? preferredTimes : undefined
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
    if (preferredTimes.length > 0) {
      message += `<b>Preferred Times:</b> ${preferredTimes.join(', ')} (randomly picked each week)\n`;
    }
    if (useConfigGolfers) {
      const config = await getAutoBookingConfig();
      if (config.golfers?.length) {
        message += `<b>Golfers:</b> ${formatGolfersList(config.golfers)}\n`;
      }
    }
    message += `\nAuto-booking created ${daysAhead} days before each ${dayName}, executed at ${String(bookingHour).padStart(2, '0')}:${String(bookingMin).padStart(2, '0')} when bookings open.`;

    await ctx.reply(message, { parse_mode: 'HTML' });
  });
}
