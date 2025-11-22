// backend/server.js
const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// Serve frontend static files so you can open via http://localhost:3000/dashboard.html
app.use(express.static(path.join(__dirname, "..", "frontend")));

// Helper to safely read JSON file
function readJson(relPath) {
  try {
    const full = path.join(__dirname, relPath);
    if (!fs.existsSync(full)) return null;
    const raw = fs.readFileSync(full, "utf8");
    return JSON.parse(raw || "null");
  } catch (err) {
    console.error("Error reading JSON:", relPath, err);
    return null;
  }
}

// LOGIN API (existing)
app.post("/login", (req, res) => {
  const { email, password } = req.body;
  const users = readJson("./data/users.json") || [];
  const user = users.find(u => u.email === email && u.password === password);
  if (!user) return res.json({ success: false, message: "Invalid email or password" });
  return res.json({ success: true, user });
});

// Dashboard API
app.get("/api/dashboard", (req, res) => {
  const products = readJson("./data/products.json") || [];
  const operations = readJson("./data/operations.json") || { receipts: [], deliveries: [], internalTransfers: [] };

  // Total products
  const totalProducts = products.length;

  // Low stock = total_stock <= reorder_level (also consider 0)
  const lowStockItems = products.filter(p => {
    // ensure fields exist
    const total = Number(p.total_stock || 0);
    const reorder = Number(p.reorder_level || 0);
    return total <= reorder; // treat equal or lower as low
  }).length;

  // Pending receipts (status: Draft, Waiting)
  const pendingReceipts = (operations.receipts || []).filter(r => {
    const s = (r.status || "").toLowerCase();
    return s === "draft" || s === "waiting" || s === "pending";
  }).length;

  // Pending deliveries (not Done)
  const pendingDeliveries = (operations.deliveries || []).filter(d => {
    const s = (d.status || "").toLowerCase();
    return s !== "done" && s !== "completed";
  }).length;

  // Internal transfers scheduled
  const internalTransfersScheduled = (operations.internalTransfers || []).filter(t => {
    const s = (t.status || "").toLowerCase();
    return s === "scheduled" || s === "waiting" || s === "pending";
  }).length;

  res.json({
    totalProducts,
    lowStockItems,
    pendingReceipts,
    pendingDeliveries,
    internalTransfersScheduled
  });
});

// GET PRODUCTS
app.get("/api/products", (req, res) => {
  const products = readJson("./data/products.json") || [];
  res.json(products);
});


// ADD PRODUCT
app.post("/api/products", (req, res) => {
  const products = readJson("./data/products.json") || [];
  const newProduct = req.body;

  newProduct.id = Date.now(); // unique ID
  products.push(newProduct);

  fs.writeFileSync("./backend/data/products.json", JSON.stringify(products, null, 2));
  res.json({ success: true, product: newProduct });
});


// UPDATE PRODUCT
app.put("/api/products/:id", (req, res) => {
  const id = Number(req.params.id);
  let products = readJson("./data/products.json") || [];

  const index = products.findIndex(p => p.id === id);
  if (index === -1) return res.json({ success: false, message: "Product not found" });

  products[index] = { ...products[index], ...req.body };

  fs.writeFileSync("./backend/data/products.json", JSON.stringify(products, null, 2));
  res.json({ success: true, product: products[index] });
});



// ---------- Receipts API ----------

// Helper: write JSON safely (relative to backend folder)
function writeJson(relPath, data) {
  try {
    const full = path.join(__dirname, relPath);
    fs.writeFileSync(full, JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch (err) {
    console.error("Error writing JSON:", relPath, err);
    return false;
  }
}

// GET all receipts
app.get("/api/receipts", (req, res) => {
  const ops = readJson("./data/operations.json") || { receipts: [], deliveries: [], internalTransfers: [] };
  res.json(ops.receipts || []);
});

// GET single receipt by id
app.get("/api/receipts/:id", (req, res) => {
  const id = Number(req.params.id);
  const ops = readJson("./data/operations.json") || { receipts: [] };
  const receipt = (ops.receipts || []).find(r => r.id === id);
  if (!receipt) return res.status(404).json({ success: false, message: "Receipt not found" });
  res.json(receipt);
});

// CREATE a receipt
// expected body: { supplier: "Name", items: [ { productId: 123, qty: 10 }, ... ] }
// newly created receipt will have { id, supplier, items, status: "Waiting", createdAt }
app.post("/api/receipts", (req, res) => {
  const ops = readJson("./data/operations.json") || { receipts: [], deliveries: [], internalTransfers: [] };
  const products = readJson("./data/products.json") || [];

  const { supplier, items } = req.body;
  if (!supplier || !Array.isArray(items)) {
    return res.status(400).json({ success: false, message: "Invalid payload" });
  }

  const newReceipt = {
    id: Date.now(),
    supplier,
    items: items.map(it => ({ productId: Number(it.productId), qty: Number(it.qty) })),
    status: "Waiting",
    createdAt: new Date().toISOString()
  };

  ops.receipts.push(newReceipt);
  writeJson("./data/operations.json", ops);

  res.json({ success: true, receipt: newReceipt });
});

// VALIDATE a receipt (mark Done and update product stocks)
// This will add qty -> product.total_stock for each item
app.put("/api/receipts/:id/validate", (req, res) => {
  const id = Number(req.params.id);
  const ops = readJson("./data/operations.json") || { receipts: [], deliveries: [], internalTransfers: [] };
  let products = readJson("./data/products.json") || [];

  const idx = (ops.receipts || []).findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ success: false, message: "Receipt not found" });

  const receipt = ops.receipts[idx];
  if (receipt.status && receipt.status.toLowerCase() === "done") {
    return res.json({ success: false, message: "Receipt already validated" });
  }

  // Update product stock
  (receipt.items || []).forEach(item => {
    const pIdx = products.findIndex(p => Number(p.id) === Number(item.productId));
    if (pIdx !== -1) {
      products[pIdx].total_stock = Number(products[pIdx].total_stock || 0) + Number(item.qty || 0);
    } else {
      // If product not found, optionally ignore or add as new product (we'll ignore)
      console.warn("Product not found for receipt item:", item);
    }
  });

  // Save updated products
  writeJson("./data/products.json", products);

  // Mark receipt as Done
  ops.receipts[idx].status = "Done";
  ops.receipts[idx].validatedAt = new Date().toISOString();
  writeJson("./data/operations.json", ops);

  res.json({ success: true, receipt: ops.receipts[idx] });
});

// ---------- Deliveries API ----------

// GET all deliveries
app.get("/api/deliveries", (req, res) => {
  const ops = readJson("./data/operations.json") || { receipts: [], deliveries: [], internalTransfers: [] };
  res.json(ops.deliveries || []);
});

// GET single delivery
app.get("/api/deliveries/:id", (req, res) => {
  const id = Number(req.params.id);
  const ops = readJson("./data/operations.json") || { deliveries: [] };
  const d = (ops.deliveries || []).find(x => x.id === id);
  if (!d) return res.status(404).json({ success: false, message: "Delivery not found" });
  res.json(d);
});

// CREATE a delivery
// body: { customer: "Name", items: [ { productId: 1, qty: 2 }, ... ] }
app.post("/api/deliveries", (req, res) => {
  const ops = readJson("./data/operations.json") || { receipts: [], deliveries: [], internalTransfers: [] };
  const { customer, items } = req.body;
  if (!customer || !Array.isArray(items)) return res.status(400).json({ success: false, message: "Invalid payload" });

  const newDelivery = {
    id: Date.now(),
    customer,
    items: items.map(it => ({ productId: Number(it.productId), qty: Number(it.qty) })),
    status: "Waiting",
    createdAt: new Date().toISOString()
  };

  ops.deliveries.push(newDelivery);
  writeJson("./data/operations.json", ops);

  res.json({ success: true, delivery: newDelivery });
});

// VALIDATE a delivery (mark Done and decrease product stocks)
// If any product has insufficient stock, validation fails and nothing is changed.
app.put("/api/deliveries/:id/validate", (req, res) => {
  const id = Number(req.params.id);
  const ops = readJson("./data/operations.json") || { receipts: [], deliveries: [], internalTransfers: [] };
  let products = readJson("./data/products.json") || [];

  const idx = (ops.deliveries || []).findIndex(d => d.id === id);
  if (idx === -1) return res.status(404).json({ success: false, message: "Delivery not found" });

  const delivery = ops.deliveries[idx];
  if (delivery.status && delivery.status.toLowerCase() === "done") {
    return res.json({ success: false, message: "Delivery already validated" });
  }

  // Check stock availability first
  const insufficient = [];
  (delivery.items || []).forEach(item => {
    const p = products.find(pp => Number(pp.id) === Number(item.productId));
    const stock = Number(p?.total_stock || 0);
    if (!p || stock < Number(item.qty || 0)) {
      insufficient.push({ productId: item.productId, required: Number(item.qty || 0), available: stock });
    }
  });

  if (insufficient.length > 0) {
    return res.status(400).json({ success: false, message: "Insufficient stock for some items", insufficient });
  }

  // Deduct stock
  (delivery.items || []).forEach(item => {
    const pIdx = products.findIndex(p => Number(p.id) === Number(item.productId));
    if (pIdx !== -1) {
      products[pIdx].total_stock = Number(products[pIdx].total_stock || 0) - Number(item.qty || 0);
    }
  });

  // Save products and mark delivery Done
  writeJson("./data/products.json", products);
  ops.deliveries[idx].status = "Done";
  ops.deliveries[idx].validatedAt = new Date().toISOString();
  writeJson("./data/operations.json", ops);

  res.json({ success: true, delivery: ops.deliveries[idx] });
});



// ---------- FORGOT PASSWORD - REQUEST OTP ----------
app.post("/api/request-otp", (req, res) => {
  const { email } = req.body;
  if (!email) return res.json({ success: false, message: "Email required" });

  const users = readJson("./data/users.json") || [];
  const user = users.find(u => u.email === email);
  if (!user) return res.json({ success: false, message: "User not found" });

  const otps = readJson("./data/otp.json") || [];

  // Generate OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();

  // Expires in 5 minutes
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  // Remove old OTPs for this user
  const filtered = otps.filter(o => o.email !== email);

  filtered.push({ email, otp, expiresAt });

  fs.writeFileSync("./backend/data/otp.json", JSON.stringify(filtered, null, 2));

  console.log(`OTP for ${email}: ${otp}`);

  res.json({
    success: true,
    message: "OTP sent to email (check console)",
    otp // ← For development only; remove in production
  });
});



// ---------- VERIFY OTP ----------
app.post("/api/verify-otp", (req, res) => {
  const { email, otp } = req.body;
  const otps = readJson("./data/otp.json") || [];

  const entry = otps.find(o => o.email === email && o.otp === otp);
  if (!entry) return res.json({ success: false, message: "Invalid OTP" });

  // Check expiry
  if (new Date(entry.expiresAt) < new Date()) {
    return res.json({ success: false, message: "OTP expired" });
  }

  res.json({ success: true, message: "OTP verified" });
});



// ---------- RESET PASSWORD ----------
app.post("/api/reset-password", (req, res) => {
  const { email, newPassword } = req.body;

  let users = readJson("./data/users.json") || [];
  const idx = users.findIndex(u => u.email === email);
  if (idx === -1) return res.json({ success: false, message: "User not found" });

  users[idx].password = newPassword;

  fs.writeFileSync("./backend/data/users.json", JSON.stringify(users, null, 2));

  // Remove used OTP
  let otps = readJson("./data/otp.json") || [];
  otps = otps.filter(o => o.email !== email);
  fs.writeFileSync("./backend/data/otp.json", JSON.stringify(otps, null, 2));

  res.json({ success: true, message: "Password reset successful" });
});




// ---------- Internal Transfers & Locations API ----------
app.get("/api/locations", (req, res) => {
  const locs = readJson("./data/locations.json") || [];
  res.json(locs);
});

app.post("/api/locations", (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ success: false, message: "Name required" });

  const locs = readJson("./data/locations.json") || [];
  const newLoc = { id: Date.now(), name, stock: [] };
  locs.push(newLoc);
  writeJson("./data/locations.json", locs);
  res.json({ success: true, location: newLoc });
});

// GET transfers
app.get("/api/internal-transfers", (req, res) => {
  const ops = readJson("./data/operations.json") || { receipts: [], deliveries: [], internalTransfers: [] };
  res.json(ops.internalTransfers || []);
});

// CREATE transfer (status = "Waiting")
app.post("/api/internal-transfers", (req, res) => {
  const { fromLocationId, toLocationId, items } = req.body;
  if (!fromLocationId || !toLocationId || !Array.isArray(items)) {
    return res.status(400).json({ success: false, message: "Invalid payload" });
  }

  const ops = readJson("./data/operations.json") || { receipts: [], deliveries: [], internalTransfers: [] };
  const newTransfer = {
    id: Date.now(),
    fromLocationId: Number(fromLocationId),
    toLocationId: Number(toLocationId),
    items: items.map(it => ({ productId: Number(it.productId), qty: Number(it.qty) })),
    status: "Waiting",
    createdAt: new Date().toISOString()
  };

  ops.internalTransfers = ops.internalTransfers || [];
  ops.internalTransfers.push(newTransfer);
  writeJson("./data/operations.json", ops);

  res.json({ success: true, transfer: newTransfer });
});

// VALIDATE transfer: check availability in source location, then move qty between locations
app.put("/api/internal-transfers/:id/validate", (req, res) => {
  const id = Number(req.params.id);
  const ops = readJson("./data/operations.json") || { internalTransfers: [] };
  const locs = readJson("./data/locations.json") || [];

  const idx = (ops.internalTransfers || []).findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).json({ success: false, message: "Transfer not found" });

  const transfer = ops.internalTransfers[idx];
  if ((transfer.status || "").toLowerCase() === "done") {
    return res.json({ success: false, message: "Transfer already validated" });
  }

  const fromLoc = locs.find(l => Number(l.id) === Number(transfer.fromLocationId));
  const toLoc = locs.find(l => Number(l.id) === Number(transfer.toLocationId));
  if (!fromLoc || !toLoc) return res.status(400).json({ success: false, message: "Invalid locations" });

  // helper to get qty
  function getQty(loc, productId) {
    const rec = (loc.stock || []).find(s => Number(s.productId) === Number(productId));
    return rec ? Number(rec.qty) : 0;
  }

  const insufficient = [];
  (transfer.items || []).forEach(it => {
    const avail = getQty(fromLoc, it.productId);
    if (avail < Number(it.qty || 0)) {
      insufficient.push({ productId: it.productId, required: Number(it.qty || 0), available: avail });
    }
  });

  if (insufficient.length > 0) {
    return res.status(400).json({ success: false, message: "Insufficient stock in source location", insufficient });
  }

  // Perform move: deduct from source, add to destination
  (transfer.items || []).forEach(it => {
    // fromLoc
    let sFrom = (fromLoc.stock || []).find(s => Number(s.productId) === Number(it.productId));
    if (!sFrom) {
      sFrom = { productId: Number(it.productId), qty: 0 };
      fromLoc.stock.push(sFrom);
    }
    sFrom.qty = Number(sFrom.qty) - Number(it.qty);

    // toLoc
    let sTo = (toLoc.stock || []).find(s => Number(s.productId) === Number(it.productId));
    if (!sTo) {
      sTo = { productId: Number(it.productId), qty: 0 };
      toLoc.stock.push(sTo);
    }
    sTo.qty = Number(sTo.qty) + Number(it.qty);
  });

  // Save locations and update transfer
  writeJson("./data/locations.json", locs);
  ops.internalTransfers[idx].status = "Done";
  ops.internalTransfers[idx].validatedAt = new Date().toISOString();
  writeJson("./data/operations.json", ops);

  res.json({ success: true, transfer: ops.internalTransfers[idx] });
});


// start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
