import { parse as parseDate } from 'chrono-node';

import { Course, getCourseAvailability } from 'requests/golfBooking';
import { getGolfClubName } from 'shared/env';
import { getLogin } from 'storage/logins';
import { addMonitor } from 'storage/monitors';
import { getOrCreateSession } from 'shared/sessionCache';
import { getMonitorBookCallbackData } from 'command/bookTime';
import { Bot } from 'grammy';

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

export function monitorCommand(bot: Bot): void {
  bot.on('message').command('monitor', async (ctx) => {
    const msg = ctx.msg;
    const command = msg.text;
    const match = /\/monitor\s+(.*)/i.exec(command);

    if (!match?.[1]) {
      await ctx.reply(
        `Usage: /monitor (date) from (startTime) - (endTime)\nExample: /monitor tomorrow from 08:00 - 10:00`
      );
      return;
    }

    const course = Course.Kilspindie;
    const dateString = match[1];
    // forwardDate: true ensures "Saturday" means NEXT Saturday, not last
    const date = parseDate(dateString, undefined, { forwardDate: true });

    if (!date || date.length === 0 || !date[0]?.start) {
      await ctx.reply(
        '❌ Could not understand date input.\nExample: /monitor Saturday from 08:00 - 10:00'
      );
      return;
    }

    const start = date[0].start.date();

    // Build end date: prefer parsed end/second result, fallback to end-of-day
    let end =
      date[0].end?.date() ??
      date[1]?.start.date() ??
      new Date(new Date(start).setUTCHours(23, 59, 59));

    if (!date[0].end?.date() && !date[1]?.start.date()) {
      start.setUTCHours(0, 0, 0);
    }

    // Clamp end date to same calendar day as start (chrono can overshoot with
    // forwardDate on ranges like "Saturday from 08:00 - 10:00")
    if (
      end.getFullYear() !== start.getFullYear() ||
      end.getMonth() !== start.getMonth() ||
      end.getDate() !== start.getDate()
    ) {
      end = new Date(start);
      // Use the parsed end's time-of-day but on the start's date
      const parsedEnd =
        date[0].end?.date() ?? date[1]?.start.date() ?? null;
      if (parsedEnd) {
        end.setHours(parsedEnd.getHours(), parsedEnd.getMinutes(), 0, 0);
      } else {
        end.setHours(23, 59, 59, 0);
      }
    }

    const credentials = await getLogin(msg.from.id);

    if (!credentials) {
      await ctx.reply('You are not authenticated');
      return;
    }

    await addMonitor(msg.from.id, course, start, end);

    let message = '<b>Monitor added</b>\n';
    message += `<b>Course:</b> ${getGolfClubName()}\n`;
    message += `<b>Window:</b> ${start.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} – ${end.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}\n\n`;
    message += 'Use /monitors to see or remove your active monitors.';

    await ctx.reply(message, { parse_mode: 'HTML' });

    // Immediate lookup: if any time in window is available, offer to book
    try {
      const request = await getOrCreateSession(
        msg.from.id,
        credentials.username,
        credentials.password
      );
      let availability = await getCourseAvailability(request, {
        course,
        date: start
      });
      const rawCount = availability.length;
      // Use local time for window (set TZ=Europe/London so this matches club)
      const startTime = `${pad2(start.getHours())}:${pad2(start.getMinutes())}`;
      const endTime = `${pad2(end.getHours())}:${pad2(end.getMinutes())}`;
      availability = availability.filter((el) => {
        const t = el.time.trim();
        const h = t.split(':')[0]?.replace(/\D/g, '') ?? '0';
        const m = t.split(':')[1]?.replace(/\D/g, '') ?? '0';
        const norm = `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
        return norm >= startTime && norm <= endTime;
      });
      console.log(
        '[Monitor] immediate lookup date=',
        `${start.getDate()}-${start.getMonth() + 1}-${start.getFullYear()}`,
        'window=',
        startTime,
        '-',
        endTime,
        'raw=',
        rawCount,
        'inWindow=',
        availability.length
      );
      if (availability.length > 0) {
        const times = availability.map((s) => s.time);
        let alert = '<b>⏰ Time(s) available now in your window</b>\n\n';
        alert += `<b>Course:</b> ${getGolfClubName()}\n`;
        alert += `<b>Date:</b> ${start.getDate()}/${start.getMonth() + 1}/${start.getFullYear()}\n\n`;
        if (times.length === 1) {
          alert += `<b>${times[0]}</b> is available. Want to book?`;
        } else {
          alert += `${times.join(', ')} available. Want to book?`;
        }
        const inline_keyboard = availability.map((slot) => [
          {
            text: `Book ${slot.time}`,
            callback_data: getMonitorBookCallbackData(start, slot.time)
          }
        ]);
        await ctx.reply(alert, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard }
        });
      }
    } catch (err) {
      console.error(
        '[Monitor] immediate lookup failed:',
        err instanceof Error ? err.message : String(err)
      );
    }
  });
}
