/* Offline check of the window snipe decision loop (no network). */
import assert from 'assert';
import { snipeWindow, SnipeSlot, chooseTeeTimes } from '../src/scheduled/windowSnipe';

type Slot = SnipeSlot & { id: string };
const mk = (times: string[], bookable: string[]): Slot[] =>
  times.map((t) => ({ time: t, canBook: bookable.includes(t), id: t }));
const ALL = ['10:08', '10:16', '10:24', '10:32', '10:40', '10:48', '15:12'];

async function run(name: string, sheets: Slot[][], bookOk: (t: string, n: number) => boolean, pref = '10:24', extra: { allowedTimes?: string[] } = {}) {
  let clock = 0; let fetches = 0; const tries: string[] = []; const logs: string[] = [];
  const count: Record<string, number> = {};
  const res = await snipeWindow<Slot, string>({
    fetchSlots: async () => { clock += 300; const s = sheets[Math.min(fetches, sheets.length - 1)]!; fetches++; return s; },
    book: async (s) => { clock += 250; count[s.time] = (count[s.time] ?? 0) + 1; tries.push(s.time); return bookOk(s.time, count[s.time]!) ? `id-${s.time}` : null; },
    now: () => clock, sleep: async (ms) => { clock += ms; }, log: (m) => logs.push(m)
  }, { windowStart: '10:16', windowEnd: '10:40', preferredTime: pref, deadline: 20000, ...extra });
  console.log(`${name}: tries=[${tries.join(', ')}] result=${res?.slot.time ?? 'none'} fetches=${fetches} t=${clock}ms`);
  return { res, tries, fetches, clock };
}

(async () => {
  // 1. Not released for 3 polls, then open: books preferred on first try.
  const closed = mk(ALL, []); const open = mk(ALL, ['10:16', '10:24', '10:40', '15:12']);
  let r = await run('release-wait', [closed, closed, closed, open], () => true);
  assert.deepStrictEqual(r.tries, ['10:24']); assert.strictEqual(r.fetches, 4);
  // 2. Tonight's case: 10:24 returns 200/no id and disappears from the sheet -> next closest.
  const after = mk(ALL, ['10:16', '10:40', '15:12']);
  r = await run('taken-by-other', [open, after], () => false || false);
  // all fail -> check order only
  assert.deepStrictEqual(r.tries.slice(0, 2), ['10:24', '10:16']);
  r = await run('taken-then-fallback', [open, after], (t) => t === '10:16');
  assert.deepStrictEqual(r.tries, ['10:24', '10:16']); assert.strictEqual(r.res?.slot.time, '10:16');
  // 3. Preferred transiently fails but stays listed: retried, booked on 3rd try.
  r = await run('preferred-retry', [open], (t, n) => t === '10:24' && n === 3);
  assert.deepStrictEqual(r.tries, ['10:24', '10:24', '10:24']);
  // 4. Preferred keeps failing: gives up after max 4 tries, then falls back inside window only.
  r = await run('preferred-giveup', [open], (t) => t === '10:40');
  assert.deepStrictEqual(r.tries, ['10:24', '10:24', '10:24', '10:24', '10:16', '10:16', '10:40']);
  assert.ok(!r.tries.includes('15:12') && !r.tries.includes('10:08') && !r.tries.includes('10:48'));
  // 5. Released but nothing in window: never books outside window.
  r = await run('window-full', [mk(ALL, ['10:08', '10:48', '15:12'])], () => true);
  assert.strictEqual(r.res, null); assert.deepStrictEqual(r.tries, []);
  // 6. Inclusive bounds: 10:16 and 10:40 both eligible.
  r = await run('inclusive', [mk(ALL, ['10:40'])], () => true);
  assert.strictEqual(r.res?.slot.time, '10:40');
  // 7. Deadline: never released -> stops by deadline with no attempts.
  r = await run('deadline', [closed], () => true);
  assert.strictEqual(r.res, null); assert.ok(r.clock >= 20000 && r.clock < 21000);
  // 8. allowedTimes: books preferred first; never tries 10:16 or 10:32.
  const allInWindow = mk(ALL, ['10:16', '10:24', '10:32', '10:40']);
  r = await run('allowed-pref-first', [allInWindow], () => true, '10:24', { allowedTimes: ['10:24', '10:40'] });
  assert.deepStrictEqual(r.tries, ['10:24']); assert.strictEqual(r.res?.slot.time, '10:24');
  // 9. allowedTimes: 10:24 fails, falls back to 10:40 only — never 10:16 or 10:32.
  r = await run('allowed-skip-1032', [allInWindow], (t) => t === '10:40', '10:24', { allowedTimes: ['10:24', '10:40'] });
  assert.deepStrictEqual(r.tries, ['10:24', '10:24', '10:24', '10:24', '10:40']);
  assert.strictEqual(r.res?.slot.time, '10:40');
  assert.ok(!r.tries.includes('10:32') && !r.tries.includes('10:16'));
  // 10. One tee-time rule (shared by snipe and poll): window, allowed times, preferred first.
  const sheet = mk(ALL, ['10:08', '10:16', '10:24', '10:32', '10:40', '15:12']);
  const pick = (o: Parameters<typeof chooseTeeTimes>[1]) => chooseTeeTimes(sheet, o).map((s) => s.time);
  assert.deepStrictEqual(pick({ windowStart: '10:16', windowEnd: '10:40' }), ['10:16', '10:24', '10:32', '10:40']);
  assert.deepStrictEqual(pick({ windowStart: '10:16', windowEnd: '10:40', preferredTime: '10:32' }), ['10:32', '10:24', '10:40', '10:16']);
  assert.deepStrictEqual(pick({ windowStart: '10:16', windowEnd: '10:40', preferredTime: '10:24', allowedTimes: ['10:24', '10:40', '15:12'] }), ['10:24', '10:40']);
  assert.deepStrictEqual(pick({ windowStart: '08:24', windowEnd: '08:40' }), []);
  // Unbookable rows never chosen.
  assert.deepStrictEqual(chooseTeeTimes(mk(ALL, ['10:40']), { windowStart: '10:16', windowEnd: '10:40', preferredTime: '10:24' }).map((s) => s.time), ['10:40']);
  console.log('ALL CHECKS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
