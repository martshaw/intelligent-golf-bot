import { AsyncTask, CronJob, SimpleIntervalJob, ToadScheduler } from 'toad-scheduler';

import rp from 'request-promise';

import { deleteAutoBooking, getAllAutoBookings } from 'storage/autoBookings';
import {
  getAutoBookingConfig,
  formatGolfersList
} from 'storage/autoBookingConfig';
import {
  bookTimeSlot,
  getBookings,
  getCourseAvailability,
  login,
  verifyLoggedIn,
  NotLoggedInError,
  addMemberPartner,
  addGuestPartner,
  resolvePartnerIdByName,
  BookingResult
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
import {
  GolferEntry,
  saveAutoBookingConfig
} from 'storage/autoBookingConfig';

let loginCache: {
  [key: string]: RequestAPI<
    rp.RequestPromise<unknown>,
    rp.RequestPromiseOptions,
    RequiredUriUrl
  >;
} = {};

/** When each cached login was taken (ms since epoch). */
let loginTakenAt: { [key: string]: number } = {};

/** Entry ids that have already had a fresh login since their window opened. */
const freshLoginDoneFor = new Set<string>();

/** Cached logins older than this are replaced before window work. */
const MAX_LOGIN_AGE_MS = 30 * 60 * 1000;

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

/**
 * True if an existing club booking is on the same calendar day as playDate.
 * Club dates look like "Sunday 18th October" (no year), so compare day + month.
 */
function hasBookingOnDay(
  bookings: { date: string }[],
  playDate: Date
): boolean {
  const month = playDate.toLocaleString('en-GB', { month: 'long' }).toLowerCase();
  const day = playDate.getDate();
  return bookings.some((b) => {
    const m = /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)/.exec(b.date);
    return !!m && Number(m[1]) === day && m[2]!.toLowerCase() === month;
  });
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

      // Before any entry whose window is open uses the cached login, make
      // sure it is still valid: the club expires idle sessions long before
      // the nightly cache clear, and an expired session sees the visitor
      // page (0 slots).
      const nowForLogin = new Date();
      const openEntries = userAutoBookings.filter(
        (ab) =>
          nowForLogin <= ab.endDate && nowForLogin >= getBookingOpensAt(ab.startDate)
      );
      if (loginCache[userId] && openEntries.length > 0) {
        const needsFresh = openEntries.some((ab) => !freshLoginDoneFor.has(ab.id));
        const age = Date.now() - (loginTakenAt[userId] ?? 0);
        if (needsFresh) {
          console.log('[AutoBook] fresh login for window');
          delete loginCache[userId];
        } else if (age > MAX_LOGIN_AGE_MS) {
          console.log('[AutoBook] cached login older than 30 min, re-logging in');
          delete loginCache[userId];
        } else if (!(await verifyLoggedIn(loginCache[userId]!))) {
          console.log('[AutoBook] cached login invalid, re-logging in');
          delete loginCache[userId];
        }
      }

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
          loginTakenAt[userId] = Date.now();
          for (const ab of openEntries) freshLoginDoneFor.add(ab.id);
        } catch (error) {
          console.error(
            '[AutoBook] login error:',
            error instanceof Error ? error.message : String(error)
          );
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

        // Already booked on this day? Stop polling and drop the request.
        try {
          const existing = await getBookings(request);
          if (hasBookingOnDay(existing, startDate)) {
            console.log(
              `[AutoBook] ${bookingId} already booked on ${startDate.toDateString()}, removing`
            );
            await deleteAutoBooking(autoBooking.id, userId);
            continue;
          }
        } catch (error) {
          console.error(
            `[AutoBook] ${bookingId} existing-booking check failed:`,
            error instanceof Error ? error.message : String(error)
          );
        }

        // Bookings are open — try to grab a slot
        console.log(
          `[AutoBook] ${bookingId} booking window OPEN, checking availability...`
        );

        try {
          let availability = await getCourseAvailability(request, {
            course,
            date: startDate,
            throwIfLoggedOut: true
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

          let bookedResult: BookingResult | null = null;
          let bookedTimeSlot = null;

          const maxAttempts = Math.min(3, availability.length);
          for (let i = 0; i < maxAttempts; i++) {
            const timeSlot = availability[i];
            if (!timeSlot) break;

            console.log(
              `[AutoBook] ${bookingId} attempting ${timeSlot.time}...`
            );
            try {
              bookedResult = await bookTimeSlot(request, { timeSlot });
              if (bookedResult) {
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

          if (bookedResult && bookedTimeSlot) {
            const { bookingId: clubBookingId, details: bookedSlot } =
              bookedResult;

            // --- Partner Assignment ---
            const partnerResults: string[] = [];
            if (autoBooking.useConfigGolfers) {
              const config = await getAutoBookingConfig();
              const golfers = config.golfers ?? [];
              // Skip golfer[0] — that's the booker (already Player 1)
              const partners = golfers.slice(1);
              let configUpdated = false;

              for (let slot = 2; slot <= partners.length + 1; slot++) {
                const golfer = partners[slot - 2];
                if (!golfer) continue;

                // Human-like delay between partner additions (3-8 seconds)
                const delay =
                  3000 + Math.floor(Math.random() * 5000);
                await new Promise((r) => setTimeout(r, delay));

                const fullName = `${golfer.firstname} ${golfer.surname}`;
                try {
                  if (golfer.type === 'guest') {
                    const success = await addGuestPartner(request, {
                      bookingId: clubBookingId,
                      slot,
                      firstname: golfer.firstname,
                      surname: golfer.surname
                    });
                    partnerResults.push(
                      success
                        ? `✅ ${fullName} (guest)`
                        : `❌ ${fullName} (guest failed)`
                    );
                  } else {
                    // Member — use cached partnerId or look it up
                    let pid = golfer.partnerId ?? null;
                    if (!pid) {
                      pid = await resolvePartnerIdByName(request, {
                        bookingId: clubBookingId,
                        firstname: golfer.firstname,
                        surname: golfer.surname
                      });
                      if (pid) {
                        // Cache the partnerId for next time
                        golfer.partnerId = pid;
                        configUpdated = true;
                        console.log(
                          `[AutoBook] cached partnerId=${pid} for ${fullName}`
                        );
                      }
                    }

                    if (pid) {
                      const success = await addMemberPartner(request, {
                        bookingId: clubBookingId,
                        partnerId: pid,
                        slot
                      });
                      partnerResults.push(
                        success
                          ? `✅ ${fullName}`
                          : `❌ ${fullName} (assign failed)`
                      );
                    } else {
                      partnerResults.push(
                        `❌ ${fullName} (member not found)`
                      );
                    }
                  }
                } catch (partnerError) {
                  console.error(
                    `[AutoBook] partner error for ${fullName}:`,
                    partnerError instanceof Error
                      ? partnerError.message
                      : String(partnerError)
                  );
                  partnerResults.push(
                    `❌ ${fullName} (error)`
                  );
                }
              }

              // Persist cached partner IDs
              if (configUpdated) {
                await saveAutoBookingConfig(config);
              }
            }

            // --- Telegram Notification ---
            let message = '<b>✅ Auto Booked!</b>\n';
            message += `<b>Date:</b> ${startDate.getDate()}/${startDate.getMonth() + 1}/${startDate.getFullYear()}\n`;
            message += `<b>Time:</b> ${bookedTimeSlot.time}\n`;
            message += `<b>Course:</b> ${bookedSlot.startingTee?.split(' ')[0] ?? getGolfClubName()}\n`;
            message += `<b>Booking ID:</b> ${clubBookingId}\n`;

            if (partnerResults.length > 0) {
              message += `\n<b>Partners:</b>\n`;
              for (const pr of partnerResults) {
                message += `  ${pr}\n`;
              }
            } else if (autoBooking.useConfigGolfers) {
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
          if (error instanceof NotLoggedInError) {
            // Drop the session so the next check (2s in the fast poll) logs in again.
            console.warn(
              `[AutoBook] ${bookingId} not logged in (visitor page), dropping cached login`
            );
            delete loginCache[userId];
            delete loginTakenAt[userId];
            break;
          }
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
    loginTakenAt = {};
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
