import { Server } from "socket.io"
import { createServer } from "http"
import express from "express"
import multer from "multer"
import path from "path"
import fs from "fs"
import cors from "cors"

const websockets = []
const usersGeoJSONCollection = {
  type: "FeatureCollection",
  features: [],
}

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

httpServer.listen(3_000, () => {
  console.log("Server listening on port 3000")
})

io.on("connection", (websocket) => {
  websockets.push(websocket)
  console.log("New user connected:", websocket.id)

  // Send existing users to new connection
  if (usersGeoJSONCollection.features.length > 0) {
    websocket.emit("new_user", usersGeoJSONCollection)
  }

  websocket.on("new_user", (user) => {
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
      },
      geometry: {
        type: "Point",
        coordinates: user.coordinates,
      },
    }

    usersGeoJSONCollection.features.push(userGeoJSON)

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
      }
      // If username changed, update it
      if (updatedUserData.username && updatedUserData.username !== oldUsername) {
        usersGeoJSONCollection.features[userIndex].properties.username = updatedUserData.username
      }

      // Broadcast the updated user to all clients
      io.emit("user_updated", usersGeoJSONCollection.features[userIndex])
    }
  })

  websocket.on("disconnect", () => {
    // Find user before removing
    const disconnectedUser = usersGeoJSONCollection.features.find(
      (feature) => feature.properties.socketId === websocket.id,
    )

    // Remove user from collection
    usersGeoJSONCollection.features = usersGeoJSONCollection.features.filter(
      (feature) => feature.properties.socketId !== websocket.id,
    )

    // Remove websocket from array
    const index = websockets.indexOf(websocket)
    if (index > -1) {
      websockets.splice(index, 1)
    }

    if (disconnectedUser) {
      io.emit("user_disconnected", disconnectedUser.properties.username)
    }

    console.log("User disconnected:", websocket.id)
  })
})
