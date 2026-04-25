/**
 * Authentication Utilities
 * Handles password hashing, PIN hashing, and password validation
 */

const bcrypt = require('bcrypt');
const crypto = require('crypto');

// Salt rounds for bcrypt
const SALT_ROUNDS = 10;
const PIN_SALT_ROUNDS = 10;

/**
 * Hash a password using bcrypt
 * @param {string} password - Plain text password
 * @returns {Promise<string>} - Hashed password
 */
async function hashPassword(password) {
  if (!password || password.length < 4) {
    throw new Error('Password must be at least 4 characters long');
  }
  return await bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verify a password against a hash
 * @param {string} password - Plain text password
 * @param {string} hash - Hashed password
 * @returns {Promise<boolean>} - True if password matches
 */
async function verifyPassword(password, hash) {
  if (!password || !hash) {
    return false;
  }
  return await bcrypt.compare(password, hash);
}

/**
 * Hash a 4-digit PIN
 * @param {string} pin - 4-digit PIN
 * @returns {Promise<string>} - Hashed PIN
 */
async function hashPIN(pin) {
  if (!pin || pin.length !== 4 || !/^\d{4}$/.test(pin)) {
    throw new Error('PIN must be exactly 4 digits');
  }
  return await bcrypt.hash(pin, PIN_SALT_ROUNDS);
}

/**
 * Verify a PIN against a hash
 * @param {string} pin - 4-digit PIN
 * @param {string} hash - Hashed PIN
 * @returns {Promise<boolean>} - True if PIN matches
 */
async function verifyPIN(pin, hash) {
  if (!pin || !hash) {
    return false;
  }
  if (pin.length !== 4 || !/^\d{4}$/.test(pin)) {
    return false;
  }
  return await bcrypt.compare(pin, hash);
}

/**
 * Generate a secure random token for password reset
 * @returns {string} - Random token
 */
function generateResetToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Hash a security answer (for password recovery)
 * @param {string} answer - Security answer
 * @returns {Promise<string>} - Hashed answer
 */
async function hashSecurityAnswer(answer) {
  if (!answer || answer.length < 3) {
    throw new Error('Security answer must be at least 3 characters long');
  }
  // Normalize answer (lowercase, trim)
  const normalized = answer.toLowerCase().trim();
  return await bcrypt.hash(normalized, SALT_ROUNDS);
}

/**
 * Verify a security answer
 * @param {string} answer - User's answer
 * @param {string} hash - Hashed answer
 * @returns {Promise<boolean>} - True if answer matches
 */
async function verifySecurityAnswer(answer, hash) {
  if (!answer || !hash) {
    return false;
  }
  const normalized = answer.toLowerCase().trim();
  return await bcrypt.compare(normalized, hash);
}

/**
 * Validate password strength
 * @param {string} password - Password to validate
 * @returns {Object} - { valid: boolean, message: string }
 */
function validatePassword(password) {
  if (!password) {
    return { valid: false, message: 'Password is required' };
  }
  if (password.length < 4) {
    return { valid: false, message: 'Password must be at least 4 characters long' };
  }
  if (password.length > 100) {
    return { valid: false, message: 'Password is too long' };
  }
  return { valid: true, message: 'Password is valid' };
}

/**
 * Validate username
 * @param {string} username - Username to validate
 * @returns {Object} - { valid: boolean, message: string }
 */
function validateUsername(username) {
  if (!username) {
    return { valid: false, message: 'Username is required' };
  }
  if (username.length < 3) {
    return { valid: false, message: 'Username must be at least 3 characters long' };
  }
  if (username.length > 50) {
    return { valid: false, message: 'Username is too long' };
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return { valid: false, message: 'Username can only contain letters, numbers, and underscores' };
  }
  return { valid: true, message: 'Username is valid' };
}

/**
 * Generate a device-bound recovery key
 * Uses device fingerprint to create a recovery key
 * @param {string} deviceId - Device fingerprint
 * @returns {string} - Recovery key
 */
function generateDeviceBoundRecoveryKey(deviceId) {
  // Create a recovery key based on device ID and current date
  // This ensures the key is device-specific and time-bound
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const combined = `${deviceId}-${date}`;
  return crypto.createHash('sha256').update(combined).digest('hex').substring(0, 16).toUpperCase();
}

module.exports = {
  hashPassword,
  verifyPassword,
  hashPIN,
  verifyPIN,
  generateResetToken,
  hashSecurityAnswer,
  verifySecurityAnswer,
  validatePassword,
  validateUsername,
  generateDeviceBoundRecoveryKey,
};


