// Load environment variables from .env file
require('dotenv').config();

import { Bot } from 'grammy';
import { getEnv } from 'shared/env';
import { devSetup } from 'devSetup';
import { registerCommands } from 'command/commands';
import { scheduledAvailableTimesMonitor } from 'scheduled/availableTimesMonitor';
import { scheduledAutoBookingsMonitor } from 'scheduled/autoBookingsMonitor';
import { scheduledRecurringBookingsMonitor } from 'scheduled/recurringBookingsMonitor';

export async function handler(): Promise<void> {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    throw new Error('BOT_TOKEN must be provided!');
  }

  if (getEnv('NODE_ENV') === 'development') {
    await devSetup();
  }

  const bot = new Bot(token);

  registerCommands(bot);

  // Temporarily disabled: scheduledAvailableTimesMonitor(bot);
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
