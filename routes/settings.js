const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireSettingsAdminOrShopOwner } = require('../middleware/authMiddleware');
const { requireShopContext } = require('../middleware/shopContextMiddleware');

// Settings: Cashiers can read, only admins can write — one row per shop
// GET route is accessible to both admins and cashiers
// PUT route requires admin role (will be checked in the route handler)

router.use(requireAuth);
router.use(requireShopContext);

// Get settings — single record per active shop
router.get('/', async (req, res) => {
  try {
    const shopId = req.shopId;
    await db.query(`
      DELETE FROM settings 
      WHERE shop_id = $1 AND id NOT IN (
        SELECT id FROM settings WHERE shop_id = $1 ORDER BY id LIMIT 1
      )
    `, [shopId]);
    
    const result = await db.query('SELECT * FROM settings WHERE shop_id = $1 ORDER BY id LIMIT 1', [shopId]);
    
    if (result.rows.length === 0) {
      await db.query(
        `INSERT INTO settings (printer_config, language, other_app_settings, shop_id)
         VALUES (NULL, 'en', '{"shop_name": "My Shop", "shop_address": "", "shop_phone": ""}'::jsonb, $1)
         RETURNING *`,
        [shopId]
      );
      const newResult = await db.query('SELECT * FROM settings WHERE shop_id = $1 ORDER BY id LIMIT 1', [shopId]);
      return res.json(newResult.rows[0]);
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching settings:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      error: 'Failed to fetch settings', 
      message: error.message,
      code: error.code,
      detail: error.detail
    });
  }
});

// Update settings - ensure only one record exists per shop
// Admin only - cashiers cannot modify settings
router.put('/', requireSettingsAdminOrShopOwner, async (req, res) => {
  try {
    console.log('[Settings API] ===== UPDATE REQUEST START =====');
    console.log('[Settings API] Request body:', JSON.stringify(req.body, null, 2));
    console.log('[Settings API] Request body keys:', Object.keys(req.body));
    
    const { printer_config, language, other_app_settings } = req.body;

    console.log('[Settings API] Extracted values:', {
      printer_config: printer_config ? 'present' : 'null',
      language: language,
      language_type: typeof language,
      language_value: language,
      other_app_settings: other_app_settings ? Object.keys(other_app_settings) : 'null'
    });

    // CRITICAL: Validate language value
    if (language === undefined || language === null) {
      console.warn('[Settings API] ⚠️ Language is undefined/null, defaulting to "en"');
    } else {
      console.log('[Settings API] ✅ Language value is valid:', language);
    }

    // Use the provided language, or default to 'en' only if truly missing
    const languageToSave = (language && language.trim()) ? language.trim() : 'en';
    console.log('[Settings API] Language to save:', languageToSave);

    // First, get existing settings to preserve backup_config
    console.log('[Settings API] Fetching existing settings...');
    const existingResult = await db.query('SELECT * FROM settings WHERE shop_id = $1 ORDER BY id LIMIT 1', [req.shopId]);
    console.log('[Settings API] Existing settings found:', existingResult.rows.length > 0);
    
    let existingOtherAppSettings = {};
    let settingsId = null;
    if (existingResult.rows.length > 0) {
      settingsId = existingResult.rows[0].id;
      console.log('[Settings API] Existing settings ID:', settingsId);
      console.log('[Settings API] Existing language:', existingResult.rows[0].language);
      
      // Parse existing settings if it's a string
      const existingSettings = existingResult.rows[0].other_app_settings;
      console.log('[Settings API] Existing other_app_settings type:', typeof existingSettings);
      
      if (typeof existingSettings === 'string') {
        try {
          existingOtherAppSettings = JSON.parse(existingSettings);
          console.log('[Settings API] Parsed existing settings from string');
        } catch (e) {
          console.error('[Settings API] Error parsing existing settings:', e);
          existingOtherAppSettings = existingSettings || {};
        }
      } else {
        existingOtherAppSettings = existingSettings || {};
        console.log('[Settings API] Using existing settings as object');
      }
      
      console.log('[Settings API] Existing other_app_settings keys:', Object.keys(existingOtherAppSettings));
    } else {
      console.log('[Settings API] No existing settings found, will create new record');
    }
    
    // Merge new settings with existing backup_config to preserve it
    const mergedOtherAppSettings = {
      ...existingOtherAppSettings,
      ...(other_app_settings || {}),
      // Preserve backup_config if it exists
      backup_config: existingOtherAppSettings.backup_config || (other_app_settings?.backup_config || null)
    };

    console.log('[Settings API] Merged settings:', {
      shop_name: mergedOtherAppSettings.shop_name,
      has_backup_config: !!mergedOtherAppSettings.backup_config,
      backup_config_keys: mergedOtherAppSettings.backup_config ? Object.keys(mergedOtherAppSettings.backup_config) : null
    });

    // CRITICAL: Delete duplicates AFTER getting the ID, but BEFORE update
    // This ensures we don't delete the record we're about to update
    if (settingsId) {
      console.log('[Settings API] Deleting duplicate records (keeping ID:', settingsId, ')');
      const deleteResult = await db.query(`
        DELETE FROM settings 
        WHERE id != $1
      `, [settingsId]);
      console.log('[Settings API] Deleted', deleteResult.rowCount, 'duplicate records');
    } else {
      // If no record exists, clean up any duplicates first
      console.log('[Settings API] No existing record, cleaning up duplicates...');
      const deleteResult = await db.query(`
        DELETE FROM settings 
        WHERE shop_id = $1 AND id NOT IN (
          SELECT id FROM settings WHERE shop_id = $1 ORDER BY id LIMIT 1
        )
      `, [req.shopId]);
      console.log('[Settings API] Cleaned up', deleteResult.rowCount, 'duplicates');
    }

    let result;
    if (settingsId) {
      // Update existing record
      console.log('[Settings API] Updating existing record (ID:', settingsId, ')');
      console.log('[Settings API] Update values:', {
        language: language || 'en',
        printer_config: printer_config ? 'present' : 'null',
        other_app_settings_keys: Object.keys(mergedOtherAppSettings)
      });
      
      result = await db.query(
        `UPDATE settings 
         SET printer_config = $1, language = $2, other_app_settings = $3
         WHERE id = $4 AND shop_id = $5
         RETURNING *`,
        [
          printer_config || null,
          languageToSave,  // CRITICAL: Use validated language value
          JSON.stringify(mergedOtherAppSettings),
          settingsId,
          req.shopId
        ]
      );
      
      console.log('[Settings API] Update query executed, rows affected:', result.rowCount);
      console.log('[Settings API] Language value sent to DB:', languageToSave);
      
      if (result.rows.length > 0) {
        console.log('[Settings API] Updated record language:', result.rows[0].language);
        console.log('[Settings API] Language match check:', result.rows[0].language === languageToSave);
      }
    } else {
      // Create new record if doesn't exist
      console.log('[Settings API] Creating new record...');
      result = await db.query(
        `INSERT INTO settings (printer_config, language, other_app_settings, shop_id)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [
          printer_config || null,
          languageToSave,  // CRITICAL: Use validated language value
          JSON.stringify(mergedOtherAppSettings),
          req.shopId
        ]
      );
      console.log('[Settings API] Insert query executed, new ID:', result.rows[0]?.id);
      console.log('[Settings API] Language value sent to DB:', languageToSave);
      
      if (result.rows.length > 0) {
        console.log('[Settings API] Inserted record language:', result.rows[0].language);
        console.log('[Settings API] Language match check:', result.rows[0].language === languageToSave);
      }
    }

    if (result.rows.length === 0) {
      console.error('[Settings API] No rows returned from update/insert!');
      throw new Error('Failed to update or create settings record');
    }

    const updatedSettings = result.rows[0];
    console.log('[Settings API] Update successful:', {
      id: updatedSettings.id,
      language: updatedSettings.language,
      language_type: typeof updatedSettings.language,
      language_length: updatedSettings.language?.length,
      has_printer_config: !!updatedSettings.printer_config,
      has_other_app_settings: !!updatedSettings.other_app_settings
    });

    // Verify the update - query directly from database
    const verifyResult = await db.query('SELECT language FROM settings WHERE id = $1 AND shop_id = $2', [updatedSettings.id, req.shopId]);
    const verifiedLanguage = verifyResult.rows[0]?.language;
    console.log('[Settings API] Verification query - language from DB:', verifiedLanguage);
    console.log('[Settings API] Verification query - language type:', typeof verifiedLanguage);
    console.log('[Settings API] Expected language:', languageToSave);
    console.log('[Settings API] Original language from request:', language);
    console.log('[Settings API] Language match:', verifiedLanguage === languageToSave);
    
    // CRITICAL: If language doesn't match, log warning
    if (verifiedLanguage !== languageToSave) {
      console.error('[Settings API] ⚠️ LANGUAGE MISMATCH IN DATABASE!');
      console.error('[Settings API] Expected:', languageToSave);
      console.error('[Settings API] Got from DB:', verifiedLanguage);
      console.error('[Settings API] Updated record shows:', updatedSettings.language);
    } else {
      console.log('[Settings API] ✅ Language saved correctly to database');
    }
    
    // CRITICAL: Ensure response contains the correct language
    updatedSettings.language = verifiedLanguage || languageToSave;
    console.log('[Settings API] Response language set to:', updatedSettings.language);
    
    console.log('[Settings API] ===== UPDATE REQUEST SUCCESS =====');
    res.json(updatedSettings);
  } catch (error) {
    console.error('[Settings API] ===== UPDATE REQUEST ERROR =====');
    console.error('[Settings API] Error:', error);
    console.error('[Settings API] Error message:', error.message);
    console.error('[Settings API] Error stack:', error.stack);
    console.error('[Settings API] ===== END ERROR =====');
    
    res.status(500).json({ 
      error: 'Failed to update settings', 
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

module.exports = router;

