// 数据库模块 —— 使用 sql.js (WASM 版 SQLite)，无需原生编译。
// 提供与 better-sqlite3 兼容的同步 API（prepare/run/get/all/exec/transaction）。
//
// sql.js 加载 WASM 是异步的，所以使用 Proxy 模式：
// 其他模块 can require('./db') 同步获取，但实际 db 操作
// 必须等 index.js 中 await db.ready 之后进行。
// 由于所有 db 操作都是在 server.listen 之后的请求处理中触发，
// 这个延迟不会造成问题。

const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');
const { config, ensureDirs } = require('./config');

ensureDirs();

const DATA_DIR = config.DATA_DIR;
const DB_PATH = path.join(DATA_DIR, 'ktv.db');

// ---- sql.js 兼容层 ----
// 将 @param 转为 :param（sql.js 不支持 @param 语法）
function _convSQL(sql) {
  return sql.replace(/@(\w+)/g, ':$1');
}
function _convBind(params) {
  // sql.js bind 只接受数组（位置参数）或对象（命名参数）
  if (params === undefined || params === null) return [];
  if (Array.isArray(params)) return params;
  if (typeof params === 'object') {
    const out = {};
    for (const key of Object.keys(params)) {
      out[':' + key.replace(/^@/, '')] = params[key];
    }
    return out;
  }
  // 标量值（如 db.prepare('...').get(1)）→ 包装为数组
  return [params];
}

function _saveToDisk(rawDb) {
  try {
    const data = rawDb.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (e) {
    console.error('数据库保存失败:', e.message);
  }
}

let _saveTimer = null;
function _autoSave(rawDb) {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => _saveToDisk(rawDb), 200);
}

function _lastInsertId(rawDb) {
  try {
    const r = rawDb.exec('SELECT last_insert_rowid() as id');
    return (r.length && r[0].values.length) ? r[0].values[0][0] : 0;
  } catch (e) { return 0; }
}

// 包装 raw sql.js Database -> better-sqlite3 风格的 API 对象
function wrapDB(rawDb) {
  return {
    prepare(sql) {
      const cvt = _convSQL(sql);
      return {
        // 支持变参: run(a, b, c) → bind([a, b, c])
        run(...args) {
          rawDb.run(cvt, _convBind(args.length <= 1 ? args[0] : args));
          _autoSave(rawDb);
          return { changes: rawDb.getRowsModified(), lastInsertRowid: _lastInsertId(rawDb) };
        },
        get(...args) {
          const stmt = rawDb.prepare(cvt);
          stmt.bind(_convBind(args.length <= 1 ? args[0] : args));
          let row = undefined;
          if (stmt.step()) row = stmt.getAsObject();
          stmt.free();
          return row;
        },
        all(...args) {
          const stmt = rawDb.prepare(cvt);
          stmt.bind(_convBind(args.length <= 1 ? args[0] : args));
          const rows = [];
          while (stmt.step()) rows.push(stmt.getAsObject());
          stmt.free();
          return rows;
        },
      };
    },
    exec(sql) {
      rawDb.run(sql);
      _autoSave(rawDb);
    },
    pragma(sql) {
      try { rawDb.run(sql); _autoSave(rawDb); } catch (e) { /* ignore */ }
    },
    transaction(fn) {
      return (...args) => {
        rawDb.run('BEGIN');
        try { const r = fn(...args); rawDb.run('COMMIT'); _autoSave(rawDb); return r; }
        catch (e) { try { rawDb.run('ROLLBACK'); } catch (r) {} throw e; }
      };
    },
    save() { _saveToDisk(rawDb); },
    // 用于直接获取底层 raw db（调试/特殊用途）
    _raw: rawDb,
  };
}

// ---- 初始化 ----
let _wrappedDB = null;        // wrapDB 包装后的 db（better-sqlite3 兼容）
let _readyPromise = null;     // 初始化 Promise

async function _init() {
  const SQL = await initSqlJs();
  let buffer = null;
  if (fs.existsSync(DB_PATH)) {
    try { buffer = new Uint8Array(fs.readFileSync(DB_PATH)); }
    catch (e) { console.error('读取数据库文件失败，创建新库:', e.message); }
  }
  const rawDB = new SQL.Database(buffer);
  const db = wrapDB(rawDB);
  _createTables(db);
  _wrappedDB = db;
  _readyPromise = null;
  console.log('数据库初始化完成: ' + DB_PATH);
  return db;
}

function _createTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS songs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      artist TEXT,
      filename TEXT UNIQUE NOT NULL,
      filepath TEXT NOT NULL,
      cover TEXT,
      duration INTEGER,
      pinyin TEXT,
      play_count INTEGER DEFAULT 0,
      audio_tracks INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      song_id INTEGER NOT NULL,
      nickname TEXT DEFAULT '匿名用户',
      is_top INTEGER DEFAULT 0,
      status TEXT DEFAULT 'waiting',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (song_id) REFERENCES songs(id)
    );
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      song_id INTEGER NOT NULL,
      nickname TEXT,
      played_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      song_id INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(song_id, device_id)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  // Migration: audio_tracks
  try {
    const cols = db.prepare("PRAGMA table_info(songs)").all().map(c => c.name);
    if (!cols.includes('audio_tracks')) {
      db.exec('ALTER TABLE songs ADD COLUMN audio_tracks INTEGER');
    }
  } catch (e) { console.error('音轨字段迁移失败:', e.message); }
  // v2.0.0: video metadata
  try {
    const cols = db.prepare("PRAGMA table_info(songs)").all().map(c => c.name);
    if (!cols.includes('video_codec')) db.exec('ALTER TABLE songs ADD COLUMN video_codec TEXT');
    if (!cols.includes('audio_codec')) db.exec('ALTER TABLE songs ADD COLUMN audio_codec TEXT');
    if (!cols.includes('width')) db.exec('ALTER TABLE songs ADD COLUMN width INTEGER');
    if (!cols.includes('height')) db.exec('ALTER TABLE songs ADD COLUMN height INTEGER');
  } catch (e) { console.error('视频元数据字段迁移失败:', e.message); }
  // v2.0.0: 伴奏文件路径
  try {
    const cols = db.prepare("PRAGMA table_info(songs)").all().map(c => c.name);
    if (!cols.includes('accompaniment')) {
      db.exec('ALTER TABLE songs ADD COLUMN accompaniment TEXT');
    }
  } catch (e) { console.error('伴奏字段迁移失败:', e.message); }
}

// ---- Proxy 导出 ----
// 所有 db 方法调用被代理到一个延迟初始化的实例上。
// 调用者可以同步 const db = require('./db')，然后 db.prepare(...)
// 但前提是 await db.ready 已经完成。

module.exports = new Proxy({}, {
  get(target, prop) {
    // 特殊属性直接处理
    if (prop === 'ready') {
      if (!_readyPromise) _readyPromise = _init();
      return _readyPromise;
    }
    if (prop === '_wrappedDB') return _wrappedDB;
    // 其他属性从 _wrappedDB 转发
    if (!_wrappedDB) {
      throw new Error('数据库尚未初始化，请确保 await db.ready 之后再调用数据库操作');
    }
    const val = _wrappedDB[prop];
    if (typeof val === 'function') return val.bind(_wrappedDB);
    return val;
  }
});
