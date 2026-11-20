// Horde Co-op : serveur autoritaire (Node + ws)
// Lancer : npm install && npm start  ->  http://localhost:8080
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const W = 1600, H = 900, TICK = 30, DT = 1 / TICK, MAXP = 4;

// Sert aussi index.html (pratique pour la version "page web")
const server = http.createServer((req, res) => {
  if (req.url.split('?')[0] === '/') {
    fs.readFile(path.join(__dirname, 'index.html'), (e, d) => {
      if (e) { res.writeHead(404); return res.end('index.html introuvable'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(d);
    });
  } else { res.writeHead(200); res.end('ok'); }
});
const wss = new WebSocketServer({ server });

const TYPES = {
  g: { hp: 3, sp: 85, r: 14, dmg: 8, pts: 10 },   // grunt
  f: { hp: 1, sp: 150, r: 10, dmg: 5, pts: 15 },  // rapide
  t: { hp: 12, sp: 50, r: 24, dmg: 20, pts: 50 }  // tank
};

const rooms = new Map();
let nextId = 1;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function makeRoom(code) {
  return { code, host: null, players: new Map(), enemies: [], bullets: [], wave: 0, phase: 'lobby', timer: 3, queue: [], spawnT: 0, uid: 1 };
}

function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = ''; for (let i = 0; i < 4; i++) c += A[(Math.random() * A.length) | 0]; } while (rooms.has(c));
  return c;
}

const cleanCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };

wss.on('connection', (ws) => {
  let room = null, p = null;

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if ((m.t === 'create' || m.t === 'join') && !p) {
      let r;
      if (m.t === 'create') {
        r = makeRoom(makeCode());
        rooms.set(r.code, r);
      } else {
        r = rooms.get(cleanCode(m.room));
        if (!r) { send(ws, { t: 'err', msg: 'Groupe introuvable (vérifie le code)' }); return; }
        if (r.players.size >= MAXP) { send(ws, { t: 'err', msg: 'Groupe plein (4 joueurs max)' }); return; }
      }
      room = r;
      const name = String(m.name || 'Joueur').replace(/[<>]/g, '').slice(0, 12) || 'Joueur';
      p = {
        id: nextId++, name, x: W / 2 + (Math.random() - 0.5) * 100, y: H / 2 + (Math.random() - 0.5) * 100,
        ang: 0, hp: 100, alive: true, score: 0, cd: 0, inv: 0,
        in: { mx: 0, my: 0, ang: 0, sh: false }
      };
      room.players.set(p.id, p);
      if (room.host === null) room.host = p.id;
      send(ws, { t: 'hello', id: p.id, room: room.code, W, H });
    } else if (m.t === 'start' && p && room) {
      if (p.id === room.host && room.phase === 'lobby') { room.phase = 'break'; room.timer = 3; }
    } else if (m.t === 'in' && p) {
      const mx = clamp(+m.mx || 0, -1, 1), my = clamp(+m.my || 0, -1, 1);
      const l = Math.hypot(mx, my) || 1;
      p.in.mx = l > 1 ? mx / l : mx;
      p.in.my = l > 1 ? my / l : my;
      p.in.ang = +m.ang || 0;
      p.in.sh = !!m.sh;
    }
  });

  ws.on('close', () => {
    if (room && p) {
      room.players.delete(p.id);
      if (room.players.size === 0) rooms.delete(room.code);
      else if (room.host === p.id) room.host = room.players.keys().next().value;
    }
  });

  ws._get = () => ({ room, p });
});

function startWave(r) {
  r.wave++;
  const n = r.wave, k = 0.6 + 0.4 * r.players.size;
  const g = Math.round((4 + 2 * n) * k);
  const f = n >= 2 ? Math.round(n * 1.2 * k) : 0;
  const t = n >= 3 ? Math.round(((n - 1) / 2) * k) : 0;
  const q = [];
  for (let i = 0; i < g; i++) q.push('g');
  for (let i = 0; i < f; i++) q.push('f');
  for (let i = 0; i < t; i++) q.push('t');
  for (let i = q.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [q[i], q[j]] = [q[j], q[i]]; }
  r.queue = q; r.phase = 'wave'; r.spawnT = 0;
}

function spawnEnemy(r, type) {
  const T = TYPES[type];
  const side = (Math.random() * 4) | 0, m = 30;
  let x, y;
  if (side === 0) { x = Math.random() * W; y = -m; }
  else if (side === 1) { x = W + m; y = Math.random() * H; }
  else if (side === 2) { x = Math.random() * W; y = H + m; }
  else { x = -m; y = Math.random() * H; }
  const scale = type === 'f' ? 1 : 1 + (r.wave - 1) * 0.12;
  r.enemies.push({ id: r.uid++, type, x, y, r: T.r, hp: Math.ceil(T.hp * scale) });
}

function step(r) {
  const players = [...r.players.values()];

  for (const p of players) {
    p.cd -= DT; p.inv -= DT;
    if (!p.alive) continue;
    p.x = clamp(p.x + p.in.mx * 260 * DT, 15, W - 15);
    p.y = clamp(p.y + p.in.my * 260 * DT, 15, H - 15);
    p.ang = p.in.ang;
    if (p.in.sh && p.cd <= 0) {
      p.cd = 0.14;
      const c = Math.cos(p.ang), s = Math.sin(p.ang);
      r.bullets.push({ id: r.uid++, x: p.x + c * 20, y: p.y + s * 20, vx: c * 750, vy: s * 750, life: 0.9, o: p.id });
    }
  }

  // Balles
  for (const b of r.bullets) {
    b.x += b.vx * DT; b.y += b.vy * DT; b.life -= DT;
    if (b.x < 0 || b.x > W || b.y < 0 || b.y > H) b.life = 0;
    if (b.life <= 0) continue;
    for (const e of r.enemies) {
      if (e.hp <= 0) continue;
      const dx = e.x - b.x, dy = e.y - b.y;
      if (dx * dx + dy * dy < (e.r + 4) * (e.r + 4)) {
        e.hp--; b.life = 0;
        if (e.hp <= 0) { const o = r.players.get(b.o); if (o) o.score += TYPES[e.type].pts; }
        break;
      }
    }
  }
  r.bullets = r.bullets.filter((b) => b.life > 0);

  // Ennemis
  const alive = players.filter((p) => p.alive);
  for (const e of r.enemies) {
    if (e.hp <= 0) continue;
    const T = TYPES[e.type];
    let tgt = null, bd = Infinity;
    for (const p of alive) { const d = (p.x - e.x) ** 2 + (p.y - e.y) ** 2; if (d < bd) { bd = d; tgt = p; } }
    if (tgt) {
      const d = Math.sqrt(bd) || 1;
      e.x += ((tgt.x - e.x) / d) * T.sp * DT;
      e.y += ((tgt.y - e.y) / d) * T.sp * DT;
      if (d < e.r + 16 && tgt.inv <= 0) {
        tgt.hp -= T.dmg; tgt.inv = 0.5;
        if (tgt.hp <= 0) { tgt.hp = 0; tgt.alive = false; }
      }
    }
  }
  // Séparation entre ennemis
  const en = r.enemies;
  for (let i = 0; i < en.length; i++) {
    for (let j = i + 1; j < en.length; j++) {
      const a = en[i], b = en[j];
      const dx = b.x - a.x, dy = b.y - a.y, min = a.r + b.r;
      const d2 = dx * dx + dy * dy;
      if (d2 > 0 && d2 < min * min) {
        const d = Math.sqrt(d2), push = (min - d) / 2;
        a.x -= (dx / d) * push; a.y -= (dy / d) * push;
        b.x += (dx / d) * push; b.y += (dy / d) * push;
      }
    }
  }
  r.enemies = r.enemies.filter((e) => e.hp > 0);

  // Phases
  if (r.phase === 'break') {
    r.timer -= DT;
    if (r.timer <= 0) startWave(r);
  } else if (r.phase === 'wave') {
    r.spawnT -= DT;
    if (r.queue.length && r.spawnT <= 0) { spawnEnemy(r, r.queue.pop()); r.spawnT = 0.5; }
    if (!r.queue.length && !r.enemies.length) {
      for (const p of players) {
        if (!p.alive) { p.alive = true; p.hp = 50; p.x = W / 2; p.y = H / 2; }
        else p.hp = Math.min(100, p.hp + 25);
      }
      r.phase = 'break'; r.timer = 4;
    }
    if (players.length && !players.some((p) => p.alive)) { r.phase = 'over'; r.timer = 5; }
  } else if (r.phase === 'over') {
    r.timer -= DT;
    if (r.timer <= 0) {
      r.wave = 0; r.enemies = []; r.bullets = []; r.queue = [];
      for (const p of players) { p.alive = true; p.hp = 100; p.score = 0; p.x = W / 2; p.y = H / 2; }
      r.phase = 'break'; r.timer = 3;
    }
  }
}

function broadcast(r) {
  const r1 = Math.round;
  const msg = JSON.stringify({
    t: 's', ph: r.phase, w: r.wave, bt: Math.max(0, Math.ceil(r.timer)), h: r.host,
    p: [...r.players.values()].map((p) => [p.id, r1(p.x), r1(p.y), +p.ang.toFixed(2), r1(p.hp), p.alive ? 1 : 0, p.score, p.name]),
    e: r.enemies.map((e) => [e.id, e.type, r1(e.x), r1(e.y)]),
    b: r.bullets.map((b) => [b.id, r1(b.x), r1(b.y)])
  });
  for (const ws of wss.clients) {
    const { room } = ws._get ? ws._get() : {};
    if (room === r && ws.readyState === 1) ws.send(msg);
  }
}

setInterval(() => {
  for (const r of rooms.values()) { step(r); broadcast(r); }
}, 1000 / TICK);

server.listen(PORT, () => console.log('Horde Co-op sur http://localhost:' + PORT));
