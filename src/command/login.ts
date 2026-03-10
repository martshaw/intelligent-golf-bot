import rp from 'request-promise';
import { login } from 'requests/golfBooking';
import { getSafeUserMessage, logError } from 'shared/errorHandling';
import { addLogin } from 'storage/logins';
import { Bot } from 'grammy';

export function loginCommand(bot: Bot): void {
  bot.on('message').command('login', async (ctx) => {
    const msg = ctx.msg;
    const command = msg.text;
    const match = /\/login (\S+) ([0-9A-Za-z]+)/i.exec(command);

    if (!match?.[1] || !match?.[2]) {
      await ctx.reply(
        'Usage: /login {username} {password}\nExample: /login 2192 1234'
      );
      return;
    }

    const username = match[1].trim();
    const password = match[2];
    const userId = msg.from.id;

    if (username.length > 128 || password.length > 64) {
      await ctx.reply('❌ Username or password too long.');
      return;
    }

    try {
      const startTime = Date.now();

      const request = rp.defaults({
        jar: rp.jar(),
        followAllRedirects: true,
        timeout: 10000 // 10s timeout
      });

      const loginResult = await login(request, { username, password });
      const duration = Date.now() - startTime;

      if (loginResult) {
        await addLogin(userId, username, password);
        await ctx.reply(
          `✅ Login succeeded in ${duration}ms\nCredentials saved for future bookings`
        );
      } else {
        await ctx.reply(
          '❌ Login failed - incorrect credentials or server error'
        );
      }
    } catch (error) {
      logError('Login', error);
      await ctx.reply(`❌ Login error: ${getSafeUserMessage(error)}`);
    }
  });
}
