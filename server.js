// Entry point: express wiring only. Logic lives in lib/, routes in routes/.
const express = require('express');
const path = require('path');
const { loadDb } = require('./lib/store');
const { requireAccess } = require('./lib/auth');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Mount API routes.
app.use('/api', require('./routes/auth'));
app.use('/api', requireAccess);
app.use('/api', require('./routes/dashboard'));
app.use('/api', require('./routes/problems'));
app.use('/api', require('./routes/chat'));
app.use('/api', require('./routes/assignment'));
app.use('/api', require('./routes/playlists'));
app.use('/api', require('./routes/settings'));
app.use('/api', require('./routes/notion'));
app.use('/api', require('./routes/backup'));

loadDb();
const PORT = process.env.PORT || 3210;
app.listen(PORT, () => console.log(`DSA tracker running at http://localhost:${PORT}`));
