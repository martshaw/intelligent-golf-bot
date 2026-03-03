import { promises } from 'fs';
import path from 'path';

import { getDataDir } from 'shared/env';

const fs = promises;

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

/** Load auto-booking config (golfers list). Returns empty config if file missing or invalid. */
export async function getAutoBookingConfig(): Promise<AutoBookingConfig> {
  if (configCache) return configCache;
  try {
    const file = await fs.readFile(configPath());
    const parsed = JSON.parse(file.toString()) as AutoBookingConfig;
    if (!parsed || typeof parsed !== 'object') {
      configCache = {};
      return configCache;
    }
    if (Array.isArray(parsed.golfers)) {
      parsed.golfers = parsed.golfers.filter(
        (g): g is GolferEntry =>
          g &&
          typeof g === 'object' &&
          (g.type === 'member' || g.type === 'guest') &&
          typeof g.firstname === 'string' &&
          typeof g.surname === 'string'
      );
    } else {
      parsed.golfers = [];
    }
    configCache = parsed;
    return configCache;
  } catch (error: unknown) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      configCache = {};
      return configCache;
    }
    configCache = {};
    return configCache;
  }
}

/** Persist config back to disk (e.g. after caching partner IDs). */
export async function saveAutoBookingConfig(
  config: AutoBookingConfig
): Promise<void> {
  await fs.writeFile(configPath(), JSON.stringify(config, null, 2));
  configCache = config;
}

/** Format golfer list for display (e.g. success message). */
export function formatGolfersList(golfers: GolferEntry[]): string {
  return golfers.map((g) => `${g.firstname} ${g.surname}`).join(', ');
}
