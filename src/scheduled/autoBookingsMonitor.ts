import { AsyncTask, CronJob, ToadScheduler } from 'toad-scheduler';

import rp from 'request-promise';

import { deleteAutoBooking, getAllAutoBookings } from 'storage/autoBookings';
import {
  bookTimeSlot,
  getCourseAvailability,
  login
} from 'requests/golfBooking';
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

export function scheduledAutoBookingsMonitor(bot: Bot): void {
  // Create scheduler once and keep reference
  if (autoScheduler) {
    return; // Already initialized
  }

  autoScheduler = new ToadScheduler();
  const scheduler = autoScheduler;

  const autoBookingJob = new AsyncTask('autoBookings', async () => {
    const autoBookings = await getAllAutoBookings();
    const userIds = Object.keys(autoBookings).map(k => Number.parseInt(k, 10));

    for (const userId of userIds) {
      const userAutoBookings = autoBookings[userId];

      // Ensure login once per user (reuse request across all their bookings)
      let request = loginCache[userId];
      if (!request) {
        request = rp.defaults({
          jar: rp.jar(),
          followAllRedirects: true,
          timeout: 15000 // 15s timeout to prevent hanging
        });
        const credentials = await getLogin(userId);
        if (!credentials) {
          console.warn(`No credentials found for user ${userId}, skipping`);
          continue;
        }
        try {
          const loginSuccess = await login(request, {
            username: credentials.username,
            password: credentials.password
          });
          if (!loginSuccess) {
            console.warn(`Login failed for user ${userId}`);
            continue;
          }
          console.log(`Logged in as ${userId}`);
          loginCache[userId] = request;
        } catch (error) {
          console.error(`Login error for user ${userId}:`, error);
          continue;
        }
      }

      // Process each booking sequentially (safe: different bookings/dates)
      for (const autoBooking of userAutoBookings) {
        const { course, startDate, endDate } = autoBooking;
        const timeToStartDate = new Date(startDate).setHours(0, 0, 0, 0) - new Date().getTime();

        if (timeToStartDate > 1214000000) {
          console.log(
            `Booking ${autoBooking.id.slice(0, 8)} waiting for ${
              (timeToStartDate - 1214000000) / 1000
            }s`
          );
          continue;
        }

        if (new Date() > endDate) {
          await deleteAutoBooking(autoBooking.id, userId);
          continue;
        }

        try {
          let availability = await getCourseAvailability(request, {
            course,
            date: startDate
          });

          console.log(
            `Found ${availability.length} slots for booking ${autoBooking.id.slice(0, 8)}`
          );

          if (availability.length === 0) continue;

          const startTime = `${startDate
            .getUTCHours()
            .toString()
            .padStart(2, '0')}:${startDate
            .getUTCMinutes()
            .toString()
            .padStart(2, '0')}`;
          const endTime = `${endDate
            .getUTCHours()
            .toString()
            .padStart(2, '0')}:${endDate
            .getUTCMinutes()
            .toString()
            .padStart(2, '0')}`;

          availability = availability.filter(
            (el) => el.canBook && el.time > startTime && el.time < endTime
          );

          if (availability.length === 0) {
            console.log(`No slots in range ${startTime}-${endTime} for booking ${autoBooking.id.slice(0, 8)}`);
            continue;
          }

          // Try slots in reverse order (latest first, pop to get earliest in range)
          availability.reverse();

          let bookedSlot = null;
          let bookedTimeSlot = null;

          // Try up to 3 slots only (limit retry attempts)
          const maxAttempts = Math.min(3, availability.length);
          for (let i = 0; i < maxAttempts; i++) {
            const timeSlot = availability.pop();
            if (!timeSlot) break;

            console.log(`Attempting booking ${autoBooking.id.slice(0, 8)} at ${timeSlot.time}`);
            try {
              bookedSlot = await bookTimeSlot(request, { timeSlot });
              if (bookedSlot) {
                bookedTimeSlot = timeSlot;
                break;
              }
            } catch (error) {
              console.error(`Booking attempt failed:`, error);
            }
          }

          if (bookedSlot && bookedTimeSlot) {
            let message = '<b>✅ Auto Booked!</b>\n';
            message += `<b>Date:</b> ${startDate.getDate()}/${startDate.getMonth() + 1}/${startDate.getFullYear()}\n`;
            message += `<b>Time:</b> ${bookedTimeSlot.time}\n`;
            message += `<b>Course:</b> ${
              bookedSlot.startingTee.split(' ')[0]
            }\n<b>Participants:</b> ${bookedSlot.participants.join(', ')}`;

            await bot.api.sendMessage(userId, message, {
              parse_mode: 'HTML'
            });
            await deleteAutoBooking(autoBooking.id, userId);
          }
        } catch (error) {
          console.error(`Error processing booking ${autoBooking.id.slice(0, 8)}:`, error);
        }
      }
    }
  });

  const clearCache = new AsyncTask('clearLoginCache', async () => {
    console.log('Clearing login cache');
    loginCache = {};
  });

  const clearCacheJob = new CronJob(
    { cronExpression: '0 0 23 * * *' }, // Daily at 11 PM
    clearCache
  );

  scheduler.addCronJob(clearCacheJob);

  // Run every 5 minutes during booking hours (6 AM - 10 PM)
  const autoBookingPeakHours = new CronJob(
    {
      cronExpression: '*/5 6-22 * * *' // Every 5 min, 6 AM to 10 PM
    },
    autoBookingJob,
    {
      id: 'autoBookingPeakHours',
      preventOverrun: true
    }
  );

  // Run once per hour during off-peak hours (10 PM - 6 AM)
  const autoBookingOffPeak = new CronJob(
    {
      cronExpression: '0 22-23,0-5 * * *' // Top of hour during off-peak
    },
    autoBookingJob,
    {
      id: 'autoBookingOffPeak',
      preventOverrun: true
    }
  );

  scheduler.addCronJob(autoBookingPeakHours);
  scheduler.addCronJob(autoBookingOffPeak);
  console.log('✅ Auto Bookings Monitor started');
}
