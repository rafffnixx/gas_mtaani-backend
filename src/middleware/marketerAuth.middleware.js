// backend/src/middleware/marketerAuth.middleware.js
const jwt = require('jsonwebtoken');

module.exports = function marketerAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    if (decoded.user_type !== 'marketer') {
      return res.status(403).json({ error: 'Not a marketer account' });
    }
    req.user = { id: decoded.id, user_type: 'marketer' };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};