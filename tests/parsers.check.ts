/* Offline checks of the club-page parsers (no network). Fixtures in tests/fixtures are synthetic, in the club's layout. */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import {
  getCourseAvailability,
  isLoggedOutBookingTitle,
  matchPartnerByName,
  Course
} from '../src/requests/golfBooking';

const fixture = (name: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

// A stand-in for the request-promise instance: answers every call with `body`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeRequest = (body: string): any => async () => body;

(async () => {
  // Logged-in vs visitor page titles.
  assert.strictEqual(isLoggedOutBookingTitle("Member's Teetime Booking at Kilspindie Golf Club"), false);
  assert.strictEqual(isLoggedOutBookingTitle('Visitor Booking at Kilspindie Golf Club'), true);
  assert.strictEqual(isLoggedOutBookingTitle('Teetime Booking'), true);

  // Partner name matching: full name, spelling variant, none.
  const results = [
    { name: 'Thompson, Alan', partnerId: 1 },
    { name: 'George Thompson', partnerId: 2 },
    { name: 'Brian Mckinlay', partnerId: 10599 }
  ];
  assert.strictEqual(matchPartnerByName(results, 'Brian', 'Mckinlay')?.partnerId, 10599);
  assert.strictEqual(matchPartnerByName(results, 'George', 'Thomson')?.partnerId, 2);
  assert.strictEqual(matchPartnerByName(results, 'Zed', 'Nobody'), null);

  // Tee sheet parsing through the real getCourseAvailability (skipLanding: ajax sheet only).
  const date = new Date(2030, 11, 5, 10, 0);
  const slots = await getCourseAvailability(fakeRequest(fixture('teesheet.html')), {
    course: Course.Kilspindie,
    date,
    skipLanding: true
  });
  assert.deepStrictEqual(slots.map((s) => s.time), ['10:08', '10:16', '10:24']);
  assert.deepStrictEqual(slots.map((s) => s.canBook), [true, true, false]);
  assert.strictEqual(slots[0]?.bookingForm.book, '10:08:00');

  // Sheet wrapped in JSON { teetimes } parses the same.
  const wrapped = JSON.stringify({ teetimes: fixture('teesheet.html') });
  const slots2 = await getCourseAvailability(fakeRequest(wrapped), { course: Course.Kilspindie, date, skipLanding: true });
  assert.strictEqual(slots2.length, 3);

  console.log('parsers.check: all assertions passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
