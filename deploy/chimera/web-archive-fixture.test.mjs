import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const validator = path.join(import.meta.dirname, 'libexec/chimera-validate-web-archive');

function createArchive(kind) {
  const root = mkdtempSync(path.join(tmpdir(), 'chimera-web-archive-'));
  const archive = path.join(root, `${kind}.tar.gz`);
  const code = String.raw`
import io,sys,tarfile
archive,kind=sys.argv[1:]
with tarfile.open(archive,'w:gz') as bundle:
  def regular(name,data=b'x'):
    item=tarfile.TarInfo(name); item.size=len(data); bundle.addfile(item,io.BytesIO(data))
  if kind == 'safe': regular('index.html',b'<script src="/assets/app-deadbeef.js"></script>'); regular('assets/app-deadbeef.js')
  elif kind == 'traversal': regular('../escape'); regular('index.html')
  elif kind == 'symlink':
    regular('index.html'); item=tarfile.TarInfo('assets/link-deadbeef.js'); item.type=tarfile.SYMTYPE; item.linkname='/etc/passwd'; bundle.addfile(item)
  elif kind == 'duplicate': regular('index.html'); regular('index.html')
  elif kind == 'missing-index': regular('assets/app-deadbeef.js')
`;
  const result = spawnSync('python3', ['-c', code, archive, kind]);
  assert.equal(result.status, 0, result.stderr.toString());
  return { root, archive };
}

test('web archive fixture accepts a regular index and hashed asset', () => {
  const f = createArchive('safe');
  try { assert.equal(spawnSync('python3', [validator, f.archive]).status, 0); }
  finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const kind of ['traversal', 'symlink', 'duplicate', 'missing-index']) {
  test(`web archive fixture rejects ${kind}`, () => {
    const f = createArchive(kind);
    try { assert.notEqual(spawnSync('python3', [validator, f.archive]).status, 0); }
    finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}
