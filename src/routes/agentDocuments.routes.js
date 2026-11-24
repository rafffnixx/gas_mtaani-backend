// 📁 backend/src/routes/agentDocuments.routes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { pool } = require('../config/database');
const { authenticate } = require('../middleware/auth.middleware'); // Removed isAgent so unapproved users can upload

// 👈 FIX: Mount directly into the Render project source folder to avoid root permission errors
const uploadDir = '/opt/render/project/src/uploads/agent-documents';

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    const safeType = (req.body.document_type || 'doc').replace(/[^a-z0-9_]/gi, '');
    cb(null, `${req.user.id}_${safeType}_${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|png|jpg|webp)$/i.test(file.mimetype);
    if (!ok) return cb(new Error('Only image files are allowed'));
    cb(null, true);
  },
});

function publicUrlFor(req, filename) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('host');
  return `${proto}://${host}/uploads/agent-documents/${filename}`;
}

// Required doc types — matches mobile DOC_TYPES (required: true)
const REQUIRED_DOC_TYPES = [
  'national_id',
  'business_permit',
  'kra_pin',
  'shop_photo',
];

// =====================================================
// GET /api/agents/documents   (agent's own list)
// =====================================================
router.get('/documents', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, document_type, url, uploaded_at, is_approved, rejection_reason
       FROM agent_documents
       WHERE agent_id = $1
       ORDER BY uploaded_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /agents/documents error:', err);
    res.status(500).json({ error: 'Failed to load documents' });
  }
});

// =====================================================
// POST /api/agents/upload-docs
// =====================================================
router.post('/upload-docs', authenticate, upload.single('file'), async (req, res) => {
  try {
    const agentId = req.user.id;
    const { document_type } = req.body;

    if (!document_type) return res.status(400).json({ error: 'document_type is required' });
    if (!req.file) return res.status(400).json({ error: 'file is required' });

    const publicUrl = publicUrlFor(req, req.file.filename);

    // Re-upload resets approval — a new file must be re-reviewed.
    const result = await pool.query(
      `INSERT INTO agent_documents (agent_id, document_type, url, is_approved)
       VALUES ($1, $2, $3, false)
       ON CONFLICT (agent_id, document_type)
       DO UPDATE SET
         url              = EXCLUDED.url,
         uploaded_at      = NOW(),
         is_approved      = false,
         rejection_reason = NULL
       RETURNING id, document_type, url, uploaded_at, is_approved`,
      [agentId, document_type, publicUrl]
    );

    // Any re-upload on a previously approved agent puts them back into review.
    await pool.query(`UPDATE agents SET is_approved = false WHERE id = $1`, [agentId]);

    res.json(result.rows[0]);
  } catch (err) {
    console.error('POST /agents/upload-docs error:', err);
    res.status(500).json({ error: err.message || 'Failed to upload document' });
  }
});

// =====================================================
// POST /api/agents/submit-application
// =====================================================
router.post('/submit-application', authenticate, async (req, res) => {
  try {
    const agentId = req.user.id;

    const docsRes = await pool.query(
      `SELECT document_type FROM agent_documents WHERE agent_id = $1`,
      [agentId]
    );
    const uploadedTypes = docsRes.rows.map((d) => d.document_type);
    const missing = REQUIRED_DOC_TYPES.filter((t) => !uploadedTypes.includes(t));

    if (missing.length > 0) {
      return res.status(400).json({
        error: `Missing required documents: ${missing.map((m) => m.replace(/_/g, ' ')).join(', ')}`,
      });
    }

    // Require a location so admin has something to review
    const loc = await pool.query(`SELECT location FROM agents WHERE id = $1`, [agentId]);
    if (!loc.rows[0]?.location) {
      return res.status(400).json({
        error: 'Please set your business location before submitting your application',
      });
    }

    await pool.query(
      `UPDATE agents
       SET verification_status    = 'under_review',
           application_submitted_at = NOW()
       WHERE id = $1`,
      [agentId]
    );

    res.json({ success: true, message: 'Application submitted successfully' });
  } catch (error) {
    console.error('Submit application error:', error);
    res.status(500).json({ error: 'Failed to submit application' });
  }
});

// =====================================================
// GET /api/agents/:agentId/documents   (Admin only)
// =====================================================
router.get('/:agentId/documents', authenticate, async (req, res) => {
  try {
    if (req.user.user_type !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const result = await pool.query(
      `SELECT id, document_type, url, uploaded_at, is_approved, rejection_reason
       FROM agent_documents
       WHERE agent_id = $1
       ORDER BY uploaded_at DESC`,
      [req.params.agentId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /agents/:agentId/documents error:', err);
    res.status(500).json({ error: 'Failed to load agent documents' });
  }
});

// =====================================================
// PUT /api/agents/:agentId/documents/:docId/approve   (Admin only)
// Body: { is_approved: boolean, rejection_reason?: string }
// =====================================================
router.put('/:agentId/documents/:docId/approve', authenticate, async (req, res) => {
  try {
    if (req.user.user_type !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { agentId, docId } = req.params;
    const { is_approved, rejection_reason = null } = req.body;

    if (typeof is_approved !== 'boolean') {
      return res.status(400).json({ error: 'is_approved must be a boolean' });
    }

    const upd = await pool.query(
      `UPDATE agent_documents
       SET is_approved      = $1,
           rejection_reason = $2
       WHERE id = $3 AND agent_id = $4
       RETURNING id, document_type, url, uploaded_at, is_approved, rejection_reason`,
      [is_approved, is_approved ? null : rejection_reason, docId, agentId]
    );

    if (upd.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Auto-approve agent if every required doc is approved
    const allDocs = await pool.query(
      `SELECT document_type, is_approved FROM agent_documents WHERE agent_id = $1`,
      [agentId]
    );

    const missingOrUnapproved = REQUIRED_DOC_TYPES.filter((t) => {
      const doc = allDocs.rows.find((d) => d.document_type === t);
      return !doc || !doc.is_approved;
    });

    const allApproved = missingOrUnapproved.length === 0;

    await pool.query(
      `UPDATE agents
       SET is_approved         = $1,
           verification_status = $2
       WHERE id = $3`,
      [allApproved, allApproved ? 'approved' : 'under_review', agentId]
    );

    res.json({
      success: true,
      document: upd.rows[0],
      agent_auto_approved: allApproved,
      missing_or_unapproved: missingOrUnapproved,
    });
  } catch (err) {
    console.error('Approve document error:', err);
    res.status(500).json({ error: 'Failed to approve document' });
  }
});

module.exports = router;