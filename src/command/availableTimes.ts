import { parse } from 'chrono-node';

import { Course, getCourseAvailability } from 'requests/golfBooking';
import { getLogin } from 'storage/logins';
import { getOrCreateSession } from 'shared/sessionCache';
import { Bot } from 'grammy';

export function availableTimesCommand(bot: Bot): void {
  bot.on('message').command('availabletimes', async (ctx) => {
    const msg = ctx.msg;
    const command = msg.text;
    const match = /\/availabletimes\s+(.*)/i.exec(command);

    if (!match?.[1]) {
      await ctx.reply('Usage: /availabletimes (date)\nExample: /availabletimes today, /availabletimes tomorrow');
      return;
    }

    const dateString = match[1];
    const results = parse(dateString);
    if (!results || results.length === 0) {
      await ctx.reply('❌ Could not understand date input!');
      return;
    }

    const date = results[0].start.date();

    const credentials = await getLogin(msg.from.id);

    if (!credentials) {
      await ctx.reply('❌ Not authenticated. Use /login first.');
      return;
    }

    try {
      const startTime = Date.now();
      const request = await getOrCreateSession(msg.from.id, credentials.username, credentials.password);
      const availableTimes = await getCourseAvailability(request, {
        course: Course.Kilspindie,
        date
      });
      const duration = Date.now() - startTime;

      if (availableTimes.length === 0) {
        await ctx.reply(
          `📅 <b>Available Times - Kilspindie</b>\n` +
          `<b>Date:</b> ${date.toDateString()}\n\n` +
          `❌ No available tee times\n\n` +
          `<i>Fetched in ${duration}ms</i>`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      let message = `📅 <b>Available Times - Kilspindie</b>\n`;
      message += `<b>Date:</b> ${date.toDateString()}\n`;
      message += `<b>Times Available:</b> ${availableTimes.length}\n\n`;

      availableTimes.forEach((timeSlot) => {
        const bookable = timeSlot.canBook ? '✅' : '❌';
        message += `${bookable} <b>${timeSlot.time}</b>\n`;
      });

      message += `\n<i>Fetched in ${duration}ms</i>`;

      await ctx.reply(message, { parse_mode: 'HTML' });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      console.error('availableTimes error:', error);
      await ctx.reply(`❌ Error: ${msg}`);
    }
  });
}
