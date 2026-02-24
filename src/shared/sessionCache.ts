import rp from 'request-promise';
import { login } from 'requests/golfBooking';
import { RequestAPI, RequiredUriUrl } from 'request';

interface CachedSession {
  request: RequestAPI<rp.RequestPromise<unknown>, rp.RequestPromiseOptions, RequiredUriUrl>;
  lastLogin: number;
}

const sessionCache: { [key: number]: CachedSession } = {};
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

export async function getOrCreateSession(
  userId: number,
  username: string,
  password: string,
  timeout = 15000
): Promise<RequestAPI<rp.RequestPromise<unknown>, rp.RequestPromiseOptions, RequiredUriUrl>> {
  const now = Date.now();
  const cached = sessionCache[userId];

  // Reuse session if valid
  if (cached && now - cached.lastLogin < SESSION_TIMEOUT) {
    console.log(`[${userId}] Session reused`);
    return cached.request;
  }

  // Create new session
  console.log(`[${userId}] Creating new session`);
  const request = rp.defaults({ jar: rp.jar(), followAllRedirects: true, timeout });

  const loginSuccess = await login(request, { username, password });
  if (!loginSuccess) {
    throw new Error('Failed to login to golf club');
  }

  sessionCache[userId] = { request, lastLogin: now };
  console.log(`[${userId}] Session created and cached`);
  return request;
}

export function clearSessionCache(userId?: number): void {
  if (userId) {
    delete sessionCache[userId];
    console.log(`[${userId}] Session cleared`);
  } else {
    Object.keys(sessionCache).forEach((key) => {
      delete sessionCache[Number(key)];
    });
    console.log('All sessions cleared');
  }
}

export function getSessionStats(): { total: number; userIds: number[] } {
  const userIds = Object.keys(sessionCache).map((key) => Number(key));
  return { total: userIds.length, userIds };
}
