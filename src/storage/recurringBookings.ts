import { promises } from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';

import { Course } from 'requests/golfBooking';
import { getDataDir } from 'shared/env';

const fs = promises;

function recurringBookingsPath(): string {
  return path.join(getDataDir(), 'recurringBookings.json');
}

export interface RecurringBooking {
  id: string;
  course: Course;
  startDate: Date;
  endDate: Date;
  /** If true, auto-bookings created from this recurring use golfers from autoBookingConfig.json. */
  useConfigGolfers?: boolean;
  /** Preferred tee times to rotate through weekly. Bot randomly picks one each week. */
  preferredTimes?: string[];
}

export interface RecurringBookings {
  [key: number]: RecurringBooking[];
}

const dateTimeReviver = (key: string, value: string) => {
  if (['startDate', 'endDate'].includes(key)) {
    return new Date(value);
  }
  return value;
};

async function save(recurringBookings: RecurringBookings): Promise<boolean> {
  await fs.writeFile(
    recurringBookingsPath(),
    JSON.stringify(recurringBookings)
  );
  return true;
}

let recurringBookingsCache: RecurringBookings | null = null;

async function load(): Promise<RecurringBookings> {
  try {
    const file = await fs.readFile(recurringBookingsPath());
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
    console.error('Loading recurring bookings failed');
    return {};
  }
}

export async function getAllRecurringBookings(): Promise<RecurringBookings> {
  if (!recurringBookingsCache) {
    const recurringBookings = await load();
    if (!recurringBookingsCache) recurringBookingsCache = recurringBookings;
  }
  return recurringBookingsCache;
}

export async function getUsersRecurringBookings(
  userId: number
): Promise<RecurringBooking[]> {
  const recurringBookings = await getAllRecurringBookings();
  return recurringBookings[userId];
}

export interface AddRecurringBookingOptions {
  useConfigGolfers?: boolean;
  preferredTimes?: string[];
}

export async function addRecurringBooking(
  userId: number,
  course: Course,
  startDate: Date,
  endDate: Date,
  options?: AddRecurringBookingOptions
): Promise<RecurringBooking> {
  const id = uuid();
  const useConfigGolfers = options?.useConfigGolfers ?? false;
  const recurringBookings: RecurringBookings = await getAllRecurringBookings();
  const userRecurringBookings = recurringBookings[userId] ?? [];
  const entry: RecurringBooking = { id, course, startDate, endDate };
  if (useConfigGolfers) entry.useConfigGolfers = true;
  if (options?.preferredTimes?.length) entry.preferredTimes = options.preferredTimes;
  userRecurringBookings.push(entry);
  recurringBookings[userId] = userRecurringBookings;
  await save(recurringBookings);
  return entry;
}

export async function deleteRecurringBooking(
  id: string,
  userId: number
): Promise<boolean> {
  const recurringBookings: RecurringBookings = await getAllRecurringBookings();
  const userRecurringBookings = recurringBookings[userId] ?? [];
  const newRecurringBookings = userRecurringBookings.filter(
    (recurringBooking) => {
      return recurringBooking.id !== id;
    }
  );
  if (userRecurringBookings.length === newRecurringBookings.length)
    return false;
  recurringBookings[userId] = newRecurringBookings;
  await save(recurringBookings);
  return true;
}
