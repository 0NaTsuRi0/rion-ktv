// 集中化配置模块 —— 所有路径、环境变量、ffmpeg 路径的统一入口。
// 替代原来散落在各文件里的 process.env.XXX || '/xxx' 写法。
const path = require('path');
const fs = require('fs');

// 尝试加载项目根目录的 .env 文件（如果存在）
try {
  const dotenvPath = path.resolve(__dirname, '..', '.env');
  if (fs.existsSync(dotenvPath)) {
    const lines = fs.readFileSync(dotenvPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (key && !process.env[key]) {
        process.env[key] = val;
      }
    }
  }
  // 如果 .env 不存在，从 .env.example 生成
  if (!fs.existsSync(dotenvPath)) {
    const examplePath = path.resolve(__dirname, '..', '.env.example');
    if (fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, dotenvPath);
      // 重新加载
      const lines = fs.readFileSync(dotenvPath, 'utf-8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (key && !process.env[key]) process.env[key] = val;
      }
    }
  }
} catch (e) {
  // .env 加载失败不阻止启动
}

// 项目根目录（rion-ktv/）
const ROOT = path.resolve(__dirname, '..');

// 把相对路径解析为绝对路径（相对于项目根目录）
function resolveDir(envVal, defaultRel) {
  const raw = envVal || defaultRel;
  return path.isAbsolute(raw) ? raw : path.resolve(ROOT, raw);
}

const DATA_DIR = resolveDir(process.env.DATA_DIR, 'data');
const HLS_DIR = resolveDir(process.env.HLS_DIR, 'data/hls');
const COVERS_DIR = resolveDir(process.env.COVERS_DIR, 'data/covers');
const BILI_CACHE_DIR = resolveDir(process.env.BILI_CACHE_DIR, 'data/bili_cache');
const MV_DIR = resolveDir(process.env.MV_DIR, 'songs');

const config = {
  PORT: Number(process.env.PORT) || 8080,
  DATA_DIR,
  MV_DIR,
  HLS_DIR,
  COVERS_DIR,
  BILI_CACHE_DIR,
  HLS_CACHE_MAX_AGE_DAYS: Number(process.env.HLS_CACHE_MAX_AGE_DAYS) || 3,
  WATCH_ENABLED: process.env.WATCH_ENABLED !== 'false',
  WATCH_DEBOUNCE_MS: Number(process.env.WATCH_DEBOUNCE_MS) || 5000,
  VAAPI_DEVICE: process.env.VAAPI_DEVICE || '/dev/dri/renderD128',
  ADMIN_AUTH_ENABLED: process.env.ADMIN_AUTH !== 'false' && process.env.ADMIN_AUTH_ENABLED !== 'false' && process.env.ADMIN_NO_AUTH !== 'true',
  BILI_COOKIE: process.env.BILI_COOKIE || '',

  get ffmpegPath() { return process.env.FFMPEG_PATH || 'ffmpeg'; },
  get ffprobePath() { return process.env.FFPROBE_PATH || 'ffprobe'; },
  get pymssPython() { return process.env.PYMSS_PYTHON || ''; },
  get pymssSrc() { return process.env.PYMSS_SRC || ''; },
};

// 启动时自动创建必要的运行时目录
function ensureDirs() {
  const dirs = [config.DATA_DIR, config.HLS_DIR, config.BILI_CACHE_DIR];
  for (const d of dirs) {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
    }
  }
}

module.exports = { config, ensureDirs };
