// Load environment variables from .env file
import { config as loadEnv } from 'dotenv';

loadEnv();

import { Bot } from 'grammy';
import { devSetup } from 'devSetup';
import { registerCommands } from 'command/commands';
import { scheduledAvailableTimesMonitor } from 'scheduled/availableTimesMonitor';
import { scheduledAutoBookingsMonitor } from 'scheduled/autoBookingsMonitor';
import { scheduledRecurringBookingsMonitor } from 'scheduled/recurringBookingsMonitor';
import { Course, getCourseAvailability } from 'requests/golfBooking';
import { ensureDataDir } from 'shared/env';
import { getOrCreateSession } from 'shared/sessionCache';
import { getFirstLogin, preloadLogins } from 'storage/logins';

async function runAvailabilityDebug(): Promise<void> {
  await ensureDataDir();
  const login = await getFirstLogin();
  if (!login) {
    console.error(
      'No login found. Use /login in Telegram first or add an entry to logins.json'
    );
    return;
  }
  const dateLabel =
    process.env.DEBUG_AVAILABILITY_DATE === 'tomorrow' ? 'tomorrow' : 'today';
  const date =
    dateLabel === 'tomorrow'
      ? new Date(Date.now() + 24 * 60 * 60 * 1000)
      : new Date();
  console.log('Using first stored login for userId', login.userId);
  const request = await getOrCreateSession(
    login.userId,
    login.username,
    login.password
  );
  console.log(
    'Fetching availability for',
    dateLabel,
    date.toDateString(),
    '...'
  );
  const slots = await getCourseAvailability(request, {
    course: Course.Kilspindie,
    date
  });
  console.log('Slots returned:', slots.length);
  slots.forEach((s, i) =>
    console.log(`  ${i + 1}. ${s.time} canBook=${s.canBook}`)
  );
  if (slots.length === 0) {
    console.log(
      '(No slots – try another date or check browser memberbooking tab.)'
    );
  }
}

export async function handler(): Promise<void> {
  if (process.env.RUN_AVAILABILITY_DEBUG === '1') {
    await runAvailabilityDebug();
    process.exit(0);
  }

  const token = process.env.BOT_TOKEN;
  if (!token) {
    throw new Error('BOT_TOKEN must be provided!');
  }

  await ensureDataDir();

  if (process.env.NODE_ENV === 'development') {
    await devSetup();
  }

  const bot = new Bot(token);

  registerCommands(bot);

  await preloadLogins();

  scheduledAvailableTimesMonitor(bot);
  scheduledAutoBookingsMonitor(bot);
  scheduledRecurringBookingsMonitor(bot);

  // Use polling for local/OpenClaw deployment (no public IP needed)
  console.log('Starting bot with polling mode...');
  await bot.start({
    onStart: (botInfo) => {
      console.log(`✅ Bot started: @${botInfo.username}`);
    }
  });
}

handler()
  .then(() => console.log('Golf Bot Running (Polling Mode)'))
  .catch((error) => {
    console.error('Uncaught Error Thrown', error);
  });
