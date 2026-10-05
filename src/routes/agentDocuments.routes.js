// 📁 backend/src/routes/agentDocuments.routes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { pool } = require('../config/database');
const { authenticate, isAgent } = require('../middleware/auth.middleware');

// Storage — save uploads under backend/uploads/agent-documents/
const uploadDir = path.join(__dirname, '..', '..', 'uploads', 'agent-documents');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    const safeType = (req.body.document_type || 'doc').replace(/[^a-z0-9_]/gi, '');
    cb(null, `${req.user.id}_${safeType}_${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|png|jpg|webp)$/i.test(file.mimetype);
    if (!ok) return cb(new Error('Only image files are allowed'));
    cb(null, true);
  },
});

// =====================================================
// GET /api/agents/documents
// Lists the current agent's uploaded documents.
// =====================================================
router.get('/', authenticate, isAgent, async (req, res) => {
  try {
    const agentId = req.user.id;
    const result = await pool.query(
      `SELECT id, document_type, url, uploaded_at
       FROM agent_documents
       WHERE agent_id = $1
       ORDER BY uploaded_at DESC`,
      [agentId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /agents/documents error:', err);
    res.status(500).json({ error: 'Failed to load documents' });
  }
});

// =====================================================
// POST /api/agents/upload-docs
// Accepts multipart form-data: { document_type, file }
// Upserts (replaces) any existing doc of the same type.
// =====================================================
router.post('/upload-docs', authenticate, isAgent, upload.single('file'), async (req, res) => {
  try {
    const agentId = req.user.id;
    const { document_type } = req.body;

    if (!document_type) {
      return res.status(400).json({ error: 'document_type is required' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'file is required' });
    }

    // Build a public URL — served by express.static at /uploads
    const relativePath = `/uploads/agent-documents/${req.file.filename}`;
    const publicUrl = `${req.protocol}://${req.get('host')}${relativePath}`;

    const result = await pool.query(
      `INSERT INTO agent_documents (agent_id, document_type, url)
       VALUES ($1, $2, $3)
       ON CONFLICT (agent_id, document_type)
       DO UPDATE SET url = EXCLUDED.url, uploaded_at = NOW()
       RETURNING id, document_type, url, uploaded_at`,
      [agentId, document_type, publicUrl]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('POST /agents/upload-docs error:', err);
    res.status(500).json({ error: err.message || 'Failed to upload document' });
  }
});

module.exports = router;