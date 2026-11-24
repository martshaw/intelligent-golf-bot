/* Offline checks of atomic JSON storage (temp dir only, no real data files). */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readJsonFile, writeJsonAtomic } from '../src/storage/jsonFile';

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golfbot-storage-'));
  try {
    const file = path.join(dir, 'autoBookings.json');
    const reviver = (k: string, v: unknown) => (k === 'startDate' ? new Date(String(v)) : v);

    // Missing file -> null (callers turn this into {}).
    assert.strictEqual(await readJsonFile(file), null);

    // Round trip with a Date reviver; file is owner-only; no temp file left.
    const data = { 1: [{ id: 'a', startDate: new Date('2026-12-06T08:24:00Z') }] };
    await writeJsonAtomic(file, data);
    const back = await readJsonFile<typeof data>(file, reviver);
    assert.ok(back?.[1]?.[0]?.startDate instanceof Date);
    assert.strictEqual(back?.[1]?.[0]?.startDate.toISOString(), '2026-12-06T08:24:00.000Z');
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepStrictEqual(fs.readdirSync(dir), ['autoBookings.json']);

    // Indented write (config file style).
    await writeJsonAtomic(file, { golfers: [] }, 2);
    assert.ok(fs.readFileSync(file, 'utf8').includes('\n  "golfers"'));

    // Corrupt file -> throws, and the message never contains the file's contents.
    fs.writeFileSync(file, '{"secretvalue": "hunter2"');
    await assert.rejects(readJsonFile(file), (e: Error) => {
      assert.ok(e.message.includes('corrupt'), e.message);
      assert.ok(!e.message.includes('hunter2') && !e.message.includes('secretvalue'), e.message);
      return true;
    });

    // A leftover temp file from a crash does not affect reads or the next write.
    fs.writeFileSync(`${file}.tmp-99999`, '{"half');
    await writeJsonAtomic(file, { ok: true });
    assert.deepStrictEqual(await readJsonFile(file), { ok: true });

    console.log('storage.check: all assertions passed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
