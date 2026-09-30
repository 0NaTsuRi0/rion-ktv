// 独立曲库扫描工具 — 不启动完整服务器，仅运行一次扫描。
// 适用于：批量导入曲库后、定时任务触发扫描、调试扫描逻辑。
const db = require('./db');

async function main() {
  // 等待数据库就绪（sql.js WASM 加载）
  await db.ready;
  const { scanLibrary } = require('./scanner');
  console.log('=== 骏耀K歌 曲库扫描工具 ===');
  console.log('');
  const t0 = Date.now();
  const result = await scanLibrary();
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('');
  console.log('扫描完成！');
  console.log(`  总文件: ${result.total}`);
  console.log(`  新增:   ${result.added}`);
  console.log(`  移除:   ${result.removed}`);
  console.log(`  耗时:   ${elapsed}s`);
  if (result.error) {
    console.log(`  错误:   ${result.error}`);
  }
  process.exit(0);
}

main().catch(e => {
  console.error('扫描失败:', e.message);
  process.exit(1);
});
