import path from 'path';
import { v4 as uuid } from 'uuid';

import { Course } from 'requests/golfBooking';
import { getDataDir } from 'shared/env';
import { readJsonFile, writeJsonAtomic } from 'storage/jsonFile';
import type { GolferEntry } from 'storage/autoBookingConfig';

function autoBookingsPath(): string {
  return path.join(getDataDir(), 'autoBookings.json');
}

export interface AutoBooking {
  id: string;
  course: Course;
  startDate: Date;
  endDate: Date;
  /** If true, use golfers from autoBookingConfig.json when booking. */
  useConfigGolfers?: boolean;
  /** Preferred exact time (HH:MM). Bot tries this first, then nearest in window. */
  preferredTime?: string;
  /** If set, only these HH:MM times may be booked (must also be inside the window). */
  allowedTimes?: string[];
  /**
   * Players for this entry only (booker first). Overrides the config golfers
   * and books golfers.length places instead of BOOKING_NUM_SLOTS.
   */
  golfers?: GolferEntry[];
}

export interface AutoBookings {
  [key: number]: AutoBooking[];
}

const dateTimeReviver = (key: string, value: string) => {
  if (['startDate', 'endDate'].includes(key)) {
    return new Date(value);
  }
  return value;
};

async function save(autoBookings: AutoBookings): Promise<boolean> {
  await writeJsonAtomic(autoBookingsPath(), autoBookings);
  return true;
}

let autoBookingsCache: AutoBookings | null = null;

async function load(): Promise<AutoBookings> {
  return (
    (await readJsonFile<AutoBookings>(autoBookingsPath(), dateTimeReviver)) ??
    {}
  );
}

export async function getAllAutoBookings(): Promise<AutoBookings> {
  if (!autoBookingsCache) {
    const autoBookings = await load();
    if (!autoBookingsCache) autoBookingsCache = autoBookings;
  }
  return autoBookingsCache;
}

export async function getUsersAutoBookings(
  userId: number
): Promise<AutoBooking[]> {
  const autoBookings = await getAllAutoBookings();
  return autoBookings[userId];
}

export interface AddAutoBookingOptions {
  useConfigGolfers?: boolean;
  preferredTime?: string;
}

export async function addAutoBooking(
  userId: number,
  course: Course,
  startDate: Date,
  endDate: Date,
  options?: AddAutoBookingOptions
): Promise<AutoBooking> {
  const id = uuid();
  const useConfigGolfers = options?.useConfigGolfers ?? false;
  const autoBookings: AutoBookings = await getAllAutoBookings();
  const userAutoBookings = autoBookings[userId] ?? [];
  const entry: AutoBooking = { id, course, startDate, endDate };
  if (useConfigGolfers) entry.useConfigGolfers = true;
  if (options?.preferredTime) entry.preferredTime = options.preferredTime;
  userAutoBookings.push(entry);
  autoBookings[userId] = userAutoBookings;
  await save(autoBookings);
  return entry;
}

export async function deleteAutoBooking(
  id: string,
  userId: number
): Promise<boolean> {
  const autoBookings: AutoBookings = await getAllAutoBookings();
  const userAutoBookings = autoBookings[userId] ?? [];
  const newAutoBookings = userAutoBookings.filter((autoBooking) => {
    return autoBooking.id !== id;
  });
  if (userAutoBookings.length === newAutoBookings.length) return false;
  autoBookings[userId] = newAutoBookings;
  await save(autoBookings);
  return true;
}
