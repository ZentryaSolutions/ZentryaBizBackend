const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, isElevatedRole } = require('../middleware/authMiddleware');
const { requireShopContext } = require('../middleware/shopContextMiddleware');

// All notification routes require authentication
router.use(requireAuth);
router.use(requireShopContext);

/**
 * Helper function to create a new notification
 * Can be called internally by other modules (e.g., sales, inventory)
 * @param {Object} notificationData
 * @param {number|null} notificationData.userId - User ID to notify (null for all admins)
 * @param {string} notificationData.title
 * @param {string} notificationData.message
 * @param {string} [notificationData.type='info'] - 'info', 'warning', 'error', 'success'
 * @param {string} [notificationData.link]
 * @param {Object} [notificationData.metadata]
 */
async function createNotification({
  userId,
  title,
  message,
  type = 'info',
  link = null,
  metadata = null,
  shopId = null,
}) {
  try {
    const resolvedShopId = shopId || metadata?.shopId || null;
    try {
      await db.query(
        `INSERT INTO notifications (user_id, title, message, type, link, metadata, shop_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7::uuid)`,
        [userId, title, message, type, link, metadata ? JSON.stringify(metadata) : null, resolvedShopId]
      );
    } catch (insertErr) {
      // Backward compatibility if notifications.shop_id is not migrated yet.
      if (insertErr?.code !== '42703') throw insertErr;
      await db.query(
        `INSERT INTO notifications (user_id, title, message, type, link, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, title, message, type, link, metadata ? JSON.stringify(metadata) : null]
      );
    }
    console.log(`[Notifications] Created notification for user ${userId || 'all admins'}: ${title}`);
  } catch (error) {
    console.error('[Notifications] Error creating notification:', error);
  }
}

// Get all notifications for current user
router.get('/', async (req, res) => {
  try {
    const userId = req.user.user_id;
    const shopId = req.shopId;
    const { limit = 50, offset = 0 } = req.query;
    
    const result = await db.query(
      `SELECT 
        notification_id,
        title,
        message,
        type,
        read,
        created_at,
        link,
        metadata
      FROM notifications
      WHERE (user_id = $1 OR user_id IS NULL)
        AND (
          shop_id = $2::uuid
          OR (shop_id IS NULL AND metadata ? 'shopId' AND metadata->>'shopId' = $2::text)
        )
      ORDER BY created_at DESC
      LIMIT $3 OFFSET $4`,
      [userId, shopId, parseInt(limit), parseInt(offset)]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: 'Failed to fetch notifications', message: error.message });
  }
});

// Get unread count
router.get('/unread-count', async (req, res) => {
  try {
    const userId = req.user.user_id;
    const shopId = req.shopId;
    
    const result = await db.query(
      `SELECT COUNT(*) as count
      FROM notifications
      WHERE (user_id = $1 OR user_id IS NULL)
        AND read = FALSE
        AND (
          shop_id = $2::uuid
          OR (shop_id IS NULL AND metadata ? 'shopId' AND metadata->>'shopId' = $2::text)
        )`,
      [userId, shopId]
    );
    
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (error) {
    console.error('Error fetching unread count:', error);
    res.status(500).json({ error: 'Failed to fetch unread count', message: error.message });
  }
});

// Mark notification as read
router.put('/:id/read', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.user_id; // Corrected from req.user.userId
    const shopId = req.shopId;
    
    await db.query(
      `UPDATE notifications
      SET read = TRUE
      WHERE notification_id = $1
        AND (user_id = $2 OR user_id IS NULL)
        AND (
          shop_id = $3::uuid
          OR (shop_id IS NULL AND metadata ? 'shopId' AND metadata->>'shopId' = $3::text)
        )`,
      [id, userId, shopId]
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ error: 'Failed to mark notification as read', message: error.message });
  }
});

// Mark all notifications as read
router.put('/read-all', async (req, res) => {
  try {
    const userId = req.user.user_id; // Corrected from req.user.userId
    const shopId = req.shopId;
    
    await db.query(
      `UPDATE notifications
      SET read = TRUE
      WHERE (user_id = $1 OR user_id IS NULL)
        AND read = FALSE
        AND (
          shop_id = $2::uuid
          OR (shop_id IS NULL AND metadata ? 'shopId' AND metadata->>'shopId' = $2::text)
        )`,
      [userId, shopId]
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    res.status(500).json({ error: 'Failed to mark all notifications as read', message: error.message });
  }
});

// Create notification (admin/system only - can be called internally)
router.post('/', async (req, res) => {
  try {
    const { user_id, title, message, type = 'info', link = null, metadata = null, shop_id = null } = req.body;
    
    // Only allow admins or system to create notifications
    if (!isElevatedRole(req.user.role) && !req.body.system) {
      return res.status(403).json({ error: 'Only administrators can create notifications' });
    }
    
    const resolvedShopId = shop_id || req.shopId || metadata?.shopId || null;
    let result;
    try {
      result = await db.query(
        `INSERT INTO notifications (user_id, title, message, type, link, metadata, shop_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7::uuid)
        RETURNING *`,
        [user_id || null, title, message, type, link, metadata ? JSON.stringify(metadata) : null, resolvedShopId]
      );
    } catch (insertErr) {
      if (insertErr?.code !== '42703') throw insertErr;
      result = await db.query(
        `INSERT INTO notifications (user_id, title, message, type, link, metadata)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *`,
        [user_id || null, title, message, type, link, metadata ? JSON.stringify(metadata) : null]
      );
    }
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating notification:', error);
    res.status(500).json({ error: 'Failed to create notification', message: error.message });
  }
});

module.exports = { router, createNotification };

