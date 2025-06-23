import express from "express"
import cors from "cors"
import fetch from "node-fetch"
import FormData from "form-data"
import multer from "multer"

const app = express()
const PORT = process.env.PORT || 10000

// --- MIDDLEWARE ---
app.use(cors()) // Enable CORS for all routes
app.use(express.json({ limit: "10mb" }))
app.use(express.urlencoded({ extended: true, limit: "10mb" }))

const storage = multer.memoryStorage()
const upload = multer({ storage: storage })

// --- ENVIRONMENT VARIABLES ---
const {
  SHOPIFY_STORE_URL, // e.g., 'your-store.myshopify.com' (NO https://, NO trailing /)
  SHOPIFY_ACCESS_TOKEN, // Admin API access token with read/write customer scope
  IMGBB_API_KEY, // Your ImgBB API key
  ADMIN_SECRET, // A secret key for admin actions
} = process.env

const getShopifyGraphQLURL = () => {
  if (!SHOPIFY_STORE_URL) {
    throw new Error("SHOPIFY_STORE_URL environment variable is not set.")
  }
  return `https://${SHOPIFY_STORE_URL}/admin/api/2024-04/graphql.json`
}

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
      console.error("Shopify API Error Response:", JSON.stringify(data.errors, null, 2))
      throw new Error(`Shopify API request failed. First error: ${data.errors[0].message}`)
    }
    return data
  } catch (error) {
    console.error("Critical Error in shopifyFetch:", error)
    throw error // Re-throw the error to be caught by the route handler
  }
}

// --- API ROUTES ---

// Health check for Render
app.get("/health", (req, res) => res.status(200).send("OK"))

// GET /apps/killboard
app.get("/apps/killboard", async (req, res) => {
  const query = `
    query getCustomersForKillboard {
      customers(first: 100, query: "metafield:rc_arsenal.xp > 0 OR metafield:rc_arsenal.victories > 0") {
        edges {
          node {
            id
            username: metafield(namespace: "rc_arsenal", key: "username") { value }
            xp: metafield(namespace: "rc_arsenal", key: "xp") { value }
            victories: metafield(namespace: "rc_arsenal", key: "victories") { value }
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
      name: node.username?.value || "Unnamed Pilot",
      xp: Number.parseInt(node.xp?.value || "0", 10),
      victories: Number.parseInt(node.victories?.value || "0", 10),
      country: node.country?.value || "Unknown",
      avatar: node.avatar?.value,
    }))

    // Sort by victories descending, then by XP descending as a tie-breaker
    players.sort((a, b) => b.victories - a.victories || b.xp - a.xp)

    res.json(players)
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch killboard data.", details: error.message })
  }
})

// GET /apps/garage-data
app.get("/apps/garage-data", async (req, res) => {
  const { customerId } = req.query
  if (!customerId) {
    return res.status(400).json({ error: "Customer ID is required." })
  }

  const query = `
    query getCustomerGarageData($id: ID!) {
      customer(id: $id) {
        id
        metafields(namespace: "rc_arsenal", first: 20) {
          edges { node { key value } }
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

    // Transform metafields into a simple key-value object
    const garageData = customerNode.metafields.edges.reduce(
      (acc, { node }) => {
        acc[node.key] = node.value
        return acc
      },
      { id: customerNode.id },
    )

    // Sanitize and set defaults
    garageData.xp = Number.parseInt(garageData.xp || "0", 10)
    garageData.victories = Number.parseInt(garageData.victories || "0", 10)
    garageData.achievements = JSON.parse(garageData.achievements || "[]")

    res.json(garageData)
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch garage data.", details: error.message })
  }
})

// POST /apps/upload-image
app.post("/apps/upload-image", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No image file provided." })
  if (!IMGBB_API_KEY)
    return res.status(500).json({ error: "Image hosting (IMGBB_API_KEY) is not configured on the server." })

  try {
    const form = new FormData()
    form.append("image", req.file.buffer.toString("base64"))

    const response = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, {
      method: "POST",
      body: form,
    })

    const result = await response.json()
    if (!result.success) {
      console.error("ImgBB Error:", result.error.message)
      return res.status(500).json({ error: "Failed to upload image.", details: result.error.message })
    }

    res.json({ url: result.data.url })
  } catch (error) {
    console.error("Image Upload Exception:", error)
    res.status(500).json({ error: "An exception occurred during image upload.", details: error.message })
  }
})

// POST /apps/update-customer
app.post("/apps/update-customer", async (req, res) => {
  const { customerId, metafields } = req.body

  if (!customerId || !metafields || !Array.isArray(metafields) || metafields.length === 0) {
    return res.status(400).json({ error: "Invalid request: requires customerId and a non-empty metafields array." })
  }

  const query = `
    mutation customerUpdate($input: CustomerInput!) {
      customerUpdate(input: $input) {
        customer { id }
        userErrors { field message }
      }
    }
  `
  const input = {
    id: `gid://shopify/Customer/${customerId}`,
    metafields: metafields.map((mf) => ({
      namespace: "rc_arsenal",
      key: mf.key,
      value: mf.value.toString(),
      type: mf.type || "single_line_text_field",
    })),
  }

  try {
    const response = await shopifyFetch(query, { input })
    if (response.data.customerUpdate.userErrors.length > 0) {
      return res.status(400).json({
        error: "Failed to update customer.",
        details: response.data.customerUpdate.userErrors,
      })
    }
    res.status(200).json({ success: true, id: response.data.customerUpdate.customer.id })
  } catch (error) {
    res.status(500).json({ error: "Failed to update customer data.", details: error.message })
  }
})

// --- SERVER START ---
app.listen(PORT, () => {
  console.log(`RC Arsenal Backend listening on port ${PORT}`)
  if (!SHOPIFY_STORE_URL || !SHOPIFY_ACCESS_TOKEN || !IMGBB_API_KEY) {
    console.warn("\n[WARNING] One or more required environment variables are missing.")
    console.warn("Please check SHOPIFY_STORE_URL, SHOPIFY_ACCESS_TOKEN, and IMGBB_API_KEY.\n")
  }
})
