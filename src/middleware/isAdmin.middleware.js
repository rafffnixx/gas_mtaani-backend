// backend/src/middleware/isAdmin.middleware.js
const jwt = require('jsonwebtoken');

module.exports = function isAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    if (decoded.user_type !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    req.user = { id: decoded.id, user_type: 'admin' };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};