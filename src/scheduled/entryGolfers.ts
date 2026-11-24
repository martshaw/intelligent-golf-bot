import type { GolferEntry } from 'storage/autoBookingConfig';

interface GolferSource {
  golfers?: GolferEntry[];
  useConfigGolfers?: boolean;
}

/**
 * Players for one auto-booking, booker first. A per-entry `golfers` list wins
 * over autoBookingConfig.json; otherwise the config list is used when
 * `useConfigGolfers` is set. `fromConfig` says whether partner ids found while
 * booking may be cached back into the config file.
 */
export function entryGolfers(
  entry: GolferSource,
  configGolfers: GolferEntry[] | undefined
): { golfers: GolferEntry[]; fromConfig: boolean } | null {
  if (entry.golfers && entry.golfers.length > 0) {
    return { golfers: entry.golfers, fromConfig: false };
  }
  if (entry.useConfigGolfers) {
    return { golfers: configGolfers ?? [], fromConfig: true };
  }
  return null;
}

/**
 * Places to book for one entry: the size of its own golfers list (1-4).
 * Undefined means "use BOOKING_NUM_SLOTS", so entries without a list are unchanged.
 */
export function entryNumSlots(entry: GolferSource): number | undefined {
  const n = entry.golfers?.length ?? 0;
  if (n < 1) return undefined;
  return Math.min(4, n);
}

/**
 * Order in which to add partners right after a booking, with the slot each
 * goes to (2-4). Members with a known partnerId first (one request each),
 * then guests, then members whose id still has to be found by name search.
 * Speed matters: another booking can claim a partner within seconds.
 */
export function partnerAddOrder(
  partners: GolferEntry[]
): Array<{ golfer: GolferEntry; slot: number }> {
  const rank = (g: GolferEntry): number => {
    if (g.type === 'member' && g.partnerId) return 0;
    if (g.type === 'guest') return 1;
    return 2;
  };
  return partners
    .map((golfer, i) => ({ golfer, i }))
    .sort((a, b) => rank(a.golfer) - rank(b.golfer) || a.i - b.i)
    .map(({ golfer }, k) => ({ golfer, slot: k + 2 }));
}
