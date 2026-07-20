'use strict';

const { existsSync } = require('node:fs');
const { delimiter, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const executable = process.platform === 'win32' ? 'prisma.cmd' : 'prisma';
const candidates = [
  resolve(__dirname, '..', 'node_modules', '.bin', executable),
  ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => resolve(directory, executable)),
];
const prisma = candidates.find(existsSync);

if (!prisma) process.exit(0);

const result = spawnSync(prisma, ['generate', '--schema=prisma/schema.prisma'], {
  cwd: resolve(__dirname, '..'),
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
