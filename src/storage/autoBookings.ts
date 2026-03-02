import { promises } from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';

import { Course } from 'requests/golfBooking';
import { getDataDir } from 'shared/env';

const fs = promises;

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
  await fs.writeFile(autoBookingsPath(), JSON.stringify(autoBookings));
  return true;
}

let autoBookingsCache: AutoBookings | null = null;

async function load(): Promise<AutoBookings> {
  try {
    const file = await fs.readFile(autoBookingsPath());
    return JSON.parse(file.toString(), dateTimeReviver);
  } catch (error: unknown) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return {};
    }
    console.error('Loading auto bookings failed');
    return {};
  }
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
