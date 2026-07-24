const { Router } = require('express');
const { todayStr } = require('../lib/store');
const { buildDashboard } = require('../lib/dashboard');
const videos = require('../lib/videos');

const router = Router();

router.post('/playlists', async (req, res) => {
  const result = await videos.addPlaylist(req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true, playlist: result.playlist, dashboard: buildDashboard() });
});

router.post('/playlists/:id/sync', async (req, res) => {
  const result = await videos.syncPlaylist(req.params.id);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true, playlist: result.playlist, dashboard: buildDashboard() });
});

router.post('/video-assignment/add', (req, res) => {
  const result = videos.addVideoToDay(todayStr(), req.body?.playlistId);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true, added: result.added, dashboard: buildDashboard() });
});

router.post('/video-assignment/regenerate', (req, res) => {
  videos.regenerateVideoAssignment(todayStr());
  res.json({ ok: true, dashboard: buildDashboard() });
});

router.delete('/playlists/:id', (req, res) => {
  const playlist = videos.removePlaylist(req.params.id);
  if (!playlist) return res.status(404).json({ error: 'playlist not found' });
  res.json({ ok: true, dashboard: buildDashboard() });
});

router.post('/video-assignment/:index', (req, res) => {
  const body = req.body || {};
  const result = videos.setVideoStatus(todayStr(), req.params.index, body.status, body.revision);
  if (!result) return res.status(400).json({ error: 'video assignment not found or invalid status' });
  res.json({ ok: true, dashboard: buildDashboard() });
});

module.exports = router;
