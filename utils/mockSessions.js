/**
 * In-memory sessions when no DB (Supabase pending).
 * Lets first-time setup + auth middleware work without PostgreSQL.
 */
const { v4: uuidv4 } = require('uuid');

let setupWizardComplete = false;
const sessions = new Map();

function isSetupWizardNeeded() {
  return !setupWizardComplete;
}

function createMockSession(user) {
  setupWizardComplete = true;
  const sessionId = uuidv4();
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 24);
  sessions.set(sessionId, { user, expiresAt });
  return sessionId;
}

function getMockSession(sessionId) {
  const rec = sessions.get(sessionId);
  if (!rec) return null;
  if (rec.expiresAt < new Date()) {
    sessions.delete(sessionId);
    return null;
  }
  return {
    isValid: true,
    user: {
      user_id: rec.user.user_id,
      username: rec.user.username,
      name: rec.user.name,
      role: rec.user.role,
    },
  };
}

function destroyMockSession(sessionId) {
  sessions.delete(sessionId);
}

module.exports = {
  isSetupWizardNeeded,
  createMockSession,
  getMockSession,
  destroyMockSession,
};
