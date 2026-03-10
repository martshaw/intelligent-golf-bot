import { AsyncTask, SimpleIntervalJob, ToadScheduler } from 'toad-scheduler';

import {
  clearMonitorCache,
  deleteMonitor,
  getAllMonitors
} from 'storage/monitors';
import { Course, getCourseAvailability } from 'requests/golfBooking';
import { getGolfClubName, getMonitorIntervalSeconds } from 'shared/env';
import { getOrCreateSession } from 'shared/sessionCache';
import { getLogin } from 'storage/logins';
import { Bot } from 'grammy';

const cache: { [key: string]: string[] } = {};
let monitorScheduler: ToadScheduler | null = null;

/** Normalize time string to HH:MM for consistent comparison (e.g. "9:00" -> "09:00"). */
function normalizeTime(t: string): string {
  const parts = t.trim().split(':');
  const h = parts[0]?.replace(/\D/g, '') ?? '0';
  const m = parts[1]?.replace(/\D/g, '') ?? '0';
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
}

export function scheduledAvailableTimesMonitor(bot: Bot): void {
  if (monitorScheduler) return;
  monitorScheduler = new ToadScheduler();
  const scheduler = monitorScheduler;
  const intervalSec = getMonitorIntervalSeconds();
  const task = new AsyncTask('availableTimesMonitor', async () => {
    clearMonitorCache();
    const monitors = await getAllMonitors();
    const totalMonitors = Object.values(monitors).flat().length;
    if (totalMonitors === 0) return;
    console.log('[Monitor] run: checking', totalMonitors, 'monitor(s)');

    for (const userKey in monitors) {
      if (!Object.hasOwnProperty.call(monitors, userKey)) continue;
      const userId = Number.parseInt(userKey, 10);
      const userMonitors = monitors[userKey] ?? [];
      if (userMonitors.length === 0) continue;
      const credentials = await getLogin(userId);
      if (!credentials) {
        console.warn('[Monitor] no credentials, skip');
        continue;
      }
      let request;
      try {
        request = await getOrCreateSession(
          userId,
          credentials.username,
          credentials.password
        );
      } catch {
        console.warn('[Monitor] login failed, skip');
        continue;
      }
      for (const monitor of userMonitors) {
        try {
          const { course, startDate, endDate } = monitor;
          const cacheKey = `${userId}${course}${startDate.toISOString()}${endDate.toISOString()}`;
          if (new Date() > endDate) {
            await deleteMonitor(monitor.id, userId);
            delete cache[cacheKey];
            continue;
          }

          const reqDate = `${startDate.getDate()}-${startDate.getMonth() + 1}-${startDate.getFullYear()}`;
          let availability = await getCourseAvailability(request, {
            course,
            date: startDate
          });
          const rawCount = availability.length;
          // Use local time for window so TZ=Europe/London matches club times
          const startTime = `${startDate.getHours().toString().padStart(2, '0')}:${startDate.getMinutes().toString().padStart(2, '0')}`;
          const endTime = `${endDate.getHours().toString().padStart(2, '0')}:${endDate.getMinutes().toString().padStart(2, '0')}`;
          availability = availability.filter((el) => {
            const t = normalizeTime(el.time);
            return t >= startTime && t <= endTime;
          });
          const filteredCount = availability.length;
          console.log(
            '[Monitor] date=',
            reqDate,
            'window=',
            startTime,
            '-',
            endTime,
            'raw=',
            rawCount,
            'inWindow=',
            filteredCount
          );

          const cacheAvailability = cache[cacheKey];
          const isFirstRun = !cacheAvailability;

          const newTimes: string[] = [];
          if (isFirstRun) {
            newTimes.push(...availability.map((slot) => slot.time));
          } else {
            for (const timeSlot of availability) {
              if (cacheAvailability.includes(timeSlot.time)) continue;
              newTimes.push(timeSlot.time);
            }
          }
          console.log(
            '[Monitor] isFirstRun=',
            isFirstRun,
            'newTimes=',
            newTimes.length
          );

          if (newTimes.length > 0) {
            const d = startDate.getDate();
            const m = startDate.getMonth() + 1;
            const y = startDate.getFullYear();
            const dateStr = `${d}-${m}-${y}`;
            const courseNum = course.valueOf();
            let message = '<b>⏰ Time(s) available in your window</b>\n\n';
            message += `<b>Course:</b> ${Course[course] ?? getGolfClubName()}\n`;
            message += `<b>Date:</b> ${d}/${m}/${y}\n\n`;
            if (newTimes.length === 1) {
              message += `<b>${newTimes[0]}</b> is available. Want to book?`;
            } else {
              message += `${newTimes.join(', ')} available. Want to book?`;
            }
            const inline_keyboard = newTimes.map((t) => [
              {
                text: `Book ${t}`,
                callback_data:
                  `monitorbook:${dateStr}:${normalizeTime(t)}:${courseNum}` as string
              }
            ]);
            await bot.api.sendMessage(userId, message, {
              parse_mode: 'HTML',
              reply_markup: { inline_keyboard }
            });
            console.log('[Monitor] sent alert, slots=', newTimes.length);
          }

          // eslint-disable-next-line require-atomic-updates
          cache[cacheKey] = availability.map((timeSlot) => timeSlot.time);
        } catch (err) {
          console.error(
            '[Monitor] error:',
            err instanceof Error ? err.message : String(err)
          );
        }
      }
    }
  });

  const job = new SimpleIntervalJob(
    { seconds: intervalSec, runImmediately: true },
    task
  );
  scheduler.addSimpleIntervalJob(job);
}
