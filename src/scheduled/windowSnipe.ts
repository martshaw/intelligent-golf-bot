/**
 * Booking-window "snipe": the decision loop run at the instant a booking
 * window opens. Pure (all I/O injected) so it can be checked offline.
 *
 * Rules kept from the regular monitor:
 * - only slots inside the entry's window (inclusive) are ever tried;
 * - closest to the preferred time first (ties keep sheet order, i.e. earlier);
 * - a booking counts only when `book` returns a result (real booking id).
 */

export interface SnipeSlot {
  time: string;
  canBook: boolean;
}

export interface SnipeDeps<S extends SnipeSlot, R> {
  /** Fetch the current tee sheet (fresh per-slot tokens each call). */
  fetchSlots: () => Promise<S[]>;
  /** Try to book; resolve to a result only for a confirmed booking id. */
  book: (slot: S) => Promise<R | null>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
}

export interface SnipeOptions {
  /** HH:MM, inclusive. */
  windowStart: string;
  /** HH:MM, inclusive. */
  windowEnd: string;
  preferredTime?: string;
  /** Epoch ms; stop trying after this. */
  deadline: number;
  /** Max attempts on the preferred time while it is still listed bookable. */
  maxPreferredAttempts?: number;
  /** Stop retrying the preferred time this long after its first failure. */
  preferredRetryMs?: number;
  /** Max attempts on each fallback time. */
  maxOtherAttempts?: number;
  /** Pause between sheet fetches while the window has not been released. */
  releasePollMs?: number;
}

/** Normalize time string to HH:MM for comparison. */
export function normalizeTime(t: string): string {
  const parts = t.trim().split(':');
  const h = parts[0]?.replace(/\D/g, '') ?? '0';
  const m = parts[1]?.replace(/\D/g, '') ?? '0';
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
}

/** Convert HH:MM to total minutes for distance comparison. */
export function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Bookable slots within [start, end] (HH:MM, inclusive). */
export function slotsInWindow<S extends SnipeSlot>(
  slots: S[],
  start: string,
  end: string
): S[] {
  return slots.filter((s) => {
    const t = normalizeTime(s.time);
    return s.canBook && t >= start && t <= end;
  });
}

/** Closest to preferred first (stable: ties keep earlier time first). */
export function sortByPreference<S extends SnipeSlot>(
  slots: S[],
  preferredTime?: string
): S[] {
  const sorted = [...slots];
  if (!preferredTime) return sorted;
  const pref = timeToMinutes(normalizeTime(preferredTime));
  return sorted.sort(
    (a, b) =>
      Math.abs(timeToMinutes(normalizeTime(a.time)) - pref) -
      Math.abs(timeToMinutes(normalizeTime(b.time)) - pref)
  );
}

export async function snipeWindow<S extends SnipeSlot, R>(
  deps: SnipeDeps<S, R>,
  opts: SnipeOptions
): Promise<{ result: R; slot: S } | null> {
  const pref = opts.preferredTime
    ? normalizeTime(opts.preferredTime)
    : undefined;
  const maxPref = opts.maxPreferredAttempts ?? 4;
  const prefRetryMs = opts.preferredRetryMs ?? 6000;
  const maxOther = opts.maxOtherAttempts ?? 2;
  const releasePollMs = opts.releasePollMs ?? 250;
  const attempts = new Map<string, number>();
  let firstPrefFailAt: number | null = null;

  const prefGivenUp = (): boolean =>
    (attempts.get(pref ?? '') ?? 0) >= maxPref ||
    (firstPrefFailAt != null && deps.now() - firstPrefFailAt >= prefRetryMs);

  while (deps.now() < opts.deadline) {
    let slots: S[];
    try {
      slots = await deps.fetchSlots();
    } catch (error) {
      deps.log(
        `sheet fetch failed: ${error instanceof Error ? error.message : String(error)}`
      );
      await deps.sleep(releasePollMs);
      continue;
    }

    const inWindow = sortByPreference(
      slotsInWindow(slots, opts.windowStart, opts.windowEnd),
      pref
    );

    if (inWindow.length === 0) {
      if (slots.some((s) => s.canBook)) {
        deps.log(
          `sheet released but no bookable slots in ${opts.windowStart}–${opts.windowEnd}`
        );
        return null;
      }
      // Nothing bookable at all yet: the day has not been released.
      await deps.sleep(releasePollMs);
      continue;
    }

    const target = inWindow.find((s) => {
      const n = normalizeTime(s.time);
      if (n === pref) return !prefGivenUp();
      return (attempts.get(n) ?? 0) < maxOther;
    });
    if (!target) {
      deps.log('every bookable slot in the window has been tried');
      return null;
    }

    const n = normalizeTime(target.time);
    const tryNo = (attempts.get(n) ?? 0) + 1;
    deps.log(
      `attempting ${n}${n === pref ? ' (preferred)' : ''} try ${tryNo}; in window: ${inWindow.map((s) => normalizeTime(s.time)).join(', ')}`
    );
    let result: R | null = null;
    try {
      result = await deps.book(target);
    } catch (error) {
      deps.log(
        `book ${n} threw: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (result) return { result, slot: target };
    attempts.set(n, tryNo);
    if (n === pref && firstPrefFailAt == null) firstPrefFailAt = deps.now();
  }

  deps.log('snipe deadline reached without a booking');
  return null;
}
