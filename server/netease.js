const { createCipheriv, createHash, randomInt } = require('crypto');
const { config } = require('./config');

async function requestMusic(host, path, params, cookie) {
  const headers = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' };
  if (cookie) headers.Cookie = cookie;
  const response = await fetch('https://' + host + path, {
    method: 'POST',
    headers,
    redirect: cookie ? 'error' : 'follow',
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Music API HTTP ' + response.status);
  const result = await response.json();
  if (result.code !== 200) throw new Error('Music API code ' + result.code);
  return result;
}

function neteaseId(filename) {
  return /^netease:(\d+)$/.exec(filename)?.[1] || null;
}

function mediaUrl(value) {
  if (typeof value !== 'string') return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!/^https?:$/.test(url.protocol) || !/^(?:[a-z0-9-]+\.)+(?:music\.126\.net|music\.163\.com)$/.test(url.hostname)) return null;
  if (url.username || url.password || url.port) return null;
  url.protocol = 'https:';
  return url.href;
}

async function getCoverImage(value) {
  const source = mediaUrl(value);
  if (!source) return null;
  const cover = new URL(source);
  cover.searchParams.set('param', '512y512');
  const limit = 5 * 1024 * 1024;
  const signal = AbortSignal.timeout(5000);
  let url = cover.href;
  let response;
  for (let redirects = 0; redirects <= 3; redirects++) {
    response = await fetch(url, {
      redirect: 'manual', signal,
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/', Accept: 'image/*' },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location || redirects === 3) return null;
    url = mediaUrl(new URL(location, url).href);
    if (!url) return null;
  }

  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  const raster = /^image\/(?:jpe?g|png|webp|gif|avif)$/.test(type);
  if (!response.ok || (!raster && type && type !== 'application/octet-stream')
    || Number(response.headers.get('content-length')) > limit || !response.body) {
    await response.body?.cancel();
    return null;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  if (!size) return null;
  const bytes = Buffer.concat(chunks, size);
  if (raster) return { type: type === 'image/jpg' ? 'image/jpeg' : type, bytes };
  // 部分 CDN 节点返回二进制类型，按图片文件头确认格式再按同源图片提供。
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { type: 'image/jpeg', bytes };
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: 'image/png', bytes };
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { type: 'image/webp', bytes };
  return null;
}

function toTrack(song) {
  return {
    id: String(song.id),
    title: song.name,
    artist: (song.ar || []).map(artist => artist.name).join(' / '),
    duration: Math.round((song.dt || 0) / 1000),
    cover: mediaUrl(song.al?.picUrl),
  };
}

async function searchTracks(keyword) {
  const { result } = await requestMusic('music.163.com', '/api/cloudsearch/pc', { s: keyword, type: 1, limit: 15 });
  return result?.songs || [];
}

async function getTrack(id) {
  const { songs } = await requestMusic('interface3.music.163.com', '/api/v3/song/detail', {
    c: '[{"id":' + id + ',"v":0}]',
  });
  const song = songs?.find(song => String(song.id) === id);
  return song ? toTrack(song) : null;
}

async function requestAudioUrl(id, endpoint, payload, session) {
  const path = '/api' + endpoint;
  const json = JSON.stringify(session ? { ...payload, header: session } : payload);
  const digest = createHash('md5').update('nobody' + path + 'use' + json + 'md5forencrypt').digest('hex');
  const cipher = createCipheriv('aes-128-ecb', 'e82ckenh8dichen8', null);
  const message = [path, json, digest].join('-36cd479b6b5-');
  const params = Buffer.concat([cipher.update(message), cipher.final()]).toString('hex').toUpperCase();
  const cookie = session && Object.entries(session).map(([key, value]) => key + '=' + value).join('; ');
  const { data } = await requestMusic('interface3.music.163.com', '/eapi' + endpoint, { params }, cookie);
  const audio = data?.find(item => String(item.id) === id);
  return audio?.code === 200 && !audio.freeTrialInfo ? mediaUrl(audio.url) : null;
}

async function getAudioUrl(id) {
  const musicU = config.NETEASE_MUSIC_U.trim();
  if (musicU && (/^MUSIC_U=/i.test(musicU) || !/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/.test(musicU))) {
    throw new Error('NETEASE_MUSIC_U 格式无效，请只填写 MUSIC_U 的值');
  }

  const endpoint = '/song/enhance/player/url';
  const legacy = { ids: [id], br: 192000 };
  if (!musicU) return requestAudioUrl(id, endpoint, legacy);

  // 登录态同时随 Cookie 和 EAPI 客户端 header 发送。
  const session = {
    os: 'pc', appver: '8.0.0',
    requestId: Date.now() + '_' + String(randomInt(10000)).padStart(4, '0'),
    MUSIC_U: musicU,
  };
  const player = { ids: '[' + id + ']', level: 'standard', encodeType: 'flac' };
  let url;
  try {
    url = await requestAudioUrl(id, endpoint + '/v1', player, session);
  } catch {
    // v1 暂时不可用时仍可尝试原有播放接口。
  }
  return url || requestAudioUrl(id, endpoint, legacy, session);
}

module.exports = { requestMusic, neteaseId, searchTracks, toTrack, getTrack, getAudioUrl, getCoverImage };
