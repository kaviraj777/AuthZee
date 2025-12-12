import { useEffect, useRef, useState } from "react"

const API_BASE = import.meta.env.VITE_API_BASE || "http://10.159.103.185:4001"
const WS_BASE =
  import.meta.env.VITE_WS_BASE || "ws://10.159.103.185:4001/mfa/ws"

export default function MobileFaceVerify() {
  const videoRef = useRef(null)
  const [status, setStatus] = useState("waiting") // waiting | streaming | approving | done | error
  const [challengeId, setChallengeId] = useState(null)
  const [message, setMessage] = useState("Waiting for login request…")

  // Stable deviceId for this phone
  const [deviceId] = useState(() => {
    const existing = localStorage.getItem("authzee_device_id")
    if (existing) return existing
    const id = "dev-" + Math.random().toString(36).slice(2)
    localStorage.setItem("authzee_device_id", id)
    return id
  })

  // Connect WebSocket and wait for MFA_FACE_REQUEST
  useEffect(() => {
    const ws = new WebSocket(`${WS_BASE}?deviceId=${encodeURIComponent(deviceId)}`)

    ws.onopen = () => {
      setMessage("Connected. Waiting for MFA request…")
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === "MFA_FACE_REQUEST") {
          setChallengeId(data.challengeId)
          setMessage("New login request. Starting camera…")
          startCamera()
        }
      } catch {
        // ignore malformed messages
      }
    }

    ws.onerror = () => {
      setStatus("error")
      setMessage("WebSocket error. Check network / tunnel.")
    }

    ws.onclose = () => {
      if (status === "waiting") {
        setMessage("Connection closed. Reload this page.")
      }
    }

    return () => ws.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId])

  async function startCamera() {
    try {
      setStatus("streaming")
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      })
      if (videoRef.current) {
        videoRef.current.srcObject = stream
      }
      setMessage("Align your face in the frame, then tap Verify.")
    } catch (err) {
      setStatus("error")
      setMessage("Camera access denied: " + err.message)
    }
  }

  async function approve() {
    if (!challengeId) return
    setStatus("approving")
    try {
      const res = await fetch(`${API_BASE}/api/face/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId }),
      })
      const data = await res.json()
      if (data.ok) {
        setStatus("done")
        setMessage("Face verified. You can return to your PC.")
      } else {
        setStatus("error")
        setMessage(data.error || "Approval failed.")
      }
    } catch (err) {
      setStatus("error")
      setMessage(err.message)
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#020617",
        color: "white",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "1.5rem 1rem",
        fontFamily:
          'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>
        AuthZee Face Verification
      </h1>
      <p style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
        Device ID: <strong>{deviceId}</strong>
      </p>

      <div
        style={{
          position: "relative",
          width: "100%",
          maxWidth: 360,
          aspectRatio: "3 / 4",
          borderRadius: 24,
          overflow: "hidden",
          border: "1px solid rgba(148,163,184,0.7)",
          background: "#020617",
          marginBottom: 12,
        }}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            background: "#111827",
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: "15%",
            borderRadius: "999px",
            border: "2px solid rgba(56,189,248,0.9)",
            boxShadow: "0 0 20px rgba(56,189,248,0.6)",
          }}
        />
      </div>

      <p
        style={{
          fontSize: 13,
          textAlign: "center",
          marginBottom: 12,
          minHeight: 32,
        }}
      >
        {message}
      </p>

      <button
        disabled={status !== "streaming" || !challengeId}
        onClick={approve}
        style={{
          width: "100%",
          maxWidth: 360,
          padding: "12px 16px",
          borderRadius: 999,
          border: "none",
          cursor:
            status === "streaming" && challengeId ? "pointer" : "not-allowed",
          fontWeight: 600,
          fontSize: 15,
          backgroundColor:
            status === "streaming" && challengeId ? "#22c55e" : "#4b5563",
          color: "white",
          marginBottom: 8,
        }}
      >
        {status === "approving"
          ? "Verifying…"
          : status === "done"
          ? "Verified"
          : "Verify Face"}
      </button>
    </div>
  )
}
