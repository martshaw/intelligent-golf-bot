import { AsyncTask, CronJob, ToadScheduler } from 'toad-scheduler';

import { getAllRecurringBookings } from 'storage/recurringBookings';
import { getAllAutoBookings } from 'storage/autoBookings';
import {
  getDaysAheadToBook,
  getGolfClubName,
  getBookingOpensHour,
  getBookingOpensMinute
} from 'shared/env';
import { Bot } from 'grammy';
import { addAutoBooking } from 'storage/autoBookings';

// Global scheduler reference to prevent garbage collection
let recurringScheduler: ToadScheduler | null = null;

/**
 * Calculate the booking-opens datetime for a target play date.
 * Bookings open DAYS_AHEAD days before at BOOKING_HOUR:BOOKING_MINUTE.
 */
function getBookingOpensDate(playDate: Date): Date {
  const opens = new Date(playDate);
  opens.setDate(opens.getDate() - getDaysAheadToBook());
  opens.setHours(getBookingOpensHour(), getBookingOpensMinute(), 0, 0);
  return opens;
}

/**
 * Check if an auto-booking already exists for this user/course/date/window
 * to avoid creating duplicates on every cron tick.
 */
async function autoBookingExists(
  userId: number,
  targetDate: Date,
  startHour: number,
  startMin: number
): Promise<boolean> {
  const allAuto = await getAllAutoBookings();
  const userAutos = allAuto[userId] ?? [];
  return userAutos.some((ab) => {
    const sd = new Date(ab.startDate);
    return (
      sd.getDate() === targetDate.getDate() &&
      sd.getMonth() === targetDate.getMonth() &&
      sd.getFullYear() === targetDate.getFullYear() &&
      sd.getHours() === startHour &&
      sd.getMinutes() === startMin
    );
  });
}

export function scheduledRecurringBookingsMonitor(bot: Bot): void {
  if (recurringScheduler) return;
  recurringScheduler = new ToadScheduler();
  const scheduler = recurringScheduler;

  const recurringBookingJob = new AsyncTask('recurringBookings', async () => {
    const recurringBookings = await getAllRecurringBookings();
    const daysAhead = getDaysAheadToBook();

    for (const userKey in recurringBookings) {
      if (!Object.hasOwnProperty.call(recurringBookings, userKey)) continue;
      const userId = Number.parseInt(userKey, 10);
      const userRecurringBookings = recurringBookings[userKey] ?? [];

      for (const recurringBooking of userRecurringBookings) {
        const { course, startDate, endDate } = recurringBooking;

        // The recurring booking stores the day-of-week + time window via
        // the original startDate/endDate (e.g. Sunday 08:45 / Sunday 09:30).
        // We need to find the next occurrence of that day-of-week that is
        // exactly DAYS_AHEAD days from today — i.e. the play date whose
        // booking window opens today.
        const today = new Date();
        const targetPlayDate = new Date(today);
        targetPlayDate.setDate(today.getDate() + daysAhead);
        targetPlayDate.setHours(
          startDate.getHours(),
          startDate.getMinutes(),
          0,
          0
        );

        // Only proceed if the target play date falls on the recurring day-of-week
        if (targetPlayDate.getDay() !== startDate.getDay()) {
          continue;
        }

        // Check if we already created an auto-booking for this exact date/window
        const exists = await autoBookingExists(
          userId,
          targetPlayDate,
          startDate.getHours(),
          startDate.getMinutes()
        );
        if (exists) {
          console.log(
            `[Recurring] auto-booking already exists for ${targetPlayDate.toDateString()} ${startDate.getHours()}:${startDate.getMinutes()}, skipping`
          );
          continue;
        }

        const targetEndDate = new Date(targetPlayDate);
        targetEndDate.setHours(endDate.getHours(), endDate.getMinutes(), 0, 0);

        const autoBooking = await addAutoBooking(
          userId,
          course,
          targetPlayDate,
          targetEndDate,
          { useConfigGolfers: recurringBooking.useConfigGolfers }
        );

        const bookingOpens = getBookingOpensDate(targetPlayDate);
        const dayName = autoBooking.startDate.toLocaleDateString('en-GB', {
          weekday: 'long',
          day: 'numeric',
          month: 'short'
        });

        let message = '<b>📅 Recurring Booking Queued</b>\n';
        message += `<b>Course:</b> ${getGolfClubName()}\n`;
        message += `<b>Play Date:</b> ${dayName}\n`;
        message += `<b>Window:</b> ${autoBooking.startDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} – ${autoBooking.endDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}\n`;
        message += `<b>Booking Opens:</b> ${bookingOpens.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} at ${bookingOpens.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}\n`;
        message += `\nWill auto-book when the window opens.`;

        await bot.api.sendMessage(userId, message, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  callback_data: `autobooking:${autoBooking.id}`,
                  text: 'Remove'
                }
              ]
            ]
          }
        });

        console.log(
          `[Recurring] created auto-booking for ${dayName}, opens ${bookingOpens.toISOString()}`
        );
      }
    }
  });

  // Run daily at midnight, 10 AM, and at BOOKING_HOUR to catch all timings.
  // The dedup check prevents duplicate auto-bookings.
  const recurringBookingCron = new CronJob(
    {
      cronExpression: `0 0,10,${getBookingOpensHour()} * * *`
    },
    recurringBookingJob,
    {
      id: 'recurringBookingCron',
      preventOverrun: true
    }
  );

  scheduler.addCronJob(recurringBookingCron);
  console.log('✅ Recurring Bookings Monitor started');
}
