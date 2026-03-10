import rp from 'request-promise';
import { login, verifyLoggedIn } from 'requests/golfBooking';
import { RequestAPI, RequiredUriUrl } from 'request';

interface CachedSession {
  request: RequestAPI<
    rp.RequestPromise<unknown>,
    rp.RequestPromiseOptions,
    RequiredUriUrl
  >;
  lastLogin: number;
}

const sessionCache: { [key: number]: CachedSession } = {};
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

/**
 * Returns a request instance that has already logged in to the club site.
 * The same request (and its cookie jar) is reused for all subsequent calls
 * (e.g. getCourseAvailability), so the ajax request is made with the same
 * session cookies and returns logged-in results.
 */
export async function getOrCreateSession(
  userId: number,
  username: string,
  password: string,
  timeout = 10000
): Promise<
  RequestAPI<
    rp.RequestPromise<unknown>,
    rp.RequestPromiseOptions,
    RequiredUriUrl
  >
> {
  const now = Date.now();
  const cached = sessionCache[userId];

  if (cached && now - cached.lastLogin < SESSION_TIMEOUT) {
    const stillLoggedIn = await verifyLoggedIn(cached.request);
    if (stillLoggedIn) return cached.request;
    delete sessionCache[userId];
  }

  const request = rp.defaults({
    jar: rp.jar(),
    followAllRedirects: true,
    timeout
  });
  const loginSuccess = await login(request, { username, password });
  if (!loginSuccess) {
    throw new Error('Failed to login to golf club');
  }

  sessionCache[userId] = { request, lastLogin: now };
  return request;
}

export function clearSessionCache(userId?: number): void {
  if (userId) {
    delete sessionCache[userId];
  } else {
    Object.keys(sessionCache).forEach((key) => {
      delete sessionCache[Number(key)];
    });
  }
}

export function getSessionStats(): { total: number; userIds: number[] } {
  const userIds = Object.keys(sessionCache).map((key) => Number(key));
  return { total: userIds.length, userIds };
}
