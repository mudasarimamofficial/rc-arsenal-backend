import express from "express"
import cors from "cors"
import fetch from "node-fetch"
import FormData from "form-data"
import multer from "multer"

const app = express()
const PORT = process.env.PORT || 10000

// --- MIDDLEWARE ---
app.use(cors()) // Enable CORS for all routes
app.use(express.json({ limit: "10mb" })) // To parse JSON bodies
app.use(express.urlencoded({ extended: true, limit: "10mb" }))

// Multer setup for handling file uploads in memory
const storage = multer.memoryStorage()
const upload = multer({ storage: storage })

// --- ENVIRONMENT VARIABLES ---
// These should be set in your Render.com environment
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL // e.g., 'your-store.myshopify.com'
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN // Admin API access token
const IMGBB_API_KEY = process.env.IMGBB_API_KEY
const ADMIN_SECRET = process.env.ADMIN_SECRET // A secret key for admin actions

// --- HELPER FUNCTIONS ---
const getShopifyGraphQLURL = () => `https://${SHOPIFY_STORE_URL}/admin/api/2024-04/graphql.json`

// Helper to make Shopify GraphQL requests
const shopifyFetch = async (query, variables) => {
  try {
    const response = await fetch(getShopifyGraphQLURL(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    })

    const data = await response.json()
    if (data.errors) {
      console.error("Shopify API Errors:", JSON.stringify(data.errors, null, 2))
      throw new Error("Shopify API request failed.")
    }
    return data
  } catch (error) {
    console.error("Error in shopifyFetch:", error)
    throw error
  }
}

// --- API ROUTES ---

// GET /health - For Render health checks
app.get("/health", (req, res) => {
  res.status(200).send("OK")
})

/**
 * GET /apps/killboard
 * Fetches all customers and their RC Arsenal metafields for the public leaderboard.
 */
app.get("/apps/killboard", async (req, res) => {
  const query = `
    query getCustomers {
      customers(first: 100, sortKey: UPDATED_AT, reverse: true) {
        edges {
          node {
            id
            firstName
            lastName
            metafield(namespace: "rc_arsenal", key: "username") { value }
            level: metafield(namespace: "rc_arsenal", key: "level") { value }
            xp: metafield(namespace: "rc_arsenal", key: "xp") { value }
            victories: metafield(namespace: "rc_arsenal", key: "victories") { value }
            tier: metafield(namespace: "rc_arsenal", key: "tier") { value }
            country: metafield(namespace: "rc_arsenal", key: "country") { value }
            avatar: metafield(namespace: "rc_arsenal", key: "avatar_url") { value }
          }
        }
      }
    }
  `
  try {
    const response = await shopifyFetch(query)
    const players = response.data.customers.edges.map(({ node }) => ({
      id: node.id,
      name: node.metafield?.value || `${node.firstName || ""} ${node.lastName || ""}`.trim() || "Unnamed Pilot",
      level: Number.parseInt(node.level?.value || "1", 10),
      xp: Number.parseInt(node.xp?.value || "0", 10),
      victories: Number.parseInt(node.victories?.value || "0", 10),
      tier: node.tier?.value || "Recruit",
      country: node.country?.value || "Unknown",
      avatar: node.avatar?.value || "",
    }))

    // Sort by XP descending
    players.sort((a, b) => b.xp - a.xp)

    res.json(players)
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch killboard data." })
  }
})

/**
 * GET /apps/garage-data
 * Fetches a single customer's complete data for their garage page.
 * Requires customerId as a query parameter.
 */
app.get("/apps/garage-data", async (req, res) => {
  const { customerId } = req.query
  if (!customerId) {
    return res.status(400).json({ error: "Customer ID is required." })
  }

  const query = `
        query getCustomer($id: ID!) {
            customer(id: $id) {
                id
                firstName
                lastName
                metafields(namespace: "rc_arsenal", first: 10) {
                    edges {
                        node {
                            key
                            value
                        }
                    }
                }
            }
        }
    `

  try {
    const response = await shopifyFetch(query, { id: `gid://shopify/Customer/${customerId}` })
    const customerNode = response.data.customer

    if (!customerNode) {
      return res.status(404).json({ error: "Customer not found." })
    }

    const garageData = { id: customerNode.id }
    customerNode.metafields.edges.forEach(({ node }) => {
      garageData[node.key] = node.value
    })

    // Add defaults if not present
    garageData.username = garageData.username || `${customerNode.firstName || ""} ${customerNode.lastName || ""}`.trim()
    garageData.level = Number.parseInt(garageData.level || "1", 10)
    garageData.xp = Number.parseInt(garageData.xp || "0", 10)
    garageData.victories = Number.parseInt(garageData.victories || "0", 10)
    garageData.tier = garageData.tier || "Recruit"
    garageData.country = garageData.country || "Unknown"
    garageData.faction = garageData.faction || "Independent"
    garageData.avatar_url = garageData.avatar_url || ""
    garageData.car_image_url = garageData.car_image_url || ""
    garageData.achievements = JSON.parse(garageData.achievements || "[]")

    res.json(garageData)
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch garage data." })
  }
})

/**
 * POST /apps/upload-image
 * Uploads an image to ImgBB and returns the URL.
 */
app.post("/apps/upload-image", upload.single("image"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No image file provided." })
  }
  if (!IMGBB_API_KEY) {
    return res.status(500).json({ error: "Image hosting is not configured." })
  }

  try {
    const form = new FormData()
    form.append("image", req.file.buffer.toString("base64"))

    const response = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, {
      method: "POST",
      body: form,
    })

    const result = await response.json()

    if (result.success) {
      res.json({ url: result.data.url })
    } else {
      console.error("ImgBB Error:", result)
      res.status(500).json({ error: "Failed to upload image." })
    }
  } catch (error) {
    console.error("Image Upload Exception:", error)
    res.status(500).json({ error: "An exception occurred during image upload." })
  }
})

/**
 * POST /apps/update-customer
 * Updates a customer's metafields.
 */
app.post("/apps/update-customer", async (req, res) => {
  const { customerId, metafields } = req.body

  if (!customerId || !metafields || !Array.isArray(metafields)) {
    return res.status(400).json({ error: "Invalid request body." })
  }

  const query = `
        mutation customerUpdate($input: CustomerInput!) {
            customerUpdate(input: $input) {
                customer {
                    id
                }
                userErrors {
                    field
                    message
                }
            }
        }
    `

  const input = {
    id: `gid://shopify/Customer/${customerId}`,
    metafields: metafields.map((mf) => ({
      namespace: "rc_arsenal",
      key: mf.key,
      value: mf.value.toString(),
      type: mf.type || "single_line_text_field", // Default type
    })),
  }

  try {
    const response = await shopifyFetch(query, { input })
    if (response.data.customerUpdate.userErrors.length > 0) {
      return res.status(400).json({ errors: response.data.customerUpdate.userErrors })
    }
    res.status(200).json({ success: true, customerId: response.data.customerUpdate.customer.id })
  } catch (error) {
    res.status(500).json({ error: "Failed to update customer data." })
  }
})

// --- ADMIN ROUTES ---
const adminAuth = (req, res, next) => {
  const secret = req.headers["x-admin-secret"]
  if (secret && secret === ADMIN_SECRET) {
    next()
  } else {
    res.status(403).json({ error: "Forbidden: Invalid admin secret." })
  }
}

/**
 * POST /apps/admin-update
 * Admin-only route to update a customer's stats.
 */
app.post("/apps/admin-update", adminAuth, async (req, res) => {
  // Re-use the same logic as the public update route
  // This ensures consistency. The only difference is the auth middleware.
  await app._router.handle({ ...req, url: "/apps/update-customer" }, res)
})

// --- SERVER START ---
app.listen(PORT, () => {
  console.log(`RC Arsenal Backend listening on port ${PORT}`)
})
