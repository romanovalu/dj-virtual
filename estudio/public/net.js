// Conexión con el servidor local: señalización de los celulares y salida hacia ffmpeg.
const handlers = new Map();
let ws = null;
let role = null;
let hello = {};

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    ws.send(JSON.stringify({ t: 'hello', role, ...hello }));
    fire('open', {});
  };
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return;
    try {
      const msg = JSON.parse(e.data);
      fire(msg.t, msg);
    } catch {
      /* ignorar */
    }
  };
  ws.onclose = () => {
    fire('close', {});
    setTimeout(connect, 1500);
  };
}

function fire(t, msg) {
  for (const cb of handlers.get(t) ?? []) cb(msg);
}

export const net = {
  start(r, extra = {}) {
    role = r;
    hello = extra;
    connect();
  },
  on(t, cb) {
    if (!handlers.has(t)) handlers.set(t, []);
    handlers.get(t).push(cb);
  },
  send(msg) {
    if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
  },
  sendBinary(buf) {
    if (ws?.readyState === 1) ws.send(buf);
  },
  get buffered() {
    return ws?.bufferedAmount ?? 0;
  },
  get connected() {
    return ws?.readyState === 1;
  },
};
