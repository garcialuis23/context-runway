'use strict';

const crypto = require('crypto');
const path = require('path');

// A short, readable, collision-safe name for a project directory, e.g.
// "app-1a2b3c4d". Used to name everything context-runway keeps per project
// (handoff notes, resume scripts and plans) outside the project itself.
function projectSlug(cwd) {
  const normalized = path.resolve(cwd || '.').replace(/\\/g, '/').toLowerCase();
  const name = path.basename(normalized).replace(/[^a-z0-9._-]/g, '_') || 'root';
  const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 8);
  return `${name}-${hash}`;
}

module.exports = { projectSlug };
