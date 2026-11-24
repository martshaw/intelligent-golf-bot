/* Offline check: per-entry golfers / numslots and partner name matching (no network). */
import assert from 'assert';
import { entryGolfers, entryNumSlots, partnerAddOrder } from '../src/scheduled/entryGolfers';
import { matchPartnerByName, checkPartnerAdded } from '../src/requests/golfBooking';
import type { GolferEntry } from '../src/storage/autoBookingConfig';

const m = (firstname: string, surname: string, partnerId?: number): GolferEntry => ({ type: 'member', firstname, surname, ...(partnerId ? { partnerId } : {}) });
const config = [m('Martin', 'Shaw'), m('Brian', 'Mckinlay', 10599)];
const three = [...config, m('George', 'Thomson')];

// Sunday-style entry (config golfers, no own list): unchanged — config list, env numslots.
let r = entryGolfers({ useConfigGolfers: true }, config);
assert.deepStrictEqual(r, { golfers: config, fromConfig: true });
assert.strictEqual(entryNumSlots({ useConfigGolfers: true }), undefined);
// Plain entry: no partners, env numslots.
assert.strictEqual(entryGolfers({}, config), null);
assert.strictEqual(entryNumSlots({}), undefined);
assert.strictEqual(entryNumSlots({ golfers: [] }), undefined);
// Per-entry list wins and sets numslots to its length; never cached into config.
r = entryGolfers({ golfers: three, useConfigGolfers: true }, config);
assert.deepStrictEqual(r, { golfers: three, fromConfig: false });
assert.strictEqual(entryNumSlots({ golfers: three }), 3);
assert.strictEqual(entryNumSlots({ golfers: [...three, m('A', 'B'), m('C', 'D')] }), 4);

// Partner matching.
const res = [
  { name: 'Alan Thomson (12.1)', partnerId: 1 },
  { name: 'George Thompson (18.4)', partnerId: 2 },
  { name: 'Brian Mckinlay (16.0)', partnerId: 10599 }
];
assert.deepStrictEqual(matchPartnerByName(res, 'Brian', 'Mckinlay'), { name: 'Brian Mckinlay (16.0)', partnerId: 10599, how: 'full' });
// Spelling variant: the right George is chosen, not the other Thomson.
assert.strictEqual(matchPartnerByName(res, 'George', 'Thomson')?.partnerId, 2);
assert.strictEqual(matchPartnerByName(res, 'George', 'Thomson')?.how, 'first+prefix');
// Exact spelling present wins over the variant.
assert.strictEqual(matchPartnerByName([...res, { name: 'George Thomson (9.0)', partnerId: 3 }], 'George', 'Thomson')?.partnerId, 3);
// Surname-only fallback still works as before.
assert.strictEqual(matchPartnerByName(res, 'Al', 'Thomson')?.how, 'surname');
assert.strictEqual(matchPartnerByName(res, 'Nobody', 'Smith'), null);

// Partner order: known ids first, then guests, then name lookups; slots 2.. in that order.
const g: GolferEntry = { type: 'guest', firstname: 'Gary', surname: 'Guest' };
const order = partnerAddOrder([m('George', 'Thomson'), g, m('Brian', 'Mckinlay', 10599)]);
assert.deepStrictEqual(order.map((o) => `${o.golfer.firstname}@${o.slot}`), ['Brian@2', 'Gary@3', 'George@4']);
assert.deepStrictEqual(partnerAddOrder([m('A', 'One'), m('B', 'Two')]).map((o) => o.golfer.firstname), ['A', 'B']);

// Add-partner page check (layout of the club's edit page, 23 Nov).
const page = (rows: string[], extra = '') => `<html><head><title>Member's Teetime Booking at Kilspindie Golf Club</title></head><body>${extra}<div id="teebooking_players"><table>${rows.map((r, i) => `<tr><td>Player ${i + 1}</td><td>${r}</td></tr>`).join('')}<tr><td></td><td></td></tr></table></div></body></html>`;
// Requested slot 3 but the club put George in Player 2: still counts as added.
assert.strictEqual(checkPartnerAdded(page(['Martin Shaw (you)', 'George Thomson ( Remove )', 'Enter Details', 'Enter Details']), 3, 'George Thomson').added, true);
assert.strictEqual(checkPartnerAdded(page(['Martin Shaw (you)', 'Brian Mckinlay (Remove)', 'Enter Details', 'Enter Details']), 2).added, true);
// Not added: reason carries title, notice and player rows.
const fail = checkPartnerAdded(page(['Martin Shaw (you)', 'Enter Details', 'Enter Details', 'Enter Details'], '<div class="error">Brian Mckinlay is already booked at 10:16 on this day.</div>'), 2, 'Brian Mckinlay');
assert.strictEqual(fail.added, false);
assert.ok(fail.reason.includes('already booked at 10:16'), fail.reason);
assert.ok(fail.reason.includes("title=\"Member's Teetime Booking"), fail.reason);
assert.ok(fail.reason.includes('Player 2: Enter Details'), fail.reason);
console.log('fail reason sample:', fail.reason);

console.log('entryGolfers.check: all assertions passed');
