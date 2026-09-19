// One-shot HTTP check: boots the server on an ephemeral port, prints header evidence, exits.
import { spawn } from 'child_process';
import { readFileSync } from 'fs';

const PORT = 3196;
const TID = process.argv[2];
const backend = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

const child = spawn('node', ['src/server.js'], {
  cwd: backend,
  env: {
    ...process.env,
    PORT: String(PORT),
    MUSIC_DIR: '/workspace/music',
    SEGMENTS_DIR: '/tmp/seg-check',
    LOG_LEVEL: 'error',
  },
  stdio: 'ignore',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (res.ok) return true;
    } catch {}
    await sleep(300);
  }
  throw new Error('server never became healthy');
}

async function probe(label, path, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers });
  const bytes = await res.arrayBuffer();
  return `${label}: ${res.status} ${res.headers.get('content-type')} ${bytes.byteLength}B`;
}

try {
  await waitHealthy();
  const lines = [];
  lines.push(await probe('V1 full      ', `/audio/${TID}`));
  lines.push(await probe('V1 range     ', `/audio/${TID}`, { Range: 'bytes=0-1023' }));

  const manifest = await fetch(`http://127.0.0.1:${PORT}/audio/${TID}/manifest`);
  const json = await manifest.json();
  lines.push(`V2 manifest  : ${manifest.status} segments=${json.segments?.length} mime=${json.mime}`);

  lines.push(await probe('V2 init      ', `/audio/${TID}/init`));
  lines.push(await probe('V2 segment   ', `/audio/${TID}/segment/0`));
  lines.push(await probe('V2 bad index ', `/audio/${TID}/segment/99`));

  console.log(lines.join('\n'));
} finally {
  child.kill('SIGTERM');
  await sleep(400);
  child.kill('SIGKILL');
}
