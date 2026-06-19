const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, isElevatedRole } = require('../middleware/authMiddleware');
const { requireShopContext } = require('../middleware/shopContextMiddleware');
const {
  lockShopDocumentNumbers,
  generateSupportTicketNumber,
} = require('../lib/documentNumbers');

router.use(requireAuth);
router.use(requireShopContext);

const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function normalizeRoleKey(role) {
  return String(role || '')
    .trim()
    .toLowerCase();
}

async function isShopAdminForRequest(req) {
  if (isElevatedRole(req.user?.role)) return true;

  try {
    const uidResult = await db.query(
      `SELECT zb_profile_id FROM users WHERE user_id = $1 AND is_active = true`,
      [req.user.user_id]
    );
    const profileId = uidResult.rows[0]?.zb_profile_id;
    if (!profileId) return false;

    const mem = await db.query(
      `SELECT role::text AS role FROM shop_users WHERE shop_id = $1::uuid AND user_id = $2::uuid`,
      [req.shopId, profileId]
    );
    const m = normalizeRoleKey(mem.rows[0]?.role);
    if (m === 'owner' || m === 'admin') return true;

    const shopOwner = await db.query(
      `SELECT owner_id::text AS oid FROM public.shops WHERE id = $1::uuid`,
      [req.shopId]
    );
    const oid = shopOwner.rows[0]?.oid;
    return oid && String(oid).toLowerCase() === String(profileId).toLowerCase();
  } catch {
    return false;
  }
}

function stripBase64Payload(data) {
  const raw = String(data || '').trim();
  if (!raw) return '';
  const idx = raw.indexOf('base64,');
  if (idx >= 0) return raw.slice(idx + 7);
  return raw;
}

function estimateBase64Bytes(b64) {
  return Math.floor((b64.length * 3) / 4);
}

function parseImages(images) {
  if (!Array.isArray(images)) return [];
  const out = [];
  for (let i = 0; i < Math.min(images.length, MAX_IMAGES); i += 1) {
    const row = images[i] || {};
    const mime = String(row.mime_type || row.mimeType || 'image/jpeg')
      .trim()
      .toLowerCase();
    if (!ALLOWED_MIME.has(mime)) {
      throw new Error(`Image ${i + 1}: only JPEG, PNG, WebP or GIF allowed`);
    }
    const payload = stripBase64Payload(row.data_base64 || row.dataBase64 || row.data);
    if (!payload) continue;
    const bytes = estimateBase64Bytes(payload);
    if (bytes > MAX_IMAGE_BYTES) {
      throw new Error(`Image ${i + 1} is too large (max 1.5 MB each)`);
    }
    out.push({
      file_name: String(row.file_name || row.fileName || `screenshot-${i + 1}.jpg`).slice(0, 200),
      mime_type: mime,
      image_data: payload,
      sort_order: i,
    });
  }
  return out;
}

function mapListRow(row) {
  return {
    ticket_id: row.ticket_id,
    ticket_number: row.ticket_number,
    heading: row.heading,
    description: row.description,
    status: row.status,
    status_label: row.status === 'resolved' ? 'Resolved' : 'Not resolved',
    created_by_user_id: row.created_by_user_id,
    created_by_name: row.created_by_name,
    created_by_role: row.created_by_role,
    created_at: row.created_at,
    updated_at: row.updated_at,
    resolved_at: row.resolved_at,
    resolved_by_user_id: row.resolved_by_user_id,
    resolved_by_name: row.resolved_by_name || '',
    resolved_by_role: row.resolved_by_role || '',
    image_count: Number(row.image_count) || 0,
    message_count: Number(row.message_count) || 0,
  };
}

function mapMessageRow(row) {
  return {
    message_id: row.message_id,
    ticket_id: row.ticket_id,
    sender_user_id: row.sender_user_id,
    sender_name: row.sender_name,
    sender_role: row.sender_role,
    sender_kind: row.sender_kind,
    body: row.body,
    created_at: row.created_at,
    is_mine: row.is_mine === true,
  };
}

/** Load ticket in this shop (any staff member with shop access) */
async function loadTicketForRequest(req, ticketId) {
  const hdr = await db.query(
    `SELECT t.*
     FROM support_tickets t
     WHERE t.ticket_id = $1 AND t.shop_id = $2`,
    [ticketId, req.shopId]
  );
  if (!hdr.rows.length) {
    const err = new Error('Ticket not found');
    err.status = 404;
    throw err;
  }
  return hdr.rows[0];
}

/** List tickets — all staff in the active shop see every ticket for that shop */
router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT t.*,
              (SELECT COUNT(*)::int FROM support_ticket_images i WHERE i.ticket_id = t.ticket_id) AS image_count,
              (SELECT COUNT(*)::int FROM support_ticket_messages m WHERE m.ticket_id = t.ticket_id) AS message_count
       FROM support_tickets t
       WHERE t.shop_id = $1
       ORDER BY t.created_at DESC, t.ticket_id DESC`,
      [req.shopId]
    );

    res.json(result.rows.map(mapListRow));
  } catch (error) {
    if (error.code === '42P01') {
      return res.status(503).json({
        error: 'Support tickets not available',
        message: 'Run database/migrations/017_support_tickets.sql in Supabase.',
      });
    }
    console.error('[support-tickets] list', error);
    res.status(500).json({ error: 'Failed to load support tickets', message: error.message });
  }
});

/** Ticket detail + images */
router.get('/:id', async (req, res) => {
  try {
    const ticketId = parseInt(req.params.id, 10);
    if (Number.isNaN(ticketId)) {
      return res.status(400).json({ error: 'Invalid ticket id' });
    }

    const row = await loadTicketForRequest(req, ticketId);

    const imgs = await db.query(
      `SELECT image_id, file_name, mime_type, sort_order, created_at, image_data
       FROM support_ticket_images
       WHERE ticket_id = $1
       ORDER BY sort_order ASC, image_id ASC`,
      [ticketId]
    );

    const images = imgs.rows.map((img) => ({
      image_id: img.image_id,
      file_name: img.file_name,
      mime_type: img.mime_type,
      sort_order: img.sort_order,
      data_url: `data:${img.mime_type};base64,${img.image_data}`,
    }));

    res.json({
      ...mapListRow({ ...row, image_count: images.length }),
      images,
    });
  } catch (error) {
    if (error.status === 404) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    if (error.status === 403) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (error.code === '42P01') {
      return res.status(503).json({
        error: 'Support tickets not available',
        message: 'Run database/migrations/017_support_tickets.sql in Supabase.',
      });
    }
    console.error('[support-tickets] detail', error);
    res.status(500).json({ error: 'Failed to load ticket', message: error.message });
  }
});

/** Submit a new support ticket */
router.post('/', async (req, res) => {
  const client = await db.getClient();
  try {
    const heading = String(req.body?.heading || '').trim();
    const description = String(req.body?.description || '').trim();
    if (heading.length < 3) {
      return res.status(400).json({ error: 'Problem heading is required (at least 3 characters).' });
    }
    if (description.length < 10) {
      return res.status(400).json({ error: 'Problem description is required (at least 10 characters).' });
    }

    let imageRows;
    try {
      imageRows = parseImages(req.body?.images);
    } catch (imgErr) {
      return res.status(400).json({ error: imgErr.message });
    }

    const createdByName = String(req.user?.name || req.user?.username || 'User').trim();
    const createdByRole = String(req.user?.role || 'staff').trim();

    await client.query('BEGIN');
    await lockShopDocumentNumbers(client, req.shopId);
    const ticketNumber = await generateSupportTicketNumber(req.shopId, client);
    const ins = await client.query(
      `INSERT INTO support_tickets (
         shop_id, ticket_number, created_by_user_id, created_by_name, created_by_role,
         heading, description, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'open')
       RETURNING *`,
      [
        req.shopId,
        ticketNumber,
        req.user.user_id,
        createdByName,
        createdByRole,
        heading,
        description,
      ]
    );
    const ticket = ins.rows[0];

    for (const img of imageRows) {
      await client.query(
        `INSERT INTO support_ticket_images (ticket_id, file_name, mime_type, image_data, sort_order)
         VALUES ($1,$2,$3,$4,$5)`,
        [ticket.ticket_id, img.file_name, img.mime_type, img.image_data, img.sort_order]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({
      ...mapListRow({ ...ticket, image_count: imageRows.length }),
      message: `Support ticket ${ticketNumber} submitted.`,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '42P01') {
      return res.status(503).json({
        error: 'Support tickets not available',
        message: 'Run database/migrations/017_support_tickets.sql in Supabase.',
      });
    }
    console.error('[support-tickets] create', error);
    res.status(500).json({ error: 'Failed to submit ticket', message: error.message });
  } finally {
    client.release();
  }
});

/** Chat messages for one ticket (shop + ticket scoped) */
router.get('/:id/messages', async (req, res) => {
  try {
    const ticketId = parseInt(req.params.id, 10);
    if (Number.isNaN(ticketId)) {
      return res.status(400).json({ error: 'Invalid ticket id' });
    }

    await loadTicketForRequest(req, ticketId);

    const result = await db.query(
      `SELECT message_id, ticket_id, sender_user_id, sender_name, sender_role, sender_kind, body, created_at
       FROM support_ticket_messages
       WHERE ticket_id = $1 AND shop_id = $2
       ORDER BY created_at ASC, message_id ASC`,
      [ticketId, req.shopId]
    );

    const uid = req.user.user_id;
    res.json(
      result.rows.map((row) =>
        mapMessageRow({
          ...row,
          is_mine: row.sender_user_id === uid && row.sender_kind === 'shop_staff',
        })
      )
    );
  } catch (error) {
    if (error.status === 404) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    if (error.status === 403) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (error.code === '42P01') {
      return res.status(503).json({
        error: 'Support ticket chat not available',
        message: 'Run database/migrations/020_support_ticket_messages.sql in Supabase.',
      });
    }
    console.error('[support-tickets] messages list', error);
    res.status(500).json({ error: 'Failed to load messages', message: error.message });
  }
});

/** Post a chat message (shop staff only for now) */
router.post('/:id/messages', async (req, res) => {
  try {
    const ticketId = parseInt(req.params.id, 10);
    if (Number.isNaN(ticketId)) {
      return res.status(400).json({ error: 'Invalid ticket id' });
    }

    const body = String(req.body?.body || '').trim();
    if (body.length < 1) {
      return res.status(400).json({ error: 'Message cannot be empty.' });
    }
    if (body.length > 4000) {
      return res.status(400).json({ error: 'Message is too long (max 4000 characters).' });
    }

    await loadTicketForRequest(req, ticketId);

    const senderName = String(req.user?.name || req.user?.username || 'User').trim();
    const senderRole = String(req.user?.role || 'staff').trim();

    const ins = await db.query(
      `INSERT INTO support_ticket_messages (
         ticket_id, shop_id, sender_user_id, sender_name, sender_role, sender_kind, body
       ) VALUES ($1, $2, $3, $4, $5, 'shop_staff', $6)
       RETURNING message_id, ticket_id, sender_user_id, sender_name, sender_role, sender_kind, body, created_at`,
      [ticketId, req.shopId, req.user.user_id, senderName, senderRole, body]
    );

    res.status(201).json(
      mapMessageRow({
        ...ins.rows[0],
        is_mine: true,
      })
    );
  } catch (error) {
    if (error.status === 404) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    if (error.status === 403) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (error.code === '42P01') {
      return res.status(503).json({
        error: 'Support ticket chat not available',
        message: 'Run database/migrations/020_support_ticket_messages.sql in Supabase.',
      });
    }
    console.error('[support-tickets] message create', error);
    res.status(500).json({ error: 'Failed to send message', message: error.message });
  }
});

/** Mark ticket resolved (or reopen) — same access rules as ticket detail */
async function updateTicketStatusHandler(req, res) {
  try {
    const ticketId = parseInt(req.params.id, 10);
    if (Number.isNaN(ticketId)) {
      return res.status(400).json({ error: 'Invalid ticket id' });
    }

    const status = String(req.body?.status || 'resolved').trim().toLowerCase();
    if (!['resolved', 'open'].includes(status)) {
      return res.status(400).json({ error: 'Status must be resolved or open' });
    }

    await loadTicketForRequest(req, ticketId);

    const adminView = await isShopAdminForRequest(req);
    if (!adminView) {
      return res.status(403).json({ error: 'Only shop administrators can change ticket status.' });
    }

    const resolverName = String(req.user?.name || req.user?.username || 'User').trim();
    const resolverRole = String(req.user?.role || 'staff').trim();

    let result;
    try {
      result = await db.query(
        `UPDATE support_tickets
            SET status = $1,
                resolved_at = CASE WHEN $1 = 'resolved' THEN now() ELSE NULL END,
                resolved_by_user_id = CASE WHEN $1 = 'resolved' THEN $2 ELSE NULL END,
                resolved_by_name = CASE WHEN $1 = 'resolved' THEN $3 ELSE NULL END,
                resolved_by_role = CASE WHEN $1 = 'resolved' THEN $4 ELSE NULL END,
                updated_at = now()
          WHERE ticket_id = $5 AND shop_id = $6::uuid
          RETURNING *`,
        [status, req.user.user_id, resolverName, resolverRole, ticketId, req.shopId]
      );
    } catch (colErr) {
      if (colErr.code === '42703') {
        result = await db.query(
          `UPDATE support_tickets
              SET status = $1,
                  resolved_at = CASE WHEN $1 = 'resolved' THEN now() ELSE NULL END,
                  resolved_by_user_id = CASE WHEN $1 = 'resolved' THEN $2 ELSE NULL END,
                  updated_at = now()
            WHERE ticket_id = $3 AND shop_id = $4::uuid
            RETURNING *`,
          [status, req.user.user_id, ticketId, req.shopId]
        );
      } else {
        throw colErr;
      }
    }

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    const row = result.rows[0];
    const imgs = await db.query(
      `SELECT image_id, file_name, mime_type, sort_order, created_at, image_data
       FROM support_ticket_images WHERE ticket_id = $1 ORDER BY sort_order ASC, image_id ASC`,
      [ticketId]
    );
    const image_count = imgs.rows.length;
    const images = imgs.rows.map((img) => ({
      image_id: img.image_id,
      file_name: img.file_name,
      mime_type: img.mime_type,
      sort_order: img.sort_order,
      data_url: `data:${img.mime_type};base64,${img.image_data}`,
    }));

    res.json({
      ...mapListRow({
        ...row,
        image_count,
        resolved_by_name: row.resolved_by_name || (status === 'resolved' ? resolverName : ''),
        resolved_by_role: row.resolved_by_role || (status === 'resolved' ? resolverRole : ''),
      }),
      images,
      message: status === 'resolved' ? 'Ticket marked as resolved.' : 'Ticket reopened.',
    });
  } catch (error) {
    if (error.status === 404) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    if (error.status === 403) {
      return res.status(403).json({ error: 'Access denied' });
    }
    console.error('[support-tickets] status', error);
    res.status(500).json({
      error: error.message || 'Failed to update ticket status',
      message: error.message,
    });
  }
}

router.patch('/:id/status', updateTicketStatusHandler);
router.post('/:id/status', updateTicketStatusHandler);

module.exports = router;
