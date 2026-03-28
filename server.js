const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const fetch = require("node-fetch");
const path = require("path");

// ─────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || "*"; // set in production

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: FRONTEND_URL, methods: ["GET", "POST"] },
});

app.use(cors({ origin: FRONTEND_URL }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // serve frontend

// ─────────────────────────────────────────
// IN-MEMORY ROOM STORE
// rooms[code] = { members: Map, ytState, spState }
// ─────────────────────────────────────────
const rooms = new Map();

function getOrCreateRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      members: new Map(), // socketId → { name, color, isHost }
      ytState: null,      // { videoId, timestamp, playing, updatedAt }
      spState: null,      // { trackTitle, trackArtist, progress, duration, playing, updatedAt }
    });
  }
  return rooms.get(code);
}

function cleanEmptyRooms() {
  for (const [code, room] of rooms.entries()) {
    if (room.members.size === 0) rooms.delete(code);
  }
}

function roomMemberList(room) {
  return Array.from(room.members.entries()).map(([id, m]) => ({ id, ...m }));
}

// ─────────────────────────────────────────
// REST: SPOTIFY TOKEN PROXY
// Exchanges sp_dc cookie for a short-lived access token.
// Your sp_dc cookie is sent to THIS server, then forwarded
// to Spotify's internal endpoint. It is never logged or stored.
// ─────────────────────────────────────────
app.post("/api/spotify/token", async (req, res) => {
  const { sp_dc } = req.body;

  if (!sp_dc || typeof sp_dc !== "string" || sp_dc.length < 20) {
    return res.status(400).json({ error: "Invalid sp_dc cookie" });
  }

  // Sanitize: only allow alphanumeric + common cookie chars
  const safe = sp_dc.replace(/[^a-zA-Z0-9_\-]/g, "");
  if (safe !== sp_dc) {
    return res.status(400).json({ error: "Cookie contains invalid characters" });
  }

  try {
    const response = await fetch(
      "https://open.spotify.com/get_access_token?reason=transport&productType=web_player",
      {
        headers: {
          Cookie: `sp_dc=${safe}`,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
          "Accept-Language": "en",
        },
      }
    );

    if (!response.ok) {
      return res.status(401).json({ error: "Invalid or expired sp_dc cookie" });
    }

    const data = await response.json();

    if (!data.accessToken) {
      return res.status(401).json({ error: "Could not get access token — check your sp_dc value" });
    }

    // Return ONLY the access token — never echo back the cookie
    return res.json({
      accessToken: data.accessToken,
      expiresIn: data.accessTokenExpirationTimestampMs,
    });
  } catch (err) {
    console.error("Spotify token error:", err.message);
    return res.status(500).json({ error: "Failed to reach Spotify" });
  }
});

// ─────────────────────────────────────────
// SOCKET.IO — ROOM EVENTS
// ─────────────────────────────────────────
io.on("connection", (socket) => {
  let currentRoom = null;
  let currentCode = null;

  // ── JOIN ROOM ──
  socket.on("join_room", ({ roomCode, name, color, isHost }) => {
    if (!roomCode || !name) return;

    // Validate inputs
    const safeCode = String(roomCode).toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 12);
    const safeName = String(name).replace(/[<>]/g, "").slice(0, 24);
    const safeColor = String(color).replace(/[^#a-fA-F0-9]/g, "").slice(0, 7);

    const room = getOrCreateRoom(safeCode);
    const alreadyHasHost = Array.from(room.members.values()).some((m) => m.isHost);
    const assignedHost = isHost && !alreadyHasHost;

    room.members.set(socket.id, {
      name: safeName,
      color: safeColor || "#7b6fff",
      isHost: assignedHost,
    });

    socket.join(safeCode);
    currentRoom = room;
    currentCode = safeCode;

    // Tell the joiner the current room state
    socket.emit("room_state", {
      members: roomMemberList(room),
      ytState: room.ytState,
      spState: room.spState,
      yourId: socket.id,
    });

    // Tell everyone else someone joined
    socket.to(safeCode).emit("member_joined", {
      id: socket.id,
      name: safeName,
      color: safeColor,
      isHost: assignedHost,
    });

    console.log(`[${safeCode}] ${safeName} joined (host: ${assignedHost})`);
  });

  // ── CHAT ──
  socket.on("chat", ({ text }) => {
    if (!currentCode || !currentRoom) return;
    const member = currentRoom.members.get(socket.id);
    if (!member) return;
    const safeText = String(text).replace(/[<>]/g, "").slice(0, 200);
    io.to(currentCode).emit("chat", {
      senderId: socket.id,
      name: member.name,
      color: member.color,
      text: safeText,
    });
  });

  // ── YOUTUBE: LOAD VIDEO ──
  socket.on("yt_load", ({ videoId, timestamp, title }) => {
    if (!currentCode || !currentRoom) return;
    const member = currentRoom.members.get(socket.id);
    if (!member) return;
    const safeId = String(videoId).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 11);
    currentRoom.ytState = { videoId: safeId, timestamp: timestamp || 0, playing: true, updatedAt: Date.now() };
    io.to(currentCode).emit("yt_load", {
      senderId: socket.id, name: member.name,
      videoId: safeId, timestamp: timestamp || 0, playing: true, title,
    });
  });

  // ── YOUTUBE: PLAY ──
  socket.on("yt_play", ({ timestamp }) => {
    if (!currentCode || !currentRoom) return;
    const member = currentRoom.members.get(socket.id);
    if (!member) return;
    if (currentRoom.ytState) {
      currentRoom.ytState.playing = true;
      currentRoom.ytState.timestamp = timestamp;
      currentRoom.ytState.updatedAt = Date.now();
    }
    socket.to(currentCode).emit("yt_play", { senderId: socket.id, name: member.name, timestamp });
  });

  // ── YOUTUBE: PAUSE ──
  socket.on("yt_pause", ({ timestamp }) => {
    if (!currentCode || !currentRoom) return;
    const member = currentRoom.members.get(socket.id);
    if (!member) return;
    if (currentRoom.ytState) {
      currentRoom.ytState.playing = false;
      currentRoom.ytState.timestamp = timestamp;
      currentRoom.ytState.updatedAt = Date.now();
    }
    socket.to(currentCode).emit("yt_pause", { senderId: socket.id, name: member.name, timestamp });
  });

  // ── YOUTUBE: SEEK ──
  socket.on("yt_seek", ({ timestamp }) => {
    if (!currentCode || !currentRoom) return;
    const member = currentRoom.members.get(socket.id);
    if (!member) return;
    if (currentRoom.ytState) currentRoom.ytState.timestamp = timestamp;
    socket.to(currentCode).emit("yt_seek", { senderId: socket.id, name: member.name, timestamp });
  });

  // ── SPOTIFY: SYNC (host → all) ──
  socket.on("sp_sync", (data) => {
    if (!currentCode || !currentRoom) return;
    const member = currentRoom.members.get(socket.id);
    if (!member) return;
    currentRoom.spState = {
      trackTitle: String(data.trackTitle || "").slice(0, 100),
      trackArtist: String(data.trackArtist || "").slice(0, 100),
      trackUri: String(data.trackUri || "").slice(0, 200),
      progress: Number(data.progress) || 0,
      duration: Number(data.duration) || 0,
      playing: Boolean(data.playing),
      updatedAt: Date.now(),
    };
    socket.to(currentCode).emit("sp_sync", {
      senderId: socket.id, name: member.name,
      ...currentRoom.spState,
    });
  });

  // ── SPOTIFY: CONTROL (play/pause/next/prev) ──
  socket.on("sp_control", ({ action }) => {
    if (!currentCode || !currentRoom) return;
    const member = currentRoom.members.get(socket.id);
    if (!member) return;
    io.to(currentCode).emit("sp_control", {
      senderId: socket.id, name: member.name, action,
    });
  });

  // ── DISCONNECT ──
  socket.on("disconnect", () => {
    if (!currentCode || !currentRoom) return;
    const member = currentRoom.members.get(socket.id);
    currentRoom.members.delete(socket.id);

    if (member) {
      // If host left, reassign host to next member
      if (member.isHost && currentRoom.members.size > 0) {
        const [newHostId, newHost] = currentRoom.members.entries().next().value;
        newHost.isHost = true;
        io.to(currentCode).emit("host_changed", { id: newHostId, name: newHost.name });
      }

      io.to(currentCode).emit("member_left", { id: socket.id, name: member.name });
      console.log(`[${currentCode}] ${member.name} disconnected`);
    }

    cleanEmptyRooms();
  });
});

// ─────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`\n🚀 SyncSpace running at http://localhost:${PORT}`);
  console.log(`   Rooms: in-memory | Socket.io: enabled\n`);
});
