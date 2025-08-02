import { Server } from "socket.io"
import { createServer } from "http"
import express from "express"
import multer from "multer"
import path from "path"
import fs from "fs"
import cors from "cors"

const websockets = []

// Ma'lumotlar bazasi o'rniga JSON file ishlatamiz (oddiy yechim)
const DATA_FILE = path.join(process.cwd(), "users_data.json")

// Ma'lumotlarni yuklash
function loadUsersData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = fs.readFileSync(DATA_FILE, "utf8")
      return JSON.parse(data)
    }
  } catch (error) {
    console.error("Error loading users data:", error)
  }
  return {
    type: "FeatureCollection",
    features: [],
  }
}

// Ma'lumotlarni saqlash
function saveUsersData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2))
    console.log("Users data saved successfully")
  } catch (error) {
    console.error("Error saving users data:", error)
  }
}

// Ma'lumotlarni yuklash
const usersGeoJSONCollection = loadUsersData()

const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
})

// Enable CORS for all routes
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  }),
)

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(process.cwd(), "uploads")
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true })
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/")
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9)
    cb(null, file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname))
  },
})

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true)
    } else {
      cb(new Error("Only image files are allowed!"), false)
    }
  },
})

// Middleware
app.use(express.json())
app.use("/uploads", express.static("uploads"))

// File upload endpoint
app.post("/upload", upload.single("profileImage"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" })
    }

    const fileUrl = `http://localhost:3000/uploads/${req.file.filename}`
    console.log("File uploaded successfully:", fileUrl)

    res.json({
      success: true,
      fileUrl: fileUrl,
      filename: req.file.filename,
    })
  } catch (error) {
    console.error("Upload error:", error)
    res.status(500).json({ error: "Upload failed" })
  }
})

// Error handling middleware
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "File too large. Maximum size is 5MB." })
    }
  }
  console.error("Error:", error)
  res.status(500).json({ error: "Something went wrong!" })
})

// Har 30 soniyada ma'lumotlarni saqlash
setInterval(() => {
  saveUsersData(usersGeoJSONCollection)
}, 30000) // 30 seconds

// Server yopilganda ma'lumotlarni saqlash
process.on("SIGINT", () => {
  console.log("Saving data before shutdown...")
  saveUsersData(usersGeoJSONCollection)
  process.exit(0)
})

process.on("SIGTERM", () => {
  console.log("Saving data before shutdown...")
  saveUsersData(usersGeoJSONCollection)
  process.exit(0)
})

httpServer.listen(3_000, () => {
  console.log("Server listening on port 3000")
  console.log(`Loaded ${usersGeoJSONCollection.features.length} users from storage`)
})

io.on("connection", (websocket) => {
  websockets.push(websocket)
  console.log("New user connected:", websocket.id)

  // Send existing users to new connection
  if (usersGeoJSONCollection.features.length > 0) {
    websocket.emit("new_user", usersGeoJSONCollection)
  }

  websocket.on("new_user", (user) => {
    // Avval mavjud user bor-yo'qligini tekshiramiz
    const existingUserIndex = usersGeoJSONCollection.features.findIndex(
      (feature) => feature.properties.username === user.username,
    )

    const userGeoJSON = {
      type: "Feature",
      properties: {
        username: user.username,
        avatar: user.avatar,
        socketId: websocket.id,
        bio: user.bio || "",
        age: user.age || "",
        interests: user.interests || "",
        socialLinks: user.socialLinks || "",
        joinedAt: user.joinedAt || Date.now(),
        lastSeen: Date.now(), // Oxirgi ko'rilgan vaqt
      },
      geometry: {
        type: "Point",
        coordinates: user.coordinates,
      },
    }

    if (existingUserIndex !== -1) {
      // Mavjud userni yangilaymiz
      usersGeoJSONCollection.features[existingUserIndex] = userGeoJSON
      console.log(`Updated existing user: ${user.username}`)
    } else {
      // Yangi user qo'shamiz
      usersGeoJSONCollection.features.push(userGeoJSON)
      console.log(`Added new user: ${user.username}`)
    }

    // Ma'lumotlarni darhol saqlaymiz
    saveUsersData(usersGeoJSONCollection)

    // Broadcast to all clients including sender
    io.emit("new_user", userGeoJSON)
  })

  websocket.on("user_updated", (updatedUserData) => {
    // Find and update the user in the collection
    const userIndex = usersGeoJSONCollection.features.findIndex(
      (feature) => feature.properties.socketId === websocket.id,
    )

    if (userIndex !== -1) {
      const oldUsername = usersGeoJSONCollection.features[userIndex].properties.username
      usersGeoJSONCollection.features[userIndex].properties = {
        ...usersGeoJSONCollection.features[userIndex].properties,
        ...updatedUserData,
        lastSeen: Date.now(), // Oxirgi faollik vaqtini yangilaymiz
      }

      // If username changed, update it
      if (updatedUserData.username && updatedUserData.username !== oldUsername) {
        usersGeoJSONCollection.features[userIndex].properties.username = updatedUserData.username
      }

      // Ma'lumotlarni saqlaymiz
      saveUsersData(usersGeoJSONCollection)

      // Broadcast the updated user to all clients
      io.emit("user_updated", usersGeoJSONCollection.features[userIndex])
    }
  })

  websocket.on("send_message", (messageData) => {
    // Find the recipient's socket
    const recipientUser = usersGeoJSONCollection.features.find(
      (feature) => feature.properties.username === messageData.to,
    )

    if (recipientUser) {
      const recipientSocket = websockets.find((ws) => ws.id === recipientUser.properties.socketId)

      if (recipientSocket) {
        // Send message to recipient
        recipientSocket.emit("new_message", messageData)
        console.log(`Message sent from ${messageData.from} to ${messageData.to}: ${messageData.message}`)
      }
    }
  })

  websocket.on("delete_chat", (deleteData) => {
    // Find both users involved in the chat
    const user1 = usersGeoJSONCollection.features.find((feature) => feature.properties.username === deleteData.from)
    const user2 = usersGeoJSONCollection.features.find((feature) => feature.properties.username === deleteData.with)

    // Send delete notification to both users
    if (user1) {
      const user1Socket = websockets.find((ws) => ws.id === user1.properties.socketId)
      if (user1Socket) {
        user1Socket.emit("chat_deleted", { with: deleteData.with })
      }
    }

    if (user2) {
      const user2Socket = websockets.find((ws) => ws.id === user2.properties.socketId)
      if (user2Socket) {
        user2Socket.emit("chat_deleted", { with: deleteData.from })
      }
    }

    console.log(`Chat deleted between ${deleteData.from} and ${deleteData.with}`)
  })

  websocket.on("delete_chat_for_me", (deleteData) => {
    // This only deletes for the requesting user, no notification sent to other user
    console.log(`Chat deleted for ${deleteData.from} only (with ${deleteData.with})`)
    // No server-side action needed as it's only local deletion
  })

  websocket.on("disconnect", () => {
    // Find user before removing
    const disconnectedUser = usersGeoJSONCollection.features.find(
      (feature) => feature.properties.socketId === websocket.id,
    )

    if (disconnectedUser) {
      // Userni o'chirish o'rniga, faqat socketId ni tozalaymiz va lastSeen ni yangilaymiz
      disconnectedUser.properties.socketId = null
      disconnectedUser.properties.lastSeen = Date.now()

      // Ma'lumotlarni saqlaymiz
      saveUsersData(usersGeoJSONCollection)

      console.log(`User ${disconnectedUser.properties.username} disconnected, but data preserved`)

      // Boshqa userlarga disconnect xabarini yuboramiz
      io.emit("user_disconnected", disconnectedUser.properties.username)
    }

    // Remove websocket from array
    const index = websockets.indexOf(websocket)
    if (index > -1) {
      websockets.splice(index, 1)
    }

    console.log("User disconnected:", websocket.id)
  })
})

// Eski userlarni tozalash (ixtiyoriy - 30 kundan eski)
setInterval(
  () => {
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
    const initialCount = usersGeoJSONCollection.features.length

    usersGeoJSONCollection.features = usersGeoJSONCollection.features.filter(
      (feature) => feature.properties.lastSeen > thirtyDaysAgo,
    )

    const removedCount = initialCount - usersGeoJSONCollection.features.length
    if (removedCount > 0) {
      console.log(`Cleaned up ${removedCount} old users`)
      saveUsersData(usersGeoJSONCollection)
    }
  },
  24 * 60 * 60 * 1000,
) // Har kunda tekshirish
