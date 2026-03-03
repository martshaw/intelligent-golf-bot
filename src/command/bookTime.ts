import { parse } from 'chrono-node';

import {
  bookTimeSlot,
  Course,
  getCourseAvailability
} from 'requests/golfBooking';
import { getSafeUserMessage, logError } from 'shared/errorHandling';
import { getGolfClubName } from 'shared/env';
import { getLogin } from 'storage/logins';
import { getOrCreateSession } from 'shared/sessionCache';
import { Bot } from 'grammy';

/** Normalize time to HH:MM for comparison. */
function normalizeTime(t: string): string {
  const parts = t.trim().split(':');
  const h = parts[0]?.replace(/\D/g, '') ?? '0';
  const m = parts[1]?.replace(/\D/g, '') ?? '0';
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
}

const MONITORBOOK_PREFIX = 'monitorbook:';

/** Build callback_data payload for "Book" from monitor alert. Format: DD-MM-YYYY:HH:MM:courseNum */
export function buildMonitorBookPayload(date: Date, time: string): string {
  const d = date.getDate();
  const m = date.getMonth() + 1;
  const y = date.getFullYear();
  const dateStr = `${d}-${m}-${y}`;
  const t = normalizeTime(time);
  return `${dateStr}:${t}:1`;
}

export function getMonitorBookCallbackData(date: Date, time: string): string {
  return MONITORBOOK_PREFIX + buildMonitorBookPayload(date, time);
}

export function bookTimeCommand(bot: Bot): void {
  bot.on('callback_query', async (ctx, next) => {
    const data = ctx.callbackQuery?.data;
    if (!data?.startsWith(MONITORBOOK_PREFIX)) {
      return next();
    }
    const payload = data.slice(MONITORBOOK_PREFIX.length);
    const parts = payload.split(':');
    if (parts.length < 3) return next();
    const [dateStr, time, courseNum] = parts;
    const dateParts = dateStr.split('-').map(Number);
    if (dateParts.length !== 3) return next();
    const [d, m, y] = dateParts;
    const date = new Date(y, m - 1, d);
    const course = courseNum === '1' ? Course.Kilspindie : Course.Kilspindie;
    const userId = ctx.from?.id;
    if (!userId) return next();

    const credentials = await getLogin(userId);
    if (!credentials) {
      await ctx.answerCallbackQuery({ text: 'Please /login first' });
      return next();
    }

    await ctx.answerCallbackQuery({ text: 'Booking…' });
    try {
      const request = await getOrCreateSession(
        userId,
        credentials.username,
        credentials.password
      );
      const slots = await getCourseAvailability(request, { date, course });
      const slot = slots.find(
        (s) => s.time === time || normalizeTime(s.time) === normalizeTime(time)
      );
      if (!slot) {
        await ctx.reply('That time is no longer available.');
        return next();
      }
      const result = await bookTimeSlot(request, { timeSlot: slot });
      if (result) {
        let msg = '<b>✅ Booked!</b>\n';
        msg += `<b>Date:</b> ${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}\n`;
        msg += `<b>Time:</b> ${slot.time}\n`;
        msg += `<b>Course:</b> ${getGolfClubName()}\n`;
        msg += `<b>Booking ID:</b> ${result.bookingId}\n`;
        msg += `<b>Participants:</b> ${result.details.participants.join(', ')}`;
        await ctx.reply(msg, { parse_mode: 'HTML' });
      } else {
        await ctx.reply('❌ Booking failed – no confirmation from club.');
      }
    } catch (error) {
      logError('monitorbook', error);
      await ctx.reply(`❌ Error: ${getSafeUserMessage(error)}`);
    }
    return next();
  });

  bot.on('message').command('booktime', async (ctx) => {
    const msg = ctx.msg;
    const command = msg.text;
    const match = /\/booktime (.*)/i.exec(command);

    if (!match?.[1]) {
      await ctx.reply('Usage: /booktime (date)\nExample: /booktime tomorrow');
      return;
    }

    // Fast-fail: check credentials early
    const credentials = await getLogin(msg.from.id);
    if (!credentials) {
      await ctx.reply('❌ Not authenticated. Use /login first.');
      return;
    }

    // Parse date asynchronously (non-blocking)
    const dateString = match[1];
    const results = parse(dateString);
    if (!results || results.length === 0) {
      await ctx.reply(
        '❌ Could not understand date input!\nExample: tomorrow, next Friday, 2026-03-15'
      );
      return;
    }

    const date = results[0].start.date();

    try {
      // Reuse or create session
      const request = await getOrCreateSession(
        msg.from.id,
        credentials.username,
        credentials.password
      );

      const availableTimes = await getCourseAvailability(request, {
        course: Course.Kilspindie,
        date
      });

      if (availableTimes.length === 0) {
        await ctx.reply(`❌ No available tee times on ${date.toDateString()}`);
        return;
      }

      const result = await bookTimeSlot(request, {
        timeSlot: availableTimes[0]
      });

      if (result) {
        let message = '<b>✅ Time Booked!</b>\n';
        message += `<b>Date:</b> ${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}\n`;
        message += `<b>Time:</b> ${availableTimes[0].time}\n`;
        message += `<b>Course:</b> ${result.details.startingTee.split(' ')[0]}\n`;
        message += `<b>Booking ID:</b> ${result.bookingId}\n`;
        message += `<b>Participants:</b> ${result.details.participants.join(', ')}`;
        await ctx.reply(message, { parse_mode: 'HTML' });
      } else {
        await ctx.reply('❌ Booking failed - no confirmation received');
      }
    } catch (error) {
      logError('bookTime', error);
      await ctx.reply(`❌ Error: ${getSafeUserMessage(error)}`);
    }
  });
}
