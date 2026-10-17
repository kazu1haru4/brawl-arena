require('dotenv').config();
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { MongoClient } = require('mongodb');

const PORT = Number(process.env.PORT || 8080);
const ROOM_SIZE = Math.max(2, Math.min(10, Number(process.env.ROOM_SIZE || 10)));
const MATCH_WAIT_MS = Math.max(2000, Number(process.env.MATCH_WAIT_MS || 10000));
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && (!allowedOrigins.length || allowedOrigins.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, service: 'brawl-arena-online', queue: queue.length, rooms: rooms.size }));
  }
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const reply = (status, body) => { res.writeHead(status); res.end(JSON.stringify(body)); };
    const readBody = () => new Promise((resolve, reject) => {
      let raw = ''; req.on('data', chunk => { raw += chunk; if (raw.length > 8192) { reject(new Error('too-large')); req.destroy(); } });
      req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('bad-json')); } }); req.on('error', reject);
    });
    try {
      if (!db) return reply(503, { ok: false, error: 'database_unavailable', message: 'データベースに接続できません。少し待ってから再試行してください。' });
      if (req.method === 'POST' && url.pathname === '/api/register') {
        const body = await readBody();
        const userId = String(body.userId || '').trim().toLowerCase();
        const displayName = String(body.displayName || userId).trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, 20) || userId;
        const password = String(body.password || '');
        if (!/^[a-z0-9_]{3,20}$/.test(userId)) return reply(400, { ok:false, error:'invalid_user_id', message:'ユーザーIDは英小文字・数字・_ の3〜20文字にしてください。' });
        if (password.length < 8 || password.length > 128) return reply(400, { ok:false, error:'invalid_password', message:'パスワードは8〜128文字にしてください。' });
        const users = db.collection('users');
        const exists = await users.findOne({ userId });
        if (exists) return reply(409, { ok:false, error:'user_exists', message:'そのユーザーIDはすでに使われています。' });
        const salt = crypto.randomBytes(16).toString('hex');
        const passwordHash = await new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (err, key) => err ? reject(err) : resolve(key.toString('hex'))));
        const now = new Date();
        await users.insertOne({ userId, displayName, passwordHash, salt, createdAt: now });
        const token = crypto.randomBytes(32).toString('hex');
        await db.collection('sessions').insertOne({ tokenHash: crypto.createHash('sha256').update(token).digest('hex'), userId, createdAt: now, expiresAt: new Date(Date.now() + 30*24*60*60*1000) });
        return reply(201, { ok:true, token, user:{ userId, displayName } });
      }
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const body = await readBody(); const userId = String(body.userId || '').trim().toLowerCase(); const password = String(body.password || '');
        const user = await db.collection('users').findOne({ userId });
        // Same response for unknown IDs and wrong passwords.
        if (!user || password.length > 128) return reply(401, { ok:false, error:'invalid_credentials', message:'ユーザーIDまたはパスワードが違います。' });
        const candidate = await new Promise((resolve, reject) => crypto.scrypt(password, user.salt, 64, (err, key) => err ? reject(err) : resolve(key.toString('hex'))));
        if (candidate.length !== user.passwordHash.length || !crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(user.passwordHash, 'hex'))) return reply(401, { ok:false, error:'invalid_credentials', message:'ユーザーIDまたはパスワードが違います。' });
        const token = crypto.randomBytes(32).toString('hex');
        await db.collection('sessions').insertOne({ tokenHash: crypto.createHash('sha256').update(token).digest('hex'), userId, createdAt: new Date(), expiresAt: new Date(Date.now() + 30*24*60*60*1000) });
        return reply(200, { ok:true, token, user:{ userId:user.userId, displayName:user.displayName } });
      }
      const auth = String(req.headers.authorization || '');
      if (auth.startsWith('Bearer ') && (req.method === 'GET' && url.pathname === '/api/me' || req.method === 'POST' && url.pathname === '/api/logout')) {
        const tokenHash = crypto.createHash('sha256').update(auth.slice(7)).digest('hex');
        const sessions = db.collection('sessions'); const session = await sessions.findOne({ tokenHash, expiresAt: { $gt: new Date() } });
        if (!session) return reply(401, { ok:false, error:'unauthorized', message:'ログインし直してください。' });
        if (req.method === 'POST') { await sessions.deleteOne({ _id: session._id }); return reply(200, { ok:true }); }
        const user = await db.collection('users').findOne({ userId: session.userId }, { projection:{ _id:0, userId:1, displayName:1, createdAt:1 } });
        if (!user) return reply(401, { ok:false, error:'unauthorized', message:'アカウントが見つかりません。' });
        return reply(200, { ok:true, user });
      }
      return reply(404, { ok:false, error:'not_found', message:'APIが見つかりません。' });
    } catch (e) {
      if (!res.headersSent) reply(e.message === 'bad-json' ? 400 : 500, { ok:false, error:'request_failed', message:e.message === 'bad-json' ? '送信内容を確認してください。' : '処理に失敗しました。少し待ってから再試行してください。' });
      console.error('API request failed:', e.message);
    }
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('BRAWL ARENA WebSocket server is running.');
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin;
  if (allowedOrigins.length && origin && !allowedOrigins.includes(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

let mongo = null, db = null;
const queue = [];
const rooms = new Map();
const sockets = new Set();
const safeText = (v, max = 24) => String(v || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max) || 'プレイヤー';
function send(ws, data) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); }
function broadcast(room, data, exceptId = null) {
  for (const p of room.players.values()) if (p.id !== exceptId && p.ws) send(p.ws, data);
}
function publicPlayers(room) {
  return [...room.players.values()].map(p => ({ id: p.id, name: p.name, x: p.x, y: p.y, hp: p.hp, alive: p.alive, isBot: p.isBot }));
}
async function saveMatchStart(room) {
  if (!db) return;
  try { await db.collection('matches').insertOne({ roomId: room.id, status: 'started', createdAt: new Date(), humanCount: [...room.players.values()].filter(p => !p.isBot).length, botCount: [...room.players.values()].filter(p => p.isBot).length, playerIds: [...room.players.keys()] }); }
  catch (e) { console.error('Could not save match start:', e.message); }
}
function makeRoom(humans) {
  const id = crypto.randomUUID();
  const room = { id, createdAt: Date.now(), started: true, players: new Map(), botCount: 0, lastStateAt: 0 };
  for (const ws of humans) {
    const p = ws.queuePlayer;
    if (!p) continue;
    p.roomId = id; p.ws = ws; p.x = Math.random() * 0.8 + 0.1; p.y = Math.random() * 0.8 + 0.1; p.hp = 4800; p.alive = true;
    room.players.set(p.id, p); ws.roomId = id; ws.playerId = p.id; ws.queuePlayer = null;
  }
  room.botCount = Math.max(0, ROOM_SIZE - room.players.size);
  for (let i = 0; i < room.botCount; i++) {
    const bid = `bot-${i + 1}`;
    room.players.set(bid, { id: bid, name: `ボット${i + 1}`, x: Math.random() * 0.8 + 0.1, y: Math.random() * 0.8 + 0.1, hp: 4800, alive: true, isBot: true, ws: null });
  }
  rooms.set(id, room);
  for (const ws of humans) {
    if (!ws.queuePlayer && ws.playerId && ws.roomId === id) {
      send(ws, { type: 'matched', roomId: id, playerId: ws.playerId, roomSize: ROOM_SIZE, humanCount: room.players.size - room.botCount, botCount: room.botCount, players: publicPlayers(room) });
    }
  }
  saveMatchStart(room);
  console.log(`Room ${id}: ${room.players.size - room.botCount} human(s), ${room.botCount} bot placeholder(s)`);
}
function removeFromQueue(ws) { const i = queue.indexOf(ws); if (i >= 0) queue.splice(i, 1); }
function startWaitingMatch() {
  const waiting = queue.filter(ws => ws.readyState === WebSocket.OPEN && ws.queuePlayer);
  if (!waiting.length) return;
  const humans = waiting.slice(0, ROOM_SIZE);
  for (const ws of humans) removeFromQueue(ws);

  // One human only: don't create an online room or server-side bot placeholders.
  // Tell that client to start its existing local BOT survival match instead.
  if (humans.length === 1) {
    const ws = humans[0];
    ws.queuePlayer = null;
    send(ws, { type: 'localBotMatch', reason: 'only-one-human' });
    console.log('Only one human found; switching to local BOT match.');
    return;
  }

  // Two or more humans keep the normal online match flow.
  makeRoom(humans);
}
let queueTimer = null;
function scheduleQueue() { if (!queueTimer) queueTimer = setTimeout(() => { queueTimer = null; startWaitingMatch(); }, MATCH_WAIT_MS); }
function joinQueue(ws, msg) {
  if (ws.roomId) return send(ws, { type: 'error', message: 'すでに試合に参加しています。' });
  if (ws.queuePlayer) return send(ws, { type: 'queued', position: Math.max(1, queue.indexOf(ws) + 1) });
  const player = { id: crypto.randomUUID(), name: safeText(msg.name), characterId: safeText(msg.characterId, 48), roomId: null, ws, x: .5, y: .5, hp: 4800, alive: true, isBot: false };
  ws.queuePlayer = player; queue.push(ws);
  send(ws, { type: 'queued', position: queue.length, waitMs: MATCH_WAIT_MS });
  if (queue.length >= ROOM_SIZE) startWaitingMatch(); else scheduleQueue();
}
function attachToRoom(ws, msg) {
  const room = rooms.get(String(msg.roomId || ''));
  const id = String(msg.playerId || '');
  if (!room || !room.players.has(id)) return send(ws, { type: 'error', message: '試合が見つかりません。マッチメイキングからやり直してください。' });
  const p = room.players.get(id);
  if (p.isBot) return send(ws, { type: 'error', message: 'プレイヤーIDが正しくありません。' });
  if (p.ws && p.ws !== ws) { try { p.ws.close(4001, 'reconnected'); } catch {} }
  p.ws = ws; ws.roomId = room.id; ws.playerId = id; ws.queuePlayer = null;
  send(ws, { type: 'roomState', roomId: room.id, playerId: id, roomSize: ROOM_SIZE, humanCount: room.players.size - room.botCount, botCount: room.botCount, players: publicPlayers(room) });
  broadcast(room, { type: 'playerJoined', player: { id: p.id, name: p.name, x: p.x, y: p.y, hp: p.hp, alive: p.alive, isBot: false } }, id);
}
function handleState(ws, msg) {
  const room = rooms.get(ws.roomId); if (!room) return;
  const p = room.players.get(ws.playerId); if (!p || p.isBot) return;
  const now = Date.now(); if (now - (ws.lastStateAt || 0) < 45) return; ws.lastStateAt = now;
  const x = Number(msg.x), y = Number(msg.y);
  if (Number.isFinite(x) && Number.isFinite(y)) { p.x = Math.max(0, Math.min(1, x)); p.y = Math.max(0, Math.min(1, y)); }
  if (Number.isFinite(Number(msg.hp))) p.hp = Math.max(0, Math.min(100000, Number(msg.hp)));
  p.alive = msg.alive !== false && p.hp > 0;
  broadcast(room, { type: 'state', player: { id: p.id, name: p.name, x: p.x, y: p.y, hp: p.hp, alive: p.alive, isBot: false }, at: now }, p.id);
}
function handleClientMessage(ws, msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
  if (msg.type === 'queue') return joinQueue(ws, msg);
  if (msg.type === 'joinRoom') return attachToRoom(ws, msg);
  if (msg.type === 'state') return handleState(ws, msg);
  if (msg.type === 'event') {
    const room = rooms.get(ws.roomId); if (!room) return;
    const allowed = new Set(['attack', 'super', 'killFeed', 'emote']);
    if (!allowed.has(msg.event)) return;
    const p = room.players.get(ws.playerId); if (!p) return;
    const payload = { type: 'event', event: msg.event, from: p.id, name: p.name, data: msg.data && typeof msg.data === 'object' ? msg.data : {}, at: Date.now() };
    broadcast(room, payload, p.id);
  }
  if (msg.type === 'cancelQueue') { removeFromQueue(ws); ws.queuePlayer = null; send(ws, { type: 'queueCancelled' }); }
  if (msg.type === 'leaveRoom') { const room = rooms.get(ws.roomId); if (room) { const p = room.players.get(ws.playerId); if (p) { p.ws = null; p.alive = false; broadcast(room, { type: 'playerLeft', playerId: p.id, name: p.name }, p.id); } } ws.roomId = null; ws.playerId = null; }
}
wss.on('connection', ws => {
  sockets.add(ws); ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => { try { handleClientMessage(ws, JSON.parse(raw.toString())); } catch (e) { send(ws, { type: 'error', message: 'メッセージを処理できませんでした。' }); } });
  ws.on('close', () => {
    sockets.delete(ws); removeFromQueue(ws);
    if (ws.queuePlayer) ws.queuePlayer = null;
    const room = rooms.get(ws.roomId); if (room) { const p = room.players.get(ws.playerId); if (p && p.ws === ws) p.ws = null; }
  });
  ws.on('error', err => console.error('WebSocket error:', err.message));
});
const heartbeat = setInterval(() => { for (const ws of sockets) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 30000);
server.listen(PORT, async () => {
  console.log(`BRAWL ARENA server listening on ${PORT}`);
  if (!process.env.MONGODB_URI) { console.warn('MONGODB_URI is missing. WebSocket matchmaking runs, but MongoDB persistence is disabled.'); return; }
  try { mongo = new MongoClient(process.env.MONGODB_URI); await mongo.connect(); db = mongo.db(process.env.DB_NAME || 'brawl_arena'); await db.collection('matches').createIndex({ roomId: 1 }, { unique: true }); await db.collection('matches').createIndex({ createdAt: -1 }); await db.collection('users').createIndex({ userId: 1 }, { unique: true }); await db.collection('sessions').createIndex({ tokenHash: 1 }, { unique: true }); await db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }); console.log('MongoDB Atlas connected.'); }
  catch (e) { console.error('MongoDB Atlas connection failed:', e.message); }
});
function shutdown() { clearInterval(heartbeat); for (const ws of sockets) ws.close(1001, 'server shutdown'); server.close(async () => { if (mongo) await mongo.close(); process.exit(0); }); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
