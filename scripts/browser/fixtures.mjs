import http from 'node:http';
import { fileURLToPath } from 'node:url';

const shell = (title, body, script = '') => `<!doctype html><html lang="en"><meta charset="utf-8">
<title>EcoGuard fixture: ${title}</title><style>body{font:16px/1.5 system-ui;max-width:760px;margin:40px auto;padding:16px}a{margin-right:16px}textarea{display:block;width:95%;height:120px}button{padding:10px}#status{white-space:pre-wrap}</style>
<h1>${title}</h1>${body}<p id="status" role="status">Local disposable EcoGuard test page.</p>
${script ? `<script>${script}</script>` : ''}</html>`;
const allocation = `window.fixtureMemory = new Uint8Array(32 * 1024 * 1024); for(let i=0;i<fixtureMemory.length;i+=4096) fixtureMemory[i]=123;`;
const pages = {
  '/': shell('Browser acceptance fixtures', '<p>Only local test data. Keep one control tab active and put test pages in the background.</p>' +
    ['allocation', 'editable', 'media', 'frame', 'workload'].map(name => `<p><a href="/${name}" target="_blank">${name}</a></p>`).join('') +
    '<p><a href="/download">Slow download (20 seconds)</a></p>'),
  '/allocation': shell('Read-only allocation', '<p>Retains 32 MiB of touched memory until unloaded. No inputs, media or frames.</p>', allocation),
  '/editable': shell('Unsaved edits', '<label for="draft">Disposable draft</label><textarea id="draft" placeholder="Type test text here"></textarea><p>Edit, navigate with the link, then verify sticky edit protection.</p><a href="#section">Same-document navigation</a>'),
  '/media': shell('Playing media', '<p>Play starts a quiet generated local tone. Muting does not remove media protection.</p><audio id="audio" controls loop src="/tone.wav"></audio>'),
  '/frame': shell('Embedded frame', '<iframe title="Disposable embedded content" src="/embedded"></iframe>'),
  '/embedded': shell('Embedded document', '<p>Frame content is not read by EcoGuard.</p>'),
  '/workload': shell('CPU and network workload', '<p>32 MiB allocation, about 10 ms of CPU and a 64 KiB loopback fetch every two seconds. Closing/unloading stops it.</p>', `${allocation}
let ticks=0; setInterval(async()=>{const end=performance.now()+10;while(performance.now()<end)Math.sqrt(Math.random());try{await fetch('/payload',{cache:'no-store'});document.getElementById('status').textContent='Completed '+(++ticks)+' local workload ticks.';}catch{}},2000);`)
};

function tone() {
  const rate = 8000;
  const data = Buffer.alloc(44 + rate * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(rate * 2, 40);
  for (let i = 0; i < rate; i++) data.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / rate) * 300), 44 + i * 2);
  return data;
}

export async function startFixtures({ port = 0 } = {}) {
  const sockets = new Set();
  let bytesSent = 0;
  const server = http.createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, type, body) => {
      response.writeHead(status, { 'Content-Type': type });
      bytesSent += Buffer.byteLength(body);
      response.end(body);
    };
    if (request.method !== 'GET') { send(405, 'text/plain', 'GET only'); return; }
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (Object.hasOwn(pages, pathname)) { send(200, 'text/html; charset=utf-8', pages[pathname]); return; }
    if (pathname === '/payload') { send(200, 'application/octet-stream', Buffer.alloc(64 * 1024, 42)); return; }
    if (pathname === '/tone.wav') { send(200, 'audio/wav', tone()); return; }
    if (pathname === '/download' || pathname === '/download-long') {
      const seconds = pathname === '/download-long' ? 90 : 20;
      response.writeHead(200, { 'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="ecoguard-disposable.bin"', 'Content-Length': seconds * 1024 });
      let chunks = 0;
      const timer = setInterval(() => {
        bytesSent += 1024; response.write(Buffer.alloc(1024));
        if (++chunks === seconds) { clearInterval(timer); response.end(); }
      }, 1000);
      response.on('close', () => clearInterval(timer));
      return;
    }
    send(404, 'text/plain', 'Not found');
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    bytesSent: () => bytesSent,
    close: () => new Promise(resolve => { server.close(resolve); for (const socket of sockets) socket.destroy(); })
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixtures = await startFixtures({ port: Number(process.env.PORT ?? 8765) });
  console.log(`EcoGuard offline fixtures: ${fixtures.origin} (Ctrl+C to stop)`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await fixtures.close(); });
}
