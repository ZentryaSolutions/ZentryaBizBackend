/**
 * Backup Scheduler - Handles automatic backups on app start and scheduled times
 */

const backupService = require('./backupService');
const cron = require('node-cron');

let scheduledJob = null;

/**
 * Parse time string (HH:mm) and return cron expression for daily execution
 */
function getCronExpression(timeString) {
  const [hours, minutes] = timeString.split(':').map(Number);
  return `${minutes} ${hours} * * *`; // cron: minute hour day month dayOfWeek
}

/**
 * Schedule daily backup
 */
function scheduleDailyBackup(timeString) {
  // Cancel existing job if any
  if (scheduledJob) {
    scheduledJob.stop();
    scheduledJob = null;
  }
  
  try {
    const cronExpression = getCronExpression(timeString);
    
    scheduledJob = cron.schedule(cronExpression, async () => {
      console.log(`[Backup Scheduler] Scheduled backup triggered at ${timeString}`);
      
      try {
        const settings = await backupService.getBackupSettings();
        
        // Only backup if enabled and mode is scheduled
        if (settings.enabled && settings.mode === 'scheduled') {
          await backupService.createBackup();
          await backupService.applyRetentionPolicy();
          console.log('[Backup Scheduler] Scheduled backup completed successfully');
        } else {
          console.log('[Backup Scheduler] Scheduled backup skipped (disabled or wrong mode)');
        }
      } catch (error) {
        console.error('[Backup Scheduler] Scheduled backup failed:', error);
        await backupService.logBackupOperation('scheduled_backup', 'failed', {
          error: error.message,
        });
      }
    }, {
      scheduled: true,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Karachi',
    });
    
    console.log(`[Backup Scheduler] Daily backup scheduled for ${timeString}`);
    return true;
  } catch (error) {
    console.error('[Backup Scheduler] Failed to schedule backup:', error);
    return false;
  }
}

/**
 * Initialize backup scheduler based on settings
 */
async function initializeScheduler() {
  try {
    const settings = await backupService.getBackupSettings();
    
    if (settings.enabled && settings.mode === 'scheduled') {
      scheduleDailyBackup(settings.scheduledTime);
    }
    
    return true;
  } catch (error) {
    console.error('[Backup Scheduler] Failed to initialize scheduler:', error);
    return false;
  }
}

/**
 * Update scheduler when settings change
 */
async function updateScheduler() {
  try {
    const settings = await backupService.getBackupSettings();
    
    if (settings.enabled && settings.mode === 'scheduled') {
      scheduleDailyBackup(settings.scheduledTime);
    } else {
      // Stop scheduler if disabled or mode changed
      if (scheduledJob) {
        scheduledJob.stop();
        scheduledJob = null;
        console.log('[Backup Scheduler] Scheduler stopped');
      }
    }
    
    return true;
  } catch (error) {
    console.error('[Backup Scheduler] Failed to update scheduler:', error);
    return false;
  }
}

/**
 * Perform backup on app start (if enabled and mode is app_start)
 */
async function performStartupBackup() {
  try {
    const settings = await backupService.getBackupSettings();
    
    if (settings.enabled && settings.mode === 'app_start') {
      console.log('[Backup Scheduler] Performing startup backup...');
      
      try {
        await backupService.createBackup();
        await backupService.applyRetentionPolicy();
        console.log('[Backup Scheduler] Startup backup completed successfully');
      } catch (error) {
        console.error('[Backup Scheduler] Startup backup failed:', error);
        await backupService.logBackupOperation('startup_backup', 'failed', {
          error: error.message,
        });
      }
    } else {
      console.log('[Backup Scheduler] Startup backup skipped (disabled or wrong mode)');
    }
  } catch (error) {
    console.error('[Backup Scheduler] Error checking startup backup settings:', error);
  }
}

/**
 * Stop scheduler
 */
function stopScheduler() {
  if (scheduledJob) {
    scheduledJob.stop();
    scheduledJob = null;
    console.log('[Backup Scheduler] Scheduler stopped');
  }
}

module.exports = {
  initializeScheduler,
  updateScheduler,
  performStartupBackup,
  stopScheduler,
  scheduleDailyBackup,
};






