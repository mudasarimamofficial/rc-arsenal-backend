import express from "express"
import cors from "cors"
import fetch from "node-fetch"
import FormData from "form-data"
import multer from "multer"

const app = express()
const PORT = process.env.PORT || 10000

// --- MIDDLEWARE ---
app.use(cors())
app.use(express.json({ limit: "10mb" }))
app.use(express.urlencoded({ extended: true, limit: "10mb" }))

const storage = multer.memoryStorage()
const upload = multer({ storage: storage })

// --- ENVIRONMENT VARIABLES ---
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN
const IMGBB_API_KEY = process.env.IMGBB_API_KEY
const ADMIN_SECRET = process.env.ADMIN_SECRET

// --- HELPER FUNCTIONS ---
const getShopifyGraphQLURL = () => `https://${SHOPIFY_STORE_URL}/admin/api/2024-04/graphql.json`

const shopifyFetch = async (query, variables) => {
  if (!SHOPIFY_STORE_URL || !SHOPIFY_ACCESS_TOKEN) {
    console.error("Shopify store URL or access token is not configured.")
    throw new Error("Shopify API credentials missing.")
  }
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
      // Try to provide a more specific error message if possible
      const firstError = data.errors[0]
      let errorMessage = "Shopify API request failed."
      if (firstError && firstError.message) {
        errorMessage = `Shopify API Error: ${firstError.message}`
        if (firstError.extensions && firstError.extensions.code) {
          errorMessage += ` (Code: ${firstError.extensions.code})`
        }
      }
      throw new Error(errorMessage)
    }
    return data
  } catch (error) {
    console.error("Error in shopifyFetch:", error.message)
    throw error // Re-throw the original or new error
  }
}

// --- API ROUTES ---

app.get("/health", (req, res) => {
  res.status(200).send("OK")
})

app.get("/apps/killboard", async (req, res) => {
  const query = `
    query getCustomers {
      customers(first: 100, sortKey: UPDATED_AT, reverse: true) {
        edges {
          node {
            id
            displayName
            firstName
            lastName
            metafield(namespace: "rc_arsenal", key: "username") { value }
            level: metafield(namespace: "rc_arsenal", key: "level") { value }
            xp: metafield(namespace: "rc_arsenal", key: "xp") { value }
            victories: metafield(namespace: "rc_arsenal", key: "victories") { value }
            tier: metafield(namespace: "rc_arsenal", key: "tier_text") { value } # Using tier_text
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
      name:
        node.metafield?.value ||
        node.displayName ||
        `${node.firstName || ""} ${node.lastName || ""}`.trim() ||
        "Unnamed Pilot",
      level: Number.parseInt(node.level?.value || "1", 10),
      xp: Number.parseInt(node.xp?.value || "0", 10),
      victories: Number.parseInt(node.victories?.value || "0", 10),
      tier: node.tier?.value || "Recruit",
      country: node.country?.value || "Unknown",
      avatar: node.avatar?.value || "",
    }))

    players.sort((a, b) => b.xp - a.xp)
    res.json(players)
  } catch (error) {
    res.status(500).json({ error: `Failed to fetch killboard data: ${error.message}` })
  }
})

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
        displayName
        metafields(namespace: "rc_arsenal", first: 20) { # Increased limit
          edges {
            node {
              key
              value
              type
            }
          }
        }
      }
    }
  `
  try {
    const customerGid = customerId.startsWith("gid://shopify/Customer/")
      ? customerId
      : `gid://shopify/Customer/${customerId}`
    const response = await shopifyFetch(query, { id: customerGid })
    const customerNode = response.data.customer

    if (!customerNode) {
      return res.status(404).json({ error: "Customer not found." })
    }

    const garageData = {
      id: customerNode.id,
      // Provide default names from customer object if username metafield is missing
      username_default:
        customerNode.displayName || `${customerNode.firstName || ""} ${customerNode.lastName || ""}`.trim(),
    }
    customerNode.metafields.edges.forEach(({ node }) => {
      // Attempt to parse numbers and JSON strings
      if (node.type === "integer" || node.type === "number_integer") {
        garageData[node.key] = Number.parseInt(node.value, 10)
      } else if (node.type === "json_string" || node.key === "achievements") {
        // Assuming achievements is JSON
        try {
          garageData[node.key] = JSON.parse(node.value)
        } catch (e) {
          garageData[node.key] = node.value // Store as string if parsing fails
          console.warn(`Failed to parse JSON for key ${node.key}: ${node.value}`)
        }
      } else {
        garageData[node.key] = node.value
      }
    })

    garageData.username = garageData.username || garageData.username_default || "Unnamed Pilot"
    garageData.level = garageData.level || 1
    garageData.xp = garageData.xp || 0
    garageData.victories = garageData.victories || 0
    garageData.tier = garageData.tier_text || garageData.tier || "Recruit" // Prefer tier_text
    garageData.country = garageData.country || "Unknown"
    garageData.faction = garageData.faction || "Independent"
    garageData.avatar_url = garageData.avatar_url || ""
    garageData.car_image_url = garageData.car_image_url || ""
    garageData.achievements = garageData.achievements || []

    res.json(garageData)
  } catch (error) {
    res.status(500).json({ error: `Failed to fetch garage data: ${error.message}` })
  }
})

app.post("/apps/upload-image", upload.single("image"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No image file provided." })
  }
  if (!IMGBB_API_KEY) {
    return res.status(500).json({ error: "Image hosting (ImgBB API Key) is not configured on the server." })
  }

  try {
    const form = new FormData()
    form.append("image", req.file.buffer.toString("base64"))

    const imgbbResponse = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, {
      method: "POST",
      body: form,
    })

    const result = await imgbbResponse.json()

    if (result.success) {
      res.json({ url: result.data.url })
    } else {
      console.error("ImgBB Error:", result)
      res.status(500).json({ error: `Failed to upload image to ImgBB: ${result.error?.message || "Unknown error"}` })
    }
  } catch (error) {
    console.error("Image Upload Exception:", error)
    res.status(500).json({ error: `An exception occurred during image upload: ${error.message}` })
  }
})

app.post("/apps/update-customer", async (req, res) => {
  const { customerId, metafields } = req.body

  if (!customerId || !metafields || !Array.isArray(metafields) || metafields.length === 0) {
    return res
      .status(400)
      .json({ error: "Invalid request body: customerId and a non-empty array of metafields are required." })
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
          code # Include error code
        }
      }
    }
  `
  const customerGid = customerId.startsWith("gid://shopify/Customer/")
    ? customerId
    : `gid://shopify/Customer/${customerId}`
  const input = {
    id: customerGid,
    metafields: metafields.map((mf) => ({
      namespace: "rc_arsenal",
      key: mf.key,
      value: String(mf.value), // Ensure value is a string
      type: mf.type || "single_line_text_field",
    })),
  }

  try {
    const response = await shopifyFetch(query, { input })
    if (response.data.customerUpdate.userErrors.length > 0) {
      console.error("Customer Update User Errors:", JSON.stringify(response.data.customerUpdate.userErrors, null, 2))
      return res.status(400).json({
        error: "Failed to update customer due to Shopify user errors.",
        userErrors: response.data.customerUpdate.userErrors,
      })
    }
    res.status(200).json({ success: true, customerId: response.data.customerUpdate.customer.id })
  } catch (error) {
    res.status(500).json({ error: `Failed to update customer data: ${error.message}` })
  }
})

const adminAuth = (req, res, next) => {
  const secret = req.headers["x-admin-secret"]
  if (!ADMIN_SECRET) {
    console.warn("Admin secret is not configured on the server. Admin routes are unprotected.")
    return next() // Or deny access if secret MUST be present
  }
  if (secret && secret === ADMIN_SECRET) {
    next()
  } else {
    res.status(403).json({ error: "Forbidden: Invalid admin secret." })
  }
}

app.post("/apps/admin-update", adminAuth, async (req, res) => {
  // This re-routes to the /apps/update-customer logic but with adminAuth first.
  // Ensure the body and structure are what /apps/update-customer expects.
  await app._router.handle({ ...req, url: "/apps/update-customer" }, res, (err) => {
    if (err) {
      console.error("Error in admin-update re-route:", err)
      res.status(500).json({ error: "Internal error during admin update." })
    }
  })
})

app.listen(PORT, () => {
  console.log(`RC Arsenal Backend listening on port ${PORT}`)
  if (!SHOPIFY_STORE_URL || !SHOPIFY_ACCESS_TOKEN || !IMGBB_API_KEY) {
    console.warn(
      "WARNING: One or more critical environment variables (SHOPIFY_STORE_URL, SHOPIFY_ACCESS_TOKEN, IMGBB_API_KEY) are missing!",
    )
  }
})
