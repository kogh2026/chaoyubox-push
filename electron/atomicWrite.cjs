// 原子写盘核心实现（方案 C）： write tmp → fsync → rename。
// 从 main.cjs 抽出来成独立模块，是为了能在真实文件系统上做验证 ——
// main.cjs 顶部 require('electron')，纯 Node 环境根本加载不了。
const path = require('path');
const fs = require('fs');

// Windows 文件名非法字符 + 控制字符
const ILLEGAL_CHARS = /[\\/:*?"<>|]/g;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** 文件名净化（渲染进程已做一遍，这里是纵深防御：IPC 边界不可信） */
function sanitizeFileName(raw, maxLen = 120) {
  const input = String(raw ?? '');
  const dot = input.lastIndexOf('.');
  let stem = dot > 0 ? input.slice(0, dot) : input;
  let ext = dot > 0 ? input.slice(dot) : '';
  const clean = (s) => s.replace(CONTROL_CHARS, '').replace(ILLEGAL_CHARS, '_').replace(/\s+/g, ' ').trim();
  stem = clean(stem);
  ext = clean(ext).replace(/\.+$/, '');
  if (ext && ext.length > 16) ext = ext.slice(0, 16);
  if (RESERVED_NAME.test(stem)) stem = `_${stem}`;
  stem = stem.replace(/^\.+/, '');
  const stemMax = Math.max(1, maxLen - ext.length);
  if (stem.length > stemMax) stem = stem.slice(0, stemMax);
  stem = stem.replace(/[\s.]+$/, '');
  if (!stem) stem = '未命名';
  return stem + ext;
}

/**
 * 列出目录里已存在的文件名（小写集合）。
 * 批量导出前先取一次快照，避免每个文件各 fs.stat 一次，也让跨 workers 的占用判断有个共同起点。
 * 读不到（目录被移走 / 权限异常）时返回空集合 —— 此时宁可退化成「可能重名」，
 * 也不能因为嗅探失败就把整个批量导出拦下来。
 */
function listTaken(dir) {
  const taken = new Set();
  try {
    for (const entry of fs.readdirSync(dir)) taken.add(String(entry).toLowerCase());
  } catch {
    /* 目录读不到：按空目录处理 */
  }
  return taken;
}

/**
 * 目标文件名已被占用时，按顺序追加「 (1)」「 (2)」…，返回最终可用的名字。
 *
 * 为什么需要它：改造前由 Chromium 下载管理器落盘，遇到同名会自动变成「xx (1).pdf」；
 * 改成自带 write tmp + rename 之后变成静默覆盖 —— 图文店改参数重导一批，上一次的结果就没了。
 * 这里刻意沿用浏览器的旧行为（不覆盖、自动顺延），代价是可能多几个文件，
 * 但比起丢掉已经做好的活，多一个文件要好得多。
 *
 * 刻意不去触碰 writeFileAtomic 的「存在即覆盖」语义：那是底层原语，
 * 换名策略属于它上一层的选择（将来若要支持「覆盖」也在这里加开关即可）。
 *
 * @param taken 已被占用的名字集合（小写）。会就地写入本次选定的名字，
 *              保证同一批次内不会有两个文件抢到同一个候选名。
 *              Windows/NTFS 大小写不敏感，故统一用小写比较。
 */
function pickFreeName(taken, name) {
  const raw = String(name ?? '');
  if (raw && !taken.has(raw.toLowerCase())) {
    taken.add(raw.toLowerCase());
    return raw;
  }
  const dot = raw.lastIndexOf('.');
  const stem = dot > 0 ? raw.slice(0, dot) : raw;
  const ext = dot > 0 ? raw.slice(dot) : '';
  for (let i = 1; i < 9999; i++) {
    const cand = `${stem} (${i})${ext}`;
    if (!taken.has(cand.toLowerCase())) {
      taken.add(cand.toLowerCase());
      return cand;
    }
  }
  // 极端情况（同目录已堆了近万个同名文件）：用时间戳兜底，总比覆盖掉别人强
  const fallback = `${stem} (${Date.now()})${ext}`;
  taken.add(fallback.toLowerCase());
  return fallback;
}

/** 阻止文件名里的 ../ 逃出目标目录（即使净化已替换斜杠，仍做最后一道校验） */
function assertInside(dir, target) {
  const root = path.resolve(dir);
  const full = path.resolve(target);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw Object.assign(new Error('refuse to write outside target dir'), { code: 'EACCES' });
  }
}

/** IPC 传来的 Uint8Array/ArrayBuffer → Buffer（零拷贝视图，不额外复制一份） */
function toBuffer(data) {
  if (!data) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.alloc(0);
}

/**
 * Windows 上目标被占用（PDF 阅读器预览 / 杀软扫描 / 索引服务）时 rename 会 EBUSY 或 EPERM，
 * 这类竞争通常几十毫秒内自行消失，重试几次即可。
 */
async function renameWithRetry(from, to, tries = 5) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fs.promises.rename(from, to);
    } catch (e) {
      lastErr = e;
      const retryable = e && (e.code === 'EBUSY' || e.code === 'EPERM');
      if (!retryable || i === tries - 1) break;
      await new Promise((r) => setTimeout(r, 120 * (i + 1)));
    }
  }
  throw lastErr;
}

/** 把底层 errno 翻译成用户看得懂的话 —— 这是选 C 方案最重要的收益 */
function translateFsError(e, target) {
  const code = String((e && e.code) || '');
  const base = path.basename(target || '');
  switch (code) {
    case 'ENOSPC':
      return { code: 'enospc', error: '磁盘空间不足，请清理后重试' };
    case 'EBUSY':
    case 'EPERM':
      return { code: 'ebusy', error: `目标文件被占用，请先关闭已打开的「${base}」再重试` };
    case 'EACCES':
      return { code: 'eacces', error: '没有写入该目录的权限，请换一个保存位置' };
    case 'EROFS':
      return { code: 'erofs', error: '目标位置只读（光盘 / 写保护的 U 盘），请换一个保存位置' };
    case 'ENOENT':
      return { code: 'enoent', error: '保存目录不存在或已被移除，请重新选择' };
    default:
      return { code: 'unknown', error: `保存失败：${(e && e.message) || String(e)}` };
  }
}

/**
 * 写前扣一次可用空间，避免在磁盘快满时写完才发现白干。
 * statvfs 需要 Node 18+，不支持的平台自动跳过（误判比漏判更糟糕）。
 */
async function ensureDiskSpace(target, need) {
  try {
    if (typeof fs.promises.statvfs !== 'function') return;
    const st = await fs.promises.statvfs(path.dirname(target));
    const free = Number(st.bavail) * Number(st.bsize);
    if (!isFinite(free)) return;
    let existing = 0;
    try {
      // 只统计「普通文件」的大小：目标恰好是同名目录时 size 没有意义，
      // 而且 rename 到目录会失败，那属于另一种错误，不该在这里用大小糊过去。
      const s = fs.statSync(target);
      if (s.isFile()) existing = s.size;
    } catch {
      existing = 0; // 目标不存在：所需空间就是全部
    }
    if (free + existing < need) {
      throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    }
  } catch (e) {
    if (e && e.code === 'ENOSPC') throw e;
    // 其它异常（目录还没建、平台不支持）：交给后续 writeFile 报更准确的错
  }
}

/**
 * 原子写：同目录临时文件 → fsync 落盘 → rename 替换目标。
 * tmp 与 target 必须在同一分区，rename 才是原子操作 —— 这里天然满足（同目录）。
 * 因此目标路径上永远只有「旧完整文件」或「新完整文件」，不会出现写到一半的内容。
 */
async function writeFileAtomic(target, buf) {
  const dir = path.dirname(target);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(target)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  const fh = await fs.promises.open(tmp, 'w');
  try {
    await fh.writeFile(buf);
    try {
      await fh.sync(); // 确保数据真的到了介质上，而不是只躺在页缓存里
    } catch {
      // 少数平台/文件系统不支持 fsync，忽略即可（rename 的原子性仍然有效）
    }
  } finally {
    await fh.close().catch(() => {});
  }
  try {
    await renameWithRetry(tmp, target);
  } catch (e) {
    await fs.promises.unlink(tmp).catch(() => {}); // 清理残留，不留垃圾
    throw e;
  }
  return target;
}

/**
 * 受限并发。磁盘 IO 不像网络请求能靠并发摊薄延迟：
 * 3 条已经足够把 open/fsync 的等待掩盖掉，再高机械盘/U 盘反而降速。
 */
async function pool(items, limit, run) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await run(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

module.exports = {
  sanitizeFileName,
  listTaken,
  pickFreeName,
  assertInside,
  toBuffer,
  renameWithRetry,
  writeFileAtomic,
  translateFsError,
  ensureDiskSpace,
  pool,
};
