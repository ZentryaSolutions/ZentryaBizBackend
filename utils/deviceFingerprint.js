const os = require('os');
const crypto = require('crypto');

/**
 * Generate a unique device fingerprint
 * Combines multiple machine identifiers for uniqueness
 */
function generateDeviceFingerprint() {
  try {
    const components = [
      os.hostname(),
      os.platform(),
      os.arch(),
      os.totalmem().toString(),
      os.cpus().length.toString(),
      // Network interfaces MAC addresses (first non-internal)
      getMacAddress(),
      // Machine ID if available (Linux)
      process.env.MACHINE_ID || '',
    ].filter(Boolean);

    const fingerprintString = components.join('|');
    
    // Hash the fingerprint for privacy and consistency
    const hash = crypto.createHash('sha256');
    hash.update(fingerprintString);
    return hash.digest('hex');
  } catch (error) {
    console.error('Error generating device fingerprint:', error);
    // Fallback to a basic fingerprint
    return crypto.createHash('sha256')
      .update(os.hostname() + os.platform() + os.arch())
      .digest('hex');
  }
}

/**
 * Get MAC address from network interfaces
 */
function getMacAddress() {
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        // Skip internal (loopback) addresses
        if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
          return iface.mac;
        }
      }
    }
    return '';
  } catch (error) {
    return '';
  }
}

/**
 * Get device ID (shorter identifier for API calls)
 */
function getDeviceId() {
  const fingerprint = generateDeviceFingerprint();
  // Use first 16 characters as device ID
  return fingerprint.substring(0, 16);
}

module.exports = {
  generateDeviceFingerprint,
  getDeviceId,
  getMacAddress
};








