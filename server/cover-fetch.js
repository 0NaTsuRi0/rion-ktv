// 专辑封面下载模块 — 从 QQ/酷狗/酷我 搜索并下载封面到歌曲文件夹
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const log = require('./logger');
const db = require('./db');
const { config } = require('./config');

// 工具函数
function getJSON(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let data = '';
      res.on('data', d => data += d.toString('utf8'));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({}); } });
    });
    req.on('error', () => resolve({}));
    req.setTimeout(10000, () => { req.destroy(); resolve({}); });
  });
}
function htmlDecode(str) {
  return str ? str.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'") : '';
}
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return httpGet(res.headers.location).then(resolve).catch(reject);
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// 搜索封面（QQ音乐）
function searchQQ(keyword, artist) {
  const q = encodeURIComponent(keyword);
  const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${q}&format=json&p=1&n=5`;
  return getJSON(url).then(json => {
    const songs = json?.data?.song?.list || [];
    const match = songs.find(s => artist && (s.singer || []).some(a => a.name && a.name.includes(artist)));
    const song = match || songs[0];
    const mid = song?.albummid || song?.album?.mid;
    return mid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${mid}.jpg` : null;
  });
}

// 搜索封面（酷狗音乐）
function searchKugou(keyword, artist) {
  const q = encodeURIComponent(keyword);
  return getJSON(`http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${q}&page=1&pagesize=5&showtype=1`).then(async json => {
    const list = json?.data?.info || [];
    const match = list.find(s => artist && s.singername?.includes(artist));
    const s = match || list[0];
    if (!s?.hash) return null;
    const detail = await getJSON(`http://www.kugou.com/yy/index.php?r=play/getdata&hash=${s.hash}`);
    return detail?.data?.img || null;
  });
}

// 搜索封面（酷我音乐）
function searchKuwo(keyword, artist) {
  const q = encodeURIComponent(keyword);
  const url = `http://search.kuwo.cn/r.s?all=${q}&ft=music&itemset=web_2013&client=kt&pn=0&rn=5&rformat=json&encoding=utf8`;
  return getJSON(url).then(json => {
    const list = json?.abslist || [];
    const match = list.find(s => artist && htmlDecode(s.ARTIST).includes(artist));
    const s = match || list[0];
    if (!s?.MUSICRID) return null;
    const rid = s.MUSICRID.replace('MUSIC_', '');
    return httpGet(`http://www.kuwo.cn/webmusic/sj/dtflagdate?flag=6&rid=${rid}`).then(t => {
      const parts = t.split(',');
      return parts.length > 1 ? parts[1] : null;
    }).catch(() => null);
  });
}

function searchCover(keyword, artist) {
  // 依次尝试 QQ → 酷狗 → 酷我
  return searchQQ(keyword, artist).then(url => url || searchKugou(keyword, artist)).then(url => url || searchKuwo(keyword, artist));
}

// 下载封面到歌曲文件夹
async function downloadCover(songId) {
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(songId);
  if (!song || !song.filepath || !fs.existsSync(song.filepath)) return null;

  const dir = path.dirname(song.filepath);
  const outputPath = path.join(dir, 'cover.jpg');
  if (fs.existsSync(outputPath)) return outputPath; // 已有封面

  const keyword = song.title || path.basename(song.filepath, path.extname(song.filepath));
  const artist = song.artist || '';

  try {
    const imgUrl = await searchCover(keyword, artist);
    if (!imgUrl) return null;

    await downloadFile(imgUrl, outputPath);
    // 转为 128x128
    await resizeImage(outputPath, outputPath);
    // 更新数据库 cover 字段
    db.prepare('UPDATE songs SET cover = ? WHERE id = ?').run('cover.jpg', songId);
    log.info('COVER', `封面下载完成: id=${songId} "${song.title}"`);
    return outputPath;
  } catch (e) {
    return null;
  }
}

function resizeImage(src, dest) {
  return new Promise((resolve, reject) => {
    const ff = spawn(config.ffmpegPath, [
      '-loglevel', 'error', '-y', '-i', src,
      '-vf', 'scale=128:128:force_original_aspect_ratio=2,crop=128:128',
      '-q:v', '3', dest,
    ]);
    ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
    ff.on('error', reject);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const getter = url.startsWith('https') ? https.get : http.get;
    getter(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // 重定向
        downloadFile(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', reject);
  });
}

// 批量下载封面
async function downloadCoversBatch(songIds) {
  const results = [];
  for (const id of songIds) {
    const r = await downloadCover(id);
    results.push({ id, ok: !!r });
  }
  return results;
}

// 批量补全所有缺失的封面（只处理从未尝试过的歌曲）
async function fetchAllMissingCovers() {
  const noCover = db.prepare('SELECT id, title FROM songs WHERE cover IS NULL').all();
  if (noCover.length === 0) return { total: 0, ok: 0, skipped: 0 };

  log.info('COVER', `开始批量补全封面，共 ${noCover.length} 首`);
  let ok = 0;
  for (const row of noCover) {
    try {
      const r = await downloadCover(row.id);
      if (r) {
        ok++;
      } else {
        // 未找到封面，标记为空字符串表示"已尝试过但没找到"，后续不再重试
        db.prepare('UPDATE songs SET cover = ? WHERE id = ?').run('', row.id);
      }
    } catch(e) {
      // 失败也标记，避免反复重试
      db.prepare('UPDATE songs SET cover = ? WHERE id = ?').run('', row.id);
    }
  }
  log.info('COVER', `批量封面补全完成: ${ok}/${noCover.length}`);
  return { total: noCover.length, ok };
}

// 强制重新下载所有封面（删除本地已有封面后重新下载）
async function reloadAllCovers() {
  const allSongs = db.prepare('SELECT id, filepath FROM songs').all();
  log.info('COVER', `开始强制重下封面，共 ${allSongs.length} 首`);
  let ok = 0;
  for (const song of allSongs) {
    if (!song.filepath || !fs.existsSync(song.filepath)) continue;
    const dir = path.dirname(song.filepath);
    const coverPath = path.join(dir, 'cover.jpg');
    // 删除已有封面文件
    try { if (fs.existsSync(coverPath)) fs.unlinkSync(coverPath); } catch(e) {}
    // 重置为"未尝试"状态
    db.prepare('UPDATE songs SET cover = NULL WHERE id = ?').run(song.id);
    try {
      const r = await downloadCover(song.id);
      if (r) ok++;
    } catch(e) { /* 单首失败跳过 */ }
  }
  log.info('COVER', `封面重下完成: ${ok}/${allSongs.length}`);
  return { total: allSongs.length, ok };
}

module.exports = { downloadCover, downloadCoversBatch, fetchAllMissingCovers, reloadAllCovers };
