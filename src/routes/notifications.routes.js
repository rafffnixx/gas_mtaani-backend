// 📁 backend/src/routes/notifications.routes.js

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth.middleware');
const svc = require('../services/notificationService');

router.use(authenticate);

// GET /api/notifications
router.get('/', async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const unreadOnly = req.query.unread === 'true';
    const items = await svc.listNotifications(userId, { limit, unreadOnly });

    // Normalize for the mobile app
    const normalized = items.map((n) => ({
      id: n.id,
      title: n.title,
      body: n.message,
      type: n.type,                                // 'order' | 'payment' | 'system' | 'promotion'
      event: n.data?.event,                        // 'order_accepted', 'payment_received', ...
      payload: n.data || {},
      read: n.is_read,
      created_at: n.created_at,
      threadId: n.data?.params?.threadId,
      orderId: n.data?.params?.orderId,
    }));

    res.json(normalized);
  } catch (err) {
    console.error('GET /notifications error:', err);
    res.status(500).json({ error: 'Failed to load notifications' });
  }
});

// GET /api/notifications/unread-count
router.get('/unread-count', async (req, res) => {
  try {
    const count = await svc.unreadCount(req.user.id);
    res.json({ count });
  } catch (err) {
    console.error('GET /notifications/unread-count error:', err);
    res.status(500).json({ error: 'Failed to load unread count' });
  }
});

// POST /api/notifications/:id/read
router.post('/:id/read', async (req, res) => {
  try {
    const updated = await svc.markRead(req.user.id, req.params.id);
    res.json(updated || { success: true });
  } catch (err) {
    console.error('POST /notifications/:id/read error:', err);
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

// POST /api/notifications/read-all
router.post('/read-all', async (req, res) => {
  try {
    await svc.markAllRead(req.user.id);
    res.json({ success: true });
  } catch (err) {
    console.error('POST /notifications/read-all error:', err);
    res.status(500).json({ error: 'Failed to mark all as read' });
  }
});

module.exports = router;