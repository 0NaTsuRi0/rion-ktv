// 视频元数据提取模块（便捷 re-export，核心实现在 ffutil.js）
const { probeVideoMeta } = require('./ffutil');
module.exports = { probeVideoMeta };
