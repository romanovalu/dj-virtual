// Servidor local del estudio de transmisión.
// - HTTP en :4000 para la PC (localhost ya es "seguro" para cámara y pantalla).
// - HTTPS en :4443 para los celulares de la red (el navegador exige HTTPS para usar la cámara).
// - WebSocket en ambos: señalización WebRTC estudio <-> celulares y salida de video hacia ffmpeg.
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import selfsigned from 'selfsigned';
import QRCode from 'qrcode';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const CERT_DIR = path.join(HERE, '.cert');
const HTTP_PORT = Number(process.env.PORT ?? 4000);
const HTTPS_PORT = Number(process.env.HTTPS_PORT ?? 4443);
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// ---------- Red local ----------

function lanAddresses() {
  const skip = /vethernet|virtualbox|vmware|loopback|wsl|hyper-v|docker|tailscale|zerotier/i;
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (skip.test(name)) continue;
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  // Primero las redes domésticas típicas.
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b));
}

async function loadCert(ips) {
  const tag = ['localhost', ...ips].join(',');
  const keyFile = path.join(CERT_DIR, 'key.pem');
  const certFile = path.join(CERT_DIR, 'cert.pem');
  const tagFile = path.join(CERT_DIR, 'hosts.txt');
  try {
    if ((await fs.readFile(tagFile, 'utf8')) === tag) {
      return { key: await fs.readFile(keyFile), cert: await fs.readFile(certFile) };
    }
  } catch {
    /* no hay certificado todavía */
  }
  const notAfter = new Date();
  notAfter.setFullYear(notAfter.getFullYear() + 2);
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'Estudio local' }], {
    keySize: 2048,
    notAfterDate: notAfter,
    extensions: [
      { name: 'basicConstraints', cA: false },
      {
        name: 'subjectAltName',
        altNames: [{ type: 2, value: 'localhost' }, ...ips.map((ip) => ({ type: 7, ip }))],
      },
    ],
  });
  await fs.mkdir(CERT_DIR, { recursive: true });
  await fs.writeFile(keyFile, pems.private);
  await fs.writeFile(certFile, pems.cert);
  await fs.writeFile(tagFile, tag);
  return { key: pems.private, cert: pems.cert };
}

// ---------- Codificador de video ----------

/** Prueba los codificadores por hardware (NVIDIA, Intel, AMD) y si ninguno anda usa libx264. */
async function pickEncoder() {
  for (const enc of ['h264_nvenc', 'h264_qsv', 'h264_amf']) {
    const ok = await new Promise((resolve) => {
      const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=size=640x360:rate=30', '-frames:v', '5', '-c:v', enc, '-f', 'null', '-']);
      p.on('error', () => resolve(false));
      p.on('exit', (code) => resolve(code === 0));
    });
    if (ok) return enc;
  }
  return 'libx264';
}

function encoderArgs(enc, kbps, fps) {
  const rate = ['-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`];
  const gop = ['-g', String(fps * 2), '-keyint_min', String(fps * 2)];
  switch (enc) {
    case 'h264_nvenc':
      return ['-c:v', enc, '-preset', 'p4', '-tune', 'll', '-rc', 'cbr', ...rate, ...gop];
    case 'h264_qsv':
      return ['-c:v', enc, '-preset', 'veryfast', ...rate, ...gop];
    case 'h264_amf':
      return ['-c:v', enc, '-usage', 'lowlatency', '-rc', 'cbr', ...rate, ...gop];
    default:
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high', '-sc_threshold', '0', ...rate, ...gop];
  }
}

/**
 * Arma la línea de ffmpeg: entra el WebM del navegador por stdin y sale a cada destino RTMP.
 * Los destinos marcados como verticales (TikTok, Reels) reciben un recorte central 9:16.
 */
function buildFfmpegArgs(cfg, encoder) {
  const fps = cfg.fps ?? 30;
  const W = cfg.width;
  const H = cfg.height;
  const landscape = W >= H;
  const dests = cfg.destinations;
  const normal = dests.filter((d) => !(landscape && d.vertical));
  const vertical = dests.filter((d) => landscape && d.vertical);
  const vW = 720;
  const vH = 1280;

  const chains = [];
  const labels = [];
  if (normal.length) labels.push('h');
  if (vertical.length) labels.push('v');
  const split = labels.length === 2 ? `split=2[s0][s1];` : '';
  const src = (i) => (labels.length === 2 ? `[s${i}]` : '');
  labels.forEach((l, i) => {
    const f = l === 'h' ? `scale=${W}:${H}` : `crop=ih*9/16:ih,scale=${vW}:${vH}`;
    chains.push(`${src(i)}${f},format=yuv420p[${l}]`);
  });
  const filter = `[0:v]fps=${fps},${split}${chains.join(';')}`;

  const tee = (list) => list.map((d) => `[f=flv:onfail=ignore:flvflags=no_duration_filesize]${d.url}`).join('|');
  const audio = ['-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2'];
  const args = ['-hide_banner', '-loglevel', 'warning', '-stats', '-fflags', '+genpts', '-thread_queue_size', '1024', '-i', 'pipe:0', '-filter_complex', filter];
  if (normal.length) {
    args.push('-map', '[h]', '-map', '0:a?', ...encoderArgs(encoder, cfg.kbps, fps), ...audio, '-flags', '+global_header', '-f', 'tee', tee(normal));
  }
  if (vertical.length) {
    args.push('-map', '[v]', '-map', '0:a?', ...encoderArgs(encoder, Math.min(cfg.kbps, 3500), fps), ...audio, '-flags', '+global_header', '-f', 'tee', tee(vertical));
  }
  return args;
}

/** Oculta las claves de transmisión en lo que se muestra o se registra. */
function hideKeys(text, destinations) {
  let out = text;
  for (const d of destinations) {
    const key = d.url.split('/').pop();
    if (key && key.length > 4) out = out.split(key).join('••••');
  }
  return out;
}

// ---------- Servidor ----------

const ips = lanAddresses();
const tls = await loadCert(ips);
let encoder = 'libx264';
pickEncoder().then((e) => {
  encoder = e;
  console.log(`Codificador de video: ${e}`);
});

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/api/info') {
    const cams = await Promise.all(
      ips.map(async (ip) => {
        const link = `https://${ip}:${HTTPS_PORT}/camara.html`;
        return { ip, link, qr: await QRCode.toString(link, { type: 'svg', margin: 1 }) };
      }),
    );
    res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' });
    res.end(JSON.stringify({ cams, encoder, httpsPort: HTTPS_PORT }));
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('No encontrado');
  }
}

const httpServer = http.createServer(handle);
const httpsServer = https.createServer(tls, handle);
const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
for (const s of [httpServer, httpsServer]) {
  s.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/ws')) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
}

/** @type {import('ws').WebSocket | null} */
let studio = null;
/** @type {Map<string, {ws: import('ws').WebSocket, name: string}>} */
const cameras = new Map();
/** @type {{proc: import('node:child_process').ChildProcess, cfg: any, stopping: boolean} | null} */
let live = null;

const send = (ws, msg) => ws && ws.readyState === 1 && ws.send(JSON.stringify(msg));

function startStream(cfg) {
  stopStream();
  const args = buildFfmpegArgs(cfg, encoder);
  console.log('ffmpeg', hideKeys(args.join(' '), cfg.destinations));
  const proc = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  const cur = { proc, cfg, stopping: false };
  live = cur;
  let tail = [];
  proc.stdin.on('error', () => {});
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk) => {
    for (const line of chunk.split(/[\r\n]+/)) {
      if (!line.trim()) continue;
      const clean = hideKeys(line, cfg.destinations);
      if (line.startsWith('frame=')) {
        const num = (re) => line.match(re)?.[1];
        send(studio, { t: 'stream-stats', fps: num(/fps=\s*([\d.]+)/), kbps: num(/bitrate=\s*([\d.]+)kbits/), speed: num(/speed=\s*([\d.]+)x/), time: num(/time=(\S+)/) });
      } else {
        tail = [...tail.slice(-9), clean];
        send(studio, { t: 'stream-log', line: clean });
      }
    }
  });
  proc.on('error', (e) => send(studio, { t: 'stream-status', state: 'error', msg: `No se pudo iniciar ffmpeg: ${e.message}` }));
  proc.on('exit', (code) => {
    if (live === cur) live = null;
    send(studio, cur.stopping ? { t: 'stream-status', state: 'stopped' } : { t: 'stream-status', state: 'error', msg: `ffmpeg se cerró (código ${code}). ${tail.slice(-3).join(' · ')}` });
  });
  send(studio, { t: 'stream-status', state: 'live', encoder });
}

function stopStream() {
  if (!live) return;
  const cur = live;
  cur.stopping = true;
  cur.proc.stdin?.end();
  setTimeout(() => cur.proc.exitCode === null && cur.proc.kill('SIGKILL'), 5000);
}

wss.on('connection', (ws) => {
  let role = null;
  let id = null;

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (ws === studio && live && !live.stopping) live.proc.stdin.write(data);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    switch (msg.t) {
      case 'hello':
        role = msg.role;
        if (role === 'studio') {
          if (studio && studio !== ws) send(studio, { t: 'replaced' });
          studio = ws;
          send(ws, { t: 'cams', list: [...cameras].map(([cid, c]) => ({ id: cid, name: c.name })) });
          for (const c of cameras.values()) send(c.ws, { t: 'studio-ready' });
        } else if (role === 'camera') {
          id = String(msg.id).slice(0, 64);
          const prev = cameras.get(id);
          if (prev && prev.ws !== ws) prev.ws.close();
          cameras.set(id, { ws, name: String(msg.name || 'Celular').slice(0, 40) });
          send(studio, { t: 'cam-join', id, name: cameras.get(id).name });
          if (studio) send(ws, { t: 'studio-ready' });
        }
        break;
      case 'signal': {
        const from = role === 'studio' ? 'studio' : id;
        const target = msg.to === 'studio' ? studio : cameras.get(msg.to)?.ws;
        send(target, { t: 'signal', from, data: msg.data });
        break;
      }
      case 'tally':
        if (role === 'studio') send(cameras.get(msg.to)?.ws, { t: 'tally', state: msg.state });
        break;
      case 'stream-start':
        if (ws === studio) startStream(msg.cfg);
        break;
      case 'stream-stop':
        if (ws === studio) stopStream();
        break;
    }
  });

  ws.on('close', () => {
    if (ws === studio) {
      studio = null;
      stopStream();
    }
    if (role === 'camera' && id && cameras.get(id)?.ws === ws) {
      cameras.delete(id);
      send(studio, { t: 'cam-leave', id });
    }
  });
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`\nEstudio:   http://localhost:${HTTP_PORT}`);
  for (const ip of ips) console.log(`Celulares: https://${ip}:${HTTPS_PORT}/camara.html`);
  console.log('');
});
httpsServer.listen(HTTPS_PORT);

process.on('SIGINT', () => {
  stopStream();
  process.exit(0);
});
