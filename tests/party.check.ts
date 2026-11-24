/* Offline checks of filling a booking's party (in-memory club adapter, no network). */
import assert from 'assert';
import { fillParty, PartyPort } from '../src/booking/party';
import type { GolferEntry } from '../src/storage/autoBookingConfig';

const m = (firstname: string, surname: string, partnerId?: number): GolferEntry => ({
  type: 'member', firstname, surname, ...(partnerId ? { partnerId } : {})
});
const guest = (firstname: string, surname: string): GolferEntry => ({ type: 'guest', firstname, surname });

function fakePort(opts: { failMember?: number[]; directory?: Record<string, number>; throwOn?: number[] } = {}) {
  const calls: string[] = [];
  const port: PartyPort = {
    addMember: async (_b, pid, slot, name) => {
      calls.push(`member:${name}:${pid}@${slot}`);
      if (opts.throwOn?.includes(pid)) throw new Error('network');
      return !opts.failMember?.includes(pid);
    },
    addGuest: async (_b, slot, f, s) => { calls.push(`guest:${f} ${s}@${slot}`); return true; },
    findMemberId: async (_b, f, s) => { calls.push(`find:${f} ${s}`); return opts.directory?.[`${f} ${s}`] ?? null; }
  };
  return { port, calls };
}

(async () => {
  const quiet = () => undefined;

  // Sunday party: Brian (known id) added to slot 2 with his name, nothing else.
  let p = fakePort();
  let r = await fillParty(p.port, '2122132', [m('Brian', 'Mckinlay', 10599)], quiet);
  assert.deepStrictEqual(p.calls, ['member:Brian Mckinlay:10599@2']);
  assert.deepStrictEqual(r.lines, ['✅ Brian Mckinlay']);
  assert.strictEqual(r.learnedIds, false);

  // Order: known ids first, then guests, then name lookups. Found id is learned.
  const george = m('George', 'Thomson');
  p = fakePort({ directory: { 'George Thomson': 10351 } });
  r = await fillParty(p.port, '1', [george, guest('Gary', 'Guest'), m('Brian', 'Mckinlay', 10599)], quiet);
  assert.deepStrictEqual(p.calls, [
    'member:Brian Mckinlay:10599@2',
    'guest:Gary Guest@3',
    'find:George Thomson',
    'member:George Thomson:10351@4'
  ]);
  assert.deepStrictEqual(r.lines, ['✅ Brian Mckinlay', '✅ Gary Guest (guest)', '✅ George Thomson']);
  assert.strictEqual(r.learnedIds, true);
  assert.strictEqual(george.partnerId, 10351);

  // A failed or throwing partner never stops the next one; strings as before.
  p = fakePort({ failMember: [10599], throwOn: [10351] });
  r = await fillParty(p.port, '1', [m('Brian', 'Mckinlay', 10599), m('George', 'Thomson', 10351), m('Zed', 'Nobody')], quiet);
  assert.deepStrictEqual(r.lines, ['❌ Brian Mckinlay (assign failed)', '❌ George Thomson (error)', '❌ Zed Nobody (member not found)']);

  // No delays: three adds complete well under 100 ms.
  p = fakePort();
  const t0 = Date.now();
  await fillParty(p.port, '1', [m('A', 'One', 1), m('B', 'Two', 2), m('C', 'Three', 3)], quiet);
  assert.ok(Date.now() - t0 < 100);

  console.log('party.check: all assertions passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
