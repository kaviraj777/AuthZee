// C:\Users\HARIS\OneDrive\Desktop\phish-server\demoUsers.js
const bcrypt = require("bcryptjs")

// simple in-memory user store for lab
// username: user, password: pass
const demoUsers = []

async function initDemoUser() {
  const hash = await bcrypt.hash("pass", 10)
  demoUsers.push({
    id: 1,
    username: "user",
    passwordHash: hash,
  })
  console.log("Demo lab user loaded: user / pass")
}

function findUser(username) {
  return demoUsers.find((u) => u.username === username)
}

module.exports = { initDemoUser, findUser }
