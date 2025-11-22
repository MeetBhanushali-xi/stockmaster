// scripts/bootstrap_locations.js
const fs = require("fs");
const path = require("path");

const productsPath = path.join(__dirname, "..", "backend", "data", "products.json");
const locationsPath = path.join(__dirname, "..", "backend", "data", "locations.json");

const products = JSON.parse(fs.readFileSync(productsPath, "utf8"));
let locations = JSON.parse(fs.readFileSync(locationsPath, "utf8"));

// find Main Warehouse (id=1) or first one
let main = locations.find(l => l.name === "Main Warehouse") || locations[0];

if (!main) {
  main = { id: Date.now(), name: "Main Warehouse", stock: [] };
  locations.push(main);
}

main.stock = products.map(p => ({ productId: p.id, qty: Number(p.total_stock || 0) }));

fs.writeFileSync(locationsPath, JSON.stringify(locations, null, 2), "utf8");
console.log("Bootstrap complete. Main Warehouse stock populated.");
