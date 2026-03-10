import { promises } from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';

import { Course } from 'requests/golfBooking';
import { getDataDir } from 'shared/env';

const fs = promises;

function monitorsPath(): string {
  return path.join(getDataDir(), 'monitors.json');
}

export interface Monitor {
  id: string;
  course: Course;
  startDate: Date;
  endDate: Date;
}

export interface Monitors {
  [key: number]: Monitor[];
}

const dateTimeReviver = (key: string, value: string) => {
  if (['startDate', 'endDate'].includes(key)) {
    return new Date(value);
  }
  return value;
};

async function save(monitors: Monitors): Promise<boolean> {
  await fs.writeFile(monitorsPath(), JSON.stringify(monitors));
  return true;
}

let monitorCache: Monitors | null = null;

async function load(): Promise<Monitors> {
  try {
    const file = await fs.readFile(monitorsPath());
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
    console.error('Loading monitors failed');
    return {};
  }
}

/** Clear in-memory cache so next getAllMonitors() reads from file. Used by scheduler to get latest. */
export function clearMonitorCache(): void {
  monitorCache = null;
}

export async function getAllMonitors(): Promise<Monitors> {
  if (!monitorCache) {
    const monitors = await load();
    if (!monitorCache) monitorCache = monitors;
  }
  return monitorCache;
}

export async function getUsersMonitors(userId: number): Promise<Monitor[]> {
  const monitors = await getAllMonitors();
  return monitors[userId];
}

export async function addMonitor(
  userId: number,
  course: Course,
  startDate: Date,
  endDate: Date
): Promise<Monitor> {
  const id = uuid();
  const monitors: Monitors = await getAllMonitors();
  const userMonitors = monitors[userId] ?? [];
  userMonitors.push({ id, course, startDate, endDate });
  monitors[userId] = userMonitors;
  await save(monitors);
  return { id, course, startDate, endDate };
}

export async function deleteMonitor(
  id: string,
  userId: number
): Promise<boolean> {
  const monitors: Monitors = await getAllMonitors();
  const userMonitors = monitors[userId] ?? [];
  const newMonitors = userMonitors.filter((monitor) => {
    return monitor.id !== id;
  });
  if (userMonitors.length === newMonitors.length) return false;
  monitors[userId] = newMonitors;
  await save(monitors);
  return true;
}
