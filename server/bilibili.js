// B站视频搜索、分P解析与流媒体转发模块
const https = require('https');
const http = require('http');
const crypto = require('crypto');
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

// 缓存 WBI 签名 Key（避免每次搜索都请求一次 nav）
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
    const req = https.get('https://api.bilibili.com/x/web-interface/nav', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.bilibili.com'
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
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
    const req = https.get(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Cookie': 'buvid3=xx;'
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.code !== 0 || !j.data || !j.data.result) {
            log.warn('BILI', `搜索无结果或报错 code=${j.code}: ${j.message}`);
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
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.bilibili.com'
      }
    }, res => {
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

// 缓存解析后的真实播放直链（短时间内同一视频无需重复请求 playurl）
const playUrlCache = new Map(); // key: bvid_cid -> { url, expireAt }

function getPlayUrl(bvid, cid) {
  const cacheKey = `${bvid}_${cid}`;
  const hit = playUrlCache.get(cacheKey);
  if (hit && hit.expireAt > Date.now()) {
    return Promise.resolve(hit.url);
  }

  return new Promise((resolve, reject) => {
    const url = `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}&qn=64&fnval=0`;
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.bilibili.com'
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.code === 0 && j.data && j.data.durl && j.data.durl[0]) {
            const rawUrl = j.data.durl[0].url;
            playUrlCache.set(cacheKey, {
              url: rawUrl,
              expireAt: Date.now() + 90 * 60 * 1000 // B站临时直链一般 2 小时有效
            });
            resolve(rawUrl);
          } else {
            reject(new Error(j.message || '获取播放地址失败'));
          }
        } catch(e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Playurl timeout')); });
  });
}

// 代理转发 B 站 MP4 视频流（支持 HTTP Range 请求）
async function proxyBilibiliStream(req, res, bvid, cid) {
  try {
    const streamUrl = await getPlayUrl(bvid, cid);
    const targetUrl = new URL(streamUrl);

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://www.bilibili.com/'
    };

    // 透传客户端的 Range 头（实现视频任意寻址/拖动进度条）
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    const client = targetUrl.protocol === 'https:' ? https : http;
    const proxyReq = client.get(streamUrl, { headers }, proxyRes => {
      // 传递状态码（200 或 206 Partial Content）
      res.status(proxyRes.statusCode);

      const passHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
      for (const h of passHeaders) {
        if (proxyRes.headers[h]) {
          res.setHeader(h, proxyRes.headers[h]);
        }
      }
      res.setHeader('Cache-Control', 'no-store');

      proxyRes.pipe(res);
      proxyRes.on('error', err => {
        log.error('BILI', `B站流传输错误: ${err.message}`);
        if (!res.headersSent) res.status(502).end();
      });
    });

    proxyReq.on('error', err => {
      log.error('BILI', `代理请求发起错误: ${err.message}`);
      if (!res.headersSent) res.status(502).end();
    });

    req.on('close', () => {
      proxyReq.destroy();
    });
  } catch(e) {
    log.error('BILI', `解析B站播放地址异常: ${e.message}`);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
}

module.exports = {
  searchBilibili,
  getBilibiliParts,
  getPlayUrl,
  proxyBilibiliStream
};
