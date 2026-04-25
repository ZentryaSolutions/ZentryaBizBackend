/**
 * Update Service - Automatic Update Management
 * NOTE: This module runs in the backend (Node.js/Express) ONLY.
 * It MUST NOT depend on Electron-specific modules like `electron-updater`.
 * All installer download/installation logic lives in the Electron main process.
 */

const fs = require('fs').promises;
const path = require('path');
const db = require('../db');
const backupService = require('./backupService');

// Update log file
const UPDATE_LOG_FILE = path.join(process.cwd(), 'updates', 'update.log');

/**
 * Ensure updates directory exists
 */
async function ensureUpdatesDirectory() {
  const updatesDir = path.join(process.cwd(), 'updates');
  try {
    await fs.mkdir(updatesDir, { recursive: true });
    return true;
  } catch (error) {
    console.error('[Update Service] Failed to create updates directory:', error);
    return false;
  }
}

/**
 * Log update operation
 */
async function logUpdateOperation(operation, status, details = {}) {
  try {
    await ensureUpdatesDirectory();
    const timestamp = new Date().toISOString();
    const logLine = `${timestamp} | ${operation} | ${status} | ${JSON.stringify(details)}\n`;
    await fs.appendFile(UPDATE_LOG_FILE, logLine, 'utf8');
  } catch (error) {
    console.error('[Update Service] Failed to log update operation:', error);
  }
}

/**
 * Get update settings from database
 */
async function getUpdateSettings() {
  try {
    const result = await db.query(
      `SELECT other_app_settings FROM settings ORDER BY id LIMIT 1`
    );
    
    if (result.rows.length === 0) {
      return getDefaultUpdateSettings();
    }
    
    const settings = result.rows[0].other_app_settings || {};
    const updateConfig = settings.update_config || {};
    
    return {
      enabled: updateConfig.enabled !== false, // Default to enabled
      autoDownload: updateConfig.autoDownload !== false, // Default to auto-download
      autoInstall: updateConfig.autoInstall !== false, // Default to auto-install
      updateServerUrl: updateConfig.updateServerUrl || 'https://updates.hisaabkitab.com',
      notifyUser: updateConfig.notifyUser !== false, // Default to notify
    };
  } catch (error) {
    console.error('[Update Service] Error getting update settings:', error);
    return getDefaultUpdateSettings();
  }
}

/**
 * Get default update settings
 */
function getDefaultUpdateSettings() {
  return {
    enabled: true,
    autoDownload: true,
    autoInstall: true,
    updateServerUrl: 'https://updates.hisaabkitab.com',
    notifyUser: true,
  };
}

/**
 * Save update settings to database
 */
async function saveUpdateSettings(settings) {
  try {
    const result = await db.query(
      `SELECT id, other_app_settings FROM settings ORDER BY id LIMIT 1`
    );
    
    let otherAppSettings = {};
    if (result.rows.length > 0) {
      otherAppSettings = result.rows[0].other_app_settings || {};
    }
    
    otherAppSettings.update_config = {
      enabled: settings.enabled,
      autoDownload: settings.autoDownload,
      autoInstall: settings.autoInstall,
      updateServerUrl: settings.updateServerUrl,
      notifyUser: settings.notifyUser,
    };
    
    if (result.rows.length > 0) {
      await db.query(
        `UPDATE settings SET other_app_settings = $1 WHERE id = $2`,
        [JSON.stringify(otherAppSettings), result.rows[0].id]
      );
    } else {
      await db.query(
        `INSERT INTO settings (other_app_settings) VALUES ($1)`,
        [JSON.stringify(otherAppSettings)]
      );
    }
    
    await logUpdateOperation('settings_save', 'success', { settings });
  } catch (error) {
    console.error('[Update Service] Error saving update settings:', error);
    await logUpdateOperation('settings_save', 'failed', { error: error.message });
    throw error;
  }
}

/**
 * Ensure backup exists before update
 */
async function ensureBackupBeforeUpdate() {
  try {
    const lastBackup = await backupService.getLastBackupStatus();
    
    if (!lastBackup.exists || !lastBackup.success) {
      console.log('[Update Service] No recent backup found, creating backup before update...');
      await logUpdateOperation('backup_before_update', 'creating', {});
      
      await backupService.createBackup();
      
      await logUpdateOperation('backup_before_update', 'success', {});
      console.log('[Update Service] Backup created successfully before update');
    } else {
      console.log('[Update Service] Recent backup exists, proceeding with update');
      await logUpdateOperation('backup_before_update', 'exists', {
        date: lastBackup.date,
        filename: lastBackup.filename
      });
    }
    
    return true;
  } catch (error) {
    console.error('[Update Service] Failed to ensure backup before update:', error);
    await logUpdateOperation('backup_before_update', 'failed', { error: error.message });
    throw error;
  }
}

/**
 * Get current app version
 */
function getCurrentVersion() {
  const packageJson = require('../../package.json');
  return packageJson.version;
}

/**
 * Get update logs
 */
async function getUpdateLogs(limit = 50) {
  try {
    if (!(await fs.access(UPDATE_LOG_FILE).then(() => true).catch(() => false))) {
      return [];
    }
    
    const logContent = await fs.readFile(UPDATE_LOG_FILE, 'utf8');
    const lines = logContent.trim().split('\n').filter(line => line.trim());
    
    const logs = lines
      .slice(-limit)
      .map(line => {
        const [timestamp, operation, status, detailsJson] = line.split(' | ');
        try {
          const details = JSON.parse(detailsJson || '{}');
          return {
            timestamp: new Date(timestamp),
            operation,
            status,
            details
          };
        } catch (e) {
          return {
            timestamp: new Date(timestamp),
            operation,
            status,
            details: { raw: detailsJson }
          };
        }
      })
      .reverse();
    
    return logs;
  } catch (error) {
    console.error('[Update Service] Error reading update logs:', error);
    return [];
  }
}

module.exports = {
  ensureUpdatesDirectory,
  logUpdateOperation,
  getUpdateSettings,
  saveUpdateSettings,
  ensureBackupBeforeUpdate,
  getCurrentVersion,
  getUpdateLogs,
  getDefaultUpdateSettings,
};


