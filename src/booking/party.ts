import {
  addGuestPartner,
  addMemberPartner,
  resolvePartnerIdByName
} from 'requests/golfBooking';
import { partnerAddOrder } from 'scheduled/entryGolfers';
import type { GolferEntry } from 'storage/autoBookingConfig';

/**
 * What filling a booking's party needs from the club site. The club adapter
 * (clubPartyPort) is used in production; checks use an in-memory one.
 */
export interface PartyPort {
  addMember(bookingId: string, partnerId: number, slot: number, name: string): Promise<boolean>;
  addGuest(bookingId: string, slot: number, firstname: string, surname: string): Promise<boolean>;
  findMemberId(bookingId: string, firstname: string, surname: string): Promise<number | null>;
}

export interface PartyResult {
  /** One line per partner for the Telegram message, e.g. "✅ Brian Mckinlay". */
  lines: string[];
  /** True when a member's partnerId was found by name (and set on the golfer). */
  learnedIds: boolean;
}

type ClubRequest = Parameters<typeof addMemberPartner>[0];

export function clubPartyPort(request: ClubRequest): PartyPort {
  return {
    addMember: (bookingId, partnerId, slot, name) =>
      addMemberPartner(request, { bookingId, partnerId, slot, name }),
    addGuest: (bookingId, slot, firstname, surname) =>
      addGuestPartner(request, { bookingId, slot, firstname, surname }),
    findMemberId: (bookingId, firstname, surname) =>
      resolvePartnerIdByName(request, { bookingId, firstname, surname })
  };
}

/**
 * Add the partners (everyone after the booker) to a booking that already
 * exists, as fast as possible: no delays, members with a known partnerId
 * first, then guests, then members found by name search. A failure for one
 * partner never stops the others. Partner ids found by name are written onto
 * the golfer objects; the caller decides whether to persist them.
 */
export async function fillParty(
  port: PartyPort,
  bookingId: string,
  partners: GolferEntry[],
  log: (msg: string) => void = (m) => console.log(m)
): Promise<PartyResult> {
  const lines: string[] = [];
  let learnedIds = false;

  for (const { golfer, slot } of partnerAddOrder(partners)) {
    const fullName = `${golfer.firstname} ${golfer.surname}`;
    try {
      if (golfer.type === 'guest') {
        const ok = await port.addGuest(bookingId, slot, golfer.firstname, golfer.surname);
        log(`[Party] ${bookingId} guest ${fullName} slot ${slot} ${ok ? 'added' : 'FAILED'}`);
        lines.push(ok ? `✅ ${fullName} (guest)` : `❌ ${fullName} (guest failed)`);
        continue;
      }
      let pid = golfer.partnerId ?? null;
      if (!pid) {
        pid = await port.findMemberId(bookingId, golfer.firstname, golfer.surname);
        if (pid) {
          golfer.partnerId = pid;
          learnedIds = true;
          log(`[Party] found partnerId=${pid} for ${fullName}`);
        }
      }
      if (!pid) {
        lines.push(`❌ ${fullName} (member not found)`);
        continue;
      }
      const ok = await port.addMember(bookingId, pid, slot, fullName);
      log(`[Party] ${bookingId} partner ${fullName} slot ${slot} ${ok ? 'added' : 'FAILED'}`);
      lines.push(ok ? `✅ ${fullName}` : `❌ ${fullName} (assign failed)`);
    } catch (error) {
      log(
        `[Party] ${bookingId} partner error for ${fullName}: ${error instanceof Error ? error.message : String(error)}`
      );
      lines.push(`❌ ${fullName} (error)`);
    }
  }
  return { lines, learnedIds };
}
