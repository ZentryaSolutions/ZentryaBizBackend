const express = require('express');
const router = express.Router();
const backupService = require('../utils/backupService');
const backupScheduler = require('../utils/backupScheduler');
const db = require('../db');

/**
 * Get backup status and settings
 */
router.get('/status', async (req, res) => {
  try {
    const settings = await backupService.getBackupSettings();
    const lastBackup = await backupService.getLastBackupStatus();
    
    res.json({
      success: true,
      settings,
      lastBackup,
    });
  } catch (error) {
    console.error('Error getting backup status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get backup status',
      message: error.message,
    });
  }
});

/**
 * Create manual backup
 */
router.post('/create', async (req, res) => {
  try {
    const result = await backupService.createBackup();
    
    // Apply retention policy after backup
    await backupService.applyRetentionPolicy();
    
    res.json({
      success: true,
      message: 'Backup created successfully',
      filename: result.filename,
      size: result.size,
      date: result.date,
    });
  } catch (error) {
    console.error('Error creating backup:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create backup',
      message: error.message,
    });
  }
});

/**
 * Update backup settings
 */
router.put('/settings', async (req, res) => {
  try {
    console.log('[Backup Route] Update settings request:', req.body);
    
    // Get current settings first to preserve existing values
    const currentSettings = await backupService.getBackupSettings();
    
    const { enabled, mode, scheduledTime, backupDir, retentionCount } = req.body;
    
    // Merge with current settings to preserve values that aren't being updated
    const settings = {
      enabled: enabled !== undefined ? enabled : currentSettings.enabled,
      mode: mode !== undefined ? mode : currentSettings.mode,
      scheduledTime: scheduledTime !== undefined ? scheduledTime : currentSettings.scheduledTime,
      backupDir: backupDir !== undefined ? backupDir : currentSettings.backupDir,
      retentionCount: retentionCount !== undefined ? retentionCount : currentSettings.retentionCount,
    };
    
    console.log('[Backup Route] Merged settings to save:', settings);
    
    const saved = await backupService.saveBackupSettings(settings);
    
    if (saved) {
      console.log('[Backup Route] Settings saved, updating scheduler...');
      
      // Update scheduler
      await backupScheduler.updateScheduler();
      
      console.log('[Backup Route] Scheduler updated successfully');
      
      res.json({
        success: true,
        message: 'Backup settings saved successfully',
        settings,
      });
    } else {
      console.error('[Backup Route] Failed to save backup settings');
      res.status(500).json({
        success: false,
        error: 'Failed to save backup settings',
      });
    }
  } catch (error) {
    console.error('[Backup Route] Error updating backup settings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update backup settings',
      message: error.message,
    });
  }
});

/**
 * List all backups
 */
router.get('/list', async (req, res) => {
  try {
    const backups = await backupService.listBackups();
    res.json({
      success: true,
      backups,
    });
  } catch (error) {
    console.error('Error listing backups:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list backups',
      message: error.message,
    });
  }
});

/**
 * Restore from backup
 */
router.post('/restore', async (req, res) => {
  try {
    const { filename } = req.body;
    
    console.log('[Backup Route] Restore request received:', { filename });
    
    if (!filename) {
      // Get most recent backup
      console.log('[Backup Route] No filename provided, getting most recent backup...');
      const mostRecent = await backupService.getMostRecentBackup();
      
      if (!mostRecent) {
        console.log('[Backup Route] No backup found');
        return res.status(400).json({
          success: false,
          error: 'No backup found to restore',
          message: 'No backup files found. Please create a backup first.',
        });
      }
      
      console.log('[Backup Route] Most recent backup:', mostRecent);
      
      // Restore most recent backup
      await backupService.restoreBackup(mostRecent);
      
      console.log('[Backup Route] Restore completed successfully');
      
      res.json({
        success: true,
        message: 'Database restored successfully. Application will restart.',
        filename: mostRecent,
        restartRequired: true,
      });
    } else {
      // Restore specific backup
      console.log('[Backup Route] Restoring specific backup:', filename);
      
      await backupService.restoreBackup(filename);
      
      console.log('[Backup Route] Restore completed successfully');
      
      res.json({
        success: true,
        message: 'Database restored successfully. Application will restart.',
        filename,
        restartRequired: true,
      });
    }
  } catch (error) {
    console.error('[Backup Route] Error restoring backup:', error);
    console.error('[Backup Route] Error details:', {
      message: error.message,
      stack: error.stack,
      stderr: error.stderr,
      stdout: error.stdout,
    });
    
    res.status(500).json({
      success: false,
      error: 'Failed to restore backup',
      message: error.message || 'An unknown error occurred during restore',
      details: error.stderr || error.stdout || undefined,
    });
  }
});

module.exports = router;
