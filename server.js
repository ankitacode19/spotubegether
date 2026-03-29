const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");

const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || "*";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: FRONTEND_URL, methods: ["GET", "POST"] },
  // FIX: allow polling fallback so Brave & mobile browsers that block WS upgrades still work
  transports: ["websocket", "polling"],
});

app.use(cors({ origin: FRONTEND_URL }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── ROOM STORE ───
// rooms[code] = { members: Map<socketId, {name,color,isHost}>, ytState, spState }
const rooms = new Map();

function getOrCreate(code) {
  if (!rooms.has(code)) {
    rooms.set(code, { members: new Map(), ytState: null, spState: null });
  }
  return rooms.get(code);
}

function memberList(room) {
  return Array.from(room.members.entries()).map(([id, m]) => ({ id, ...m }));
}

function cleanEmpty() {
  for (const [code, room] of rooms.entries()) {
    if (room.members.size === 0) rooms.delete(code);
  }
}

// ─── SOCKET EVENTS ───
io.on("connection", (socket) => {
  let room = null;
  let code = null;

  // JOIN
  socket.on("join_room", ({ roomCode, name, color, isHost }) => {
    if (!roomCode || !name) return;
    const safeCode  = String(roomCode).toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 12);
    const safeName  = String(name).replace(/[<>&"]/g, "").slice(0, 24);
    const safeColor = String(color || "").replace(/[^#a-fA-F0-9]/g, "").slice(0, 7) || "#7b6fff";

    room = getOrCreate(safeCode);
    code = safeCode;

    const alreadyHasHost = [...room.members.values()].some(m => m.isHost);
    const asHost = Boolean(isHost) && !alreadyHasHost;

    room.members.set(socket.id, { name: safeName, color: safeColor, isHost: asHost });
    socket.join(safeCode);

    // Send joiner the full current state
    socket.emit("room_state", {
      yourId: socket.id,
      members: memberList(room),
      ytState: room.ytState,
      spState: room.spState,
    });

    // Tell the rest
    socket.to(safeCode).emit("member_joined", {
      id: socket.id, name: safeName, color: safeColor, isHost: asHost,
    });

    console.log(`[${safeCode}] ${safeName} joined (host:${asHost})`);
  });

  // REQUEST STATE (for re-sync button)
  socket.on("request_state", () => {
    if (!room) return;
    socket.emit("room_state", {
      yourId: socket.id,
      members: memberList(room),
      ytState: room.ytState,
      spState: room.spState,
    });
  });

  // CHAT — broadcast to whole room including sender so everyone sees it
  socket.on("chat", ({ text }) => {
    if (!code || !room) return;
    const m = room.members.get(socket.id); if (!m) return;
    const safeText = String(text).replace(/[<>&"]/g, "").slice(0, 200);
    io.to(code).emit("chat", { senderId: socket.id, name: m.name, color: m.color, text: safeText });
  });

  // ── YOUTUBE ──
  socket.on("yt_load", ({ videoId, timestamp }) => {
    if (!code || !room) return;
    const m = room.members.get(socket.id); if (!m) return;
    const safeId = String(videoId).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 11);
    room.ytState = { videoId: safeId, timestamp: Number(timestamp)||0, playing: true, updatedAt: Date.now() };
    // Broadcast to everyone INCLUDING sender (sender filters by senderId client-side)
    io.to(code).emit("yt_load", { senderId: socket.id, name: m.name, videoId: safeId, timestamp: Number(timestamp)||0 });
  });

  socket.on("yt_play", ({ timestamp }) => {
    if (!code || !room) return;
    const m = room.members.get(socket.id); if (!m) return;
    if (room.ytState) { room.ytState.playing = true; room.ytState.timestamp = Number(timestamp)||0; room.ytState.updatedAt = Date.now(); }
    // FIX: use io.to (not socket.to) so SENDER also receives the echo → appears in their chat
    io.to(code).emit("yt_play", { senderId: socket.id, name: m.name, timestamp: Number(timestamp)||0 });
  });

  socket.on("yt_pause", ({ timestamp }) => {
    if (!code || !room) return;
    const m = room.members.get(socket.id); if (!m) return;
    if (room.ytState) { room.ytState.playing = false; room.ytState.timestamp = Number(timestamp)||0; room.ytState.updatedAt = Date.now(); }
    // FIX: echo to sender too
    io.to(code).emit("yt_pause", { senderId: socket.id, name: m.name, timestamp: Number(timestamp)||0 });
  });

  socket.on("yt_seek", ({ timestamp }) => {
    if (!code || !room) return;
    const m = room.members.get(socket.id); if (!m) return;
    if (room.ytState) room.ytState.timestamp = Number(timestamp)||0;
    socket.to(code).emit("yt_seek", { senderId: socket.id, timestamp: Number(timestamp)||0 });
  });

  // ── SPOTIFY ──
  socket.on("sp_load", ({ trackId, position }) => {
    if (!code || !room) return;
    const m = room.members.get(socket.id); if (!m) return;
    const safeTrack = String(trackId||"").replace(/[^a-zA-Z0-9]/g, "").slice(0, 30);
    if (!safeTrack) return;
    room.spState = { trackId: safeTrack, position: Number(position)||0, playing: true, updatedAt: Date.now() };
    // Send to everyone except sender (sender already loaded it locally)
    socket.to(code).emit("sp_load", { senderId: socket.id, name: m.name, trackId: safeTrack, position: Number(position)||0 });
  });

  // FIX: sp_play echoes to EVERYONE (including sender) so host sees their action in chat
  socket.on("sp_play", ({ position }) => {
    if (!code || !room) return;
    const m = room.members.get(socket.id); if (!m) return;
    const pos = Number(position)||0;
    if (room.spState) { room.spState.playing = true; room.spState.position = pos; room.spState.updatedAt = Date.now(); }
    io.to(code).emit("sp_play", { senderId: socket.id, name: m.name, position: pos });
  });

  // FIX: sp_pause echoes to EVERYONE
  socket.on("sp_pause", ({ position }) => {
    if (!code || !room) return;
    const m = room.members.get(socket.id); if (!m) return;
    const pos = Number(position)||0;
    if (room.spState) { room.spState.playing = false; room.spState.position = pos; room.spState.updatedAt = Date.now(); }
    io.to(code).emit("sp_pause", { senderId: socket.id, name: m.name, position: pos });
  });

  socket.on("sp_seek", ({ position }) => {
    if (!code || !room) return;
    const m = room.members.get(socket.id); if (!m) return;
    const pos = Number(position)||0;
    if (room.spState) { room.spState.position = pos; room.spState.updatedAt = Date.now(); }
    socket.to(code).emit("sp_seek", { senderId: socket.id, position: pos });
  });

  // FIX: heartbeat — host broadcasts every 4s; server relays to all OTHER members
  socket.on("sp_heartbeat", ({ trackId, position, playing }) => {
    if (!code || !room) return;
    const m = room.members.get(socket.id); if (!m || !m.isHost) return; // only trust host
    const safeTrack = String(trackId||"").replace(/[^a-zA-Z0-9]/g, "").slice(0, 30);
    const pos = Number(position)||0;
    // Update server state so late-joiners get correct position
    if (room.spState) { room.spState.position = pos; room.spState.playing = Boolean(playing); room.spState.updatedAt = Date.now(); }
    // Relay to non-hosts only
    socket.to(code).emit("sp_heartbeat", {
      senderId: socket.id, trackId: safeTrack, position: pos, playing: Boolean(playing),
    });
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    if (!code || !room) return;
    const m = room.members.get(socket.id);
    room.members.delete(socket.id);
    if (m) {
      if (m.isHost && room.members.size > 0) {
        const [newId, newM] = room.members.entries().next().value;
        newM.isHost = true;
        io.to(code).emit("host_changed", { id: newId, name: newM.name });
      }
      io.to(code).emit("member_left", { id: socket.id, name: m.name });
      console.log(`[${code}] ${m.name} left`);
    }
    cleanEmpty();
  });
});

httpServer.listen(PORT, () => {
  console.log(`\n🚀 SyncSpace → http://localhost:${PORT}\n`);
});
