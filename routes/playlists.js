const { Router } = require('express');
const { todayStr } = require('../lib/store');
const { getDb } = require('../lib/store');
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

router.post('/video-progress', (req, res) => {
  const body = req.body || {};
  const result = videos.setVideoProgress(todayStr(), body.playlistId, body.position, body.status, body.revision);
  if (!result) return res.status(400).json({ error: 'unknown video or invalid status' });
  res.json({ ok: true, dashboard: buildDashboard() });
});

router.get('/playlists/progress', (req, res) => {
  const db = getDb();
  const todayItems = new Set((db.videoAssignments[todayStr()]?.items || []).map((item) => `${item.playlistId}:${item.position}`));
  const playlists = db.playlists.map((playlist) => {
    const videosList = Array.from({ length: playlist.totalVideos }, (_, offset) => {
      const position = offset + 1;
      const progress = videos.progressFor(db, playlist.id, position);
      return {
        position, title: playlist.videos?.[offset]?.title || `Video ${position}`,
        thumbnail: playlist.videos?.[offset]?.thumbnail || '', videoId: playlist.videos?.[offset]?.videoId || '',
        status: progress.status, revision: progress.revision, timesAssigned: progress.timesAssigned, lastAssignedDate: progress.lastAssignedDate,
        inTodayPlan: todayItems.has(`${playlist.id}:${position}`),
      };
    });
    return { id: playlist.id, title: playlist.title, url: playlist.url, targetDays: playlist.targetDays, totalVideos: playlist.totalVideos, done: videosList.filter((video) => video.status === 'completed').length, videos: videosList };
  });
  res.json({ playlists });
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
