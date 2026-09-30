// 文件系统监听模块 —— MV 目录文件变化时自动触发增量扫描。
// 使用 fs.watch 实现（Node.js 内置，无需额外依赖）。
// Windows 下对网络驱动器可能不够稳定，但本地目录工作正常。
const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const log = require('./logger');

let watcher = null;
let scanTimer = null;
let scanInProgress = false;

// 递归监听目录（手动实现，因为 fs.watch 的 recursive 选项在 Windows 上不稳定）
function watchRecursive(dir, callback) {
  const watchers = [];

  function watchDir(d) {
    if (!fs.existsSync(d)) return;
    try {
      const w = fs.watch(d, { persistent: true }, (eventType, filename) => {
        if (filename) {
          const fullPath = path.join(d, filename);
          callback(eventType, fullPath);
          // 如果是新增目录，开始监听它
          if (eventType === 'rename') {
            try {
              const st = fs.statSync(fullPath);
              if (st.isDirectory()) {
                watchDir(fullPath);
              }
            } catch (e) { /* 文件可能已被删除 */ }
          }
        }
      });
      watchers.push(w);

      // 递归监听子目录
      try {
        const entries = fs.readdirSync(d, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            watchDir(path.join(d, entry.name));
          }
        }
      } catch (e) { /* 读取子目录失败，跳过 */ }
    } catch (e) {
      log.warn('WATCH', `无法监听目录: ${d}: ${e.message}`);
    }
  }

  watchDir(dir);
  return watchers;
}

function startWatcher(scanCallback) {
  if (!config.WATCH_ENABLED) {
    log.info('WATCH', '文件变更监控已禁用 (WATCH_ENABLED=false)');
    return null;
  }

  const mvDir = config.MV_DIR;
  if (!fs.existsSync(mvDir)) {
    log.warn('WATCH', `监控目录不存在，30 秒后重试: ${mvDir}`);
    const retryTimer = setTimeout(() => startWatcher(scanCallback), 30000);
    retryTimer.unref();
    return retryTimer;
  }

  // 过滤：只处理视频文件
  const VIDEO_EXT = new Set(['.mp4', '.mkv', '.avi', '.flv', '.mov', '.webm', '.mpg']);

  const debouncedScan = (eventType, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    // 只关心视频文件变化
    if (!VIDEO_EXT.has(ext)) return;

    const relPath = path.relative(mvDir, filePath);
    log.info('WATCH', `检测到文件变动: ${eventType} ${relPath}`);

    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(async () => {
      if (scanInProgress) {
        log.info('WATCH', '上一次扫描仍在进行中，延后本次触发');
        // 重新设置定时器
        if (scanTimer) clearTimeout(scanTimer);
        scanTimer = setTimeout(() => debouncedScan('retry', filePath), config.WATCH_DEBOUNCE_MS);
        scanTimer.unref();
        return;
      }
      scanInProgress = true;
      try {
        const result = await scanCallback();
        log.info('WATCH', `自动扫描完成: 共 ${result.total} 文件, 新增 ${result.added}, 移除 ${result.removed}`);
      } catch (e) {
        log.error('WATCH', `自动扫描失败: ${e.message}`);
      } finally {
        scanInProgress = false;
      }
    }, config.WATCH_DEBOUNCE_MS);
    scanTimer.unref();
  };

  const watchers = watchRecursive(mvDir, debouncedScan);
  watcher = watchers; // 设置模块级变量供 getWatcherStatus 查询

  log.info('WATCH', `文件变更监控已启动 (${mvDir}, 防抖 ${config.WATCH_DEBOUNCE_MS}ms)`);
  return watchers;
}

function stopWatcher(w) {
  if (w) {
    if (Array.isArray(w)) {
      w.forEach(watcher => {
        try { watcher.close(); } catch (e) { /* ignore */ }
      });
    } else if (typeof w.close === 'function') {
      try { w.close(); } catch (e) { /* ignore */ }
    } else if (typeof w === 'object' && w._idleTimeout !== undefined) {
      // setTimeout 返回值
      clearTimeout(w);
    }
  }
  if (scanTimer) {
    clearTimeout(scanTimer);
    scanTimer = null;
  }
}

function getWatcherStatus() {
  return {
    enabled: config.WATCH_ENABLED,
    watching: watcher !== null,
    mvDir: config.MV_DIR,
    debounceMs: config.WATCH_DEBOUNCE_MS,
    scanInProgress,
  };
}

module.exports = { startWatcher, stopWatcher, getWatcherStatus };
