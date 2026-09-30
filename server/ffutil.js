// 共享的 ffmpeg / ffprobe 调用工具。
// 从 hlsgen.js 和 scanner.js 中提取，消除重复代码。
const { spawn, execFileSync } = require('child_process');
const { config } = require('./config');

// 异步执行 ffmpeg，返回 Promise。适用于耗时较长的转码任务。
function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn(config.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errBuf = '';
    ff.stderr.on('data', d => {
      errBuf += d.toString();
      if (errBuf.length > 4000) errBuf = errBuf.slice(-4000);
    });
    ff.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${errBuf.slice(-500)}`));
    });
    ff.on('error', reject);
  });
}

// 同步执行 ffprobe，返回 stdout 字符串。适用于快速探测任务。
function runFFprobe(args, opts = {}) {
  return execFileSync(config.ffprobePath, args, {
    timeout: opts.timeout || 15000,
    encoding: 'utf-8',
  }).toString();
}

// 用 ffprobe 的 JSON 输出一次性提取视频元数据（时长/编码/分辨率）
function probeVideoMeta(filepath) {
  const out = runFFprobe([
    '-v', 'error',
    '-print_format', 'json',
    '-show_entries', 'format=duration',
    '-show_entries', 'stream=codec_name,codec_type,width,height',
    filepath,
  ]);

  let duration = null, videoCodec = null, audioCodec = null, width = null, height = null;

  try {
    const data = JSON.parse(out);

    if (data.format && data.format.duration) {
      duration = Math.round(parseFloat(data.format.duration));
    }

    if (Array.isArray(data.streams)) {
      for (const s of data.streams) {
        if (s.codec_type === 'video' && !videoCodec) {
          videoCodec = s.codec_name || null;
          width = s.width || null;
          height = s.height || null;
        } else if (s.codec_type === 'audio' && !audioCodec) {
          audioCodec = s.codec_name || null;
        }
      }
    }
  } catch (e) {
    // JSON 解析失败，返回空值
  }

  return { duration, videoCodec, audioCodec, width, height };
}

module.exports = { runFFmpeg, runFFprobe, probeVideoMeta };
