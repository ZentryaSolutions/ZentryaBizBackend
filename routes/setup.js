const express = require('express');
const router = express.Router();
const db = require('../db');
const mockSessions = require('../utils/mockSessions');
const fs = require('fs');
const path = require('path');

/**
 * Check if first-time setup is needed (checks for users)
 */
router.get('/check', async (req, res) => {
  if (!db.isDatabaseConfigured()) {
    const need = mockSessions.isSetupWizardNeeded();
    return res.json({
      needsSetup: need,
      userCount: need ? 0 : 1,
      setupComplete: !need,
      tablesExist: false,
    });
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
      return res.json({
        needsSetup: true,
        userCount: 0,
        setupComplete: false,
        tablesExist: false
      });
    }

    // Check if any users exist
    const userResult = await db.query('SELECT COUNT(*) as count FROM users');
    const userCount = parseInt(userResult.rows[0].count, 10);

    // Check if first-time setup is marked as complete in settings
    let setupComplete = false;
    try {
      const settingsResult = await db.query(`
        SELECT other_app_settings FROM settings ORDER BY id LIMIT 1
      `);
      
      if (settingsResult.rows.length > 0) {
        const settings = settingsResult.rows[0].other_app_settings || {};
        if (typeof settings === 'string') {
          settings = JSON.parse(settings);
        }
        setupComplete = settings.firstTimeSetupComplete === true;
      }
    } catch (err) {
      // Settings table might not exist yet, that's okay
      console.log('[Setup] Settings check skipped:', err.message);
    }

    res.json({
      needsSetup: userCount === 0 || !setupComplete,
      userCount,
      setupComplete
    });
  } catch (error) {
    console.error('[Setup Route] Check error:', error);
    // If error, assume setup is needed
    res.json({
      needsSetup: true,
      userCount: 0,
      setupComplete: false,
      error: error.message
    });
  }
});

module.exports = router;


