const express = require('express');
const router = express.Router();
const db = require('../db');
const mockSessions = require('../utils/mockSessions');
const { 
  hashPassword, 
  hashPIN,
  hashSecurityAnswer,
  validatePassword, 
  validateUsername 
} = require('../utils/authUtils');
const { createSession } = require('../middleware/authMiddleware');
const { logAuditEvent } = require('../utils/auditLogger');
const deviceFingerprint = require('../utils/deviceFingerprint');

// Helper to get client IP and device info
const getClientInfo = (req) => ({
  ipAddress: req.ip || req.connection.remoteAddress,
  deviceInfo: req.headers['user-agent'] || 'Unknown Device',
  deviceId: req.headers['x-device-id'] || deviceFingerprint.getDeviceId(),
});

/**
 * @route GET /api/setup-auth/check-first-time
 * @description Checks if any users exist in the database.
 * @access Public
 */
router.get('/check-first-time', async (req, res) => {
  if (!db.isDatabaseConfigured()) {
    return res.json({ isFirstTimeSetup: mockSessions.isSetupWizardNeeded() });
  }

  try {
    // First check if users table exists
    const checkUsersTableQuery = `
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'users'
      );
    `;
    
    const tableResult = await db.query(checkUsersTableQuery);
    const usersTableExists = tableResult.rows[0].exists;

    if (!usersTableExists) {
      // Users table doesn't exist - setup is needed
      return res.json({ isFirstTimeSetup: true });
    }

    const result = await db.query('SELECT COUNT(*) FROM users');
    const userCount = parseInt(result.rows[0].count, 10);
    
    // Also check if setup is marked as complete
    let setupComplete = false;
    try {
      const settingsResult = await db.query(`
        SELECT other_app_settings FROM settings ORDER BY id LIMIT 1
      `);
      
      if (settingsResult.rows.length > 0) {
        const settings = settingsResult.rows[0].other_app_settings || {};
        const parsedSettings = typeof settings === 'string' ? JSON.parse(settings) : settings;
        setupComplete = parsedSettings.firstTimeSetupComplete === true;
      }
    } catch (err) {
      // Settings table might not exist, that's okay
    }
    
    res.json({ isFirstTimeSetup: userCount === 0 || !setupComplete });
  } catch (error) {
    console.error('[Setup Auth Route] Error checking first-time setup:', error);
    // If error, assume setup is needed
    res.json({ isFirstTimeSetup: true });
  }
});

/**
 * @route POST /api/setup-auth/create-admin
 * @description Creates the first administrator account with business information and POS settings
 * @access Public (only if no users exist)
 */
router.post('/create-admin', async (req, res) => {
  const { 
    // Business Information
    shopName,
    ownerName,
    mobileNumber,
    city,
    businessType,
    // Admin Account
    username, 
    password, 
    pin, 
    securityQuestion, 
    securityAnswer,
    // POS Settings
    currency,
    enableGST,
    receiptSize,
    stockTracking,
    lowStockAlert
  } = req.body;
  
  const { ipAddress, deviceInfo, deviceId } = getClientInfo(req);

  try {
    if (!db.isDatabaseConfigured()) {
      if (!mockSessions.isSetupWizardNeeded()) {
        return res.status(403).json({ message: 'First-time setup already completed.' });
      }

      if (!shopName || !ownerName || !username || !password) {
        return res.status(400).json({ message: 'Shop name, owner name, username, and password are required.' });
      }

      const usernameValidation = validateUsername(username);
      if (!usernameValidation.valid) {
        return res.status(400).json({ message: usernameValidation.message });
      }
      const passwordValidation = validatePassword(password);
      if (!passwordValidation.valid) {
        return res.status(400).json({ message: passwordValidation.message });
      }
      if (pin && !/^\d{4}$/.test(pin)) {
        return res.status(400).json({ message: 'PIN must be a 4-digit number.' });
      }
      if (securityQuestion && (!securityAnswer || securityAnswer.length < 3)) {
        return res.status(400).json({ message: 'Security answer must be at least 3 characters long if a question is provided.' });
      }

      const mockUser = {
        user_id: 1,
        username,
        name: ownerName,
        role: 'administrator',
      };
      const sessionId = mockSessions.createMockSession(mockUser);

      return res.status(201).json({
        message:
          'Setup completed (no database yet — connect Supabase to persist data).',
        sessionId,
        user: {
          userId: mockUser.user_id,
          username: mockUser.username,
          name: mockUser.name,
          role: mockUser.role,
          hasPin: !!pin,
        },
      });
    }

    // Ensure this is truly the first-time setup
    const userCountResult = await db.query('SELECT COUNT(*) FROM users');
    if (parseInt(userCountResult.rows[0].count, 10) > 0) {
      await logAuditEvent({
        userId: null,
        action: 'FIRST_TIME_SETUP_ATTEMPT_FAILED',
        notes: 'Attempted first-time setup when users already exist.',
        ipAddress,
        userAgent: deviceInfo
      });
      return res.status(403).json({ message: 'First-time setup already completed.' });
    }

    // Validate inputs
    if (!shopName || !ownerName || !username || !password) {
      return res.status(400).json({ message: 'Shop name, owner name, username, and password are required.' });
    }

    const usernameValidation = validateUsername(username);
    if (!usernameValidation.valid) {
      return res.status(400).json({ message: usernameValidation.message });
    }
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({ message: passwordValidation.message });
    }
    if (pin && !/^\d{4}$/.test(pin)) {
      return res.status(400).json({ message: 'PIN must be a 4-digit number.' });
    }
    if (securityQuestion && (!securityAnswer || securityAnswer.length < 3)) {
      return res.status(400).json({ message: 'Security answer must be at least 3 characters long if a question is provided.' });
    }

    const passwordHash = await hashPassword(password);
    let pinHash = null;
    if (pin) {
      pinHash = await hashPIN(pin);
    }
    let securityAnswerHash = null;
    if (securityQuestion && securityAnswer) {
      securityAnswerHash = await hashSecurityAnswer(securityAnswer);
    }

    // Create admin user
    const result = await db.query(
      `INSERT INTO users (name, username, password_hash, pin_hash, role, security_question, security_answer_hash)
       VALUES ($1, $2, $3, $4, 'administrator', $5, $6)
       RETURNING user_id, username, role, name, pin_hash`,
      [ownerName, username, passwordHash, pinHash, securityQuestion, securityAnswerHash]
    );

    const newUser = result.rows[0];

    // Save business information and POS settings to settings table
    const businessInfo = {
      shopName: shopName || '',
      ownerName: ownerName || '',
      mobileNumber: mobileNumber || '',
      city: city || '',
      businessType: businessType || 'mixed'
    };

    const posSettings = {
      currency: currency || 'PKR',
      enableGST: enableGST !== undefined ? enableGST : false,
      receiptSize: receiptSize || '80mm',
      stockTracking: stockTracking !== undefined ? stockTracking : true,
      lowStockAlert: lowStockAlert !== undefined ? lowStockAlert : true
    };

    // Get or create settings record
    const settingsResult = await db.query('SELECT id, other_app_settings FROM settings ORDER BY id LIMIT 1');
    
    let otherAppSettings = {};
    if (settingsResult.rows.length > 0) {
      const existingSettings = settingsResult.rows[0].other_app_settings || {};
      otherAppSettings = typeof existingSettings === 'string' 
        ? JSON.parse(existingSettings) 
        : existingSettings;
    }

    // Update settings
    otherAppSettings.firstTimeSetupComplete = true;
    otherAppSettings.businessInfo = businessInfo;
    otherAppSettings.posSettings = posSettings;

    if (settingsResult.rows.length > 0) {
      await db.query(
        'UPDATE settings SET other_app_settings = $1 WHERE id = $2',
        [JSON.stringify(otherAppSettings), settingsResult.rows[0].id]
      );
    } else {
      await db.query(
        'INSERT INTO settings (other_app_settings) VALUES ($1)',
        [JSON.stringify(otherAppSettings)]
      );
    }

    // Create session for the new admin
    const sessionId = await createSession(newUser.user_id, deviceId, ipAddress, deviceInfo);
    await logAuditEvent({
      userId: newUser.user_id,
      action: 'FIRST_TIME_SETUP_COMPLETE',
      notes: 'Initial administrator account created with business information and POS settings.',
      ipAddress,
      userAgent: deviceInfo
    });

    res.status(201).json({
      message: 'Setup completed successfully. You are now logged in.',
      sessionId,
      user: {
        userId: newUser.user_id,
        username: newUser.username,
        name: newUser.name,
        role: newUser.role,
        hasPin: !!newUser.pin_hash,
      },
    });
  } catch (error) {
    console.error('[Setup Auth Route] Error creating admin:', error);
    await logAuditEvent({
      userId: null,
      action: 'FIRST_TIME_SETUP_ERROR',
      notes: `Server error: ${error.message}`,
      ipAddress,
      userAgent: deviceInfo
    });
    res.status(500).json({ message: 'Internal server error during setup.' });
  }
});

module.exports = router;

