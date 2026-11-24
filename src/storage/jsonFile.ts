import { promises as fs } from 'fs';
import path from 'path';

/**
 * Write JSON so a crash mid-write can never leave a truncated file: write a
 * temp file beside the target, flush it to disk, then rename it over the
 * target (atomic on the same filesystem). Files are owner-only (0600).
 */
export async function writeJsonAtomic(
  file: string,
  data: unknown,
  indent?: number
): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}`;
  const handle = await fs.open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(JSON.stringify(data, null, indent));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600);
}

/**
 * Read a JSON data file. Missing file → null (caller decides the empty value).
 * Unreadable or invalid JSON → throws, so the bot never carries on with empty
 * data and later overwrites the real file. The error never includes the
 * file's contents (some files hold credentials).
 */
export async function readJsonFile<T>(
  file: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reviver?: (key: string, value: any) => any
): Promise<T | null> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf-8');
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return null;
    throw new Error(
      `[Storage] cannot read ${path.basename(file)}: ${code ?? 'unknown error'}`
    );
  }
  try {
    return JSON.parse(text, reviver) as T;
  } catch {
    const msg = `[Storage] ${path.basename(file)} is corrupt (invalid JSON); refusing to continue with empty data`;
    console.error(msg);
    throw new Error(msg);
  }
}
