import path from 'path';

import { getDataDir } from 'shared/env';
import { readJsonFile, writeJsonAtomic } from 'storage/jsonFile';

/** One golfer in auto-booking config (names only; credentials come from login/env). */
export interface GolferEntry {
  type: 'member' | 'guest';
  firstname: string;
  surname: string;
  /** Cached club-system partner ID (looked up once via surname search). */
  partnerId?: number;
}

export interface AutoBookingConfig {
  golfers?: GolferEntry[];
}

function configPath(): string {
  return path.join(getDataDir(), 'autoBookingConfig.json');
}

let configCache: AutoBookingConfig | null = null;

/**
 * Load auto-booking config (golfers list). Missing file → empty config.
 * A corrupt file throws (see readJsonFile) instead of silently dropping golfers.
 */
export async function getAutoBookingConfig(): Promise<AutoBookingConfig> {
  if (configCache) return configCache;
  const parsed = await readJsonFile<AutoBookingConfig>(configPath());
  if (!parsed || typeof parsed !== 'object') {
    configCache = {};
    return configCache;
  }
  parsed.golfers = Array.isArray(parsed.golfers)
    ? parsed.golfers.filter(
        (g): g is GolferEntry =>
          g &&
          typeof g === 'object' &&
          (g.type === 'member' || g.type === 'guest') &&
          typeof g.firstname === 'string' &&
          typeof g.surname === 'string'
      )
    : [];
  configCache = parsed;
  return configCache;
}

/** Persist config back to disk (e.g. after caching partner IDs). */
export async function saveAutoBookingConfig(
  config: AutoBookingConfig
): Promise<void> {
  await writeJsonAtomic(configPath(), config, 2);
  configCache = config;
}

/** Format golfer list for display (e.g. success message). */
export function formatGolfersList(golfers: GolferEntry[]): string {
  return golfers.map((g) => `${g.firstname} ${g.surname}`).join(', ');
}
