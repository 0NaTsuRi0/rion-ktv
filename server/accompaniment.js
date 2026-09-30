// AI 伴奏生成模块 —— 使用 pymss 的 karaoke 模型分离人声生成伴奏
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const log = require('./logger');
const db = require('./db');
const { config } = require('./config');

const KARAOKE_MODEL = 'bs_roformer_karaoke_anvuew';
// 伴奏存储在歌曲所在文件夹内

const running = new Map(); // songId -> Promise
const progress = new Map(); // songId -> { pct, status }

// 对单首歌曲生成伴奏
async function generateAccompaniment(songId) {
  if (running.has(songId)) return running.get(songId);

  const promise = (async () => {
    const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(songId);
    if (!song) throw new Error('歌曲不存在');
    if (song.accompaniment && fs.existsSync(song.accompaniment)) {
      log.info('ACCOMP', `歌曲 id=${songId} 已有伴奏，跳过`);
      return song.accompaniment;
    }
    progress.set(songId, { pct: 0, status: '初始化中...' });

    const input = song.filepath;
    const tmpDir = path.join(config.DATA_DIR, 'accompaniments', '.tmp_' + songId);
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      // 用 pymss infer 生成伴奏
      progress.set(songId, { pct: 0, status: '正在加载模型...' });
      log.info('ACCOMP', `开始分离人声: id=${songId} "${song.title}"`);
      await runPython([
        '-c', `
import sys, json
sys.path.insert(0, ${JSON.stringify(config.pymssSrc)})
from pymss.cli import main
sys.exit(main(["infer", ${JSON.stringify(KARAOKE_MODEL)}, "-i", ${JSON.stringify(input)}, "-o", ${JSON.stringify(tmpDir)}, "--format", "mp3", "--device", "cuda"]))
        `
      ], 600000, songId); // 10 分钟超时

      // pymss 输出格式：tmpDir/{model_name}/{stem}/filename.mp3
      // karaoke 模型输出 backing_vocal（伴奏）和 vocals（人声）
      let accFile = findFile(tmpDir, ['backing_vocal', 'instrumental']);
      if (!accFile) {
        accFile = findLargestAudio(tmpDir);
      }

      if (!accFile || !fs.existsSync(accFile)) throw new Error('未找到生成的伴奏文件');

      // 复制到歌曲所在文件夹，带歌手和歌名
      const songDir = path.dirname(song.filepath);
      const safeBase = ((song.artist||'未知歌手') + ' - ' + (song.title||'unknown')).replace(/[<>:"/\\|?*]/g, '_');
      const accExt = path.extname(accFile);
      const outName = safeBase + '_伴奏' + accExt;
      const outPath = path.join(songDir, outName);
      fs.copyFileSync(accFile, outPath);

      // 更新数据库
      db.prepare('UPDATE songs SET accompaniment = ? WHERE id = ?').run(outPath, songId);
      // 清除 HLS 缓存，下次播放重新生成含伴奏的音轨
      try { require('./hlsgen').removeHLS(songId); } catch(e) {}
      progress.set(songId, { pct: 100, status: '完成' });
      log.info('ACCOMP', `伴奏生成完成: id=${songId} "${song.title}" -> ${outPath}`);

      return outPath;
    } catch (e) {
      progress.set(songId, { pct: -1, status: '失败: ' + e.message });
      running.delete(songId);
      throw e;
    } finally {
      // 清理临时文件
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
      running.delete(songId);
    }
  })();

  running.set(songId, promise);
  return promise;
}

function runPython(args, timeout = 300000, progId = null) {
  const py = config.pymssPython;
  const src = config.pymssSrc;
  if (!py || !fs.existsSync(py)) return Promise.reject(new Error('PYMSS_PYTHON 未配置或路径不存在'));
  if (!src || !fs.existsSync(src)) return Promise.reject(new Error('PYMSS_SRC 未配置或路径不存在'));
  return new Promise((resolve, reject) => {
    const proc = spawn(py, args, { timeout, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => {
      const text = d.toString();
      err += text;
      if (progId) {
        const pctMatch = text.match(/(\d+)%\s*\|/);
        if (pctMatch) {
          progress.set(progId, { pct: parseInt(pctMatch[1]), status: '分离中...' });
        } else if (text.includes('Processing')) {
          progress.set(progId, { pct: progress.get(progId)?.pct || 0, status: '处理中...' });
        }
      }
    });
    proc.on('close', code => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`pymss exit ${code}: ${err.slice(-1000)}`));
    });
    proc.on('error', reject);
  });
}

function findFile(dir, names) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        const sub = findFile(path.join(dir, e.name), names);
        if (sub) return sub;
      }
      if (e.isFile() && names.some(n => e.name.toLowerCase().includes(n))) {
        return path.join(dir, e.name);
      }
    }
  } catch (e) { /* ignore */ }
  return null;
}

function findLargestAudio(dir) {
  let best = null, bestSize = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const sub = findLargestAudio(full);
        if (sub) { const sz = fs.statSync(sub).size; if (sz > bestSize) { best = sub; bestSize = sz; } }
      }
      if (e.isFile() && /\.(mp3|wav|flac|m4a)$/i.test(e.name)) {
        const sz = fs.statSync(full).size;
        if (sz > bestSize) { best = full; bestSize = sz; }
      }
    }
  } catch (e) { /* ignore */ }
  return best;
}

function getGenerationStatus() {
  const details = {};
  for (const [id, p] of progress) {
    details[id] = p;
    // 清理已完成或失败的记录
    if (p.pct === 100 || p.pct === -1) setTimeout(() => progress.delete(id), 60000);
  }
  return {
    running: Array.from(running.keys()),
    count: running.size,
    progress: details,
  };
}

module.exports = { generateAccompaniment, getGenerationStatus };
