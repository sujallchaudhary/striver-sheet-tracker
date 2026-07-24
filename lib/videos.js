// Playlist progress and daily video assignment. Each playlist video has the
// same lifecycle as a sheet problem: new, retry, or revision.
const { getDb, saveDb, daysBetween } = require('./store');

const VIDEO_STATUSES = ['pending', 'attempted', 'completed'];
const REVISION_DELAY_DAYS = 2;

function playlistVideoUrl(playlist, position) {
  const videoId = playlist.videos?.[position - 1]?.videoId;
  if (videoId) return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&list=${encodeURIComponent(playlist.youtubePlaylistId || '')}&index=${position}`;
  try {
    const url = new URL(playlist.url);
    url.searchParams.set('index', String(position));
    return url.toString();
  } catch { return playlist.url; }
}

function playlistIdFromUrl(value) {
  try { return new URL(value).searchParams.get('list') || ''; } catch { return ''; }
}

async function fetchPlaylistMetadata(url, apiKey) {
  const playlistId = playlistIdFromUrl(url);
  if (!playlistId) throw new Error('The URL must include a YouTube playlist ID (the list= parameter).');
  const videos = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({ part: 'snippet,contentDetails', maxResults: '50', playlistId, key: apiKey });
    if (pageToken) params.set('pageToken', pageToken);
    const response = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?${params}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error?.message || 'YouTube could not load this playlist.');
    for (const item of body.items || []) {
      const videoId = item.contentDetails?.videoId;
      if (videoId) videos.push({ videoId, title: item.snippet?.title || 'Untitled video', thumbnail: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || '' });
    }
    pageToken = body.nextPageToken || '';
  } while (pageToken && videos.length < 10000);
  if (!videos.length) throw new Error('No playable videos were found in this playlist.');
  return { playlistId, videos };
}

function key(playlistId, position) { return `${playlistId}:${position}`; }

function progressFor(db, playlistId, position) {
  const id = key(playlistId, position);
  if (!db.videoProgress[id]) db.videoProgress[id] = { status: 'pending', revision: false, timesAssigned: 0, lastAssignedDate: null, statusUpdatedAt: null };
  return db.videoProgress[id];
}

function typeFor(progress) {
  if (progress.revision) return 'revision';
  return progress.status === 'attempted' ? 'retry' : 'new';
}

function getOrCreateVideoAssignment(date) {
  const db = getDb();
  if (db.videoAssignments[date]) return db.videoAssignments[date];

  const selected = new Set(db.settings.preferredPlaylistIds || []);
  const playlists = db.playlists.filter((p) => selected.has(p.id));
  const count = Math.min(20, Math.max(1, Number(db.settings.videoDailyCount) || 2));
  const items = [], picked = new Set(), usedPlaylists = new Set();
  const add = (playlist, position, type) => {
    const itemKey = key(playlist.id, position);
    if (picked.has(itemKey)) return false;
    const progress = progressFor(db, playlist.id, position);
    picked.add(itemKey); usedPlaylists.add(playlist.id);
    progress.timesAssigned++;
    progress.lastAssignedDate = date;
    items.push({ playlistId: playlist.id, position, type, completed: false });
    return true;
  };

  // First reserve a small revision budget, preferring a playlist not already
  // represented today just as the problem sheet balances revision topics.
  const revisionTarget = count >= 5 ? 2 : 1;
  for (let slot = 0; slot < revisionTarget && items.length < count; slot++) {
    const candidates = [];
    for (const playlist of playlists) for (let position = 1; position <= playlist.totalVideos; position++) {
      const progress = progressFor(db, playlist.id, position);
      const due = progress.revision && progress.statusUpdatedAt && daysBetween(progress.statusUpdatedAt, date) >= REVISION_DELAY_DAYS;
      if (due) candidates.push({ playlist, position, progress });
    }
    candidates.sort((a, b) => (usedPlaylists.has(a.playlist.id) ? 1 : 0) - (usedPlaylists.has(b.playlist.id) ? 1 : 0) ||
      (a.progress.lastAssignedDate || '').localeCompare(b.progress.lastAssignedDate || '') || a.position - b.position);
    if (!candidates.length || !add(candidates[0].playlist, candidates[0].position, 'revision')) break;
  }

  // Fill remaining capacity with incomplete videos. A playlist with the
  // highest remaining-videos / target-days ratio is most urgent; ties rotate
  // across playlists before taking a second video from one.
  while (items.length < count) {
    const candidates = playlists.map((playlist) => {
      const incomplete = [];
      for (let position = 1; position <= playlist.totalVideos; position++) {
        const progress = progressFor(db, playlist.id, position);
        if (progress.status !== 'completed' && !picked.has(key(playlist.id, position)) && !progress.revision) incomplete.push({ position, progress });
      }
      if (!incomplete.length) return null;
      const next = incomplete.find((x) => x.position >= playlist.nextVideo) || incomplete[0];
      const remaining = incomplete.length;
      return { playlist, position: next.position, progress: next.progress, urgency: remaining / Math.max(1, playlist.targetDays || 1) };
    }).filter(Boolean);
    if (!candidates.length) break;
    // Diversity comes before deadline pressure: selected playlists each get a
    // turn before any one of them can dominate the daily queue.
    candidates.sort((a, b) =>
      (usedPlaylists.has(a.playlist.id) ? 1 : 0) - (usedPlaylists.has(b.playlist.id) ? 1 : 0) ||
      b.urgency - a.urgency || a.position - b.position);
    const next = candidates[0];
    add(next.playlist, next.position, typeFor(next.progress));
    next.playlist.nextVideo = next.position === next.playlist.totalVideos ? 1 : next.position + 1;
  }

  db.videoAssignments[date] = { date, items };
  saveDb();
  return db.videoAssignments[date];
}

function regenerateVideoAssignment(date) {
  const db = getDb();
  const existing = db.videoAssignments[date];
  if (existing) {
    const earliestByPlaylist = new Map();
    for (const item of existing.items) {
      const progress = progressFor(db, item.playlistId, item.position);
      if (progress.status === 'completed') continue;
      const earliest = earliestByPlaylist.get(item.playlistId);
      if (earliest == null || item.position < earliest) earliestByPlaylist.set(item.playlistId, item.position);
    }
    for (const [playlistId, position] of earliestByPlaylist) {
      const playlist = db.playlists.find((item) => item.id === playlistId);
      if (playlist) playlist.nextVideo = position;
    }
    releaseVideoAssignment(date);
  }
  return getOrCreateVideoAssignment(date);
}

// Removing or rebuilding a same-day plan should not make a lesson look as if
// it was assigned repeatedly. Undo the provisional assignment counters first.
function releaseVideoAssignment(date) {
  const db = getDb();
  const assignment = db.videoAssignments[date];
  if (!assignment) return;
  for (const item of assignment.items) {
    const progress = progressFor(db, item.playlistId, item.position);
    if (progress.lastAssignedDate === date) {
      progress.timesAssigned = Math.max(0, (progress.timesAssigned || 0) - 1);
      if (progress.timesAssigned === 0) progress.lastAssignedDate = null;
    }
  }
  delete db.videoAssignments[date];
  saveDb();
}

function setVideoStatus(date, index, status, revision) {
  const db = getDb();
  const assignment = getOrCreateVideoAssignment(date);
  const item = assignment.items[Number(index)];
  if (!item) return null;
  const progress = progressFor(db, item.playlistId, item.position);
  if (status != null) {
    if (!VIDEO_STATUSES.includes(status)) return null;
    progress.status = status;
    progress.statusUpdatedAt = date;
    if (status === 'completed') progress.revision = false;
  }
  if (revision != null) {
    progress.revision = Boolean(revision);
    progress.statusUpdatedAt = date;
  }
  item.completed = progress.status === 'completed';
  saveDb();
  return { item, progress };
}

// Update by stable identity instead of a day's array index. Queue indexes can
// change after a rebalance; playlist ID + position can never cross playlists.
function setVideoProgress(date, playlistId, position, status, revision) {
  const db = getDb();
  const playlist = db.playlists.find((item) => item.id === String(playlistId));
  const numericPosition = Number(position);
  if (!playlist || !Number.isInteger(numericPosition) || numericPosition < 1 || numericPosition > playlist.totalVideos) return null;
  const progress = progressFor(db, playlist.id, numericPosition);
  if (status != null) {
    if (!VIDEO_STATUSES.includes(status)) return null;
    progress.status = status;
    progress.statusUpdatedAt = date;
    if (status === 'completed') progress.revision = false;
  }
  if (revision != null) {
    progress.revision = Boolean(revision);
    progress.statusUpdatedAt = date;
  }
  const assignment = db.videoAssignments[date];
  if (assignment) {
    const item = assignment.items.find((entry) => entry.playlistId === playlist.id && entry.position === numericPosition);
    if (item) item.completed = progress.status === 'completed';
  }
  saveDb();
  return { playlist, progress };
}

// Append the next incomplete lesson to today's queue. A playlist can be
// specified explicitly; otherwise the same urgency rule as the daily planner
// chooses from the selected playlists.
function addVideoToDay(date, playlistId) {
  const db = getDb();
  const assignment = getOrCreateVideoAssignment(date);
  const selected = new Set(db.settings.preferredPlaylistIds || []);
  let playlists = db.playlists.filter((playlist) => selected.has(playlist.id));
  if (playlistId) playlists = playlists.filter((playlist) => playlist.id === String(playlistId));
  if (!playlists.length) return { error: playlistId ? 'That playlist is not selected for the video queue.' : 'Select at least one playlist in Workspace settings.' };

  const inToday = new Set(assignment.items.map((item) => key(item.playlistId, item.position)));
  const candidates = playlists.map((playlist) => {
    const incomplete = [];
    for (let position = 1; position <= playlist.totalVideos; position++) {
      const progress = progressFor(db, playlist.id, position);
      if (progress.status !== 'completed' && !progress.revision && !inToday.has(key(playlist.id, position))) incomplete.push({ position, progress });
    }
    if (!incomplete.length) return null;
    const next = incomplete.find((item) => item.position >= playlist.nextVideo) || incomplete[0];
    return { playlist, position: next.position, progress: next.progress, urgency: incomplete.length / Math.max(1, playlist.targetDays || 1) };
  }).filter(Boolean);
  if (!candidates.length) return { error: 'No incomplete new videos are available to add.' };
  candidates.sort((a, b) => b.urgency - a.urgency || a.position - b.position);
  const next = candidates[0];
  next.progress.timesAssigned++;
  next.progress.lastAssignedDate = date;
  assignment.items.push({ playlistId: next.playlist.id, position: next.position, type: typeFor(next.progress), completed: false });
  next.playlist.nextVideo = next.position === next.playlist.totalVideos ? 1 : next.position + 1;
  saveDb();
  return { added: { playlistId: next.playlist.id, playlistTitle: next.playlist.title, position: next.position, title: next.playlist.videos?.[next.position - 1]?.title || `Video ${next.position}` } };
}

async function addPlaylist({ title, url, totalVideos, targetDays }) {
  const db = getDb();
  const cleanUrl = String(url || '').trim();
  if (!/^https?:\/\//i.test(cleanUrl)) return { error: 'Enter a valid playlist URL.' };
  let metadata;
  const key = db.settings.youtubeApiKey || process.env.YOUTUBE_API_KEY;
  try { if (key) metadata = await fetchPlaylistMetadata(cleanUrl, key); } catch (error) { return { error: `Could not import YouTube metadata: ${error.message}` }; }
  const count = metadata?.videos.length || Number.parseInt(totalVideos, 10), days = Number.parseInt(targetDays, 10);
  if (!Number.isInteger(count) || count < 1 || count > 10000) return { error: 'Enter the number of videos, or add a YouTube API key to import them automatically.' };
  if (!Number.isInteger(days) || days < 1 || days > 3650) return { error: 'Enter how many days you want to finish this playlist in.' };
  const playlist = { id: `playlist-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, title: String(title || '').trim() || metadata?.videos[0]?.title || 'Untitled playlist', url: cleanUrl, totalVideos: count, targetDays: days, nextVideo: 1, youtubePlaylistId: metadata?.playlistId || playlistIdFromUrl(cleanUrl), videos: metadata?.videos || [], createdAt: new Date().toISOString() };
  db.playlists.push(playlist);
  if (!db.settings.preferredPlaylistIds.includes(playlist.id)) db.settings.preferredPlaylistIds.push(playlist.id);
  releaseVideoAssignment(require('./store').todayStr());
  saveDb();
  return { playlist };
}

async function syncPlaylist(id) {
  const db = getDb();
  const playlist = db.playlists.find((item) => item.id === String(id));
  if (!playlist) return { error: 'playlist not found' };
  const apiKey = db.settings.youtubeApiKey || process.env.YOUTUBE_API_KEY;
  if (!apiKey) return { error: 'Add a YouTube Data API key in Workspace settings first.' };
  try {
    const metadata = await fetchPlaylistMetadata(playlist.url, apiKey);
    playlist.youtubePlaylistId = metadata.playlistId;
    playlist.videos = metadata.videos;
    playlist.totalVideos = metadata.videos.length;
    playlist.nextVideo = Math.min(playlist.nextVideo, playlist.totalVideos);
    releaseVideoAssignment(require('./store').todayStr());
    saveDb();
    return { playlist };
  } catch (error) { return { error: `Could not import YouTube metadata: ${error.message}` }; }
}

function removePlaylist(id) {
  const db = getDb(), index = db.playlists.findIndex((p) => p.id === String(id));
  if (index === -1) return null;
  const [playlist] = db.playlists.splice(index, 1);
  db.settings.preferredPlaylistIds = db.settings.preferredPlaylistIds.filter((pid) => pid !== playlist.id);
  for (const assignment of Object.values(db.videoAssignments)) assignment.items = assignment.items.filter((item) => item.playlistId !== playlist.id);
  for (const progressKey of Object.keys(db.videoProgress)) if (progressKey.startsWith(`${playlist.id}:`)) delete db.videoProgress[progressKey];
  saveDb();
  return playlist;
}

module.exports = { getOrCreateVideoAssignment, releaseVideoAssignment, regenerateVideoAssignment, addVideoToDay, setVideoStatus, setVideoProgress, addPlaylist, syncPlaylist, removePlaylist, playlistVideoUrl, progressFor, VIDEO_STATUSES };
