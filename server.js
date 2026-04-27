const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
// Prefer env.local (dev) then fallback to .env
require('dotenv').config({
  path: fs.existsSync(path.join(__dirname, 'env.local'))
    ? path.join(__dirname, 'env.local')
    : path.join(__dirname, '.env'),
});

const app = express();
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0'; // Listen on all network interfaces for LAN access

// CORS: reflect request origin (works for dev proxy + same-origin production web)
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-device-id', 'x-session-id', 'x-shop-id'],
}));

// Stripe webhook needs raw body for signature verification (must be registered BEFORE express.json()).
const stripeWebhookHandler = require('./routes/stripeWebhook');
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Read-only mode detection middleware
const readOnlyMode = process.env.READ_ONLY_MODE === 'true' || false;

// Middleware to block write operations in read-only mode
const checkReadOnly = (req, res, next) => {
  if (readOnlyMode && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    return res.status(403).json({ 
      error: 'Read-only mode: Write operations are not allowed on client PCs',
      readOnly: true
    });
  }
  next();
};

// Apply read-only check to all routes except health check
app.use((req, res, next) => {
  if (req.path !== '/api/health') {
    checkReadOnly(req, res, next);
  } else {
    next();
  }
});

// Database connection
const db = require('./db');

// Flag set after DB test completes (must not read before bootstrap finishes — avoids race with app.listen)
let dbReady = false;
let runtimeInitPromise = null;

/**
 * Test DB, run migrations, then listen. Previously app.listen ran before testConnection finished,
 * so logs showed "Database: Not Connected" even when Postgres was fine.
 */
async function bootstrap() {
  console.log('[Backend] Testing database connection...');
  dbReady = await db.testConnection(5, 2000);

  if (dbReady) {
    if (process.env.ENABLE_MIGRATIONS !== 'false') {
      try {
        const migrationService = require('./utils/migrationService');
        const result = await migrationService.runMigrations();
        if (result.success) {
          console.log(`[Migration] ✅ Applied: ${result.applied?.length || 0}`);
        } else {
          console.error('[Migration] ❌', result.error);
        }
      } catch (err) {
        console.error('[Migration]', err);
      }
    }

    if (process.env.ENABLE_BACKUP_SCHEDULER === 'true') {
      const backupScheduler = require('./utils/backupScheduler');
      backupScheduler.initializeScheduler().catch(() => {});
      backupScheduler.performStartupBackup().catch(() => {});
    }
  } else {
    console.error('⚠️ Database unavailable — set DATABASE_URL (or DB_*) in backend/.env (see .env.example).');
  }

  if (!dbReady) {
    console.warn(
      '[Backend] ⚠️ No database — /api/* data routes will fail until DATABASE_URL is set (use Supabase Postgres connection string).'
    );
  }

  const server = app.listen(PORT, HOST, () => {
    console.log(`\n[Backend] ✅ HisaabKitab Backend Server running on http://${HOST}:${PORT}`);
    console.log(`[Backend] Mode: ${readOnlyMode ? 'Read-Only (Client PC)' : 'Full Access (Server PC)'}`);
    console.log(`[Backend] Database: ${dbReady ? '✅ Connected' : '❌ Not configured or unreachable'}`);
    if (!readOnlyMode && HOST === '0.0.0.0') {
      console.log(`[Backend] LAN Access: Other PCs can connect using your local IP address`);
      console.log(`[Backend] To find your IP: Run 'ipconfig' on Windows or 'ifconfig' on Linux/Mac\n`);
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[Backend] Port ${PORT} is already in use. Stop the other process (e.g. taskkill /F /PID <pid> on Windows) or set PORT=5001 in backend/.env — do not run "node server.js" twice.`
      );
    } else {
      console.error('[Backend] Server error:', err.message);
    }
    process.exit(1);
  });
}

async function initializeRuntimeOnce() {
  if (!runtimeInitPromise) {
    runtimeInitPromise = (async () => {
      console.log('[Backend] Testing database connection...');
      dbReady = await db.testConnection(5, 2000);

      if (dbReady) {
        if (process.env.ENABLE_MIGRATIONS !== 'false') {
          try {
            const migrationService = require('./utils/migrationService');
            const result = await migrationService.runMigrations();
            if (result.success) {
              console.log(`[Migration] ✅ Applied: ${result.applied?.length || 0}`);
            } else {
              console.error('[Migration] ❌', result.error);
            }
          } catch (err) {
            console.error('[Migration]', err);
          }
        }
      } else {
        console.error('⚠️ Database unavailable — check DATABASE_URL in runtime env.');
      }
    })().catch((err) => {
      console.error('[Backend] Runtime init failed:', err);
      throw err;
    });
  }
  return runtimeInitPromise;
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'HisaabKitab API is running',
    mode: readOnlyMode ? 'read-only' : 'full-access',
    timestamp: new Date().toISOString()
  });
});

// Authentication routes
console.log('[Server] Registering Authentication Routes...');
console.log('[Server] Route: POST /api/auth/login');
console.log('[Server] Route: POST /api/auth/zb-simple-session');
console.log('[Server] Route: POST /api/auth/logout');
console.log('[Server] Route: GET /api/auth/me');
console.log('[Server] Route: POST /api/auth/forgot-password');
console.log('[Server] Route: POST /api/auth/reset-password');
console.log('[Server] Route: POST /api/auth/change-password');
app.use('/api/auth', require('./routes/auth'));

// First-time setup routes
console.log('[Server] Registering Setup Routes...');
console.log('[Server] Route: GET /api/setup/check');
console.log('[Server] Route: POST /api/setup/create-admin');
console.log('[Server] Route: GET /api/setup-auth/check-first-time');
console.log('[Server] Route: POST /api/setup-auth/create-admin');
app.use('/api/setup', require('./routes/setup'));
app.use('/api/setup-auth', require('./routes/setupAuth'));

// Serve React app static files
// Check if build folder exists, serve it if available (for both dev and production)
const buildPath = path.join(__dirname, '../frontend/build');
if (fs.existsSync(buildPath)) {
  app.use(express.static(buildPath));
}

// API routes
app.use('/api/products', require('./routes/products'));
app.use('/api/suppliers', require('./routes/suppliers'));
app.use('/api/sales', require('./routes/sales'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/purchases', require('./routes/purchases'));
app.use('/api/expenses', require('./routes/expenses'));
app.use('/api/customer-payments', require('./routes/customer_payments'));
app.use('/api/supplier-payments', require('./routes/supplier-payments'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/backup', require('./routes/backup'));
app.use('/api/users', require('./routes/users'));
app.use('/api/notifications', require('./routes/notifications').router);
app.use('/api/updates', require('./routes/updates'));
app.use('/api/billing', require('./routes/billing'));
app.use('/api/otp', require('./routes/otp'));

// Catch-all route for React app (must be last, after all API routes)
// This serves index.html for any non-API routes (React Router)
const indexHtmlPath = path.join(__dirname, '../frontend/build', 'index.html');
if (fs.existsSync(indexHtmlPath)) {
  app.get('*', (req, res) => {
    // Only serve index.html for non-API routes
    if (!req.path.startsWith('/api/')) {
      res.sendFile(indexHtmlPath);
    } else {
      res.status(404).json({ error: 'API endpoint not found' });
    }
  });
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    error: 'Something went wrong!',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

if (require.main === module) {
  bootstrap().catch((err) => {
    console.error('[Backend] ❌ Failed to start server:', err);
    process.exit(1);
  });
} else {
  // Serverless runtime (Vercel): do NOT call app.listen()
  initializeRuntimeOnce().catch((err) => {
    console.error('[Backend] ❌ Serverless init failed:', err);
  });
}

module.exports = app;
