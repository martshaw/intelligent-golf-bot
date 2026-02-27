export const getEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`Environment variable ${name} is not set`);
  }
  return value;
};

/** Optional base directory for JSON data files (logins, bookings, etc.). Default: current working directory. */
export const getDataDir = (): string => process.env.DATA_DIR?.trim() || '.';

/** Ensure DATA_DIR exists (creates it if missing). Call at startup when using a custom DATA_DIR. */
export async function ensureDataDir(): Promise<void> {
  const dir = getDataDir();
  if (dir === '.') return;
  const { promises: fs } = await import('fs');
  await fs.mkdir(dir, { recursive: true });
}

/** Club subdomain for Intelligent Golf (e.g. kilspindie). Default: kilspindie */
export const getGolfClub = (): string =>
  process.env.GOLF_CLUB?.trim() || 'kilspindie';

/** Base URL for the club's Intelligent Golf site */
export const getGolfClubBaseUrl = (): string =>
  `https://${getGolfClub()}.intelligentgolf.co.uk/`;

/** Display name for the club (e.g. Kilspindie) */
export const getGolfClubName = (): string => {
  const club = getGolfClub();
  return club.charAt(0).toUpperCase() + club.slice(1).toLowerCase();
};

/** Number of players/slots to book (booker + others). Default: 3 (booker + 2 others). */
export const getBookingNumSlots = (): number => {
  const v = process.env.BOOKING_NUM_SLOTS?.trim();
  if (v === undefined || v === '') return 3;
  const n = parseInt(v, 10);
  return Number.isNaN(n) || n < 1 || n > 4 ? 3 : n;
};

/** How often the available-times monitor checks (seconds). Default: 300 (5 min). Min 60. */
export const getMonitorIntervalSeconds = (): number => {
  const v = process.env.MONITOR_INTERVAL_SECONDS?.trim();
  if (v === undefined || v === '') return 300;
  const n = parseInt(v, 10);
  return Number.isNaN(n) || n < 60 ? 300 : Math.min(n, 900);
};

/** If true, auto-booking picks a random slot in range (IGBookerBot-style). Default: false (earliest). */
export const getAutoBookingRandomSlot = (): boolean =>
  process.env.AUTO_BOOKING_RANDOM_SLOT === 'true' ||
  process.env.AUTO_BOOKING_RANDOM_SLOT === '1';

/** Hour of day when bookings open (0–23). Used for reference; default 18. */
export const getBookingOpensHour = (): number => {
  const v = process.env.BOOKING_HOUR?.trim();
  if (v === undefined || v === '') return 18;
  const n = parseInt(v, 10);
  return Number.isNaN(n) || n < 0 || n > 23 ? 18 : n;
};

/** Minute of hour when bookings open (0–59). Default 45. */
export const getBookingOpensMinute = (): number => {
  const v = process.env.BOOKING_MINUTE?.trim();
  if (v === undefined || v === '') return 45;
  const n = parseInt(v, 10);
  return Number.isNaN(n) || n < 0 || n > 59 ? 45 : n;
};

/** Days ahead to book (e.g. 5 = book 5 days in advance). Default 5. */
export const getDaysAheadToBook = (): number => {
  const v = process.env.DAYS_AHEAD_TO_BOOK?.trim();
  if (v === undefined || v === '') return 5;
  const n = parseInt(v, 10);
  return Number.isNaN(n) || n < 1 ? 5 : Math.min(n, 14);
};
