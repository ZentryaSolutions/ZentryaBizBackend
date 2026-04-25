/**
 * Migration Service - Database Schema Versioning
 * Handles versioned database migrations with transactions and rollback
 */

const fs = require('fs').promises;
const path = require('path');
const db = require('../db');

// Migration directory
const MIGRATIONS_DIR = path.join(__dirname, '../../database/migrations');

// Schema version table name
const SCHEMA_VERSION_TABLE = 'schema_version';

/**
 * Ensure migrations directory exists
 */
async function ensureMigrationsDirectory() {
  try {
    await fs.mkdir(MIGRATIONS_DIR, { recursive: true });
    return true;
  } catch (error) {
    console.error('[Migration Service] Failed to create migrations directory:', error);
    return false;
  }
}

/**
 * Initialize schema version table
 */
async function initializeSchemaVersionTable() {
  try {
    // Check if table exists
    const checkTable = await db.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = '${SCHEMA_VERSION_TABLE}'
      )
    `);
    
    if (!checkTable.rows[0].exists) {
      // Create schema version table
      await db.query(`
        CREATE TABLE ${SCHEMA_VERSION_TABLE} (
          id SERIAL PRIMARY KEY,
          version INTEGER NOT NULL UNIQUE,
          applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          description TEXT,
          success BOOLEAN DEFAULT true
        )
      `);
      
      // Insert initial version (0)
      await db.query(`
        INSERT INTO ${SCHEMA_VERSION_TABLE} (version, description, success)
        VALUES (0, 'Initial schema version', true)
      `);
      
      console.log('[Migration Service] Schema version table initialized');
    }
    
    return true;
  } catch (error) {
    console.error('[Migration Service] Error initializing schema version table:', error);
    throw error;
  }
}

/**
 * Get current schema version from database
 */
async function getCurrentSchemaVersion() {
  try {
    await initializeSchemaVersionTable();
    
    const result = await db.query(`
      SELECT MAX(version) as current_version 
      FROM ${SCHEMA_VERSION_TABLE} 
      WHERE success = true
    `);
    
    return result.rows[0].current_version || 0;
  } catch (error) {
    console.error('[Migration Service] Error getting current schema version:', error);
    return 0;
  }
}

/**
 * Get required schema version from app
 */
async function getRequiredSchemaVersion() {
  try {
    // Read migrations directory and find highest version number
    await ensureMigrationsDirectory();
    
    const files = await fs.readdir(MIGRATIONS_DIR);
    const migrationFiles = files
      .filter(file => file.endsWith('.sql'))
      .map(file => {
        const match = file.match(/^(\d+)_/);
        return match ? parseInt(match[1]) : 0;
      })
      .filter(version => version > 0);
    
    return migrationFiles.length > 0 ? Math.max(...migrationFiles) : 0;
  } catch (error) {
    console.error('[Migration Service] Error getting required schema version:', error);
    return 0;
  }
}

/**
 * Get migration files in order
 */
async function getMigrationFiles() {
  try {
    await ensureMigrationsDirectory();
    
    const files = await fs.readdir(MIGRATIONS_DIR);
    const migrationFiles = files
      .filter(file => file.endsWith('.sql'))
      .map(file => {
        const match = file.match(/^(\d+)_(.+)\.sql$/);
        if (match) {
          return {
            version: parseInt(match[1]),
            filename: file,
            description: match[2].replace(/_/g, ' ')
          };
        }
        return null;
      })
      .filter(file => file !== null)
      .sort((a, b) => a.version - b.version);
    
    return migrationFiles;
  } catch (error) {
    console.error('[Migration Service] Error getting migration files:', error);
    return [];
  }
}

/**
 * Read migration SQL content
 */
async function readMigrationFile(filename) {
  try {
    const filePath = path.join(MIGRATIONS_DIR, filename);
    const content = await fs.readFile(filePath, 'utf8');
    return content;
  } catch (error) {
    console.error(`[Migration Service] Error reading migration file ${filename}:`, error);
    throw error;
  }
}

/**
 * Apply a single migration within a transaction
 */
async function applyMigration(migration) {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');
    
    console.log(`[Migration Service] Applying migration ${migration.version}: ${migration.description}`);
    
    // Read migration SQL
    const sql = await readMigrationFile(migration.filename);
    
    // Execute migration SQL
    await client.query(sql);
    
    // Record migration in schema_version table
    await client.query(`
      INSERT INTO ${SCHEMA_VERSION_TABLE} (version, description, success)
      VALUES ($1, $2, true)
      ON CONFLICT (version) DO UPDATE SET
        applied_at = CURRENT_TIMESTAMP,
        description = EXCLUDED.description,
        success = true
    `, [migration.version, migration.description]);
    
    await client.query('COMMIT');
    
    console.log(`[Migration Service] ✅ Migration ${migration.version} applied successfully`);
    return { success: true, migration };
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`[Migration Service] ❌ Migration ${migration.version} failed:`, error);
    
    // Record failed migration
    try {
      await client.query(`
        INSERT INTO ${SCHEMA_VERSION_TABLE} (version, description, success)
        VALUES ($1, $2, false)
        ON CONFLICT (version) DO UPDATE SET
          applied_at = CURRENT_TIMESTAMP,
          description = EXCLUDED.description,
          success = false
      `, [migration.version, `${migration.description} - FAILED: ${error.message}`]);
    } catch (recordError) {
      console.error('[Migration Service] Error recording failed migration:', recordError);
    }
    
    return { success: false, migration, error: error.message };
  } finally {
    client.release();
  }
}

/**
 * Run all pending migrations
 */
async function runMigrations() {
  try {
    console.log('[Migration Service] Starting migration process...');
    
    await initializeSchemaVersionTable();
    
    const currentVersion = await getCurrentSchemaVersion();
    const migrationFiles = await getMigrationFiles();
    
    // Filter migrations that need to be applied
    const pendingMigrations = migrationFiles.filter(m => m.version > currentVersion);
    
    if (pendingMigrations.length === 0) {
      console.log('[Migration Service] ✅ Database is up to date, no migrations needed');
      return { success: true, applied: [], skipped: migrationFiles.length };
    }
    
    console.log(`[Migration Service] Found ${pendingMigrations.length} pending migration(s)`);
    
    const applied = [];
    const failed = [];
    
    // Apply migrations sequentially
    for (const migration of pendingMigrations) {
      const result = await applyMigration(migration);
      
      if (result.success) {
        applied.push(result.migration);
      } else {
        failed.push(result);
        // Stop on first failure
        console.error(`[Migration Service] ❌ Migration failed, stopping migration process`);
        break;
      }
    }
    
    if (failed.length > 0) {
      return {
        success: false,
        applied,
        failed,
        error: `Migration ${failed[0].migration.version} failed: ${failed[0].error}`
      };
    }
    
    console.log(`[Migration Service] ✅ Successfully applied ${applied.length} migration(s)`);
    return { success: true, applied, failed: [] };
    
  } catch (error) {
    console.error('[Migration Service] Error running migrations:', error);
    return {
      success: false,
      applied: [],
      failed: [],
      error: error.message
    };
  }
}

/**
 * Get migration status
 */
async function getMigrationStatus() {
  try {
    await initializeSchemaVersionTable();
    
    const currentVersion = await getCurrentSchemaVersion();
    const requiredVersion = await getRequiredSchemaVersion();
    const migrationFiles = await getMigrationFiles();
    const pendingMigrations = migrationFiles.filter(m => m.version > currentVersion);
    
    // Get migration history
    const history = await db.query(`
      SELECT version, description, applied_at, success
      FROM ${SCHEMA_VERSION_TABLE}
      ORDER BY version DESC
      LIMIT 20
    `);
    
    return {
      currentVersion,
      requiredVersion,
      isUpToDate: currentVersion >= requiredVersion,
      pendingCount: pendingMigrations.length,
      pendingMigrations: pendingMigrations.map(m => ({
        version: m.version,
        description: m.description
      })),
      history: history.rows
    };
  } catch (error) {
    console.error('[Migration Service] Error getting migration status:', error);
    return {
      currentVersion: 0,
      requiredVersion: 0,
      isUpToDate: false,
      pendingCount: 0,
      pendingMigrations: [],
      history: [],
      error: error.message
    };
  }
}

module.exports = {
  ensureMigrationsDirectory,
  initializeSchemaVersionTable,
  getCurrentSchemaVersion,
  getRequiredSchemaVersion,
  getMigrationFiles,
  applyMigration,
  runMigrations,
  getMigrationStatus,
};


