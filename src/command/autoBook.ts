import { parse } from 'chrono-node';

import { Course } from 'requests/golfBooking';
import { getSafeUserMessage, logError } from 'shared/errorHandling';
import { getGolfClubName } from 'shared/env';
import { getLogin } from 'storage/logins';
import { addAutoBooking } from 'storage/autoBookings';
import { Bot } from 'grammy';

export function autoBookCommand(bot: Bot): void {
  bot.on('message').command('autobook', async (ctx) => {
    const msg = ctx.msg;
    const command = msg.text;
    const match = /\/autobook (.*)/i.exec(command);

    if (match?.length !== 2) {
      await ctx.reply(
        'Usage: /autobook (date) from (startTime) to (endTime) [with golfers]\nExample: /autobook tomorrow from 08:30 to 14:00\nAdd "with golfers" to use names from autoBookingConfig.json'
      );
      return;
    }

    const dateString = match[1].trim();
    const useConfigGolfers = /\bwith\s+golfers\b/i.test(dateString);
    const dateStringClean = dateString
      .replace(/\bwith\s+golfers\b/gi, '')
      .trim();
    const results = parse(dateStringClean);

    if (!results || results.length === 0) {
      await ctx.reply('❌ Could not understand date/time input!');
      return;
    }

    let startDate: Date;
    let endDate: Date | undefined;

    if (results.length >= 2) {
      // Multiple date/time ranges found (e.g., "tomorrow from 08:30 to 14:00")
      startDate = results[0].start.date();
      endDate = results[1].start.date() || results[0].end?.date();
    } else {
      // Single date found
      startDate = results[0].start.date();
      endDate = results[0].end?.date();
    }

    // Ensure endDate is set
    if (!endDate) {
      endDate = new Date(startDate);
      endDate.setHours(23, 59, 59);
    }

    // Validate same day
    if (
      startDate.getUTCDate() !== endDate.getUTCDate() ||
      startDate.getUTCMonth() !== endDate.getUTCMonth() ||
      startDate.getUTCFullYear() !== endDate.getUTCFullYear()
    ) {
      await ctx.reply('❌ Start and end times must be on the same day!');
      return;
    }

    // Validate time order
    if (startDate.getTime() >= endDate.getTime()) {
      await ctx.reply('❌ Start time must be before end time!');
      return;
    }

    const credentials = await getLogin(msg.from.id);

    if (!credentials) {
      await ctx.reply('❌ You are not authenticated. Use /login first.');
      return;
    }

    try {
      await addAutoBooking(msg.from.id, Course.Kilspindie, startDate, endDate, {
        useConfigGolfers
      });

      let message = '<b>✅ Auto Booking Added</b>\n';
      message += `<b>Course:</b> ${getGolfClubName()}\n`;
      message += `<b>Date:</b> ${startDate.toDateString()}\n`;
      message += `<b>Start Time:</b> ${startDate.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit'
      })}\n`;
      message += `<b>End Time:</b> ${endDate.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit'
      })}`;

      await ctx.reply(message, { parse_mode: 'HTML' });
    } catch (error) {
      logError('autoBook', error);
      await ctx.reply(`❌ An error occurred: ${getSafeUserMessage(error)}`);
    }
  });
}
