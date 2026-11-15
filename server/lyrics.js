const { requestMusic, neteaseId, searchTracks } = require('./netease');

const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_LIMIT = 128;

function normalize(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}]+/gu, '');
}

async function searchLyrics({ title, artist, duration, filename }) {
  const id = neteaseId(filename);
  if (id) return fetchLyrics(id);
  const songTitle = normalize(title);
  if (!songTitle) return null;

  // B 站的 artist 字段存的是上传者，不能拿来匹配原唱。
  const artistName = /^bilibili:/.test(filename) || /^(未知歌手|未知|unknown( artist)?)$/i.test(artist?.trim())
    ? ''
    : artist?.trim() || '';
  const normalizedArtist = normalize(artistName);
  const keyword = [title, artistName].filter(Boolean).join(' ');
  const results = await searchTracks(keyword);
  const durationDifference = candidate => candidate.dt > 0 ? Math.abs(duration - candidate.dt / 1000) : Infinity;
  const matches = results.filter(candidate => {
    if (!candidate.id || normalize(candidate.name) !== songTitle) return false;
    const artists = (candidate.ar || []).map(artist => artist.name);
    if (normalizedArtist && !artists.some(name => normalize(name) === normalizedArtist)
      && normalize(artists.join('/')) !== normalizedArtist) return false;
    return !(duration > 0 && candidate.dt > 0) || durationDifference(candidate) <= 8;
  });
  if (duration > 0) matches.sort((a, b) => durationDifference(a) - durationDifference(b));
  const match = matches[0];
  if (!match || (!artistName && matches.some(candidate => candidate.id !== match.id))) return null;
  return fetchLyrics(match.id);
}

async function fetchLyrics(id) {
  const resultLyrics = await requestMusic('interface3.music.163.com', '/api/song/lyric', {
    id, lv: -1, kv: -1, tv: -1,
  });
  const lrc = resultLyrics.lrc?.lyric;
  return typeof lrc === 'string' && /^\[\d+:\d{2}(?:[.:]\d{1,3})?\]/m.test(lrc)
    ? { source: 'netease', lrc }
    : null;
}

function getLyrics(song) {
  const key = JSON.stringify([song.id, song.title, song.artist, song.duration, song.filename]);
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.promise;

  cache.delete(key);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  const entry = {
    expires: Date.now() + CACHE_TTL,
    promise: searchLyrics(song).catch(error => {
      if (cache.get(key) === entry) cache.delete(key);
      throw error;
    }),
  };
  cache.set(key, entry);
  return entry.promise;
}

module.exports = { getLyrics };
