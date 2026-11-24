#!/usr/bin/env node
/* Run every tests/*.check.ts with ts-node (transpile only). Exit 1 on any failure. */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tsNode = path.join(root, 'node_modules/ts-node/dist/bin.js');
const files = fs
  .readdirSync(path.join(root, 'tests'))
  .filter((f) => f.endsWith('.check.ts') && !f.includes('.bak-'))
  .sort();

let failed = 0;
for (const f of files) {
  const rel = path.join('tests', f);
  const r = spawnSync(
    process.execPath,
    [
      tsNode,
      '-T',
      '-O',
      '{"module":"commonjs","esModuleInterop":true,"baseUrl":"src"}',
      '-r',
      'tsconfig-paths/register',
      rel
    ],
    { cwd: root, encoding: 'utf8' }
  );
  if (r.status === 0) {
    console.log(`PASS ${rel}`);
  } else {
    failed++;
    console.log(`FAIL ${rel}`);
    process.stdout.write(r.stdout ?? '');
    process.stderr.write(r.stderr ?? '');
  }
}
console.log(`${files.length - failed}/${files.length} check files passed`);
process.exit(failed ? 1 : 0);
