const fs = require("fs");
const path = require("path");

const swPath = path.join(__dirname, "..", "public", "sw.js");
const buildId = Date.now().toString(36);

const content = fs.readFileSync(swPath, "utf8");
const updated = content.replace(/__BUILD_ID__/g, buildId);
fs.writeFileSync(swPath, updated);

console.log(`sw.js stamped with build id: ${buildId}`);
