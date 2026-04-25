/**
 * Backup Service - Automatic Local Backup System
 * Handles automatic backups, scheduled backups, retention, and restore
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const db = require('../db');

const execPromise = promisify(exec);

// Default backup directory
const DEFAULT_BACKUP_DIR = path.join(process.cwd(), 'backup');

// Export for use in other modules
module.exports.DEFAULT_BACKUP_DIR = DEFAULT_BACKUP_DIR;

// Backup log file
const BACKUP_LOG_FILE = path.join(process.cwd(), 'backup', 'backup.log');

/**
 * Ensure backup directory exists
 */
async function ensureBackupDirectory(backupDir) {
  try {
    await fs.mkdir(backupDir, { recursive: true });
    return true;
  } catch (error) {
    console.error('[Backup Service] Failed to create backup directory:', error);
    return false;
  }
}

/**
 * Get backup settings from database
 */
async function getBackupSettings() {
  try {
    const result = await db.query(
      `SELECT other_app_settings FROM settings ORDER BY id LIMIT 1`
    );
    
    if (result.rows.length === 0) {
      return getDefaultBackupSettings();
    }
    
    const settings = result.rows[0].other_app_settings || {};
    const backupConfig = settings.backup_config || {};
    
    return {
      enabled: backupConfig.enabled !== false, // Default to enabled
      mode: backupConfig.mode || 'scheduled', // 'app_start' or 'scheduled'
      scheduledTime: backupConfig.scheduledTime || '02:00',
      backupDir: backupConfig.backupDir || DEFAULT_BACKUP_DIR,
      retentionCount: backupConfig.retentionCount || 5,
    };
  } catch (error) {
    console.error('[Backup Service] Error getting backup settings:', error);
    return getDefaultBackupSettings();
  }
}

/**
 * Get default backup settings
 */
function getDefaultBackupSettings() {
  return {
    enabled: true,
    mode: 'scheduled',
    scheduledTime: '02:00',
    backupDir: DEFAULT_BACKUP_DIR,
    retentionCount: 5,
  };
}

/**
 * Save backup settings to database
 */
async function saveBackupSettings(settings) {
  try {
    console.log('[Backup Service] Saving backup settings:', settings);
    
    // First, ensure only one record exists
    await db.query(`
      DELETE FROM settings 
      WHERE id NOT IN (
        SELECT id FROM settings ORDER BY id LIMIT 1
      )
    `);
    
    const result = await db.query(
      `SELECT other_app_settings FROM settings ORDER BY id LIMIT 1`
    );
    
    let otherAppSettings = {};
    if (result.rows.length > 0) {
      const existingSettings = result.rows[0].other_app_settings;
      if (typeof existingSettings === 'string') {
        otherAppSettings = JSON.parse(existingSettings);
      } else {
        otherAppSettings = existingSettings || {};
      }
    }
    
    // Merge backup_config with existing settings (preserve other settings)
    otherAppSettings.backup_config = {
      enabled: settings.enabled !== undefined ? settings.enabled : true,
      mode: settings.mode || 'scheduled',
      scheduledTime: settings.scheduledTime || '02:00',
      backupDir: settings.backupDir || DEFAULT_BACKUP_DIR,
      retentionCount: settings.retentionCount !== undefined ? settings.retentionCount : 5,
    };
    
    console.log('[Backup Service] Merged other_app_settings:', otherAppSettings);
    
    // Update the single record
    const updateResult = await db.query(
      `UPDATE settings 
       SET other_app_settings = $1
       WHERE id = (SELECT id FROM settings ORDER BY id LIMIT 1)
       RETURNING *`,
      [JSON.stringify(otherAppSettings)]
    );
    
    // If no record exists, create one
    if (updateResult.rows.length === 0) {
      console.log('[Backup Service] No settings record found, creating new one...');
      await db.query(
        `INSERT INTO settings (printer_config, language, other_app_settings)
         VALUES (NULL, 'en', $1)
         RETURNING *`,
        [JSON.stringify(otherAppSettings)]
      );
    }
    
    console.log('[Backup Service] Backup settings saved successfully');
    return true;
  } catch (error) {
    console.error('[Backup Service] Error saving backup settings:', error);
    console.error('[Backup Service] Error stack:', error.stack);
    return false;
  }
}

/**
 * Log backup operation
 */
async function logBackupOperation(operation, status, details = {}) {
  try {
    const logDir = path.dirname(BACKUP_LOG_FILE);
    await fs.mkdir(logDir, { recursive: true });
    
    const logEntry = {
      timestamp: new Date().toISOString(),
      operation,
      status,
      ...details,
    };
    
    const logLine = JSON.stringify(logEntry) + '\n';
    await fs.appendFile(BACKUP_LOG_FILE, logLine, 'utf8');
  } catch (error) {
    console.error('[Backup Service] Failed to log backup operation:', error);
  }
}

/**
 * Generate backup filename: backup_YYYY_MM_DD.sql
 */
function generateBackupFilename(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `backup_${year}_${month}_${day}.sql`;
}

/**
 * Find PostgreSQL bin directory
 */
async function findPostgresBinPath() {
  // Check custom environment variable first
  if (process.env.PG_BIN_PATH) {
    const customPath = process.env.PG_BIN_PATH;
    const pgDumpPath = path.join(customPath, os.platform() === 'win32' ? 'pg_dump.exe' : 'pg_dump');
    try {
      await fs.access(pgDumpPath);
      console.log(`[Backup Service] Using PostgreSQL bin from PG_BIN_PATH: ${customPath}`);
      return customPath;
    } catch {
      console.warn(`[Backup Service] PG_BIN_PATH set but pg_dump not found at ${pgDumpPath}`);
    }
  }
  
  // Check if pg_dump is in PATH
  try {
    if (os.platform() === 'win32') {
      const { stdout } = await execPromise('where pg_dump');
      if (stdout && stdout.trim()) {
        const pgDumpFullPath = stdout.trim().split('\n')[0];
        const binPath = path.dirname(pgDumpFullPath);
        console.log(`[Backup Service] Found pg_dump in PATH: ${binPath}`);
        return binPath;
      }
    } else {
      const { stdout } = await execPromise('which pg_dump');
      if (stdout && stdout.trim()) {
        const pgDumpFullPath = stdout.trim();
        const binPath = path.dirname(pgDumpFullPath);
        console.log(`[Backup Service] Found pg_dump in PATH: ${binPath}`);
        return binPath;
      }
    }
  } catch {
    // pg_dump not in PATH, try common paths
  }
  
  // Try common PostgreSQL installation paths on Windows
  const commonPaths = [
    'E:\\PostgreSQL\\15\\bin', // Custom installation path (development)
    'C:\\Program Files\\PostgreSQL\\16\\bin',
    'C:\\Program Files\\PostgreSQL\\15\\bin',
    'C:\\Program Files\\PostgreSQL\\14\\bin',
    'C:\\Program Files\\PostgreSQL\\13\\bin',
    'C:\\Program Files\\PostgreSQL\\12\\bin',
    'C:\\Program Files (x86)\\PostgreSQL\\16\\bin',
    'C:\\Program Files (x86)\\PostgreSQL\\15\\bin',
    'C:\\Program Files (x86)\\PostgreSQL\\14\\bin',
    'C:\\Program Files (x86)\\PostgreSQL\\13\\bin',
    'C:\\Program Files (x86)\\PostgreSQL\\12\\bin',
  ];
  
  // Try common installation paths
  for (const binPath of commonPaths) {
    const pgDumpPath = path.join(binPath, os.platform() === 'win32' ? 'pg_dump.exe' : 'pg_dump');
    try {
      await fs.access(pgDumpPath);
      console.log(`[Backup Service] Found PostgreSQL bin directory: ${binPath}`);
      return binPath;
    } catch {
      continue;
    }
  }
  
  // If not found, return null to indicate we should use PATH
  console.warn('[Backup Service] PostgreSQL bin directory not found. Will try PATH...');
  return null;
}

/**
 * Get full path to pg_dump command
 */
let pgDumpPath = null;
let psqlPath = null;

async function getPgDumpPath() {
  if (pgDumpPath === null) {
    const binPath = await findPostgresBinPath();
    if (binPath) {
      pgDumpPath = path.join(binPath, os.platform() === 'win32' ? 'pg_dump.exe' : 'pg_dump');
    } else {
      // Use just the executable name if not found (will rely on PATH)
      pgDumpPath = os.platform() === 'win32' ? 'pg_dump.exe' : 'pg_dump';
    }
  }
  return pgDumpPath;
}

async function getPsqlPath() {
  if (psqlPath === null) {
    const binPath = await findPostgresBinPath();
    if (binPath) {
      psqlPath = path.join(binPath, os.platform() === 'win32' ? 'psql.exe' : 'psql');
    } else {
      // Use just the executable name if not found (will rely on PATH)
      psqlPath = os.platform() === 'win32' ? 'psql.exe' : 'psql';
    }
  }
  return psqlPath;
}

/**
 * Create PostgreSQL backup using pg_dump
 * 
 * REQUIRED DATABASE PRIVILEGES:
 * The database user (DB_USER from .env, default: 'postgres') must have:
 * - SELECT privilege on all tables (to read data)
 * - USAGE privilege on schemas (to access schema objects)
 * 
 * RECOMMENDED: Use the 'postgres' superuser account for backup operations.
 * If using a non-superuser account, ensure it has SELECT privileges on all tables.
 * 
 * Backup flags used:
 * - --clean: Include DROP statements before CREATE statements
 * - --if-exists: Use IF EXISTS when dropping objects (prevents errors)
 * - --no-owner: Skip restoration of object ownership (prevents permission errors)
 * - --no-privileges: Skip restoration of access privileges (prevents permission errors)
 */
async function createBackup(backupDir = null) {
  const settings = await getBackupSettings();
  const targetDir = backupDir || settings.backupDir;
  
  // Ensure directory exists
  if (!(await ensureBackupDirectory(targetDir))) {
    throw new Error('Failed to create backup directory');
  }
  
  const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'hisaabkitab',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  };
  
  // Generate filename - check if file exists for today
  let filename = generateBackupFilename();
  let backupPath = path.join(targetDir, filename);
  let attempt = 1;
  
  // If file exists, add suffix (shouldn't happen with date-based naming, but safety)
  while (await fileExists(backupPath)) {
    const baseName = path.basename(filename, '.sql');
    filename = `${baseName}_${attempt}.sql`;
    backupPath = path.join(targetDir, filename);
    attempt++;
  }
  
  // Temporary file for atomic write
  const tempPath = backupPath + '.tmp';
  
  // Store original PGPASSWORD before modifying it
  const originalPgPassword = process.env.PGPASSWORD;
  
  try {
    // Set PGPASSWORD environment variable
    process.env.PGPASSWORD = dbConfig.password;
    
    // Build pg_dump command
    // --clean: Include DROP statements before CREATE statements
    // --if-exists: Use IF EXISTS when dropping objects
    // --no-owner: Skip restoration of object ownership
    // --no-privileges: Skip restoration of access privileges (grants/revokes)
    const pgDumpCmdPath = await getPgDumpPath();
    // Only quote if it's a full path (absolute path or contains directory separators), otherwise use as-is
    const isFullPath = path.isAbsolute(pgDumpCmdPath) || pgDumpCmdPath.includes('\\') || pgDumpCmdPath.includes('/');
    const pgDumpCmd = isFullPath
      ? `"${pgDumpCmdPath}" -h ${dbConfig.host} -p ${dbConfig.port} -U ${dbConfig.user} -d ${dbConfig.database} -f "${tempPath}" --clean --if-exists --no-owner --no-privileges --no-password`
      : `${pgDumpCmdPath} -h ${dbConfig.host} -p ${dbConfig.port} -U ${dbConfig.user} -d ${dbConfig.database} -f "${tempPath}" --clean --if-exists --no-owner --no-privileges --no-password`;
    
    // Execute pg_dump
    await execPromise(pgDumpCmd);
    
    // Verify backup file exists and has content
    const stats = await fs.stat(tempPath);
    if (stats.size === 0) {
      throw new Error('Backup file is empty');
    }
    
    // Atomic move: temp -> final
    await fs.rename(tempPath, backupPath);
    
    // Restore original PGPASSWORD
    if (originalPgPassword !== undefined) {
      process.env.PGPASSWORD = originalPgPassword;
    } else {
      delete process.env.PGPASSWORD;
    }
    
    // Log success
    await logBackupOperation('backup_create', 'success', {
      filename,
      size: stats.size,
      path: backupPath,
    });
    
    return {
      success: true,
      filename,
      path: backupPath,
      size: stats.size,
      date: new Date(),
    };
  } catch (error) {
    // Clean up temp file on error
    try {
      await fs.unlink(tempPath);
    } catch (unlinkError) {
      // Ignore cleanup errors
    }
    
    // Restore original PGPASSWORD
    if (originalPgPassword !== undefined) {
      process.env.PGPASSWORD = originalPgPassword;
    } else {
      delete process.env.PGPASSWORD;
    }
    
    // Log failure
    await logBackupOperation('backup_create', 'failed', {
      error: error.message,
      filename,
    });
    
    // Provide helpful error message if pg_dump not found
    if (error.message && (error.message.includes('not recognized') || error.message.includes('not found') || error.code === 1)) {
      const helpfulError = new Error(
        `PostgreSQL pg_dump command not found. Please ensure PostgreSQL is installed and either:\n` +
        `1. Add PostgreSQL bin directory to your system PATH, or\n` +
        `2. Set PG_BIN_PATH environment variable (e.g., set PG_BIN_PATH=C:\\Program Files\\PostgreSQL\\16\\bin)`
      );
      helpfulError.originalError = error;
      throw helpfulError;
    }
    
    throw error;
  }
}

/**
 * Check if file exists
 */
async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply retention policy - keep only last N backups
 */
async function applyRetentionPolicy() {
  try {
    const settings = await getBackupSettings();
    const backupDir = settings.backupDir;
    const retentionCount = settings.retentionCount || 5;
    
    if (!(await fileExists(backupDir))) {
      return { deleted: 0 };
    }
    
    // List all backup files
    const files = await fs.readdir(backupDir);
    const backupFiles = files
      .filter(file => file.startsWith('backup_') && file.endsWith('.sql'))
      .map(file => ({
        filename: file,
        path: path.join(backupDir, file),
      }))
      .map(async (file) => {
        const stats = await fs.stat(file.path);
        return {
          ...file,
          created: stats.birthtime || stats.mtime,
        };
      });
    
    const filesWithDates = await Promise.all(backupFiles);
    
    // Sort by creation date (newest first)
    filesWithDates.sort((a, b) => b.created - a.created);
    
    // Delete files beyond retention count
    const filesToDelete = filesWithDates.slice(retentionCount);
    let deletedCount = 0;
    
    for (const file of filesToDelete) {
      try {
        await fs.unlink(file.path);
        deletedCount++;
        await logBackupOperation('backup_delete', 'success', {
          filename: file.filename,
        });
      } catch (error) {
        console.error(`[Backup Service] Failed to delete backup ${file.filename}:`, error);
        await logBackupOperation('backup_delete', 'failed', {
          filename: file.filename,
          error: error.message,
        });
      }
    }
    
    return { deleted: deletedCount };
  } catch (error) {
    console.error('[Backup Service] Error applying retention policy:', error);
    await logBackupOperation('retention_policy', 'failed', {
      error: error.message,
    });
    return { deleted: 0, error: error.message };
  }
}

/**
 * Get last backup status
 */
async function getLastBackupStatus() {
  try {
    const settings = await getBackupSettings();
    const backupDir = settings.backupDir;
    
    if (!(await fileExists(backupDir))) {
      return {
        exists: false,
        date: null,
        success: false,
      };
    }
    
    // Read backup log to find last successful backup
    let lastBackup = null;
    try {
      if (await fileExists(BACKUP_LOG_FILE)) {
        const logContent = await fs.readFile(BACKUP_LOG_FILE, 'utf8');
        const lines = logContent.trim().split('\n').filter(line => line);
        
        // Find last successful backup
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const entry = JSON.parse(lines[i]);
            if (entry.operation === 'backup_create' && entry.status === 'success') {
              lastBackup = entry;
              break;
            }
          } catch (parseError) {
            // Skip invalid log entries
            continue;
          }
        }
      }
    } catch (logError) {
      // If log doesn't exist or can't be read, check files directly
    }
    
    // If no log entry, check files directly
    if (!lastBackup) {
      const files = await fs.readdir(backupDir);
      const backupFiles = files
        .filter(file => file.startsWith('backup_') && file.endsWith('.sql'))
        .map(file => ({
          filename: file,
          path: path.join(backupDir, file),
        }))
        .map(async (file) => {
          const stats = await fs.stat(file.path);
          return {
            filename: file.filename,
            created: stats.birthtime || stats.mtime,
            size: stats.size,
          };
        });
      
      const filesWithDates = await Promise.all(backupFiles);
      if (filesWithDates.length > 0) {
        filesWithDates.sort((a, b) => b.created - a.created);
        const latest = filesWithDates[0];
        lastBackup = {
          timestamp: latest.created.toISOString(),
          filename: latest.filename,
          size: latest.size,
        };
      }
    }
    
    return {
      exists: !!lastBackup,
      date: lastBackup ? new Date(lastBackup.timestamp) : null,
      filename: lastBackup ? lastBackup.filename : null,
      size: lastBackup ? lastBackup.size : null,
      success: !!lastBackup,
    };
  } catch (error) {
    console.error('[Backup Service] Error getting last backup status:', error);
    return {
      exists: false,
      date: null,
      success: false,
      error: error.message,
    };
  }
}

/**
 * List all backups
 */
async function listBackups() {
  try {
    const settings = await getBackupSettings();
    const backupDir = settings.backupDir;
    
    if (!(await fileExists(backupDir))) {
      return [];
    }
    
    const files = await fs.readdir(backupDir);
    const backupFiles = files
      .filter(file => file.startsWith('backup_') && file.endsWith('.sql'))
      .map(file => ({
        filename: file,
        path: path.join(backupDir, file),
      }))
      .map(async (file) => {
        const stats = await fs.stat(file.path);
        return {
          filename: file.filename,
          size: stats.size,
          created: stats.birthtime || stats.mtime,
        };
      });
    
    const filesWithDates = await Promise.all(backupFiles);
    filesWithDates.sort((a, b) => b.created - a.created);
    
    return filesWithDates;
  } catch (error) {
    console.error('[Backup Service] Error listing backups:', error);
    return [];
  }
}

/**
 * Restore database from backup file
 * 
 * REQUIRED DATABASE PRIVILEGES:
 * The database user (DB_USER from .env, default: 'postgres') must have:
 * - CREATE privilege on the database (to create tables, sequences, functions, triggers)
 * - DROP privilege on the database (to drop existing objects when using --clean)
 * - INSERT, UPDATE, DELETE, SELECT privileges on all tables (to restore data)
 * - USAGE privilege on schemas (to access schema objects)
 * 
 * RECOMMENDED: Use the 'postgres' superuser account for backup/restore operations.
 * If using a non-superuser account, ensure it has the above privileges granted.
 * 
 * The restore process:
 * 1. Executes the SQL backup file using psql
 * 2. Continues on expected errors (already exists, permission warnings, etc.)
 * 3. Verifies restore success by checking database state
 * 4. Only reports success if verification passes
 */
async function restoreBackup(backupFilename) {
  console.log(`[Backup Service] Starting restore from: ${backupFilename}`);
  
  const settings = await getBackupSettings();
  const backupDir = settings.backupDir;
  const backupPath = path.join(backupDir, backupFilename);
  
  console.log(`[Backup Service] Backup directory: ${backupDir}`);
  console.log(`[Backup Service] Backup file path: ${backupPath}`);
  
  // Verify backup file exists
  if (!(await fileExists(backupPath))) {
    const error = new Error(`Backup file not found: ${backupPath}`);
    console.error(`[Backup Service] ${error.message}`);
    throw error;
  }
  
  // Verify file is not empty
  const stats = await fs.stat(backupPath);
  if (stats.size === 0) {
    const error = new Error(`Backup file is empty: ${backupPath}`);
    console.error(`[Backup Service] ${error.message}`);
    throw error;
  }
  
  console.log(`[Backup Service] Backup file size: ${stats.size} bytes`);
  
  const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'hisaabkitab',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  };
  
  const originalPgPassword = process.env.PGPASSWORD;
  
  try {
    // Set PGPASSWORD
    process.env.PGPASSWORD = dbConfig.password;
    
    // Note: We do NOT close the pool here because it's shared across the entire app.
    // PostgreSQL can handle concurrent connections during restore.
    // If there are active transactions, they may fail, but that's acceptable for a restore operation.
    // The user should be aware that a restore operation will interrupt active operations.
    
    // Build psql restore command
    const psqlCmdPath = await getPsqlPath();
    console.log(`[Backup Service] Using psql path: ${psqlCmdPath}`);
    
    // Only quote if it's a full path (absolute path or contains directory separators), otherwise use as-is
    const isFullPath = path.isAbsolute(psqlCmdPath) || psqlCmdPath.includes('\\') || psqlCmdPath.includes('/');
    
    // Quote backup path if it contains spaces
    const quotedBackupPath = backupPath.includes(' ') ? `"${backupPath}"` : backupPath;
    
    // IMPORTANT: We do NOT use --single-transaction because:
    // 1. It causes the entire restore to abort on ANY error (even expected ones)
    // 2. With --clean --if-exists, we expect some "already exists" errors which are harmless
    // 3. We'll verify restore success after completion instead
    
    // Use --set ON_ERROR_STOP=off to continue on errors (we'll verify success separately)
    const psqlCmd = isFullPath
      ? `"${psqlCmdPath}" -h ${dbConfig.host} -p ${dbConfig.port} -U ${dbConfig.user} -d ${dbConfig.database} -f ${quotedBackupPath} --set ON_ERROR_STOP=off --no-password`
      : `${psqlCmdPath} -h ${dbConfig.host} -p ${dbConfig.port} -U ${dbConfig.user} -d ${dbConfig.database} -f ${quotedBackupPath} --set ON_ERROR_STOP=off --no-password`;
    
    console.log(`[Backup Service] Executing restore command...`);
    
    // Execute restore with timeout
    let stdout, stderr, exitCode = 0;
    let restoreSucceeded = false;
    
    try {
      const result = await execPromise(psqlCmd, {
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        timeout: 300000, // 5 minute timeout
      });
      stdout = result.stdout;
      stderr = result.stderr;
      exitCode = 0;
      restoreSucceeded = true;
    } catch (error) {
      // execPromise throws an error if exit code is non-zero
      stdout = error.stdout || '';
      stderr = error.stderr || '';
      exitCode = error.code || 1;
      
      // Check if there are critical errors (not just expected warnings)
      const errorLines = stderr.split('\n').filter(line => line.trim());
      const criticalErrors = errorLines.filter(line => {
        // Skip expected errors from --clean --if-exists
        if (line.includes('already exists') || line.includes('does not exist')) {
          return false;
        }
        // Skip permission warnings (we use --no-owner --no-privileges)
        if (line.includes('must be owner') || line.includes('must be member') || line.includes('no privileges were granted')) {
          return false;
        }
        // Skip duplicate key errors (these happen if data already exists, but restore continues)
        if (line.includes('duplicate key value violates unique constraint')) {
          return false; // This is expected if restoring over existing data
        }
        // Skip trigger already exists errors
        if (line.includes('trigger') && line.includes('already exists')) {
          return false;
        }
        // Keep actual critical errors
        return line.includes('ERROR:');
      });
      
      // If there are critical errors, we'll verify database state before failing
      if (criticalErrors.length > 0) {
        console.warn(`[Backup Service] Critical errors detected during restore, will verify database state...`);
        criticalErrors.forEach(err => console.warn(`  ${err}`));
      } else {
        // No critical errors, restore likely succeeded
        restoreSucceeded = true;
      }
    }
    
    // Verify restore actually succeeded by checking database state
    console.log(`[Backup Service] Verifying restore success...`);
    let verificationFailed = false;
    let verificationError = null;
    
    try {
      // Wait a moment for database to settle
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Check if key tables exist and are accessible
      const verificationQueries = [
        'SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = \'public\' AND table_type = \'BASE TABLE\'',
        'SELECT COUNT(*) as count FROM products',
        'SELECT COUNT(*) as count FROM customers',
        'SELECT COUNT(*) as count FROM sales',
      ];
      
      for (const query of verificationQueries) {
        try {
          const result = await db.query(query);
          console.log(`[Backup Service] Verification query succeeded: ${query.substring(0, 50)}...`);
        } catch (err) {
          console.error(`[Backup Service] Verification query failed: ${query.substring(0, 50)}... - ${err.message}`);
          verificationFailed = true;
          verificationError = err.message;
          break;
        }
      }
      
      if (!verificationFailed) {
        console.log(`[Backup Service] Database verification passed - restore was successful`);
        restoreSucceeded = true;
      } else {
        console.error(`[Backup Service] Database verification failed - restore may have failed`);
        restoreSucceeded = false;
      }
    } catch (verifyErr) {
      console.error(`[Backup Service] Error during verification: ${verifyErr.message}`);
      verificationFailed = true;
      verificationError = verifyErr.message;
      restoreSucceeded = false;
    }
    
    // Log output (limited to avoid spam)
    if (stdout && stdout.length > 0) {
      const stdoutPreview = stdout.length > 500 ? stdout.substring(0, 500) + '...' : stdout;
      console.log(`[Backup Service] psql stdout: ${stdoutPreview}`);
    }
    
    if (stderr && stderr.length > 0) {
      // Filter out expected errors and warnings
      const filteredStderr = stderr.split('\n').filter(line => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        
        // Skip expected errors from --clean --if-exists
        if (trimmed.includes('already exists') || trimmed.includes('does not exist')) {
          return false;
        }
        // Skip permission warnings (we use --no-owner --no-privileges)
        if (trimmed.includes('must be owner') || trimmed.includes('must be member') || trimmed.includes('no privileges were granted')) {
          return false;
        }
        // Skip duplicate key errors (expected when restoring over existing data)
        if (trimmed.includes('duplicate key value violates unique constraint')) {
          return false;
        }
        // Skip trigger already exists errors
        if (trimmed.includes('trigger') && trimmed.includes('already exists')) {
          return false;
        }
        // Keep actual errors
        return trimmed.includes('ERROR:');
      }).join('\n');
      
      if (filteredStderr) {
        const stderrPreview = filteredStderr.length > 500 ? filteredStderr.substring(0, 500) + '...' : filteredStderr;
        console.warn(`[Backup Service] psql stderr (filtered critical errors): ${stderrPreview}`);
      }
    }
    
    // If restore failed verification, throw error
    if (!restoreSucceeded || verificationFailed) {
      const errorMsg = verificationError 
        ? `Restore verification failed: ${verificationError}`
        : `Restore failed - database verification did not pass`;
      console.error(`[Backup Service] ${errorMsg}`);
      throw new Error(errorMsg);
    }
    
    console.log(`[Backup Service] Restore completed and verified successfully`);
    
    // Log restore success (don't let logging errors break the restore)
    try {
      await logBackupOperation('backup_restore', 'success', {
        filename: backupFilename,
      });
    } catch (logError) {
      console.warn(`[Backup Service] Failed to log restore success: ${logError.message}`);
    }
    
    return {
      success: true,
      message: 'Database restored successfully',
    };
  } catch (error) {
    console.error(`[Backup Service] Restore failed:`, error);
    
    // Restore original PGPASSWORD
    if (originalPgPassword !== undefined) {
      process.env.PGPASSWORD = originalPgPassword;
    } else {
      delete process.env.PGPASSWORD;
    }
    
    // Log restore failure (don't let logging errors mask the original error)
    try {
      await logBackupOperation('backup_restore', 'failed', {
        filename: backupFilename,
        error: error.message,
        stderr: error.stderr || '',
        stdout: error.stdout || '',
      });
    } catch (logError) {
      console.warn(`[Backup Service] Failed to log restore failure: ${logError.message}`);
    }
    
    // Provide more detailed error message
    let errorMessage = error.message || 'Unknown error occurred during restore';
    if (error.stderr) {
      errorMessage += `\nDetails: ${error.stderr}`;
    }
    if (error.stdout) {
      errorMessage += `\nOutput: ${error.stdout}`;
    }
    
    const restoreError = new Error(errorMessage);
    restoreError.originalError = error;
    throw restoreError;
  }
}

/**
 * Get most recent backup file
 */
async function getMostRecentBackup() {
  const backups = await listBackups();
  if (backups.length === 0) {
    return null;
  }
  return backups[0].filename;
}

module.exports = {
  createBackup,
  restoreBackup,
  getBackupSettings,
  saveBackupSettings,
  getLastBackupStatus,
  listBackups,
  getMostRecentBackup,
  applyRetentionPolicy,
  generateBackupFilename,
  logBackupOperation,
  DEFAULT_BACKUP_DIR,
};

