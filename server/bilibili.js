// B站视频搜索、分P解析与音视频流下载封装模块（参考 BBDown 原理：WBI DASH + FFmpeg 拷贝合并）
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { config } = require('./config');
const log = require('./logger');

const mixinKeyEncTab = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52
];

function getMixinKey(orig) {
  return mixinKeyEncTab.map(n => orig[n]).join('').slice(0, 32);
}

// 缓存 WBI 签名 Key（避免每次搜索或请求直链都请求一次 nav）
let cachedWbi = {
  mixinKey: null,
  expiresAt: 0
};

function fetchWbiKeys() {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    if (cachedWbi.mixinKey && cachedWbi.expiresAt > now) {
      return resolve(cachedWbi.mixinKey);
    }
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://www.bilibili.com/'
    };
    if (config.BILI_COOKIE) {
      headers['Cookie'] = config.BILI_COOKIE;
    }
    const req = https.get('https://api.bilibili.com/x/web-interface/nav', { headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (!j.data || !j.data.wbi_img) {
            return reject(new Error('获取 WBI 签名密钥失败: 无 wbi_img 数据'));
          }
          const img = j.data.wbi_img.img_url.split('/').pop().split('.')[0];
          const sub = j.data.wbi_img.sub_url.split('/').pop().split('.')[0];
          const mixin = getMixinKey(img + sub);
          cachedWbi = {
            mixinKey: mixin,
            expiresAt: now + 12 * 3600 * 1000 // 缓存 12 小时
          };
          resolve(mixin);
        } catch(e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('WBI key fetch timeout')); });
  });
}

// 搜索 B 站视频
async function searchBilibili(keyword, page = 1) {
  if (!keyword || !keyword.trim()) return [];
  const mixinKey = await fetchWbiKeys();
  const wts = Math.floor(Date.now() / 1000);
  const params = {
    keyword: keyword.trim(),
    search_type: 'video',
    page: page,
    wts: wts
  };

  const sortedKeys = Object.keys(params).sort();
  const queryParts = [];
  for (const k of sortedKeys) {
    const val = String(params[k]).replace(/[!'()*]/g, '');
    queryParts.push(encodeURIComponent(k) + '=' + encodeURIComponent(val));
  }
  const queryStr = queryParts.join('&');
  const w_rid = crypto.createHash('md5').update(queryStr + mixinKey).digest('hex');

  const searchUrl = 'https://api.bilibili.com/x/web-interface/wbi/search/type?' + queryStr + '&w_rid=' + w_rid;

  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://www.bilibili.com/'
    };
    if (config.BILI_COOKIE) {
      headers['Cookie'] = config.BILI_COOKIE;
    } else {
      headers['Cookie'] = 'buvid3=xx;';
    }

    const req = https.get(searchUrl, { headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.code !== 0 || !j.data || !j.data.result) {
            log.warn('BILI', `搜索无结果或提示 code=${j.code}: ${j.message}`);
            return resolve([]);
          }
          const list = (j.data.result || []).map(r => ({
            bvid: r.bvid,
            title: r.title.replace(/<[^>]+>/g, ''), // 去除高亮 <em> 标签
            author: r.author,
            pic: r.pic.startsWith('http') ? r.pic : 'https:' + r.pic,
            duration: r.duration,
            play: r.play
          }));
          resolve(list);
        } catch(e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Search timeout')); });
  });
}

// 获取视频的分 P 列表
function getBilibiliParts(bvid) {
  return new Promise((resolve, reject) => {
    const url = `https://api.bilibili.com/x/player/pagelist?bvid=${encodeURIComponent(bvid)}`;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://www.bilibili.com/'
    };
    if (config.BILI_COOKIE) headers['Cookie'] = config.BILI_COOKIE;

    const req = https.get(url, { headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.code === 0 && Array.isArray(j.data)) {
            const parts = j.data.map(p => ({
              cid: p.cid,
              page: p.page,
              part: p.part || `第${p.page}P`,
              duration: p.duration
            }));
            resolve(parts);
          } else {
            resolve([]);
          }
        } catch(e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Pagelist timeout')); });
  });
}

// 缓存解析后的播放直链（短时间内同一视频无需重复请求 playurl）
const playUrlCache = new Map(); // key: bvid_cid -> { playInfo, expireAt }

// 参考 BBDown：利用 WBI 签名请求 DASH 分离音视频流，获得最高兼容性与音质
async function getPlayUrl(bvid, cid) {
  const cacheKey = `${bvid}_${cid}`;
  const hit = playUrlCache.get(cacheKey);
  if (hit && hit.expireAt > Date.now()) {
    return hit.playInfo;
  }

  const mixinKey = await fetchWbiKeys();
  const wts = Math.floor(Date.now() / 1000);
  const params = {
    bvid: String(bvid),
    cid: String(cid),
    fnval: 4048, // 开启 DASH、高规格音频与清晰度支持
    fnver: 0,
    fourk: 1,
    otype: 'json',
    qn: 80,      // 优先请求 1080P/720P
    try_look: 1,
    wts: wts
  };

  const sortedKeys = Object.keys(params).sort();
  const queryParts = [];
  for (const k of sortedKeys) {
    const val = String(params[k]).replace(/[!'()*]/g, '');
    queryParts.push(encodeURIComponent(k) + '=' + encodeURIComponent(val));
  }
  const queryStr = queryParts.join('&');
  const w_rid = crypto.createHash('md5').update(queryStr + mixinKey).digest('hex');
  const playUrl = 'https://api.bilibili.com/x/player/wbi/playurl?' + queryStr + '&w_rid=' + w_rid;

  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://www.bilibili.com/'
    };
    if (config.BILI_COOKIE) headers['Cookie'] = config.BILI_COOKIE;

    const req = https.get(playUrl, { headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.code !== 0 || !j.data) {
            return reject(new Error(j.message || `获取播放地址失败 code=${j.code}`));
          }

          let playInfo = null;

          // 1. 优先提取 DASH 格式流（音视频分离）
          if (j.data.dash) {
            const rawVideos = j.data.dash.video || [];
            // 优先选择 H.264/AVC 编码（广泛兼容浏览器硬解和快速 copy 切片，无 HEVC 授权与播放卡顿问题）
            const avcVideos = rawVideos.filter(v => (v.codecs && v.codecs.startsWith('avc1')) || v.codecid === 7);
            const candidates = avcVideos.length > 0 ? avcVideos : rawVideos;
            candidates.sort((a, b) => (b.id - a.id) || ((b.bandwidth || 0) - (a.bandwidth || 0)));

            const bestVideo = candidates[0];
            const vUrl = bestVideo ? (bestVideo.baseUrl || bestVideo.base_url || (bestVideo.backupUrl && bestVideo.backupUrl[0]) || (bestVideo.backup_url && bestVideo.backup_url[0])) : null;

            // 提取高品质音频轨
            const audios = [...(j.data.dash.audio || [])];
            audios.sort((a, b) => ((b.bandwidth || 0) - (a.bandwidth || 0)) || (b.id - a.id));
            const bestAudio = audios[0];
            const aUrl = bestAudio ? (bestAudio.baseUrl || bestAudio.base_url || (bestAudio.backupUrl && bestAudio.backupUrl[0]) || (bestAudio.backup_url && bestAudio.backup_url[0])) : null;

            if (vUrl && aUrl) {
              playInfo = {
                type: 'dash',
                videoUrl: vUrl,
                audioUrl: aUrl,
                quality: bestVideo.id,
                codecs: bestVideo.codecs
              };
            } else if (vUrl) {
              playInfo = {
                type: 'durl',
                url: vUrl,
                quality: bestVideo.id
              };
            }
          }

          // 2. 兜底传统单流 (durl)
          if (!playInfo && j.data.durl && j.data.durl[0]) {
            const durl = j.data.durl[0];
            const singleUrl = durl.url || (durl.backup_url && durl.backup_url[0]);
            if (singleUrl) {
              playInfo = {
                type: 'durl',
                url: singleUrl,
                quality: j.data.quality
              };
            }
          }

          if (!playInfo) {
            return reject(new Error('未找到可用的 B 站播放流'));
          }

          playUrlCache.set(cacheKey, {
            playInfo,
            expireAt: Date.now() + 60 * 60 * 1000 // 缓存 1 小时
          });

          resolve(playInfo);
        } catch(e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Playurl request timeout')); });
  });
}

// 下载 B 站视频到本地缓存目录（支持复用下载 Promise、DASH 音视频流快速合并封装）
const downloadingTasks = new Map();

function downloadBilibiliVideo(bvid, cid, cacheDir) {
  const key = `${bvid}_${cid}`;
  const targetFile = path.join(cacheDir, `${key}.mp4`);
  const tmpFile = path.join(cacheDir, `${key}.mp4.tmp`);

  // 1. 如果已存在有效文件（> 100KB），直接返回
  if (fs.existsSync(targetFile)) {
    try {
      const st = fs.statSync(targetFile);
      if (st.size > 100000) return Promise.resolve(targetFile);
    } catch(e) {}
  }

  // 2. 如果正在下载，直接复用任务
  if (downloadingTasks.has(key)) {
    return downloadingTasks.get(key);
  }

  const p = (async () => {
    log.info('BILI', `开始解析并下载 B 站视频: ${bvid} (cid: ${cid})`);
    const playInfo = await getPlayUrl(bvid, cid);

    const headersStr = 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\r\nReferer: https://www.bilibili.com/\r\n'
      + (config.BILI_COOKIE ? `Cookie: ${config.BILI_COOKIE}\r\n` : '');

    let args = [];
    if (playInfo.type === 'dash') {
      log.info('BILI', `使用 DASH 模式快速抓取封装音视频 (画质: ${playInfo.quality}, 编码: ${playInfo.codecs || 'avc1'})`);
      args = [
        '-loglevel', 'error',
        '-y',
        '-headers', headersStr,
        '-i', playInfo.videoUrl,
        '-headers', headersStr,
        '-i', playInfo.audioUrl,
        '-c:v', 'copy',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        '-f', 'mp4',
        tmpFile
      ];
    } else {
      log.info('BILI', `使用单流模式抓取 (画质: ${playInfo.quality})`);
      args = [
        '-loglevel', 'error',
        '-y',
        '-headers', headersStr,
        '-i', playInfo.url,
        '-c', 'copy',
        '-movflags', '+faststart',
        '-f', 'mp4',
        tmpFile
      ];
    }

    const t0 = Date.now();
    try {
      if (fs.existsSync(tmpFile)) {
        try { fs.unlinkSync(tmpFile); } catch(e) {}
      }

      await new Promise((resolve, reject) => {
        const ff = spawn(config.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let errBuf = '';
        ff.stderr.on('data', d => {
          errBuf += d.toString();
          if (errBuf.length > 2000) errBuf = errBuf.slice(-2000);
        });
        ff.on('close', code => {
          if (code === 0) resolve();
          else reject(new Error(`FFmpeg 下载合并退出码: ${code}, ${errBuf.slice(-300)}`));
        });
        ff.on('error', reject);
      });

      if (!fs.existsSync(tmpFile) || fs.statSync(tmpFile).size < 50000) {
        throw new Error('下载文件大小异常或未生成');
      }

      if (fs.existsSync(targetFile)) {
        try { fs.unlinkSync(targetFile); } catch(e) {}
      }
      fs.renameSync(tmpFile, targetFile);

      const sz = fs.statSync(targetFile).size;
      log.info('BILI', `B 站视频下载并封装完成 (${(sz / 1024 / 1024).toFixed(2)} MB, 耗时 ${Date.now() - t0}ms): ${targetFile}`);
      return targetFile;
    } catch(err) {
      try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch(e) {}
      log.error('BILI', `B 站视频下载失败: ${err.message}`);
      throw err;
    }
  })();

  downloadingTasks.set(key, p);
  p.finally(() => downloadingTasks.delete(key));
  return p;
}

// 代理转发 B 站 MP4 视频流（如果未缓存先拉取缓存，然后提供完备的 HTTP Range 206 寻址服务）
async function proxyBilibiliStream(req, res, bvid, cid) {
  try {
    const targetFile = await downloadBilibiliVideo(bvid, cid, config.BILI_CACHE_DIR);
    if (!fs.existsSync(targetFile)) {
      return res.status(404).end();
    }

    const stat = fs.statSync(targetFile);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4',
        'Cache-Control': 'no-store'
      });
      fs.createReadStream(targetFile, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
        'Cache-Control': 'no-store'
      });
      fs.createReadStream(targetFile).pipe(res);
    }
  } catch(e) {
    log.error('BILI', `B站流代理异常: ${e.message}`);
    if (!res.headersSent) res.status(502).end();
  }
}

// 代理获取 B 站封面图片（防盗链 Referer 处理及 302 重定向跟随）
function proxyImage(imgUrl, res, redirectCount = 0) {
  const defaultSvg = path.join(__dirname, '../web/icons/album.svg');
  if (!imgUrl || typeof imgUrl !== 'string' || !imgUrl.startsWith('http')) {
    return res.sendFile(defaultSvg);
  }
  if (redirectCount > 3) {
    return res.sendFile(defaultSvg);
  }

  try {
    const targetUrl = new URL(imgUrl);
    const client = targetUrl.protocol === 'https:' ? https : http;
    const req = client.get(imgUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.bilibili.com/'
      }
    }, proxyRes => {
      if ([301, 302, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
        let nextUrl = proxyRes.headers.location;
        if (nextUrl.startsWith('//')) nextUrl = targetUrl.protocol + nextUrl;
        return proxyImage(nextUrl, res, redirectCount + 1);
      }
      if (proxyRes.statusCode === 200) {
        res.set({
          'Content-Type': proxyRes.headers['content-type'] || 'image/jpeg',
          'Cache-Control': 'public, max-age=86400'
        });
        return proxyRes.pipe(res);
      }
      res.sendFile(defaultSvg);
    });

    req.on('error', () => {
      if (!res.headersSent) res.sendFile(defaultSvg);
    });
    req.setTimeout(6000, () => {
      req.destroy();
      if (!res.headersSent) res.sendFile(defaultSvg);
    });
  } catch (e) {
    if (!res.headersSent) res.sendFile(defaultSvg);
  }
}

module.exports = {
  searchBilibili,
  getBilibiliParts,
  getPlayUrl,
  proxyBilibiliStream,
  proxyImage,
  downloadBilibiliVideo
};
