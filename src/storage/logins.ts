import { promises } from 'fs';
import path from 'path';

import { getDataDir } from 'shared/env';

const fs = promises;

function loginsPath(): string {
  return path.join(getDataDir(), 'logins.json');
}

interface Login {
  username: string;
  password: string;
}

interface Logins {
  [key: number]: Login;
}

async function save(logins: Logins): Promise<boolean> {
  await fs.writeFile(loginsPath(), JSON.stringify(logins));
  return true;
}

let loginCache: Logins | null = null;

async function load(): Promise<Logins> {
  try {
    const file = await fs.readFile(loginsPath(), 'utf-8');
    return JSON.parse(file) as Logins;
  } catch (error: unknown) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return {};
    }
    console.error('Loading logins failed');
    return {};
  }
}

async function getLogins(): Promise<Logins> {
  if (!loginCache) {
    const logins = await load();
    if (!loginCache) loginCache = logins;
  }
  return loginCache;
}

export async function getLogin(userId: number): Promise<Login> {
  const logins = await getLogins();
  return logins[userId];
}

/** Returns first stored login (for debug scripts). */
export async function getFirstLogin(): Promise<{
  userId: number;
  username: string;
  password: string;
} | null> {
  const logins = await getLogins();
  const userId = Object.keys(logins)
    .map(Number)
    .find((id) => logins[id]);
  if (userId === undefined || !logins[userId]) return null;
  return {
    userId,
    username: logins[userId].username,
    password: logins[userId].password
  };
}

/** Call at startup to load logins into memory so first command avoids disk read. */
export async function preloadLogins(): Promise<void> {
  await getLogins();
}

export async function addLogin(
  userId: number,
  username: string,
  password: string
): Promise<Login> {
  const logins: Logins = await getLogins();
  logins[userId] = { username, password };
  await save(logins);
  return { username, password };
}
