'use strict';

const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const executable = process.platform === 'win32' ? 'prisma.cmd' : 'prisma';
const prisma = resolve(__dirname, '..', 'node_modules', '.bin', executable);

if (!existsSync(prisma)) process.exit(0);

const result = spawnSync(prisma, ['generate', '--schema=prisma/schema.prisma'], {
  cwd: resolve(__dirname, '..'),
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
