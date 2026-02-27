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
  const options: RequestPromiseOptions = {
    method: 'POST',
    baseUrl: getGolfClubBaseUrl(),
    form: {
      task: 'login',
      topmenu: 1,
      memberid: args.username,
      pin: args.password,
      Submit: 'Login'
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
    const landingHtml = await request('/memberbooking/', {
      method: 'GET',
      baseUrl,
      headers: fullPageHeaders
    });
    const landingTitle = cheerio.load(landingHtml)('title').text();
    // The memberbooking page has title like "Member's Teetime Booking at <Club>"
    // when logged in. The main site has "Welcome to <Club>". Accept either.
    if (
      !landingTitle.includes('Welcome') &&
      !landingTitle.includes('Member') &&
      !landingTitle.includes('Booking')
    ) {
      throw new Error('Session not authenticated for member booking');
    }
    let slots = await fetchTeetimesForDate(datePadded);
    if (slots.length > 0) return dropPastSlotsForToday(slots, args.date);
    slots = await fetchTeetimesForDate(dateUnpadded);
    return dropPastSlotsForToday(slots, args.date);
  } catch (_error) {
    return [];
  }
}

export async function bookTimeSlot(
  request: RequestAPI<RequestPromise, RequestPromiseOptions, RequiredUriUrl>,
  args: {
    timeSlot: TimeSlot;
  }
): Promise<BookingDetails | null> {
  const options: RequestPromiseOptions = {
    method: 'GET',
    baseUrl: getGolfClubBaseUrl(),
    qs: {
      numslots: getBookingNumSlots(),
      ...args.timeSlot.bookingForm
    }
  };

  try {
    const html = await request('/memberbooking/', options);
    const $ = cheerio.load(html);

    // Try multiple selector patterns for confirmation
    let confirmation = $(
      'div.user-messages.alert.user-message-success > ul > li > strong'
    ).html();

    if (!confirmation) {
      confirmation = $('div.alert-success strong').html();
    }

    if (!confirmation) {
      confirmation = $('div.alert-success').text();
    }

    if (confirmation && confirmation.trim().length > 0) {
      const details = parseBookingDetailsPage(html);
      return details;
    }
    console.error('bookTimeSlot: no confirmation found in response');
  } catch (error) {
    console.error('bookTimeSlot error');
  }

  return null;
}
