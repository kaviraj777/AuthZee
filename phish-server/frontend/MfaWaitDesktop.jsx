import { useEffect, useState } from "react"

const API_BASE = import.meta.env.VITE_API_BASE || "http://10.159.103.185:4001"

export default function MfaWaitDesktop({ userId, deviceId, onApproved, onError }) {
  const [challengeId, setChallengeId] = useState(null)
  const [status, setStatus] = useState("starting") // starting | pending | approved | failed

  useEffect(() => {
    let pollInterval

    async function startChallenge() {
      try {
        const res = await fetch(`${API_BASE}/api/mfa/start-face`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, deviceId }),
        })
        const data = await res.json()
        if (!data.ok) {
          setStatus("failed")
          onError?.(data.error || "Failed to start MFA")
          return
        }
        setChallengeId(data.challengeId)
        setStatus("pending")

        pollInterval = setInterval(checkStatus, 2000)
      } catch (err) {
        setStatus("failed")
        onError?.(err.message)
      }
    }

    async function checkStatus() {
      try {
        if (!challengeId) return
        const res = await fetch(
          `${API_BASE}/api/mfa/status?challengeId=${encodeURIComponent(
            challengeId
          )}`
        )
        const data = await res.json()
        if (!data.ok) return
        if (data.status === "approved") {
          clearInterval(pollInterval)
          setStatus("approved")
          onApproved?.()
        }
      } catch {
        // ignore transient errors
      }
    }

    startChallenge()

    return () => {
      if (pollInterval) clearInterval(pollInterval)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, deviceId, onApproved, onError, challengeId])

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        background: "#020617",
        color: "white",
        fontFamily:
          'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      <div
        style={{
          margin: "auto",
          maxWidth: 480,
          width: "100%",
          padding: 24,
          borderRadius: 24,
          border: "1px solid rgba(148,163,184,0.7)",
          background: "rgba(15,23,42,0.96)",
          boxShadow: "0 24px 48px rgba(15,23,42,0.8)",
          textAlign: "center",
        }}
      >
        <h2 style={{ fontSize: 24, fontWeight: 800, marginBottom: 8 }}>
          Face verification required
        </h2>
        <p style={{ fontSize: 13, opacity: 0.9, marginBottom: 16 }}>
          A login request was sent to your registered device. Open the AuthZee
          mobile face page and complete verification to continue.
        </p>
        <div style={{ fontSize: 14, marginBottom: 8 }}>
          Status:{" "}
          {status === "starting"
            ? "Preparing challenge…"
            : status === "pending"
            ? "Waiting for approval on mobile…"
            : status === "approved"
            ? "Approved!"
            : "Failed to start MFA"}
        </div>
        <p style={{ fontSize: 12, opacity: 0.8 }}>
          Tip: On your phone, open{" "}
          <code>http://10.159.103.185:5173/mobile-face</code> on the same
          network.
        </p>
      </div>
    </div>
  )
}
