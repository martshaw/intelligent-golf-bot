import { parse } from 'chrono-node';

import {
  bookTimeSlot,
  Course,
  getCourseAvailability,
  addMemberPartner,
  addGuestPartner,
  resolvePartnerIdByName,
  BookingResult
} from 'requests/golfBooking';
import { getSafeUserMessage, logError } from 'shared/errorHandling';
import { getGolfClubName } from 'shared/env';
import { getLogin } from 'storage/logins';
import { getOrCreateSession } from 'shared/sessionCache';
import {
  getAutoBookingConfig,
  saveAutoBookingConfig,
  formatGolfersList
} from 'storage/autoBookingConfig';
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

/**
 * After booking, add partners from autoBookingConfig.json.
 * Returns array of result strings for display.
 */
async function addPartnersFromConfig(
  request: Parameters<typeof addMemberPartner>[0],
  bookingId: string
): Promise<string[]> {
  const config = await getAutoBookingConfig();
  const golfers = config.golfers ?? [];
  const partners = golfers.slice(1); // skip [0] = booker
  const results: string[] = [];
  let configUpdated = false;

  for (let slot = 2; slot <= partners.length + 1; slot++) {
    const golfer = partners[slot - 2];
    if (!golfer) continue;

    // Human-like delay
    const delay = 3000 + Math.floor(Math.random() * 5000);
    await new Promise((r) => setTimeout(r, delay));

    const fullName = `${golfer.firstname} ${golfer.surname}`;
    try {
      if (golfer.type === 'guest') {
        const ok = await addGuestPartner(request, {
          bookingId,
          slot,
          firstname: golfer.firstname,
          surname: golfer.surname
        });
        results.push(ok ? `✅ ${fullName} (guest)` : `❌ ${fullName} (guest failed)`);
      } else {
        let pid = golfer.partnerId ?? null;
        if (!pid) {
          pid = await resolvePartnerIdByName(request, {
            bookingId,
            firstname: golfer.firstname,
            surname: golfer.surname
          });
          if (pid) {
            golfer.partnerId = pid;
            configUpdated = true;
          }
        }
        if (pid) {
          const ok = await addMemberPartner(request, { bookingId, partnerId: pid, slot });
          results.push(ok ? `✅ ${fullName}` : `❌ ${fullName} (assign failed)`);
        } else {
          results.push(`❌ ${fullName} (not found)`);
        }
      }
    } catch (err) {
      results.push(`❌ ${fullName} (error)`);
    }
  }

  if (configUpdated) {
    await saveAutoBookingConfig(config);
  }
  return results;
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
      // Monitor-book: single player (1 slot)
      const result = await bookTimeSlot(request, { timeSlot: slot, numslots: 1 });
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
    const match = /\/booktime\s+(.*)/i.exec(command);

    if (!match?.[1]) {
      let usage = 'Usage: /booktime (date) [time] [with golfers]\n\n';
      usage += 'Examples:\n';
      usage += '/booktime tomorrow — books first available, 1 player\n';
      usage += '/booktime Saturday 09:12 — books 09:12, 1 player\n';
      usage += '/booktime Saturday 09:12 with golfers — books 09:12, 3 players + assigns partners';
      await ctx.reply(usage);
      return;
    }

    // Fast-fail: check credentials early
    const credentials = await getLogin(msg.from.id);
    if (!credentials) {
      await ctx.reply('❌ Not authenticated. Use /login first.');
      return;
    }

    let raw = match[1].trim();

    // Parse "with golfers" flag
    const withGolfers = /\bwith\s+golfers\b/i.test(raw);
    raw = raw.replace(/\bwith\s+golfers\b/gi, '').trim();

    // Extract explicit time (HH:MM) from input before passing to chrono
    let requestedTime: string | null = null;
    const timeMatch = /\b(\d{1,2})[.:](\d{2})\b/.exec(raw);
    if (timeMatch) {
      requestedTime = `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}`;
    }

    // Parse date
    const results = parse(raw, undefined, { forwardDate: true });
    if (!results || results.length === 0) {
      await ctx.reply(
        '❌ Could not understand date input!\nExample: tomorrow, Saturday 09:12, 2026-03-15'
      );
      return;
    }

    const date = results[0].start.date();

    // Determine numslots
    const config = withGolfers ? await getAutoBookingConfig() : null;
    const numslots = withGolfers ? (config?.golfers?.length ?? 1) : 1;

    try {
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

      // Find the requested time or fall back to first available
      let slot = availableTimes[0];
      if (requestedTime) {
        const exact = availableTimes.find(
          (s) => normalizeTime(s.time) === requestedTime
        );
        if (exact) {
          slot = exact;
        } else {
          await ctx.reply(
            `❌ ${requestedTime} is not available.\n\nAvailable: ${availableTimes
              .slice(0, 10)
              .map((s) => s.time)
              .join(', ')}${availableTimes.length > 10 ? '…' : ''}`
          );
          return;
        }
      }

      const statusMsg = await ctx.reply(
        `⏳ Booking ${slot.time} for ${numslots} player${numslots > 1 ? 's' : ''}…`
      );

      const result = await bookTimeSlot(request, { timeSlot: slot, numslots });

      if (result) {
        let message = '<b>✅ Time Booked!</b>\n';
        message += `<b>Date:</b> ${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}\n`;
        message += `<b>Time:</b> ${slot.time}\n`;
        message += `<b>Course:</b> ${result.details.startingTee?.split(' ')[0] ?? getGolfClubName()}\n`;
        message += `<b>Booking ID:</b> ${result.bookingId}\n`;
        message += `<b>Players:</b> ${numslots}\n`;

        // Add partners if requested
        if (withGolfers && numslots > 1) {
          message += `\n⏳ Adding partners…\n`;
          await ctx.reply(message, { parse_mode: 'HTML' });

          const partnerResults = await addPartnersFromConfig(
            request,
            result.bookingId
          );

          let partnerMsg = '<b>Partner Assignment</b>\n';
          for (const pr of partnerResults) {
            partnerMsg += `  ${pr}\n`;
          }
          await ctx.reply(partnerMsg, { parse_mode: 'HTML' });
        } else {
          message += `<b>Participants:</b> ${result.details.participants.join(', ')}`;
          await ctx.reply(message, { parse_mode: 'HTML' });
        }
      } else {
        await ctx.reply('❌ Booking failed - no confirmation received');
      }
    } catch (error) {
      logError('bookTime', error);
      await ctx.reply(`❌ Error: ${getSafeUserMessage(error)}`);
    }
  });
}
