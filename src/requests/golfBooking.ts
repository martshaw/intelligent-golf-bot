import * as cheerio from 'cheerio';

import { getBookingNumSlots, getGolfClubBaseUrl } from 'shared/env';
import { RequestPromise, RequestPromiseOptions } from 'request-promise';
import { RequestAPI, RequiredUriUrl } from 'request';

/**
 * Log in to the club site. POSTs to the base URL (form target used by the site).
 * Cookie jar is reused so subsequent requests (memberbooking, ajax) send the session.
 */
export async function login(
  request: RequestAPI<RequestPromise, RequestPromiseOptions, RequiredUriUrl>,
  args: {
    username: string;
    password: string;
  }
): Promise<boolean> {
  // The site rejects logins without the _csrf_token from the login page (403).
  // Fetch the page with the same cookie jar, then echo the token back.
  const loginPage = await request('login.php', { method: 'GET', baseUrl: getGolfClubBaseUrl() });
  const csrfToken = cheerio.load(String(loginPage))('input[name=_csrf_token]').attr('value') || '';
  const options: RequestPromiseOptions = {
    method: 'POST',
    baseUrl: getGolfClubBaseUrl(),
    form: {
      task: 'login',
      topmenu: 1,
      memberid: args.username,
      pin: args.password,
      Submit: 'Login',
      _csrf_token: csrfToken
    }
  };
  const html = await request('', options);
  const $ = cheerio.load(html);
  return $('title').text().includes('Welcome');
}

/**
 * Verify that the request still has a valid session (same check as post-login).
 * Used when reusing a cached session so availability requests get logged-in results.
 */
export async function verifyLoggedIn(
  request: RequestAPI<RequestPromise, RequestPromiseOptions, RequiredUriUrl>
): Promise<boolean> {
  try {
    const html = await request(getGolfClubBaseUrl(), {
      method: 'GET',
      timeout: 5000
    });
    const $ = cheerio.load(html);
    return $('title').text().includes('Welcome');
  } catch {
    return false;
  }
}

interface BookingDetails {
  startingTee: string;
  holes: string;
  price: string;
  servicesBooked: string;
  participants: string[];
}

interface Booking {
  date: string;
  time: string;
  playerCount: string;
  id: string;
  moreDetails: BookingDetails;
}

interface TimeSlot {
  time: string;
  bookingForm: { [x: string]: string };
  canBook: boolean;
}

export async function getBookings(
  request: RequestAPI<RequestPromise, RequestPromiseOptions, RequiredUriUrl>
): Promise<Booking[]> {
  const html = await request(getGolfClubBaseUrl());
  const $ = cheerio.load(html);
  if (!$('title').text().includes('Welcome')) return [];
  const bookings = $('div#myteetimes tr');
  const parsedBookings: Booking[] = [];
  await Promise.all(
    bookings.map(async (i: number, booking: unknown) => {
      if (i === bookings.length - 1) return;
      const $row = $(booking as Parameters<ReturnType<typeof cheerio.load>>[0]);
      const bookingDetails = $row.find('td');
      const date = bookingDetails.eq(0).html() ?? 'Unavailable';
      const time = bookingDetails.eq(1).html() ?? 'Unavailable';
      const playerCount = bookingDetails.eq(2).html() ?? 'Unavailable';
      const bookingId =
        bookingDetails.eq(3).find('a').attr('href')?.split('=')[1] ??
        'Unavailable';

      parsedBookings[i] = {
        date,
        time,
        playerCount,
        id: bookingId,
        moreDetails: await getBookingDetails(request, { bookingId })
      };
    })
  );

  return parsedBookings;
}

/**
 * Dates of the member's upcoming bookings (e.g. "Sunday 29th November"),
 * read from the home page's tee-times table in ONE request. Used for the
 * same-day check in the booking loops, which do not need booking details.
 * Returns [] when the session is not logged in.
 */
export async function getBookingDates(
  request: RequestAPI<RequestPromise, RequestPromiseOptions, RequiredUriUrl>
): Promise<Array<{ date: string }>> {
  const html = await request(getGolfClubBaseUrl());
  return parseBookingDates(String(html));
}

export function parseBookingDates(html: string): Array<{ date: string }> {
  const $ = cheerio.load(html);
  if (!$('title').text().includes('Welcome')) return [];
  const rows = $('div#myteetimes tr');
  const dates: Array<{ date: string }> = [];
  rows.each((i: number, row: unknown) => {
    if (i === rows.length - 1) return; // footer row, as in getBookings
    const date = $(row as Parameters<ReturnType<typeof cheerio.load>>[0])
      .find('td')
      .eq(0)
      .html(); // same cell read as getBookings, so hasBookingOnDay sees identical text
    if (date) dates.push({ date });
  });
  return dates;
}

function parseBookingDetailsPage(html: string) {
  const $ = cheerio.load(html);
  const bookingDetails = $('div#teebooking_info tr');
  const participantDetails = $('div#teebooking_players tr');

  const startingTee = bookingDetails.eq(1).find('td').html() ?? 'Unavailable';
  const holes = bookingDetails.eq(3).find('td').html() ?? 'Unavailable';
  const price = bookingDetails.eq(4).find('td').html() ?? 'Unavailable';
  const servicesBooked =
    bookingDetails.eq(5).find('td').html() ?? 'Unavailable';

  const participants: string[] = [];
  participantDetails.each((i: number, participant: unknown) => {
    if (i === participantDetails.length - 1) return;
    const parsed =
      $(participant as Parameters<ReturnType<typeof cheerio.load>>[0])
        .find('td')
        .eq(1)
        .text()
        .split('(')[0]
        .trim() ?? '';
    if (parsed !== 'Enter Details') participants.push(parsed);
  });

  return {
    startingTee,
    participants,
    servicesBooked,
    price,
    holes
  };
}

export async function getBookingDetails(
  request: RequestAPI<RequestPromise, RequestPromiseOptions, RequiredUriUrl>,
  args: {
    bookingId: string;
  }
): Promise<BookingDetails> {
  const html: string = await request(
    `${getGolfClubBaseUrl()}member_teetime.php?edit=${args.bookingId}`
  );
  return parseBookingDetailsPage(html);
}

// eslint-disable-next-line no-shadow
export enum Course {
  // eslint-disable-next-line no-unused-vars
  Kilspindie = 1
}

export async function cancelBooking(
  request: RequestAPI<RequestPromise, RequestPromiseOptions, RequiredUriUrl>,
  args: {
    bookingId: string;
  }
): Promise<boolean> {
  const options: RequestPromiseOptions = {
    method: 'POST',
    baseUrl: getGolfClubBaseUrl(),
    qs: {
      edit: args.bookingId
    },
    formData: {
      cancel: 'Yes'
    },
    resolveWithFullResponse: true
  };
  const html = await request('/member_teetime.php', options);
  return html.req.res.statusCode === 200;
}

/**
 * Parse a time string (e.g. "15:28" or "3:28 PM") into a Date on the given day.
 * Returns null if the time cannot be parsed.
 */
function parseTimeOnDate(timeStr: string, date: Date): Date | null {
  const t = timeStr.trim();
  const m24 = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (m24) {
    const hours = Math.min(23, Math.max(0, parseInt(m24[1], 10)));
    const minutes = Math.min(59, Math.max(0, parseInt(m24[2], 10)));
    return new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      hours,
      minutes,
      0,
      0
    );
  }
  const m12 = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(t);
  if (m12) {
    let hours = parseInt(m12[1], 10);
    const minutes = Math.min(59, Math.max(0, parseInt(m12[2], 10)));
    if (m12[3].toLowerCase() === 'pm' && hours !== 12) hours += 12;
    if (m12[3].toLowerCase() === 'am' && hours === 12) hours = 0;
    hours = Math.min(23, Math.max(0, hours));
    return new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      hours,
      minutes,
      0,
      0
    );
  }
  return null;
}

/**
 * Parse tee times from memberbooking page HTML.
 * Bookable slots are `tr.bookable` rows in the AJAX teetimes HTML.
 * Each row has: time in th, form with hidden inputs for the book GET, and a.inlineBooking button.
 */
function parseTimeSlots(html: string): TimeSlot[] {
  const $ = cheerio.load(html);
  const availableTimes: TimeSlot[] = [];

  // Primary: tr.bookable — this is the class the server adds for available slots
  let rows = $('tr.bookable');

  if (process.env.DEBUG_AVAILABILITY_RAW === '1') {
    console.log(`[parseTimeSlots] tr.bookable = ${rows.length} rows`);
  }

  // Fallback: canreserve not empty
  if (rows.length === 0) {
    rows = $('tr.canreserve:not(.empty-row)');
    if (process.env.DEBUG_AVAILABILITY_RAW === '1') {
      console.log(`[parseTimeSlots] fallback tr.canreserve:not(.empty-row) = ${rows.length} rows`);
    }
  }

  // Fallback: cantreserve not empty (booked but visible slots)
  if (rows.length === 0) {
    rows = $('tr.cantreserve:not(.empty-row)');
    if (process.env.DEBUG_AVAILABILITY_RAW === '1') {
      console.log(`[parseTimeSlots] fallback tr.cantreserve:not(.empty-row) = ${rows.length} rows`);
    }
  }

  if (process.env.DEBUG_AVAILABILITY_RAW === '1') {
    console.log(`[parseTimeSlots] Total rows to parse: ${rows.length}`);
  }

  rows.each((_i: number, row: unknown) => {
    const $row = $(row as Parameters<ReturnType<typeof cheerio.load>>[0]);
    const bookingButton = $row.find('a.inlineBooking');
    const time = $row.find('th').first().text().trim();
    // Grab hidden inputs from the booking form (date, course, group, book, csrf token)
    const formInputs = $row.find('form input[type="hidden"]');
    const bookingForm: { [x: string]: string } = {};
    formInputs.each((_: number, field: unknown) => {
      const el = field as { attribs?: { name?: string; value?: string } };
      const name = el.attribs?.name;
      const value = el.attribs?.value;
      if (name != null) bookingForm[name] = value ?? '';
    });
    if (time && time.length > 0) {
      if (process.env.DEBUG_AVAILABILITY_RAW === '1') {
        console.log(`[parseTimeSlots]   Slot: ${time}, canBook=${bookingButton.length > 0}, formKeys=${Object.keys(bookingForm).join(',')}`);
      }
      availableTimes.push({
        time,
        bookingForm,
        canBook: bookingButton.length > 0
      });
    }
  });

  if (process.env.DEBUG_AVAILABILITY_RAW === '1') {
    console.log(`[parseTimeSlots] Returned ${availableTimes.length} available slots`);
  }

  return availableTimes;
}

export class NotLoggedInError extends Error {
  constructor() {
    super('not logged in (visitor page)');
    this.name = 'NotLoggedInError';
  }
}

/** True when a /memberbooking/ page title is the visitor (logged-out) page. */
export function isLoggedOutBookingTitle(title: string): boolean {
  return /visitor/i.test(title) || !/member/i.test(title);
}

/**
 * Fetch available tee times for the member session.
 * No query params on the URL: GET /memberbooking/ then POST /memberbooking/ with body
 * date=DD-MM-YYYY&course=&requestType=ajax (matches browser XHR). Parses tr.bookable from response.
 */
export async function getCourseAvailability(
  request: RequestAPI<RequestPromise, RequestPromiseOptions, RequiredUriUrl>,
  args: {
    date: Date;
    course: Course;
    /** Throw NotLoggedInError instead of returning [] when the session is logged out. */
    throwIfLoggedOut?: boolean;
    /**
     * Skip the GET /memberbooking/ landing page and go straight to the ajax
     * tee sheet. Used at the instant a window opens, after the session has
     * already been verified pre-window, to save a round trip.
     */
    skipLanding?: boolean;
  }
): Promise<TimeSlot[]> {
  const day = args.date.getDate();
  const month = args.date.getMonth() + 1;
  const year = args.date.getFullYear();
  const dateUnpadded = `${day}-${month}-${year}`;
  const datePadded = `${String(day).padStart(2, '0')}-${String(month).padStart(2, '0')}-${year}`;

  const baseUrl = getGolfClubBaseUrl();
  const memberBookingUrl = baseUrl + 'memberbooking/';
  const origin = baseUrl.replace(/\/$/, '');
  const fullPageHeaders: Record<string, string> = {
    Referer: memberBookingUrl,
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  };
  const ajaxHeaders: Record<string, string> = {
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    Origin: origin,
    Referer: memberBookingUrl,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    'X-Requested-With': 'XMLHttpRequest'
  };

  const fetchTeetimesForDate = async (dateStr: string): Promise<TimeSlot[]> => {
    try {
      const options: RequestPromiseOptions = {
        method: 'POST',
        baseUrl,
        form: {
          date: dateStr,
          course: '',
          requestType: 'ajax'
        },
        headers: ajaxHeaders
      };
      const response = await request('/memberbooking/', options);

      let html = '';
      if (typeof response === 'string') {
        // Some IG setups return raw HTML; others JSON with { teetimes }
        const trimmed = response.trim();
        if (trimmed.startsWith('{')) {
          try {
            const parsed = JSON.parse(trimmed) as { teetimes?: string };
            if (parsed && typeof parsed.teetimes === 'string') {
              html = parsed.teetimes;
            }
          } catch (err) {
            if (process.env.DEBUG_AVAILABILITY_RAW === '1') {
              console.warn(
                '[DEBUG_AVAILABILITY_RAW] JSON parse failed, using raw html:',
                (err as Error)?.message
              );
            }
          }
        }
        if (!html && response.length >= 10) {
          html = response;
        }
      } else if (typeof response === 'object' && response != null) {
        const maybeHtml =
          (response as { teetimes?: string }).teetimes ??
          (response as { html?: string }).html;
        if (typeof maybeHtml === 'string') {
          html = maybeHtml;
        }
      }

      if (process.env.DEBUG_AVAILABILITY_RAW === '1' && html) {
        const $ = cheerio.load(html);
        console.log(
          '[DEBUG_AVAILABILITY_RAW] POST ajax teetimes len=%d tr=%d bookable=%d',
          html.length,
          $('tr').length,
          $('tr.bookable').length
        );
      }

      if (html.length >= 10) {
        const slots = parseTimeSlots(html);
        if (slots.length > 0) return slots;
        if (html.includes('no-teetimes-message')) return [];
      }
      return [];
    } catch {
      return [];
    }
  };

  const isToday = (d: Date): boolean => {
    const now = new Date();
    return (
      d.getDate() === now.getDate() &&
      d.getMonth() === now.getMonth() &&
      d.getFullYear() === now.getFullYear()
    );
  };

  const dropPastSlotsForToday = (
    slots: TimeSlot[],
    requestDate: Date
  ): TimeSlot[] => {
    if (!isToday(requestDate) || slots.length === 0) return slots;
    const now = new Date();
    return slots.filter((slot) => {
      const slotDt = parseTimeOnDate(slot.time, requestDate);
      return slotDt != null && slotDt > now;
    });
  };

  try {
    if (args.skipLanding) {
      const quick = await fetchTeetimesForDate(datePadded);
      return dropPastSlotsForToday(quick, args.date);
    }
    const landingHtml = await request('/memberbooking/', {
      method: 'GET',
      baseUrl,
      headers: fullPageHeaders
    });
    const landingTitle = cheerio.load(landingHtml)('title').text();
    // Logged in, the memberbooking page title is like "Member's Teetime Booking
    // at <Club>". An expired session gets the visitor booking page instead,
    // which still says "Booking" but not "Member".
    if (isLoggedOutBookingTitle(landingTitle)) {
      console.warn('[Availability] not logged in (visitor page)');
      throw new NotLoggedInError();
    }
    let slots = await fetchTeetimesForDate(datePadded);
    if (slots.length > 0) return dropPastSlotsForToday(slots, args.date);
    slots = await fetchTeetimesForDate(dateUnpadded);
    return dropPastSlotsForToday(slots, args.date);
  } catch (error) {
    if (args.throwIfLoggedOut && error instanceof NotLoggedInError) throw error;
    return [];
  }
}

export interface BookingResult {
  bookingId: string;
  details: BookingDetails;
}

/**
 * Booking id from the club's redirect after a booking request, or null.
 * Only `?edit=<id>&newbooking=1` counts as a new booking.
 */
export function bookingIdFromRedirect(
  location: string | undefined
): string | null {
  if (!location || !/[?&]newbooking=1(?:&|$)/.test(location)) return null;
  const m = /[?&]edit=(\d+)/.exec(location);
  return m ? m[1] : null;
}

/**
 * Book a tee time slot.
 * Disables redirect following to capture the Location header which contains the
 * booking ID (e.g. `?edit=1895056&newbooking=1`).
 * Then follows the redirect manually to get the confirmation page.
 */
export async function bookTimeSlot(
  request: RequestAPI<RequestPromise, RequestPromiseOptions, RequiredUriUrl>,
  args: {
    timeSlot: TimeSlot;
    numslots?: number;
  }
): Promise<BookingResult | null> {
  const baseUrl = getGolfClubBaseUrl();

  try {
    // Step 1: Send booking GET with redirect following DISABLED.
    // The club returns a 302 with Location: ?edit={bookingId}&newbooking=1
    const bookingResponse = await request('/memberbooking/', {
      method: 'GET',
      baseUrl,
      qs: {
        numslots: args.numslots ?? getBookingNumSlots(),
        ...args.timeSlot.bookingForm
      },
      followRedirect: false,
      followAllRedirects: false,
      resolveWithFullResponse: true,
      simple: false // don't throw on non-2xx
    });

    const statusCode = bookingResponse.statusCode;
    const locationHeader: string | undefined =
      bookingResponse.headers?.location;

    console.log(
      `[bookTimeSlot] response status=${statusCode}, location=${locationHeader ?? '(none)'}`
    );

    // A booking exists only when the club redirects to the new booking's
    // edit page (?edit=<id>&newbooking=1). Nothing else counts.
    const bookingId = bookingIdFromRedirect(locationHeader);
    if (bookingId) {
      console.log(`[bookTimeSlot] extracted bookingId=${bookingId}`);
    } else if (locationHeader) {
      console.warn(
        `[bookTimeSlot] redirect is not a new booking (location=${locationHeader}); not booked`
      );
    }

    // No new-booking redirect (e.g. 200 with an error page): not booked.
    // Never take an id from the page body — it can list other bookings.
    if (!bookingId) {
      const bodyHtml =
        typeof bookingResponse.body === 'string' ? bookingResponse.body : '';
      if (bodyHtml) {
        // Log what the club said (page title + any error/notice text) so a
        // failed attempt can be diagnosed. Truncated; no form data logged.
        const $b = cheerio.load(bodyHtml);
        const title = $b('title').text().replace(/\s+/g, ' ').trim();
        const notice = $b(
          '.error, .alert, .message, .notice, .warning, .errorbox, #errors'
        )
          .map((_i: number, el: unknown) =>
            $b(el as Parameters<typeof $b>[0]).text()
          )
          .get()
          .join(' | ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 200);
        console.error(
          `[bookTimeSlot] no new-booking redirect — not booked (status=${statusCode}, title="${title.slice(0, 80)}", notice="${notice}", bodyLen=${bodyHtml.length})`
        );
        return null;
      } else {
        console.error('[bookTimeSlot] empty response body and no redirect');
        return null;
      }
    }

    // Step 2: Follow the redirect manually to get the confirmation page
    const confirmUrl = `${baseUrl}memberbooking/?edit=${bookingId}&newbooking=1`;
    const confirmHtml = await request(confirmUrl, {
      method: 'GET'
    });
    const details = parseBookingDetailsPage(confirmHtml);

    return { bookingId, details };
  } catch (error) {
    console.error(
      '[bookTimeSlot] error:',
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}

/**
 * Search for a club member by surname prefix (first 3 letters).
 * POSTs to the edit booking page with `partner={prefix}&submit=submit`.
 * Returns matching member links with their partner IDs.
 */
export async function searchMemberPartner(
  request: RequestAPI<RequestPromise, RequestPromiseOptions, RequiredUriUrl>,
  args: {
    bookingId: string;
    surnamePrefix: string;
  }
): Promise<Array<{ name: string; partnerId: number }>> {
  const baseUrl = getGolfClubBaseUrl();
  const url = `${baseUrl}memberbooking/?edit=${args.bookingId}`;

  const html: string = await request(url, {
    method: 'POST',
    form: {
      partner: args.surnamePrefix.substring(0, 3),
      submit: 'submit'
    }
  });

  const $ = cheerio.load(html);
  const results: Array<{ name: string; partnerId: number }> = [];

  $('a[href*="addpartner="]').each((_i: number, el: unknown) => {
    const $el = $(el as Parameters<ReturnType<typeof cheerio.load>>[0]);
    const href = $el.attr('href') ?? '';
    const name = $el.text().trim();
    const match = /addpartner=(\d+)/.exec(href);
    if (match) {
      results.push({ name, partnerId: parseInt(match[1], 10) });
    }
  });

  return results;
}

/**
 * Add a member partner to a booking by their club partner ID.
 * GET /memberbooking/?edit={bookingId}&addpartner={partnerId}&partnerslot={slot}
 */
export async function addMemberPartner(
  request: RequestAPI<RequestPromise, RequestPromiseOptions, RequiredUriUrl>,
  args: {
    bookingId: string;
    partnerId: number;
    slot: number;
    /** Partner's name; counts as added if it shows in any player row (the club may compact slots). */
    name?: string;
  }
): Promise<boolean> {
  const baseUrl = getGolfClubBaseUrl();
  const url =
    `${baseUrl}memberbooking/?edit=${args.bookingId}` +
    `&addpartner=${args.partnerId}&partnerslot=${args.slot}`;

  try {
    const html: string = await request(url, { method: 'GET' });
    const result = checkPartnerAdded(html, args.slot, args.name);
    if (!result.added) {
      console.warn(
        `[addMemberPartner] slot ${args.slot}${args.name ? ` (${args.name})` : ''} not added — ${result.reason}`
      );
    }
    return result.added;
  } catch (error) {
    console.error(
      `[addMemberPartner] error for slot ${args.slot}:`,
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}

/** True when every word of `name` appears in the row text (case-insensitive). */
function rowHasName(rowText: string, name: string): boolean {
  const row = rowText.toLowerCase();
  return name
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => row.includes(w));
}

/**
 * Read the booking edit page returned after an add-partner request.
 * With `name`: added = that name appears in any player row (any word order).
 * Without `name`: added = the requested slot is filled.
 * When not added, `reason` holds the page title, any notice text, and the
 * player rows (names only), so the failure can be diagnosed from the log.
 */
export function checkPartnerAdded(
  html: string,
  slot: number,
  name?: string
): { added: boolean; reason: string } {
  const $ = cheerio.load(html);
  const clean = (t: string) => t.replace(/\s+/g, ' ').trim();
  const rows: string[] = [];
  let added = false;
  $('div#teebooking_players tr').each((_i: number, row: unknown) => {
    const $row = $(row as Parameters<ReturnType<typeof cheerio.load>>[0]);
    const slotCell = clean($row.find('td').eq(0).text());
    const nameCell = clean($row.find('td').eq(1).text());
    if (!slotCell && !nameCell) return;
    rows.push(`${slotCell}: ${nameCell.replace(/\(\s*Remove\s*\)/i, '').trim()}`);
    if (name) {
      // With a name, only that name counts: the club fills the next free row,
      // so the requested row may hold a different partner.
      if (rowHasName(nameCell, name)) added = true;
    } else if (
      slotCell === `Player ${slot}` &&
      nameCell &&
      !nameCell.includes('Enter Details')
    ) {
      added = true;
    }
  });
  if (added) return { added, reason: '' };
  const title = clean($('title').text()).slice(0, 80);
  const notice = clean(
    $('.error, .alert, .message, .notice, .warning, .errorbox, #errors, .ui-state-error, .ui-state-highlight')
      .map((_i: number, el: unknown) => $(el as Parameters<typeof $>[0]).text())
      .get()
      .join(' | ')
  ).slice(0, 200);
  const bodyText = clean($('body').text());
  const hint = /[^.]{0,80}(already|not available|unable|cannot|can't|clash)[^.]{0,80}/i.exec(bodyText);
  return {
    added,
    reason: `title="${title}", notice="${notice}"${hint ? `, text="${clean(hint[0]).slice(0, 160)}"` : ''}, players=[${rows.join('; ')}]`
  };
}

/**
 * Add a guest player to a booking.
 * POST to /memberbooking/?edit={bookingId}&partnerslot={slot}
 * with form: guest=1, forename, surname, user_email, mobtel
 */
export async function addGuestPartner(
  request: RequestAPI<RequestPromise, RequestPromiseOptions, RequiredUriUrl>,
  args: {
    bookingId: string;
    slot: number;
    firstname: string;
    surname: string;
  }
): Promise<boolean> {
  const baseUrl = getGolfClubBaseUrl();
  const url =
    `${baseUrl}memberbooking/?edit=${args.bookingId}&partnerslot=${args.slot}`;

  try {
    const html: string = await request(url, {
      method: 'POST',
      form: {
        guest: '1',
        forename: args.firstname,
        surname: args.surname,
        user_email: '',
        mobtel: ''
      }
    });
    const $ = cheerio.load(html);
    const players = $('div#teebooking_players tr');
    let filled = false;
    players.each((_i: number, row: unknown) => {
      const $row = $(row as Parameters<ReturnType<typeof cheerio.load>>[0]);
      const slotCell = $row.find('td').eq(0).text().trim();
      const nameCell = $row.find('td').eq(1).text().trim();
      if (
        slotCell === `Player ${args.slot}` &&
        !nameCell.includes('Enter Details')
      ) {
        filled = true;
      }
    });
    return filled;
  } catch (error) {
    console.error(
      `[addGuestPartner] error for slot ${args.slot}:`,
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}

/**
 * Pick a member from partner-search results. Order: full name; then same
 * first name with the surname's first 4 letters (spelling variants such as
 * Thomson/Thompson); then surname only.
 */
export function matchPartnerByName(
  results: Array<{ name: string; partnerId: number }>,
  firstname: string,
  surname: string
): { name: string; partnerId: number; how: 'full' | 'first+prefix' | 'surname' } | null {
  const first = firstname.trim().toLowerCase();
  const sur = surname.trim().toLowerCase();
  const full = `${first} ${sur}`;
  const lower = results.map((r) => ({ r, n: r.name.toLowerCase() }));
  const byFull = lower.find(({ n }) => n.includes(full));
  if (byFull) return { ...byFull.r, how: 'full' };
  const prefix = sur.slice(0, 4);
  const byFirst = lower.find(
    ({ n }) => n.startsWith(`${first} `) && n.slice(first.length + 1).startsWith(prefix)
  );
  if (byFirst) return { ...byFirst.r, how: 'first+prefix' };
  const bySur = lower.find(({ n }) => n.includes(sur));
  if (bySur) return { ...bySur.r, how: 'surname' };
  return null;
}

/**
 * Look up a golfer's partner ID by searching the club member list.
 * Searches by first 3 chars of surname, then matches the full name.
 * Returns the partnerId or null if not found.
 */
export async function resolvePartnerIdByName(
  request: RequestAPI<RequestPromise, RequestPromiseOptions, RequiredUriUrl>,
  args: {
    bookingId: string;
    firstname: string;
    surname: string;
  }
): Promise<number | null> {
  const results = await searchMemberPartner(request, {
    bookingId: args.bookingId,
    surnamePrefix: args.surname.substring(0, 3)
  });

  const match = matchPartnerByName(results, args.firstname, args.surname);
  if (match) {
    if (match.how !== 'full') {
      console.log(
        `[resolvePartnerIdByName] ${match.how} match: "${match.name}" for "${args.firstname} ${args.surname}" — using partnerId=${match.partnerId}`
      );
    }
    return match.partnerId;
  }

  console.warn(
    `[resolvePartnerIdByName] no match for "${args.firstname} ${args.surname}" in ${results.length} results`
  );
  return null;
}
