const path = require('path');

// Load local .env when present. Render supplies these values in its Environment settings.
try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch (error) {
  if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
}

// Both services must use the same SQLite file.
process.env.DATABASE_FILE = process.env.DATABASE_FILE || path.join(__dirname, 'bot', 'keys.db');

require('./api/server.js');
require('./bot/bot.js');
