import { AsyncTask, CronJob, SimpleIntervalJob, ToadScheduler } from 'toad-scheduler';

import rp from 'request-promise';

import { deleteAutoBooking, getAllAutoBookings } from 'storage/autoBookings';
import {
  getAutoBookingConfig,
  formatGolfersList
} from 'storage/autoBookingConfig';
import {
  bookTimeSlot,
  getCourseAvailability,
  login
} from 'requests/golfBooking';
import {
  getAutoBookingRandomSlot,
  getDaysAheadToBook,
  getBookingOpensHour,
  getBookingOpensMinute,
  getGolfClubName
} from 'shared/env';
import { getLogin } from 'storage/logins';
import { Bot } from 'grammy';
import { RequestAPI, RequiredUriUrl } from 'request';

let loginCache: {
  [key: string]: RequestAPI<
    rp.RequestPromise<unknown>,
    rp.RequestPromiseOptions,
    RequiredUriUrl
  >;
} = {};

// Global scheduler reference to prevent garbage collection
let autoScheduler: ToadScheduler | null = null;

/** Normalize time string to HH:MM for comparison. */
function normalizeTime(t: string): string {
  const parts = t.trim().split(':');
  const h = parts[0]?.replace(/\D/g, '') ?? '0';
  const m = parts[1]?.replace(/\D/g, '') ?? '0';
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
}

/** Convert HH:MM to total minutes for distance comparison. */
function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Calculate when bookings open for a given play date.
 * Returns the exact datetime when the club allows booking.
 */
function getBookingOpensAt(playDate: Date): Date {
  const opens = new Date(playDate);
  opens.setDate(opens.getDate() - getDaysAheadToBook());
  opens.setHours(getBookingOpensHour(), getBookingOpensMinute(), 0, 0);
  return opens;
}

export function scheduledAutoBookingsMonitor(bot: Bot): void {
  if (autoScheduler) return;
  autoScheduler = new ToadScheduler();
  const scheduler = autoScheduler;

  const autoBookingJob = new AsyncTask('autoBookings', async () => {
    const autoBookings = await getAllAutoBookings();
    const userIds = Object.keys(autoBookings).map((k) =>
      Number.parseInt(k, 10)
    );

    if (userIds.length === 0) return;

    for (const userId of userIds) {
      const userAutoBookings = autoBookings[userId];

      let request = loginCache[userId];
      if (!request) {
        request = rp.defaults({
          jar: rp.jar(),
          followAllRedirects: true,
          timeout: 15000
        });
        const credentials = await getLogin(userId);
        if (!credentials) {
          console.warn('[AutoBook] skipping user (no credentials)');
          continue;
        }
        try {
          const loginSuccess = await login(request, {
            username: credentials.username,
            password: credentials.password
          });
          if (!loginSuccess) {
            console.warn('[AutoBook] login failed for user');
            continue;
          }
          loginCache[userId] = request;
        } catch (error) {
          console.error('[AutoBook] login error');
          continue;
        }
      }

      for (const autoBooking of userAutoBookings) {
        const { course, startDate, endDate } = autoBooking;
        const now = new Date();
        const bookingId = autoBooking.id.slice(0, 8);

        // Clean up expired bookings
        if (now > endDate) {
          console.log(`[AutoBook] ${bookingId} expired, removing`);
          await deleteAutoBooking(autoBooking.id, userId);
          continue;
        }

        // BOOKING WINDOW CHECK: Don't poll until bookings have opened.
        // Bookings open DAYS_AHEAD days before the play date at BOOKING_HOUR:BOOKING_MINUTE.
        const bookingOpensAt = getBookingOpensAt(startDate);
        if (now < bookingOpensAt) {
          const msUntilOpen = bookingOpensAt.getTime() - now.getTime();
          const hoursUntilOpen = (msUntilOpen / 1000 / 60 / 60).toFixed(1);
          console.log(
            `[AutoBook] ${bookingId} waiting — booking opens ${bookingOpensAt.toLocaleString('en-GB')} (${hoursUntilOpen}h)`
          );
          continue;
        }

        // Bookings are open — try to grab a slot
        console.log(
          `[AutoBook] ${bookingId} booking window OPEN, checking availability...`
        );

        try {
          let availability = await getCourseAvailability(request, {
            course,
            date: startDate
          });

          console.log(
            `[AutoBook] ${bookingId} found ${availability.length} total slots`
          );

          if (availability.length === 0) continue;

          // Filter to time window using local time (matches club)
          const startTime = normalizeTime(
            `${startDate.getHours()}:${startDate.getMinutes()}`
          );
          const endTime = normalizeTime(
            `${endDate.getHours()}:${endDate.getMinutes()}`
          );

          availability = availability.filter((el) => {
            const t = normalizeTime(el.time);
            return el.canBook && t >= startTime && t <= endTime;
          });

          if (availability.length === 0) {
            console.log(
              `[AutoBook] ${bookingId} no bookable slots in ${startTime}–${endTime}`
            );
            continue;
          }

          console.log(
            `[AutoBook] ${bookingId} ${availability.length} slots in window: ${availability.map((s) => s.time).join(', ')}`
          );

          // Sort by proximity to preferred time (if set), otherwise earliest first
          if (autoBooking.preferredTime) {
            const pref = normalizeTime(autoBooking.preferredTime);
            availability.sort((a, b) => {
              const aN = normalizeTime(a.time);
              const bN = normalizeTime(b.time);
              const aDiff = Math.abs(timeToMinutes(aN) - timeToMinutes(pref));
              const bDiff = Math.abs(timeToMinutes(bN) - timeToMinutes(pref));
              return aDiff - bDiff;
            });
            console.log(
              `[AutoBook] ${bookingId} preferred=${pref}, sorted: ${availability.map((s) => s.time).join(', ')}`
            );
          } else if (getAutoBookingRandomSlot() && availability.length > 1) {
            // Random from top 3 (stealth mode) — only if no preferred time
            const pick = Math.floor(
              Math.random() * Math.min(3, availability.length)
            );
            const [chosen] = availability.splice(pick, 1);
            availability.unshift(chosen);
          }

          let bookedSlot = null;
          let bookedTimeSlot = null;

          const maxAttempts = Math.min(3, availability.length);
          for (let i = 0; i < maxAttempts; i++) {
            const timeSlot = availability[i];
            if (!timeSlot) break;

            console.log(
              `[AutoBook] ${bookingId} attempting ${timeSlot.time}...`
            );
            try {
              bookedSlot = await bookTimeSlot(request, { timeSlot });
              if (bookedSlot) {
                bookedTimeSlot = timeSlot;
                break;
              }
            } catch (error) {
              console.error(
                `[AutoBook] ${bookingId} booking attempt failed:`,
                error
              );
            }
          }

          if (bookedSlot && bookedTimeSlot) {
            let message = '<b>✅ Auto Booked!</b>\n';
            message += `<b>Date:</b> ${startDate.getDate()}/${startDate.getMonth() + 1}/${startDate.getFullYear()}\n`;
            message += `<b>Time:</b> ${bookedTimeSlot.time}\n`;
            message += `<b>Course:</b> ${bookedSlot.startingTee?.split(' ')[0] ?? getGolfClubName()}\n`;
            if (autoBooking.useConfigGolfers) {
              const config = await getAutoBookingConfig();
              const golfersList = config.golfers?.length
                ? formatGolfersList(config.golfers)
                : null;
              message += `<b>Participants:</b> ${golfersList ?? bookedSlot.participants.join(', ')}\n`;
            } else {
              message += `<b>Participants:</b> ${bookedSlot.participants.join(', ')}\n`;
            }

            await bot.api.sendMessage(userId, message, {
              parse_mode: 'HTML'
            });
            console.log(
              `[AutoBook] ${bookingId} SUCCESS — booked ${bookedTimeSlot.time}`
            );
            await deleteAutoBooking(autoBooking.id, userId);
          } else {
            console.log(
              `[AutoBook] ${bookingId} all attempts failed, will retry next cycle`
            );
          }
        } catch (error) {
          console.error(
            `[AutoBook] ${bookingId} error:`,
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    }
  });

  const clearCache = new AsyncTask('clearLoginCache', async () => {
    console.log('[AutoBook] clearing login cache');
    loginCache = {};
  });

  const clearCacheJob = new CronJob(
    { cronExpression: '0 0 23 * * *' },
    clearCache
  );

  scheduler.addCronJob(clearCacheJob);

  // Poll every 5 minutes. The booking-window check inside the job
  // ensures we only hit the club site when bookings are actually open.
  const autoBookingPoll = new SimpleIntervalJob(
    { seconds: 300, runImmediately: true },
    autoBookingJob,
    {
      id: 'autoBookingPoll',
      preventOverrun: true
    }
  );

  scheduler.addSimpleIntervalJob(autoBookingPoll);

  // FAST POLL: Every 2 seconds from booking-opens time for 5 minutes (HH:45–HH:50).
  // This gives us the best chance of grabbing a slot the instant it goes live.
  const bookingHour = getBookingOpensHour();
  const bookingMin = getBookingOpensMinute();
  const fastPollEnd = Math.min(59, bookingMin + 5);
  const fastPollCron = `*/2 ${bookingMin}-${fastPollEnd} ${bookingHour} * * *`;

  const fastPollJob = new CronJob(
    { cronExpression: fastPollCron },
    autoBookingJob,
    {
      id: 'autoBookingFastPoll',
      preventOverrun: true
    }
  );

  scheduler.addCronJob(fastPollJob);
  console.log(
    `✅ Auto Bookings Monitor started (5min poll + fast 2s poll at ${bookingHour}:${String(bookingMin).padStart(2, '0')}–${bookingHour}:${String(fastPollEnd).padStart(2, '0')})`
  );
}
