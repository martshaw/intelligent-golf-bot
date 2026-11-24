import { AsyncTask, CronJob, SimpleIntervalJob, ToadScheduler } from 'toad-scheduler';

import rp from 'request-promise';

import {
  AutoBooking,
  deleteAutoBooking,
  getAllAutoBookings
} from 'storage/autoBookings';
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
import { escapeHtml, htmlToPlain } from 'shared/html';
import { RequestAPI, RequiredUriUrl } from 'request';
import { saveAutoBookingConfig } from 'storage/autoBookingConfig';
import { clubPartyPort, fillParty } from 'booking/party';
import {
  normalizeTime,
  timeToMinutes,
  snipeWindow,
  filterAllowedTimes
} from 'scheduled/windowSnipe';
import {
  entryGolfers,
  entryNumSlots
} from 'scheduled/entryGolfers';

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

type ClubRequest = RequestAPI<
  rp.RequestPromise<unknown>,
  rp.RequestPromiseOptions,
  RequiredUriUrl
>;
type BookableSlot = Awaited<ReturnType<typeof getCourseAvailability>>[number];

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** Users whose pre-window snipe is running; the regular poll skips them. */
const snipeActiveFor = new Set<number>();
/** Entry ids that already had a snipe this process (one per entry). */
const snipedEntries = new Set<string>();

/** Start the pre-window login when the window is at most this far away. */
const SNIPE_LEAD_MS = 90 * 1000;
/** How long after the window opens the snipe keeps trying. */
const SNIPE_DURATION_MS = 20 * 1000;

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

/**
 * After a confirmed booking id: add partners, remove the auto-booking entry,
 * then send the Telegram confirmation (a notify failure can't leave the entry
 * behind or abort the caller). Shared by the regular poll and the snipe.
 */
async function completeAutoBooking(
  bot: Bot,
  request: ClubRequest,
  userId: number,
  autoBooking: AutoBooking,
  bookedResult: BookingResult,
  bookedTimeSlot: { time: string }
): Promise<void> {
  const { startDate } = autoBooking;
  const bookingId = autoBooking.id.slice(0, 8);
  const { bookingId: clubBookingId, details: bookedSlot } = bookedResult;

  // --- Partner Assignment (immediately; partners can be claimed within seconds) ---
  let partnerResults: string[] = [];
  const config = await getAutoBookingConfig();
  const players = entryGolfers(autoBooking, config.golfers);
  if (players) {
    // golfers[0] is the booker (already Player 1)
    const party = await fillParty(
      clubPartyPort(request),
      clubBookingId,
      players.golfers.slice(1)
    );
    partnerResults = party.lines;
    // Persist found partner IDs (only for golfers that came from the config)
    if (party.learnedIds && players.fromConfig) {
      await saveAutoBookingConfig(config);
    }
  }

  // The booking exists: clear the entry before anything that can fail.
  await deleteAutoBooking(autoBooking.id, userId);
  console.log(`[AutoBook] ${bookingId} entry cleared`);

  // --- Telegram Notification ---
  let message = '<b>✅ Auto Booked!</b>\n';
  message += `<b>Date:</b> ${startDate.getDate()}/${startDate.getMonth() + 1}/${startDate.getFullYear()}\n`;
  message += `<b>Time:</b> ${bookedTimeSlot.time}\n`;
  message += `<b>Course:</b> ${bookedSlot.startingTee?.split(' ')[0] ?? getGolfClubName()}\n`;
  message += `<b>Booking ID:</b> ${clubBookingId}\n`;

  if (partnerResults.length > 0) {
    message += `\n<b>Partners:</b>\n`;
    for (const pr of partnerResults) {
      message += `  ${escapeHtml(pr)}\n`;
    }
  } else if (players) {
    const golfersList = players.golfers.length
      ? formatGolfersList(players.golfers)
      : null;
    message += `<b>Participants:</b> ${escapeHtml(golfersList ?? bookedSlot.participants.join(', '))}\n`;
  } else {
    message += `<b>Participants:</b> ${escapeHtml(bookedSlot.participants.join(', '))}\n`;
  }

  console.log(
    `[AutoBook] ${bookingId} SUCCESS — booked ${bookedTimeSlot.time} id=${clubBookingId}`
  );
  await notifyBooked(bot, userId, bookingId, message);
}

/** Send the booking confirmation; on failure retry once as plain text. Never throws. */
async function notifyBooked(
  bot: Bot,
  userId: number,
  shortId: string,
  message: string
): Promise<void> {
  try {
    await bot.api.sendMessage(userId, message, { parse_mode: 'HTML' });
    return;
  } catch (error) {
    console.error(
      `[AutoBook] ${shortId} notify FAILED, retrying as plain text:`,
      error instanceof Error ? error.message : String(error)
    );
  }
  await sleep(5000);
  try {
    await bot.api.sendMessage(userId, htmlToPlain(message));
  } catch (error) {
    console.error(
      `[AutoBook] ${shortId} notify FAILED again (booking still made):`,
      error instanceof Error ? error.message : String(error)
    );
  }
}


/** Log in on a new cookie jar and confirm the member booking page loads. */
async function freshVerifiedLogin(userId: number): Promise<ClubRequest | null> {
  const credentials = await getLogin(userId);
  if (!credentials) return null;
  const request = rp.defaults({
    jar: rp.jar(),
    followAllRedirects: true,
    timeout: 15000
  });
  const ok = await login(request, {
    username: credentials.username,
    password: credentials.password
  });
  if (!ok) return null;
  return request;
}

/**
 * Pre-window snipe for one user's entries opening within SNIPE_LEAD_MS:
 * log in fresh ~60-90 s early, verify the session and the same-day rule,
 * then at the opening instant fetch only the ajax tee sheet and book via
 * snipeWindow (preferred first, short retries, fallback inside the window).
 * Anything not booked here is left to the regular 2 s fast poll.
 */
async function runWindowSnipe(
  bot: Bot,
  userId: number,
  entries: AutoBooking[]
): Promise<void> {
  const [first] = entries;
  if (!first) return;
  snipeActiveFor.add(userId);
  for (const e of entries) snipedEntries.add(e.id);
  try {
    let request: ClubRequest | null = null;
    for (let attempt = 1; attempt <= 2 && !request; attempt++) {
      try {
        const candidate = await freshVerifiedLogin(userId);
        if (!candidate) {
          console.warn(`[Snipe] pre-window login failed (try ${attempt})`);
          continue;
        }
        // Landing page + sheet: throws if the session is the visitor page.
        await getCourseAvailability(candidate, {
          course: first.course,
          date: first.startDate,
          throwIfLoggedOut: true
        });
        request = candidate;
      } catch (error) {
        console.warn(
          `[Snipe] pre-window session check failed (try ${attempt}):`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
    if (!request) return;
    loginCache[userId] = request;
    loginTakenAt[userId] = Date.now();
    for (const e of entries) freshLoginDoneFor.add(e.id);
    console.log('[Snipe] pre-window login verified');

    for (const autoBooking of entries) {
      const { course, startDate, endDate } = autoBooking;
      const shortId = autoBooking.id.slice(0, 8);
      const opensAt = getBookingOpensAt(startDate).getTime();

      try {
        const existing = await getBookings(request);
        if (hasBookingOnDay(existing, startDate)) {
          console.log(
            `[Snipe] ${shortId} already booked on ${startDate.toDateString()}, removing`
          );
          await deleteAutoBooking(autoBooking.id, userId);
          continue;
        }
      } catch (error) {
        console.error(
          `[Snipe] ${shortId} existing-booking check failed:`,
          error instanceof Error ? error.message : String(error)
        );
      }

      const waitMs = opensAt - Date.now();
      console.log(
        `[Snipe] ${shortId} ready; waiting ${(waitMs / 1000).toFixed(1)}s for ${new Date(opensAt).toLocaleTimeString('en-GB')}`
      );
      await sleep(waitMs);
      const req = request;
      const outcome = await snipeWindow<BookableSlot, BookingResult>(
        {
          fetchSlots: () =>
            getCourseAvailability(req, {
              course,
              date: startDate,
              skipLanding: true
            }),
          book: (slot) =>
            bookTimeSlot(req, {
              timeSlot: slot,
              numslots: entryNumSlots(autoBooking)
            }),
          now: () => Date.now(),
          sleep,
          log: (msg) => console.log(`[Snipe] ${shortId} ${msg}`)
        },
        {
          windowStart: normalizeTime(
            `${startDate.getHours()}:${startDate.getMinutes()}`
          ),
          windowEnd: normalizeTime(
            `${endDate.getHours()}:${endDate.getMinutes()}`
          ),
          preferredTime: autoBooking.preferredTime,
          allowedTimes: autoBooking.allowedTimes,
          deadline: Math.max(opensAt, Date.now()) + SNIPE_DURATION_MS
        }
      );
      if (outcome) {
        console.log(
          `[Snipe] ${shortId} booked ${outcome.slot.time} id=${outcome.result.bookingId}`
        );
        await completeAutoBooking(
          bot,
          req,
          userId,
          autoBooking,
          outcome.result,
          outcome.slot
        );
      } else {
        console.log(`[Snipe] ${shortId} no booking; fast poll will continue`);
      }
    }
  } catch (error) {
    console.error(
      '[Snipe] error:',
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    snipeActiveFor.delete(userId);
  }
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
      // A pre-window snipe owns this user's session until it finishes.
      if (snipeActiveFor.has(userId)) continue;
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
            `[AutoBook] ${bookingId} waiting — booking opens ${bookingOpensAt.toLocaleString('en-GB')} (${hoursUntilOpen}h)` +
              (autoBooking.golfers?.length
                ? ` — ${autoBooking.golfers.length} places: ${formatGolfersList(autoBooking.golfers)}`
                : '')
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

          availability = filterAllowedTimes(
            availability.filter((el) => {
              const t = normalizeTime(el.time);
              return el.canBook && t >= startTime && t <= endTime;
            }),
            autoBooking.allowedTimes
          );

          if (availability.length === 0) {
            const range = autoBooking.allowedTimes?.length
              ? `allowed times ${autoBooking.allowedTimes.map(normalizeTime).join(', ')}`
              : `${startTime}–${endTime}`;
            console.log(
              `[AutoBook] ${bookingId} no bookable slots in ${range}`
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
              bookedResult = await bookTimeSlot(request, {
                timeSlot,
                numslots: entryNumSlots(autoBooking)
              });
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
            await completeAutoBooking(
              bot,
              request,
              userId,
              autoBooking,
              bookedResult,
              bookedTimeSlot
            );
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

  // SNIPE CHECK: every 15 s, start a pre-window snipe for any entry whose
  // window opens within SNIPE_LEAD_MS (so login starts ~75-90 s early).
  const snipeCheck = new AsyncTask('autoBookingSnipeCheck', async () => {
    const all = await getAllAutoBookings();
    const now = Date.now();
    for (const key of Object.keys(all)) {
      const userId = Number.parseInt(key, 10);
      if (snipeActiveFor.has(userId)) continue;
      const due = (all[userId] ?? []).filter((ab) => {
        if (snipedEntries.has(ab.id)) return false;
        const lead = getBookingOpensAt(ab.startDate).getTime() - now;
        return lead > 0 && lead <= SNIPE_LEAD_MS && now < ab.endDate.getTime();
      });
      if (due.length === 0) continue;
      console.log(`[Snipe] starting for ${due.length} entr${due.length === 1 ? 'y' : 'ies'}`);
      void runWindowSnipe(bot, userId, due);
    }
  });
  scheduler.addSimpleIntervalJob(
    new SimpleIntervalJob({ seconds: 15, runImmediately: true }, snipeCheck, {
      id: 'autoBookingSnipeCheck',
      preventOverrun: true
    })
  );

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
