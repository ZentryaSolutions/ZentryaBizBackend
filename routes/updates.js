/**
 * Updates API Routes
 * Handles update checking, migration status, and update logs
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const updateService = require('../utils/updateService');
const migrationService = require('../utils/migrationService');

// All routes require authentication
router.use(requireAuth);

/**
 * GET /api/updates/status
 * Get update status and current version
 */
router.get('/status', async (req, res) => {
  try {
    const currentVersion = updateService.getCurrentVersion();
    const settings = await updateService.getUpdateSettings();
    const migrationStatus = await migrationService.getMigrationStatus();
    
    res.json({
      success: true,
      currentVersion,
      updateSettings: settings,
      migrationStatus
    });
  } catch (error) {
    console.error('Error getting update status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get update status',
      message: error.message
    });
  }
});

/**
 * GET /api/updates/settings
 * Get update settings
 */
router.get('/settings', async (req, res) => {
  try {
    const settings = await updateService.getUpdateSettings();
    res.json({
      success: true,
      settings
    });
  } catch (error) {
    console.error('Error getting update settings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get update settings',
      message: error.message
    });
  }
});

/**
 * PUT /api/updates/settings
 * Update update settings (admin only)
 */
router.put('/settings', async (req, res) => {
  try {
    const { enabled, autoDownload, autoInstall, updateServerUrl, notifyUser } = req.body;
    
    const settings = {
      enabled: enabled !== undefined ? enabled : true,
      autoDownload: autoDownload !== undefined ? autoDownload : true,
      autoInstall: autoInstall !== undefined ? autoInstall : true,
      updateServerUrl: updateServerUrl || 'https://updates.hisaabkitab.com',
      notifyUser: notifyUser !== undefined ? notifyUser : true,
    };
    
    await updateService.saveUpdateSettings(settings);
    
    res.json({
      success: true,
      message: 'Update settings saved successfully',
      settings
    });
  } catch (error) {
    console.error('Error saving update settings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save update settings',
      message: error.message
    });
  }
});

/**
 * POST /api/updates/ensure-backup
 * Ensure backup exists before update (called before applying update)
 */
router.post('/ensure-backup', async (req, res) => {
  try {
    await updateService.ensureBackupBeforeUpdate();
    
    res.json({
      success: true,
      message: 'Backup verified/created successfully'
    });
  } catch (error) {
    console.error('Error ensuring backup before update:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to ensure backup before update',
      message: error.message
    });
  }
});

/**
 * GET /api/updates/logs
 * Get update logs
 */
router.get('/logs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const logs = await updateService.getUpdateLogs(limit);
    
    res.json({
      success: true,
      logs
    });
  } catch (error) {
    console.error('Error getting update logs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get update logs',
      message: error.message
    });
  }
});

/**
 * GET /api/updates/migration-status
 * Get database migration status
 */
router.get('/migration-status', async (req, res) => {
  try {
    const status = await migrationService.getMigrationStatus();
    
    res.json({
      success: true,
      migrationStatus: status
    });
  } catch (error) {
    console.error('Error getting migration status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get migration status',
      message: error.message
    });
  }
});

/**
 * POST /api/updates/run-migrations
 * Run pending database migrations (admin only)
 */
router.post('/run-migrations', async (req, res) => {
  try {
    // Ensure backup before running migrations
    await updateService.ensureBackupBeforeUpdate();
    
    // Run migrations
    const result = await migrationService.runMigrations();
    
    if (result.success) {
      res.json({
        success: true,
        message: `Successfully applied ${result.applied.length} migration(s)`,
        result
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error || 'Migration failed',
        result
      });
    }
  } catch (error) {
    console.error('Error running migrations:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to run migrations',
      message: error.message
    });
  }
});

module.exports = router;


