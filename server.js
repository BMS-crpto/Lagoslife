const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, data) => {
    if (err) { res.writeHead(500); return res.end('error'); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
});

// ---- tiny dependency-free WebSocket (text frames) ----
class Sock {
  constructor(socket) { this.socket = socket; this.readyState = 1; this.buf = Buffer.alloc(0); this.handlers = {};
    socket.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    socket.on('close', () => this.end()); socket.on('error', () => this.end()); }
  on(e, f) { this.handlers[e] = f; }
  end() { if (this.readyState === 1) { this.readyState = 3; this.handlers.close && this.handlers.close(); } }
  send(str) {
    const p = Buffer.from(str); let h;
    if (p.length < 126) h = Buffer.from([0x81, p.length]);
    else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(p.length, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(p.length), 2); }
    this.socket.write(Buffer.concat([h, p]));
  }
  parse() {
    while (this.buf.length >= 2) {
      const op = this.buf[0] & 0x0f, masked = this.buf[1] & 0x80; let len = this.buf[1] & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (len > 1e5) { this.socket.destroy(); return; }
      const total = off + (masked ? 4 : 0) + len; if (this.buf.length < total) return;
      let payload = this.buf.slice(off + (masked ? 4 : 0), total);
      if (masked) { const k = this.buf.slice(off, off + 4); payload = Buffer.from(payload.map((b, i) => b ^ k[i % 4])); }
      this.buf = this.buf.slice(total);
      if (op === 1 && this.handlers.message) this.handlers.message(payload.toString());
      else if (op === 8) { this.socket.end(); this.end(); return; }
      else if (op === 9) { this.socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); }
    }
  }
}
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key']; if (!key) return socket.destroy();
  const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  onConnection(new Sock(socket));
});

const rooms = {}; // code -> { players:{}, owners:{houseId:playerId} }
let nextId = 1;
const ROLES = ['police', 'thief', 'nurse', 'lawyer', 'taxi', 'courier'];

// ---- world layout (same for every room) ----
const cx = b => b * 40 + 20;
const HOUSES = [[-4,-4],[-3,-4],[2,-4],[3,-4],[-4,2],[3,2]].map(([bx,bz],i) => ({ id: i, x: cx(bx)+9, z: cx(bz)+6, price: 3000 + i*1500 }));
const SHOPS = [[-4,-3],[3,-3],[-4,3],[3,3]].map(([bx,bz],i) => ({ id: i, x: cx(bx)-9, z: cx(bz)-6 }));
const JAIL = { x: -175, z: 175 };
const CLUB = { x: cx(0) + 9, z: cx(-4) + 6 };
const FOOD = [{ name: 'Jollof & chicken', price: 50, en: 40 }, { name: 'Amala & ewedu', price: 30, en: 30 }, { name: 'Suya', price: 20, en: 15 }];
const LM = [['🏨','Eko Hotels',-120,-120],['🌴','Lekki Conservation',120,-120],['🏢','Marina Towers',-40,-40],['🛒','Balogun Market',40,40],['🕌','Central Mosque',120,40],['⛪','Church',-120,40],['🚓','Police Station',0,-80],['⛳','Ikoyi Golf Club',80,120],['🎉','Quilox Club',40,-120],['🏠','Home Estate',-80,120]].map(([emoji,name,x,z],id) => ({ id, emoji, name, x, z }));
const RIDES = { keke: { emoji: '🛺', base: 30, rate: 0.5 }, danfo: { emoji: '🚌', base: 30, rate: 0.2 }, okada: { emoji: '🏍️', base: 100, rate: 1.2 }, car: { emoji: '🚗', base: 200, rate: 2.5 } };
const WORLD = { houses: HOUSES, shops: SHOPS, jail: JAIL, club: CLUB, landmarks: LM };

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room, msg) { Object.values(rooms[room].players).forEach(p => send(p.ws, msg)); }
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
function nearest(room, me, filter, maxd) {
  let best = null, bd = maxd;
  for (const p of Object.values(rooms[room].players)) {
    if (p.id === me.id || !filter(p)) continue;
    const d = dist(p, me); if (d < bd) { bd = d; best = p; }
  }
  return best;
}
function jail(room, p, ms) {
  p.jailUntil = Date.now() + ms;
  p.x = JAIL.x + (Math.random() - 0.5) * 6; p.z = JAIL.z + (Math.random() - 0.5) * 6; p.car = -1;
  send(p.ws, { t: 'tp', x: p.x, z: p.z });
}
function cooldown(p, key, ms) { const n = Date.now(); if ((p.cd[key] || 0) > n) return false; p.cd[key] = n + ms; return true; }

function onConnection(ws) {
  let id = null, room = null;
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'join') {
      room = String(m.room || 'LOBBY').toUpperCase().slice(0, 8);
      const role = ROLES.includes(m.role) ? m.role : 'thief';
      id = nextId++;
      rooms[room] = rooms[room] || { players: {}, owners: {} };
      rooms[room].players[id] = {
        ws, id, name: String(m.name || 'Player').slice(0, 14), role, money: 500, vibes: 0, energy: 100, rest: 100, fun: 100, carry: false, car: -1, jailUntil: 0, cd: {},
        x: (Math.random() - 0.5) * 8, z: (Math.random() - 0.5) * 8, ry: 0, moving: false
      };
      send(ws, { t: 'welcome', id, room, world: WORLD });
      broadcast(room, { t: 'toast', text: `${rooms[room].players[id].name} joined as ${role}` });
      return;
    }
    if (!room || !rooms[room] || !rooms[room].players[id]) return;
    const p = rooms[room].players[id], R = rooms[room];
    const now = Date.now();
    if (m.t === 'move') {
      if (p.jailUntil > now) return;
      p.x = +m.x || 0; p.z = +m.z || 0; p.ry = +m.ry || 0; p.moving = !!m.moving;
      p.car = Number.isInteger(m.car) && m.car >= 0 && m.car < 5 ? m.car : -1;
    } else if (m.t === 'chat') {
      broadcast(room, { t: 'chat', name: p.name, text: String(m.text || '').slice(0, 80) });
    } else if (m.t === 'buy') {
      if (p.jailUntil > now) return;
      const h = HOUSES.find(h => dist(h, p) < 9);
      if (!h) return send(ws, { t: 'toast', text: 'No house nearby' });
      if (R.owners[h.id]) return send(ws, { t: 'toast', text: 'Already owned' });
      if (p.money < h.price) return send(ws, { t: 'toast', text: `Need ₦${h.price}` });
      p.money -= h.price; R.owners[h.id] = p.id;
      broadcast(room, { t: 'toast', text: `🏠 ${p.name} bought a house! (earns rent)` });
    } else if (m.t === 'eat') {
      if (p.jailUntil > now) return;
      if (!SHOPS.find(s => dist(s, p) < 8)) return send(ws, { t: 'toast', text: 'Go to a shop' });
      const f = FOOD[m.i] || FOOD[0];
      if (p.money < f.price) return send(ws, { t: 'toast', text: 'Need ₦' + f.price });
      if (p.energy >= 100) return send(ws, { t: 'toast', text: 'You are full' });
      p.money -= f.price; p.energy = Math.min(100, p.energy + f.en);
      send(ws, { t: 'toast', text: '😋 ' + f.name + '! Energy restored' });
    } else if (m.t === 'party') {
      if (p.jailUntil > now) return;
      if (dist(CLUB, p) > 12) return send(ws, { t: 'toast', text: 'Go to Quilox Club' });
      if (p.money < 100) return send(ws, { t: 'toast', text: 'Need ₦100 for the club' });
      if (!cooldown(p, 'party', 5000)) return send(ws, { t: 'toast', text: 'Relax, one drink at a time' });
      p.money -= 100; p.vibes++; p.fun = Math.min(100, p.fun + 30);
      broadcast(room, { t: 'toast', text: `🎉 ${p.name} is vibing at Quilox! (vibes ${p.vibes})` });
    } else if (m.t === 'setrole') {
      if (ROLES.includes(m.role)) { p.role = m.role; p.carry = false; broadcast(room, { t: 'toast', text: `💼 ${p.name} is now a ${m.role}` }); }
    } else if (m.t === 'sleep') {
      if (p.jailUntil > now) return;
      const h = HOUSES.find(h => dist(h, p) < 9 && R.owners[h.id] === p.id);
      if (!h) return send(ws, { t: 'toast', text: 'Go to your own house to sleep' });
      if (!cooldown(p, 'sleep', 8000)) return send(ws, { t: 'toast', text: 'You just woke up' });
      p.rest = Math.min(100, p.rest + 50); send(ws, { t: 'toast', text: '😴 Slept well' });
    } else if (m.t === 'ride') {
      if (p.jailUntil > now) return;
      const L = LM[m.dest], r = RIDES[m.type];
      if (!L || !r) return;
      const fare = Math.round(r.base + dist(L, p) * r.rate);
      if (p.money < fare) return send(ws, { t: 'toast', text: 'Need ₦' + fare });
      p.money -= fare;
      const drv = Object.values(R.players).find(q => q.id !== p.id && q.role === 'taxi' && q.jailUntil <= now);
      if (drv) { drv.money += Math.round(fare / 2); send(drv.ws, { t: 'toast', text: `🚖 ${p.name} paid you ₦${Math.round(fare / 2)}` }); }
      p.x = L.x + 3; p.z = L.z + 3; p.car = -1; send(ws, { t: 'tp', x: p.x, z: p.z });
      send(ws, { t: 'toast', text: `${r.emoji} Arrived at ${L.name} (₦${fare})` });
    } else if (m.t === 'action') {
      if (p.jailUntil > now) return send(ws, { t: 'toast', text: 'You are in jail!' });
      const say = text => broadcast(room, { t: 'toast', text });
      const me = text => send(ws, { t: 'toast', text });
      const free = q => q.jailUntil <= now;
      if (p.role === 'police') {
        const t = nearest(room, p, q => q.role === 'thief' && free(q), 10);
        if (!t) return me('No thief close enough');
        const take = Math.floor(t.money * 0.25); t.money -= take; p.money += take + 200;
        jail(room, t, 15000); say(`🚔 ${p.name} arrested ${t.name}! (+₦${take + 200})`);
      } else if (p.role === 'thief') {
        const shop = SHOPS.find(s => dist(s, p) < 8);
        if (shop) {
          if (!cooldown(p, 'shop', 20000)) return me('Shop was just robbed, wait...');
          const take = nepa ? 700 : 400; p.money += take; say(`💰 ${p.name} robbed a shop${nepa ? ' during NEPA' : ''}! (+₦${take})`);
        } else {
          const v = nearest(room, p, q => free(q) && q.money >= 50, 7);
          if (!v) return me('Go near a shop or a player to rob');
          if (!cooldown(p, 'rob', 8000)) return me('Wait a few seconds...');
          const loot = Math.min(500, Math.floor(v.money * 0.15)); v.money -= loot; p.money += loot;
          say(`💰 ${p.name} robbed ${v.name} of ₦${loot}!`);
        }
      } else if (p.role === 'nurse') {
        const t = nearest(room, p, free, 7);
        if (!t) return me('No patient nearby');
        if (!cooldown(p, 'heal', 5000)) return me('Wait a few seconds...');
        p.money += 150; t.energy = Math.min(100, t.energy + 40); say(`💉 ${p.name} healed ${t.name} (+₦150)`);
      } else if (p.role === 'lawyer') {
        const t = nearest(room, p, q => !free(q), 12);
        if (!t) return me('No one in jail nearby. Walk to the jail!');
        const fee = Math.min(100, t.money); t.money -= fee; p.money += 300 + fee; t.jailUntil = 0;
        t.x = 0; t.z = 8; send(t.ws, { t: 'tp', x: 0, z: 8 });
        say(`⚖️ ${p.name} freed ${t.name} from jail! (+₦${300 + fee})`);
      } else if (p.role === 'courier') {
        const shop = SHOPS.find(s => dist(s, p) < 8);
        if (shop && !p.carry) { p.carry = true; return me('📦 Package picked up! Deliver to a house'); }
        const h = HOUSES.find(h => dist(h, p) < 9);
        if (p.carry && h) { p.carry = false; p.money += 250; say(`📦 ${p.name} delivered a package (+₦250)`); }
        else me(p.carry ? 'Walk to a house to deliver' : 'Pick up a package at a shop');
      } else if (p.role === 'taxi') {
        const t = nearest(room, p, q => free(q) && q.car < 0, 6);
        if (!t) return me('No passenger nearby');
        if (!cooldown(p, 'taxi', 8000)) return me('Wait a few seconds...');
        p.money += 100; say(`🚌 ${p.name} loaded ${t.name} in danfo (+₦100)`);
      }
    }
  });
  ws.on('close', () => {
    if (room && rooms[room]) {
      const p = rooms[room].players[id];
      delete rooms[room].players[id];
      for (const h in rooms[room].owners) if (rooms[room].owners[h] === id) delete rooms[room].owners[h];
      if (p) broadcast(room, { t: 'toast', text: `${p.name} left` });
      if (!Object.keys(rooms[room].players).length) delete rooms[room];
    }
  });
}

setInterval(() => {
  const now = Date.now();
  for (const code in rooms) {
    const R = rooms[code];
    for (const p of Object.values(R.players)) {
      if (p.jailUntil && p.jailUntil <= now) { p.jailUntil = 0; p.x = 0; p.z = 8; send(p.ws, { t: 'tp', x: 0, z: 8 }); send(p.ws, { t: 'toast', text: 'You are free!' }); }
    }
    const owners = {};
    for (const h in R.owners) { const o = R.players[R.owners[h]]; if (o) owners[h] = o.name; }
    const list = Object.values(R.players).map(p => ({
      id: p.id, name: p.name, role: p.role, x: p.x, z: p.z, ry: p.ry, moving: p.moving,
      car: p.car, money: p.money, vibes: p.vibes, energy: Math.round(p.energy), rest: Math.round(p.rest), fun: Math.round(p.fun), carry: p.carry, jailed: p.jailUntil > now
    }));
    broadcast(code, { t: 'state', players: list, owners, tod: ((now - START) / 240000) % 1, rain, nepa });
  }
}, 66);

// house rent every 10s
setInterval(() => {
  for (const code in rooms) for (const h in rooms[code].owners) {
    const o = rooms[code].players[rooms[code].owners[h]]; if (o) o.money += 25;
  }
}, 10000);

// day/night (4 min cycle) + random rain + energy drain
const START = Date.now(); let rain = false, nepa = false;
setInterval(() => { if (Math.random() < 0.25) rain = !rain; if (Math.random() < 0.2) nepa = !nepa; }, 40000);
setInterval(() => {
  for (const code in rooms) for (const p of Object.values(rooms[code].players)) {
    p.energy = Math.max(0, p.energy - 1); p.rest = Math.max(0, p.rest - 0.6); p.fun = Math.max(0, p.fun - 0.8);
    if (p.energy === 0 && Math.random() < 0.2) send(p.ws, { t: 'toast', text: '😫 Exhausted! Buy food at a shop' });
  }
}, 3000);

server.listen(PORT, () => console.log('City game running on port ' + PORT));
