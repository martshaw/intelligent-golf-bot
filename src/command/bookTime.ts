import { parse } from 'chrono-node';

import {
  bookTimeSlot,
  Course,
  getCourseAvailability
} from 'requests/golfBooking';
import { getLogin } from 'storage/logins';
import { getOrCreateSession } from 'shared/sessionCache';
import { Bot } from 'grammy';

export function bookTimeCommand(bot: Bot): void {
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
      await ctx.reply('❌ Could not understand date input!\nExample: tomorrow, next Friday, 2026-03-15');
      return;
    }

    const date = results[0].start.date();

    try {
      // Reuse or create session
      const request = await getOrCreateSession(msg.from.id, credentials.username, credentials.password);

      const availableTimes = await getCourseAvailability(request, {
        course: Course.Kilspindie,
        date
      });

      if (availableTimes.length === 0) {
        await ctx.reply(`❌ No available tee times on ${date.toDateString()}`);
        return;
      }

      const details = await bookTimeSlot(request, { timeSlot: availableTimes[0] });

      if (details) {
        let message = '<b>✅ Time Booked!</b>\n';
        message += `<b>Date:</b> ${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}\n`;
        message += `<b>Time:</b> ${availableTimes[0].time}\n`;
        message += `<b>Course:</b> ${details.startingTee.split(' ')[0]}\n`;
        message += `<b>Participants:</b> ${details.participants.join(', ')}`;
        await ctx.reply(message, { parse_mode: 'HTML' });
      } else {
        await ctx.reply('❌ Booking failed - no confirmation received');
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      console.error('bookTime error:', error);
      await ctx.reply(`❌ Error: ${msg}`);
    }
  });
}
