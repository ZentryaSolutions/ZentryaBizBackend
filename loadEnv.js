/**
 * Load backend env in order: .env → env.local → env.email.local (later files override).
 */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

function loadBackendEnv() {
  const dir = __dirname;
  for (const name of ['.env', 'env.local', 'env.email.local']) {
    const filePath = path.join(dir, name);
    if (fs.existsSync(filePath)) {
      dotenv.config({ path: filePath, override: true });
    }
  }
}

module.exports = { loadBackendEnv };
