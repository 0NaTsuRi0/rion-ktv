const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const dbMod = require('./db');
const log = require('./logger');
const { config } = require('./config');
const { scanLibrary, rescanLibrary, MV_DIR } = require('./scanner');
const { ensureHLS, removeHLS, outDir, waitForFile, scheduleHLSCleanup } = require('./hlsgen');
const { getWatcherStatus } = require('./watcher');
const { searchBilibili, getBilibiliParts, proxyBilibiliStream, proxyImage, downloadBilibiliVideo } = require('./bilibili');

// 伴奏文件存在性缓存（避免每次请求都查磁盘）
let accCache = { timestamp: 0, valid: new Set() };
const ACC_CACHE_TTL = 60000; // 缓存 1 分钟
function isAccValid(accompaniment, audioTracks) {
  // 先检查独立伴奏文件
  if (accompaniment) {
    const now = Date.now();
    if (now - accCache.timestamp > ACC_CACHE_TTL) accCache = { timestamp: now, valid: new Set() };
    if (accCache.valid.has(accompaniment)) return true;
    const ok = fs.existsSync(accompaniment);
    if (ok) accCache.valid.add(accompaniment);
    if (ok) return true;
  }
  // 双音轨（MKV 内置伴奏）也算有伴奏
  if ((audioTracks || 1) >= 2) return true;
  return false;
}

// db 模块现在是异步初始化的（sql.js WASM 加载）
// 使用 lazy proxy，实际 db 操作需在 ready 之后
let db;
const PORT = config.PORT;
const app = express();
app.use(express.json());

// ---------- 「曲库管理」管理员登录 ----------
// 管理员密码不再通过安装/升级向导收集、也不写进 docker-compose.yml：改成
// 首次打开「曲库管理」(/admin) 时，由用户自己设置一个密码，哈希后存进
// SQLite 的 settings 表（key='admin_password_hash'，见 db.js），跟随 /data
// 一起持久化，升级、容器重建都不受影响。之后每次打开都是登录，不是设置。
// 登录成功后签发一个随机 session token，保存在内存里（进程重启/容器重建
// 后失效，需要重新登录，符合这类局域网轻量应用的预期），通过 httpOnly
// cookie 下发给浏览器。
// 注意：登录状态只用来保护「曲库管理」页面里真正的管理操作（编辑/删除
// 歌曲、改密码）；/api/scan、/api/songs 等电视端、手机点歌页面同样在用的
// 公共接口不受影响——电视端"扫描曲库"本来就需要有人在电视旁边用遥控器
// 操作，风险和曲库管理网页端裸露在局域网里不是一回事。
const ADMIN_PASSWORD_KEY = 'admin_password_hash';
const ADMIN_SESSION_COOKIE = 'ktv_admin_session';
const adminSessions = new Set();

function getAdminPasswordHash() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(ADMIN_PASSWORD_KEY);
  return row ? row.value : null;
}

function setAdminPasswordHash(hash) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(ADMIN_PASSWORD_KEY, hash);
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function hashesMatch(a, b) {
  const bufA = Buffer.from(String(a || '').padEnd(64, '0'));
  const bufB = Buffer.from(String(b || '').padEnd(64, '0'));
  return String(a).length === 64 && crypto.timingSafeEqual(bufA, bufB);
}

// 没有引入 cookie-parser，手动解析 Cookie 请求头即可，避免多引入一个依赖。
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function isAuthDisabled() {
  if (config.ADMIN_AUTH_ENABLED === false) return true;
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_auth_disabled');
    return row && row.value === 'true';
  } catch(e) { return false; }
}

function isAdminAuthed(req) {
  if (isAuthDisabled()) return true;
  const token = parseCookies(req)[ADMIN_SESSION_COOKIE];
  return !!(token && adminSessions.has(token));
}

function requireAdminAuth(req, res, next) {
  if (isAdminAuthed(req)) return next();
  res.status(401).json({ error: '请先登录管理员账号' });
}

function startSession(res) {
  const token = crypto.randomBytes(24).toString('hex');
  adminSessions.add(token);
  res.cookie(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

// 前端据此判断该弹"设置密码"（首次使用）还是"登录"表单，还是直接免密进入。
app.get('/api/admin/session', (req, res) => {
  const noAuth = isAuthDisabled();
  res.json({
    authed: noAuth || isAdminAuthed(req),
    passwordSet: !!getAdminPasswordHash(),
    authDisabled: noAuth
  });
});

// 一键免密模式（用于开发/测试/内网环境，免去每次输入密码的烦恼）
app.post('/api/admin/disable-auth', (req, res) => {
  db.prepare("INSERT INTO settings (key, value) VALUES ('admin_auth_disabled', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'").run();
  startSession(res);
  log.info('ADMIN', '已开启曲库管理免密模式');
  res.json({ ok: true, authDisabled: true });
});

// 恢复密码保护
app.post('/api/admin/enable-auth', requireAdminAuth, (req, res) => {
  db.prepare("INSERT INTO settings (key, value) VALUES ('admin_auth_disabled', 'false') ON CONFLICT(key) DO UPDATE SET value = 'false'").run();
  log.info('ADMIN', '已恢复曲库管理密码保护');
  res.json({ ok: true, authDisabled: false });
});

// 首次使用：设置管理员密码。
app.post('/api/admin/setup', (req, res) => {
  if (getAdminPasswordHash()) {
    return res.status(409).json({ error: '管理员密码已设置过，请使用登录' });
  }
  const { password } = req.body || {};
  if (!password || password.length < 4) {
    return res.status(400).json({ error: '密码至少 4 位' });
  }
  setAdminPasswordHash(sha256Hex(password));
  db.prepare("INSERT INTO settings (key, value) VALUES ('admin_auth_disabled', 'false') ON CONFLICT(key) DO UPDATE SET value = 'false'").run();
  startSession(res);
  log.info('ADMIN', '首次设置曲库管理密码成功');
  res.json({ ok: true });
});

app.post('/api/admin/login', (req, res) => {
  const stored = getAdminPasswordHash();
  if (!stored) {
    return res.status(400).json({ error: '尚未设置管理员密码，请先设置' });
  }
  const { password } = req.body || {};
  const inputHash = password ? sha256Hex(password) : '';
  if (!hashesMatch(inputHash, stored)) {
    log.warn('ADMIN', '曲库管理登录失败：密码错误');
    return res.status(401).json({ error: '密码错误' });
  }
  startSession(res);
  log.info('ADMIN', '曲库管理登录成功');
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  const token = parseCookies(req)[ADMIN_SESSION_COOKIE];
  if (token) adminSessions.delete(token);
  res.clearCookie(ADMIN_SESSION_COOKIE);
  res.json({ ok: true });
});

// 登录状态下修改密码：需要正确提供当前密码，防止已经打开着「曲库管理」
// 页面的旁人（会话没过期时）随手把密码改掉。改密码后，为安全起见把其它
// 所有已登录的 session 一起失效，只保留当前这一个。
app.post('/api/admin/change-password', requireAdminAuth, (req, res) => {
  const stored = getAdminPasswordHash();
  const { oldPassword, newPassword } = req.body || {};
  const oldHash = oldPassword ? sha256Hex(oldPassword) : '';
  if (!stored || !hashesMatch(oldHash, stored)) {
    return res.status(401).json({ error: '当前密码不正确' });
  }
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: '新密码至少 4 位' });
  }
  setAdminPasswordHash(sha256Hex(newPassword));
  const token = parseCookies(req)[ADMIN_SESSION_COOKIE];
  adminSessions.clear();
  if (token) adminSessions.add(token);
  log.info('ADMIN', '曲库管理密码已修改');
  res.json({ ok: true });
});

// ---------- 封面静态资源 ----------
app.get('/api/cover/:id', (req, res) => {
  const DEFAULTS = path.join(__dirname, '../web/icons');
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(req.params.id);
  if (song) {
    // 支持远程网络封面（如 B 站歌曲）
    if (song.cover && song.cover.startsWith('http')) {
      return proxyImage(song.cover, res);
    }
    if (song.filepath && !song.filepath.startsWith('bilibili:')) {
      const coverPath = path.join(path.dirname(song.filepath), 'cover.jpg');
      if (fs.existsSync(coverPath)) {
        res.set({ 'Cache-Control': 'public, max-age=86400' });
        return res.sendFile(coverPath);
      }
    }
  }
  res.sendFile(path.join(DEFAULTS, 'album.svg'));
});

// ---------- 二维码（服务端生成，自动检测局域网 IPv4） ----------
const QRCode = require('qrcode');
const os = require('os');

function getLocalIPv4() {
  const { execSync } = require('child_process');
  try {
    // Windows: 用 PowerShell 查默认路由对应的网卡 IP
    const out = execSync(
      'powershell -NoProfile -Command "(Get-NetRoute -DestinationPrefix 0.0.0.0/0 | Where-Object { $_.NextHop -ne \'0.0.0.0\' } | Sort-Object RouteMetric | Select-Object -First 1 | Get-NetIPAddress).IPAddress"',
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(out)) return out;
  } catch (e) { /* fallback */ }
  // 备用：route print 捕获第4列（接口IP）
  try {
    const out = execSync('route print 0.0.0.0', { encoding: 'utf8', timeout: 3000 });
    const lines = out.split('\n');
    for (const line of lines) {
      const m = line.match(/0\.0\.0\.0\s+0\.0\.0\.0\s+\S+\s+(\S+)/);
      if (m && /^\d+\.\d+\.\d+\.\d+$/.test(m[1])) return m[1];
    }
  } catch (e) { /* fallback */ }
  // Linux/Mac
  try {
    const out = execSync('ip route get 1 2>/dev/null || route -n get default 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
    const m = out.match(/src\s+(\d+\.\d+\.\d+\.\d+)/);
    if (m) return m[1];
  } catch (e) { /* fallback */ }
  return '127.0.0.1';
}

const LAN_IP = getLocalIPv4();
const MOBILE_URL = `http://${LAN_IP}:${PORT}/mobile`;
log.info('SERVER', `局域网 IPv4: ${LAN_IP}`);

// 告诉前端正确的访问地址
app.get('/api/server-info', (req, res) => {
  res.json({ lanIP: LAN_IP, port: PORT, mobileURL: MOBILE_URL });
});

app.get('/api/qrcode', async (req, res) => {
  try {
    const png = await QRCode.toBuffer(MOBILE_URL, { width: 200, margin: 2, color: { dark: '#f4f4ff', light: '#00000000' } });
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    res.send(png);
  } catch (e) {
    res.status(500).end();
  }
});

// ---------- 文件上传 ----------
const multer = require('multer');
const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      var name = Buffer.from(file.originalname, 'latin1').toString('utf8');
      var folder = path.join(config.MV_DIR, path.basename(name, path.extname(name)));
      if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
      cb(null, folder);
    },
    filename(req, file, cb) {
      cb(null, Buffer.from(file.originalname, 'latin1').toString('utf8'));
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = ['.mp4','.mkv','.avi','.flv','.mov','.webm','.mpg'];
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('不支持的视频格式: ' + ext));
  }
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未选择文件' });
  log.info('UPLOAD', `文件上传完成: ${req.file.originalname}`);
  res.json({ ok: true, filename: req.file.originalname });
});

// ---------- 静态资源 ----------
app.use('/tv',    express.static(path.join(__dirname, '../web/tv')));
app.use('/mobile', express.static(path.join(__dirname, '../web/mobile')));
app.use('/admin', express.static(path.join(__dirname, '../web/admin')));
app.use('/icons', express.static(path.join(__dirname, '../web/icons')));

// ---------- HLS 播放 (音轨切换不中断播放、进度可寻址) ----------
// 取代了旧的"?track=0/1 现场 ffmpeg 重新封装"方案：那个方案吐出的新流没有
// Content-Length/Range 支持，所以切音轨、以及切完音轨后拖进度条，都只能从
// 头播放。现在把视频轨和每条音频轨分别切成独立的 HLS 分片(.ts)，用一份
// master.m3u8 通过 EXT-X-MEDIA 把所有音频轨声明成同一个 AUDIO group。前端
// hls.js 加载它后，切音轨只是 hls.audioTrack = 0/1，只重新拉音频分片，视频
// 播放位置、连续性完全不受影响；HLS 分片本身天然可寻址，拖进度条对任意音轨
// 都正常工作。单音轨文件走同一套逻辑，master.m3u8 里只声明 1 条音频轨即可，
// 具体生成逻辑见 hlsgen.js。
// 渐进式：ensureHLS 不会等整首歌转码完成才 resolve —— 如果这首歌还没转过，
// 它会立刻创建输出目录、把 master.m3u8 写出来，然后把真正耗时的 ffmpeg 转码
// 丢到后台异步执行，函数本身几乎立即返回。所以这个路由的响应时间只取决于
// "有没有查到歌"和"磁盘 IO"，跟这首歌要转多久没有关系，不会再出现点歌后
// 卡在这一步转圈的情况。
app.get('/hls/:id/master.m3u8', async (req, res) => {
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(req.params.id);
  if (!song) return res.status(404).end();

  // 若为 B 站歌曲，确保已下载到本地缓存目录
  if (song.filename && song.filename.startsWith('bilibili:')) {
    const parts = song.filename.split(':');
    const bvid = parts[1];
    const cid = parts[2];
    try {
      song.filepath = await downloadBilibiliVideo(bvid, cid, config.BILI_CACHE_DIR);
    } catch(err) {
      log.error('HLS', `B站歌曲下载异常: ${err.message}`);
      return res.status(502).end();
    }
  }

  if (!fs.existsSync(song.filepath)) return res.status(404).end();
  log.info('HLS', `请求播放 master.m3u8: id=${song.id} "${song.title || song.filename}"`);
  try {
    const m3u8Path = await ensureHLS(song);
    res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
    fs.createReadStream(m3u8Path).pipe(res);
  } catch (e) {
    log.error('HLS', `master.m3u8 生成失败: id=${song.id} "${song.filename}": ${e.message}`);
    res.status(500).end();
  }
});

// 子播放列表(video.m3u8/audioN.m3u8)与分片(.ts)。file 名做白名单校验防止路径穿越，
// id 也强制要求纯数字，避免拼接出 outDir 之外的路径。
//
// 渐进式转码下，这些文件是随着后台 ffmpeg 进程持续产出的：播放器可能会在
// 某个分片刚好还没转出来的瞬间发出请求。这里不再"文件不存在就直接 404"，
// 而是短暂轮询等待它出现（waitForFile），一旦转码进度追上就立即响应——
// 真正做到"随出随播"，而不是让播放器自己重试或者干等整首歌转完。如果这
// 首歌的转码任务本身已经失败，或者等待太久都没等到（比如源文件损坏、卡在
// 极端情况），才会明确地报错而不是无限期挂起请求。
app.get('/hls/:id/:file', async (req, res) => {
  const { id, file } = req.params;
  if (!/^\d+$/.test(id) || !/^[\w.-]+$/.test(file)) return res.status(400).end();
  const p = path.join(outDir(id), file);

  let ready = fs.existsSync(p);
  if (!ready) {
    try {
      await waitForFile(p, id);
      ready = true;
    } catch (e) {
      if (e.code === 'BUILD_FAILED') {
        log.error('HLS', `分片生成失败: id=${id}, file=${file}: ${e.cause && e.cause.message}`);
        return res.status(500).end();
      }
      log.warn('HLS', `等待分片超时: id=${id}, file=${file}`);
      return res.status(404).end(); // 等待超时，视为确实不存在（例如非法文件名/已被清理）
    }
  }

  if (file.endsWith('.m3u8')) {
    res.set({
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
  } else if (file.endsWith('.ts')) {
    res.set({
      'Content-Type': 'video/mp2t',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
  }
  fs.createReadStream(p).pipe(res);
});

// ---------- AI 伴奏生成（pymss） ----------
const { generateAccompaniment, getGenerationStatus } = require('./accompaniment');

// 批量生成伴奏：POST /api/accompaniment/generate  body: { ids: [1,2,3] }
app.post('/api/accompaniment/generate', requireAdminAuth, async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0)
    return res.status(400).json({ error: '请选择歌曲' });
  const results = [];
  for (const id of ids) {
    try {
      const song = db.prepare('SELECT id, title, accompaniment FROM songs WHERE id = ?').get(id);
      if (!song) { results.push({ id, error: '歌曲不存在' }); continue; }
      if (song.accompaniment && fs.existsSync(song.accompaniment)) {
        results.push({ id, status: 'skipped', reason: '已有伴奏' }); continue;
      }
      // 异步启动，不等待完成
      generateAccompaniment(id).then(() => {
        log.info('ACCOMP', `歌曲 id=${id} 伴奏生成完成`);
      }).catch(e => log.error('ACCOMP', `歌曲 id=${id} 伴奏生成失败: ${e.message}`));
      results.push({ id, status: 'started' });
    } catch (e) { results.push({ id, error: e.message }); }
  }
  res.json({ ok: true, results });
});

app.get('/api/accompaniment/status', requireAdminAuth, (req, res) => {
  res.json(getGenerationStatus());
});

// ---------- 伴奏上传 ----------
const audioUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(req.params.songId);
      if (song) cb(null, path.dirname(song.filepath));
      else cb(new Error('歌曲不存在'));
    },
    filename(req, file, cb) {
      const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(req.params.songId);
      const safeBase = song ? ((song.artist||'未知歌手') + ' - ' + (song.title||'unknown')).replace(/[<>:"/\\|?*]/g, '_') : 'unknown';
      const ext = path.extname(Buffer.from(file.originalname, 'latin1').toString('utf8'));
      cb(null, safeBase + '_伴奏' + ext);
    }
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.mp3','.aac','.m4a','.wav','.flac','.ogg'].includes(ext)) cb(null, true);
    else cb(new Error('不支持的音频格式'));
  }
});
app.post('/api/upload/accompaniment/:songId', audioUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未选择文件' });
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(req.params.songId);
  if (!song) { fs.unlinkSync(req.file.path); return res.status(404).json({ error: '歌曲不存在' }); }
  db.prepare('UPDATE songs SET accompaniment = ? WHERE id = ?').run(req.file.path, req.params.songId);
  // 清除 HLS 缓存，下次播放会重新生成含伴奏的音轨
  const { removeHLS } = require('./hlsgen');
  removeHLS(req.params.songId);
  log.info('UPLOAD', `伴奏上传完成: ${song.title} -> ${req.file.originalname}`);
  res.json({ ok: true, path: req.file.path });
});

// ---------- B 站搜索与解析点歌 ----------
app.get('/api/bilibili/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    const page = parseInt(req.query.page) || 1;
    const list = await searchBilibili(q, page);
    res.json(list);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/bilibili/parts', async (req, res) => {
  try {
    const bvid = req.query.bvid || '';
    if (!bvid) return res.status(400).json({ error: '缺少 bvid' });
    const parts = await getBilibiliParts(bvid);
    res.json(parts);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/bilibili/cover', (req, res) => {
  proxyImage(req.query.url, res);
});

// B 站历史点歌列表（未搜索时展示）
app.get('/api/bilibili/history', (req, res) => {
  const rows = db.prepare(`
    SELECT s.id, s.title, s.artist, s.filename, s.cover, s.duration, s.play_count,
           COALESCE((SELECT MAX(q.created_at) FROM queue q WHERE q.song_id = s.id), s.created_at) as last_time
    FROM songs s
    WHERE s.filename LIKE 'bilibili:%'
    ORDER BY last_time DESC, s.id DESC
    LIMIT 50
  `).all();
  res.json(rows);
});

app.post('/api/bilibili/enqueue', (req, res) => {
  try {
    const { bvid, cid, partTitle, videoTitle, author, pic, duration, nickname } = req.body || {};
    if (!bvid || !cid) return res.status(400).json({ error: '缺少 bvid 或 cid' });

    const key = `bilibili:${bvid}:${cid}`;
    const targetFilePath = path.join(config.BILI_CACHE_DIR, `${bvid}_${cid}.mp4`);
    let displayTitle = (videoTitle || bvid).trim();
    const pTitle = (partTitle || '').trim();
    if (pTitle && pTitle !== displayTitle) {
      if (pTitle.toLowerCase().startsWith(displayTitle.toLowerCase())) {
        displayTitle = pTitle;
      } else {
        displayTitle = `${displayTitle} - ${pTitle}`;
      }
    }

    let song = db.prepare('SELECT id FROM songs WHERE filename = ?').get(key);
    if (!song) {
      const displayArtist = author ? `B站 · ${author}` : 'B站';
      const sec = parseInt(duration) || 0;
      const info = db.prepare(`
        INSERT INTO songs (title, artist, filename, filepath, cover, duration, audio_tracks)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `).run(displayTitle, displayArtist, key, targetFilePath, pic || '', sec);
      song = { id: info.lastInsertRowid };
    } else {
      // 同步最新复合标题、本地缓存路径与封面
      db.prepare("UPDATE songs SET title = ?, filepath = ?, cover = COALESCE(NULLIF(cover, ''), ?) WHERE id = ?")
        .run(displayTitle, targetFilePath, pic || '', song.id);
    }

    // 后台立即触发视频下载与 HLS 预热切片
    downloadBilibiliVideo(bvid, cid, config.BILI_CACHE_DIR).then(savedPath => {
      const fullSong = db.prepare('SELECT * FROM songs WHERE id = ?').get(song.id);
      if (fullSong) {
        ensureHLS(fullSong).catch(e => log.warn('HLS', `B站预切片提示: ${e.message}`));
      }
    }).catch(e => log.error('BILI', `后台下载B站视频失败: ${e.message}`));

    const qInfo = db.prepare('INSERT INTO queue (song_id, nickname) VALUES (?, ?)').run(song.id, nickname || '匿名用户');
    db.prepare('UPDATE songs SET play_count = play_count + 1 WHERE id = ?').run(song.id);

    const playing = db.prepare("SELECT * FROM queue WHERE status='playing'").get();
    if (!playing) {
      db.prepare("UPDATE queue SET status='playing' WHERE id=?").run(qInfo.lastInsertRowid);
    }
    broadcastQueue();
    res.json({ ok: true, queue_id: qInfo.lastInsertRowid, song_id: song.id });
  } catch(e) {
    log.error('BILI', `点歌失败: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

app.get('/stream/bilibili/:bvid/:cid', (req, res) => {
  proxyBilibiliStream(req, res, req.params.bvid, req.params.cid);
});

// ---------- MV 直传流 (Range 请求) ----------
// 历史接口，现已不是 TV 播放器的主路径(见上面的 /hls)。保留作为兼容兜底：
// 例如 hls.js 加载失败、或未来某个场景需要拿到原始文件直传时使用。仍支持
// ?track=0/1（对多音轨文件用 ffmpeg -c copy 现场重新封装出单音轨流），但注意
// 这个分支吐出的流不支持 Range/寻址，只适合"整段从头播完"的用途，不要再用它
// 做音轨切换后还要拖进度条的场景——那正是旧 bug 的根因，具体解释见 /hls 路由。
app.get('/stream/:id', (req, res) => {
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(req.params.id);
  if (!song) return res.status(404).end();

  // B 站网络歌曲直接代理流
  if (song.filename && song.filename.startsWith('bilibili:')) {
    const parts = song.filename.split(':');
    const bvid = parts[1];
    const cid = parts[2];
    return proxyBilibiliStream(req, res, bvid, cid);
  }

  if (!fs.existsSync(song.filepath)) return res.status(404).end();

  const trackParam = req.query.track;
  const hasMultiTrack = (song.audio_tracks || 1) >= 2;

  if ((trackParam !== undefined && hasMultiTrack) || (trackParam == '1' && song.accompaniment && fs.existsSync(song.accompaniment))) {
    const track = trackParam !== undefined ? Math.max(0, Math.min(parseInt(trackParam, 10) || 0, song.audio_tracks - 1)) : 1;
    const useAcc = trackParam == '1' && song.accompaniment && fs.existsSync(song.accompaniment);
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'none',
      'Cache-Control': 'no-store',
    });
    const args = ['-loglevel', 'error', '-i', song.filepath];
    const maps = ['-map', '0:v:0'];
    if (useAcc) {
      args.push('-i', song.accompaniment);
      maps.push('-map', '1:a:0');
    } else {
      maps.push('-map', `0:a:${track}`);
    }
    var acodec = useAcc ? ['-c:a', 'aac', '-b:a', '192k'] : ['-c:a', 'copy'];
    args.push(...maps, '-c:v', 'copy', ...acodec, '-movflags', 'frag_keyframe+empty_moov+faststart', '-f', 'mp4', 'pipe:1');
    const ff = spawn(config.ffmpegPath, args);
    let responded = false;
    ff.stdout.pipe(res);
    ff.stderr.on('data', d => log.warn('TRANSCODE', `[stream直传兜底][ffmpeg] ${d.toString().trim()}`));
    const cleanup = () => { if (!ff.killed) { try { ff.kill('SIGKILL'); } catch (e) {} } };
    ff.on('error', err => { log.error('TRANSCODE', `[stream直传兜底] ffmpeg 启动失败: ${err.message}`); if (!responded) { responded = true; res.status(500).end(); } cleanup(); });
    res.on('close', cleanup);
    return;
  }

  // 流播放：ffmpeg 封装视频+原始音频（不做任何滤镜）
  const useAcc_t = trackParam == '1' && song.accompaniment && fs.existsSync(song.accompaniment);
  const ffArgs = ['-loglevel', 'error', '-i', song.filepath];
  const ffMaps = ['-map', '0:v:0'];
  if (useAcc_t) {
    ffArgs.push('-i', song.accompaniment);
    ffMaps.push('-map', '1:a:0');
  } else {
    ffMaps.push('-map', '0:a:0');
  }
  var acodec2 = useAcc_t ? ['-c:a', 'aac', '-b:a', '192k'] : ['-c:a', 'copy'];
  ffArgs.push(...ffMaps, '-c:v', 'copy', ...acodec2, '-movflags', 'frag_keyframe+empty_moov+faststart', '-f', 'mp4', 'pipe:1');
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'none',
    'Cache-Control': 'no-store',
  });
  const ff = spawn(config.ffmpegPath, ffArgs);
  ff.stdout.pipe(res);
  ff.stderr.on('data', d => log.warn('TRANSCODE', `[stream][ffmpeg] ${d.toString().trim()}`));
  ff.on('error', err => { if (!res.headersSent) res.status(500).end(); });
  res.on('close', () => { if (!ff.killed) try { ff.kill('SIGKILL'); } catch(e) {} });
});

// ---------- 原唱/伴唱切换状态上报 ----------
// 实际的切换动作(hls.audioTrack=0/1 或者声道复制)完全发生在浏览器端
// (见 web/tv/index.html 的 VoiceManager)，服务端本身并不参与、也就无从
// 知晓用户什么时候切了原唱/伴唱。这里加一个轻量上报接口，由前端在每次
// 切换后调用一次，让这个状态变化也能进 docker 后台日志，方便排查
// "切了没生效"之类的问题。上报失败与否不影响播放本身，前端是 fire-and-forget。
app.post('/api/voice/switch', (req, res) => {
  const { song_id, mode, to } = req.body || {};
  const song = song_id ? db.prepare('SELECT id, title, filename FROM songs WHERE id = ?').get(song_id) : null;
  const songTag = song ? `id=${song.id} "${song.title || song.filename}"` : `id=${song_id || '未知'}`;
  const toName = to === 'original' ? '原唱' : to === 'accompaniment' ? '伴唱' : (to || '未知');
  const modeName = mode === 'tracks' ? '多音轨(HLS audioTrack)' : mode === 'stereo' ? '双声道(Web Audio 声道复制)' : (mode || '未知');
  log.info('VOICE', `切换音轨: ${songTag} -> ${toName} (方式: ${modeName})`);
  res.json({ ok: true });
});

// ---------- 歌曲库 ----------
app.get('/api/songs', (req, res) => {
  const q = (req.query.q || '').trim();
  const artist = (req.query.artist || '').trim();
  let rows;
  if (artist) {
    rows = db.prepare("SELECT * FROM songs WHERE filename NOT LIKE 'bilibili:%' AND artist LIKE ? ORDER BY title").all(`%${artist}%`);
  } else if (q) {
    rows = db.prepare("SELECT * FROM songs WHERE filename NOT LIKE 'bilibili:%' AND (title LIKE ? OR artist LIKE ?) ORDER BY play_count DESC LIMIT 100").all(`%${q}%`, `%${q}%`);
  } else {
    rows = db.prepare("SELECT * FROM songs WHERE filename NOT LIKE 'bilibili:%' ORDER BY play_count DESC, id DESC").all();
  }
  // 校验伴奏文件是否存在（带缓存）
  rows.forEach(s => s.accompaniment_valid = isAccValid(s.accompaniment, s.audio_tracks));
  res.json(rows);
});

// 按首字母搜索
app.get('/api/songs/letter/:letter', (req, res) => {
  const letter = req.params.letter.toUpperCase();
  const rows = db.prepare("SELECT * FROM songs WHERE filename NOT LIKE 'bilibili:%' AND UPPER(SUBSTR(title,1,1)) = ? ORDER BY title LIMIT 100").all(letter);
  res.json(rows);
});

// ---------- 歌手列表（支持多歌手，用 / 分隔） ----------
const pinyinMod = require('pinyin');

function getPinyinInitial(name) {
  try {
    const res = pinyinMod.pinyin(name, { style: pinyinMod.STYLE_FIRST_LETTER });
    return res.map(r => r[0].toUpperCase()).join('');
  } catch(e) { return ''; }
}

app.get('/api/artists', (req, res) => {
  const rows = db.prepare("SELECT artist FROM songs WHERE filename NOT LIKE 'bilibili:%' AND artist IS NOT NULL AND artist != ''").all();
  const artistMap = {};
  for (const row of rows) {
    const names = row.artist.split('/').map(s => s.trim()).filter(Boolean);
    for (const name of names) {
      artistMap[name] = (artistMap[name] || 0) + 1;
    }
  }
  const result = Object.entries(artistMap).map(([artist, count]) => ({ artist, count, initial: getPinyinInitial(artist)[0] || '#' })).sort((a, b) => {
    // 按拼音首字母排序
    const ai = a.initial.toLowerCase(), bi = b.initial.toLowerCase();
    if (ai !== bi) return ai < bi ? -1 : 1;
    return a.artist.localeCompare(b.artist);
  });
  res.json(result);
});

// ---------- 历史 (常唱) ----------
app.get('/api/history', (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, COUNT(h.id) as times_sung
    FROM songs s JOIN history h ON s.id = h.song_id
    GROUP BY s.id ORDER BY times_sung DESC, s.play_count DESC LIMIT 50
  `).all();
  res.json(rows);
});

// ---------- 爱唱榜 (按播放次数) ----------
app.get('/api/charts', (req, res) => {
  const rows = db.prepare("SELECT * FROM songs WHERE filename NOT LIKE 'bilibili:%' AND play_count > 0 ORDER BY play_count DESC LIMIT 50").all();
  res.json(rows);
});

// ---------- 收藏 ----------
app.get('/api/favorites', (req, res) => {
  const device = req.query.device || 'default';
  const rows = db.prepare(`
    SELECT s.* FROM songs s
    JOIN favorites f ON s.id = f.song_id
    WHERE f.device_id = ? ORDER BY f.created_at DESC
  `).all(device);
  res.json(rows);
});

app.post('/api/favorites/:song_id', (req, res) => {
  const device = req.body.device || 'default';
  db.prepare('INSERT OR IGNORE INTO favorites (song_id, device_id) VALUES (?,?)').run(req.params.song_id, device);
  res.json({ ok: true });
});

app.delete('/api/favorites/:song_id', (req, res) => {
  const device = req.query.device || 'default';
  db.prepare('DELETE FROM favorites WHERE song_id = ? AND device_id = ?').run(req.params.song_id, device);
  res.json({ ok: true });
});

// ---------- 歌曲管理 (Admin) ----------
// 只有这两个真正的"增删改"动作要求登录；/api/scan、/api/songs 等电视端、
// 手机点歌页面共用的接口保持开放，见文件顶部「曲库管理管理员登录」的说明。
app.delete('/api/songs/:id', requireAdminAuth, (req, res) => {
  db.prepare('DELETE FROM songs WHERE id = ?').run(req.params.id);
  removeHLS(req.params.id);
  res.json({ ok: true });
});

app.put('/api/songs/:id', requireAdminAuth, (req, res) => {
  const { title, artist } = req.body;
  db.prepare('UPDATE songs SET title=?, artist=? WHERE id=?').run(title, artist, req.params.id);
  res.json({ ok: true });
});

// ---------- 封面下载 ----------
const { downloadCover, downloadCoversBatch, fetchAllMissingCovers, reloadAllCovers } = require('./cover-fetch');

// 单首下载 /api/cover/fetch/:id
app.post('/api/cover/fetch/:id', requireAdminAuth, async (req, res) => {
  try {
    const path = await downloadCover(req.params.id);
    res.json({ ok: !!path, path });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 批量下载 /api/cover/fetch-batch
app.post('/api/cover/fetch-batch', requireAdminAuth, async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: '请选择歌曲' });
  // 后台执行，不等待
  downloadCoversBatch(ids).then(r => {
    log.info('COVER', `批量封面下载完成: ${r.filter(x=>x.ok).length}/${ids.length}`);
  }).catch(e => log.error('COVER', `批量封面下载失败: ${e.message}`));
  res.json({ ok: true, count: ids.length });
});

// 一键补全所有缺失封面（扫描不到的自动跳过，不会反复重试）
app.post('/api/cover/fetch-all', requireAdminAuth, async (req, res) => {
  try {
    const result = await fetchAllMissingCovers();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 强制重新下载所有封面（清空本地后重下）
app.post('/api/cover/reload-all', requireAdminAuth, async (req, res) => {
  try {
    const result = await reloadAllCovers();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- 扫描 / 统计 ----------
app.post('/api/scan', async (req, res) => {
  try { res.json({ ok: true, ...(await scanLibrary()) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 全量重新扫描（清空数据库后重扫）
app.post('/api/scan/rescan', requireAdminAuth, async (req, res) => {
  try { res.json({ ok: true, ...(await rescanLibrary()) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/watcher', (req, res) => {
  res.json(getWatcherStatus());
});

app.get('/api/stats', (req, res) => {
  const songCount  = db.prepare("SELECT COUNT(*) c FROM songs WHERE filename NOT LIKE 'bilibili:%'").get().c;
  const queueCount = db.prepare("SELECT COUNT(*) c FROM queue WHERE status!='done'").get().c;
  const totalPlays = db.prepare("SELECT COALESCE(SUM(play_count),0) c FROM songs WHERE filename NOT LIKE 'bilibili:%'").get().c;
  res.json({ songCount, queueCount, mvDir: config.MV_DIR, totalPlays });
});

// v2.0.0: 单首歌曲完整元数据
app.get('/api/songs/:id/meta', (req, res) => {
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(req.params.id);
  if (!song) return res.status(404).json({ error: '歌曲不存在' });
  // 校验伴奏文件是否存在（带缓存）
  song.accompaniment_valid = isAccValid(song.accompaniment, song.audio_tracks);
  res.json(song);
});

// ---------- 点歌队列 ----------
function getQueueWithSongs() {
  return db.prepare(`
    SELECT q.id as queue_id, q.nickname, q.is_top, q.status, q.created_at,
           s.id as song_id, s.title, s.artist, s.filename, s.duration,
           s.audio_tracks
    FROM queue q JOIN songs s ON q.song_id = s.id
    WHERE q.status != 'done'
    -- 排序修复：置顶只能把一首歌挪到"正在播放"之后的第一位（即整个队列的第二位），
    -- 不能盖过正在播放的那首。旧排序 'is_top DESC, id ASC' 只按置顶标记排，
    -- 完全没考虑播放状态——如果正在播放的这一行本身 is_top=0，任何一首刚被置顶
    -- 的候选歌都会因为 is_top=1 排到它前面，等于把"正在播放"从队首挤下去，
    -- 界面上会显示成"置顶歌曲排在正在播放的歌前面"，观感和语义都不对。
    -- 现在最优先按 status='playing' 排（true=1 排最前），保证正在播放的
    -- 那一行永远占据第一位，其次才按 is_top、再按 id 排——这样置顶操作实际能
    -- 达到的最靠前位置，就是紧跟在正在播放歌曲后面的"第二位"，不会再越过它。
    ORDER BY (q.status='playing') DESC, q.is_top DESC, q.id ASC
  `).all();
}

app.get('/api/queue', (req, res) => res.json(getQueueWithSongs()));

app.post('/api/queue', (req, res) => {
  const { song_id, nickname } = req.body;
  const song = db.prepare('SELECT * FROM songs WHERE id=?').get(song_id);
  if (!song) return res.status(404).json({ error: '歌曲不存在' });
  const info = db.prepare('INSERT INTO queue (song_id,nickname) VALUES (?,?)').run(song_id, nickname || '匿名用户');
  db.prepare('UPDATE songs SET play_count=play_count+1 WHERE id=?').run(song_id);
  const playing = db.prepare("SELECT * FROM queue WHERE status='playing'").get();
  if (!playing) db.prepare("UPDATE queue SET status='playing' WHERE id=?").run(info.lastInsertRowid);
  broadcastQueue();
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.post('/api/queue/:id/top', (req, res) => {
  // Bug修复：原来只把这一条设成 is_top=1，从不清除其它行的置顶标记。连续给
  // 不同歌曲点"置顶"后，会有多条 is_top=1 的记录同时存在，这些记录之间只能
  // 按 id ASC 排序——最新点的这首排在更早被置顶的那些后面，界面上看起来就是
  // "点了置顶但完全没反应/挪不动"，也就是卡住无法置顶。
  // 修复为：先把所有非播放中的置顶标记清空，再把当前这条设为置顶，保证同一
  // 时刻只有一首歌处于"置顶"状态，每次点击都能确实把这首歌顶到最前面
  // （紧跟在正在播放的歌曲之后）。
  const tx = db.transaction((id) => {
    db.prepare("UPDATE queue SET is_top=0 WHERE status!='playing'").run();
    db.prepare('UPDATE queue SET is_top=1 WHERE id=?').run(id);
  });
  tx(req.params.id);
  broadcastQueue(); res.json({ ok: true });
});

app.delete('/api/queue/:id', (req, res) => {
  db.prepare('DELETE FROM queue WHERE id=?').run(req.params.id);
  broadcastQueue(); res.json({ ok: true });
});

// 即唱：把指定队列项立即设为播放中
app.post('/api/queue/:id/playnow', (req, res) => {
  const cur = db.prepare("SELECT * FROM queue WHERE status='playing'").get();
  if (cur) db.prepare("UPDATE queue SET status='done' WHERE id=?").run(cur.id);
  db.prepare("UPDATE queue SET status='playing', is_top=0 WHERE id=?").run(req.params.id);
  broadcastQueue(); res.json({ ok: true });
});

app.post('/api/queue/next', (req, res) => {
  const cur = db.prepare("SELECT * FROM queue WHERE status='playing' ORDER BY id LIMIT 1").get();
  if (cur) {
    db.prepare("UPDATE queue SET status='done' WHERE id=?").run(cur.id);
    db.prepare('INSERT INTO history (song_id,nickname) VALUES (?,?)').run(cur.song_id, cur.nickname);
  }
  const nxt = db.prepare("SELECT * FROM queue WHERE status='waiting' ORDER BY is_top DESC, id ASC LIMIT 1").get();
  if (nxt) db.prepare("UPDATE queue SET status='playing' WHERE id=?").run(nxt.id);
  broadcastQueue(); res.json({ ok: true });
});

// ---------- WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// 防止端口被占用时进程崩溃
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log.error('SERVER', `端口 ${err.port} 已被占用，请先关闭占用该端口的进程或更换 PORT 环境变量`);
  } else {
    log.error('SERVER', `服务器错误: ${err.message}`);
  }
  process.exit(1);
});
wss.on('error', () => { /* WebSocket 错误由 server 统一处理 */ });

function broadcastQueue() {
  const payload = JSON.stringify({ type: 'queue', data: getQueueWithSongs() });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(payload); });
}

// 最近一次 TV 上报的状态（音量/原唱伴唱），用于新设备同步
let lastTvState = null;

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'queue', data: getQueueWithSongs() }));
  // 新设备连上来时下发 TV 当前状态
  if (lastTvState) ws.send(JSON.stringify(lastTvState));
  ws.on('message', msg => {
    try {
      const p = JSON.parse(msg);
      if (p.type === 'state') {
        lastTvState = p; // 缓存 TV 状态
      }
      if (p.type === 'control' || p.type === 'state')
        wss.clients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify(p)); });
    } catch(e) {}
  });
});

// 异步主函数：等待数据库初始化完成后启动服务
(async function main() {
  await dbMod.ready;
  db = dbMod;

  // 启动时清空队列（不保留上次关闭的队列）
  db.exec("DELETE FROM queue");

  server.listen(PORT, () => {
    log.info('SERVER', `KTV 服务已启动: http://0.0.0.0:${PORT}`);
    log.info('SERVER', `数据目录: ${config.DATA_DIR}`);
    log.info('SERVER', `曲库目录: ${config.MV_DIR}`);
  });

  // 启动扫描已关闭，请在管理后台手动扫描

  const { startWatcher } = require('./watcher');
  const watcherHandle = startWatcher(() => scanLibrary());
  process.on('SIGINT', () => {
    require('./watcher').stopWatcher(watcherHandle);
    process.exit(0);
  });

  scheduleHLSCleanup(() => db.prepare('SELECT id FROM songs').all().map(r => r.id));
})();
