#!/usr/bin/env node
/**
 * 下载 B 站指定视频的全部分 P 弹幕，按分 P 名称导出为 B 站标准 XML。
 *
 * 用法：
 *   node scripts/bilibili-danmaku-download.mjs <视频链接|BV号|av号>
 *   node scripts/bilibili-danmaku-download.mjs https://www.bilibili.com/video/av117227776903200
 *   node scripts/bilibili-danmaku-download.mjs BV1JMbw62E72 -o ./danmaku --pages 1-3,5
 *
 * Cookie 优先读取命令行 --cookie，其次读取环境变量 BILIBILI_COOKIE，
 * 也会自动尝试加载 config/.env 与根目录 .env。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { parseDanmakuBase64 } from '../danmu_api/utils/codec-util.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_OUTPUT_DIR = path.join(ROOT_DIR, '.cache', 'bilibili_danmaku');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SEGMENT_SECONDS = 360;
const VIEW_API = 'https://api.bilibili.com/x/web-interface/view';
const SEGMENT_API = 'https://api.bilibili.com/x/v2/dm/web/seg.so';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 解析视频链接 / BV号 / av号 / 纯数字 aid。
 * @param {string} input
 * @returns {{aid?: string, bvid?: string}}
 */
export function parseVideoInput(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('缺少视频链接、BV号或 av号');

  if (/^BV[0-9A-Za-z]+$/i.test(raw)) return { bvid: raw };
  if (/^av\d+$/i.test(raw)) return { aid: raw.substring(2) };
  if (/^\d+$/.test(raw)) return { aid: raw };

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`无法识别的视频输入: ${raw}`);
  }

  const match = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+|av\d+)/i);
  if (!match) throw new Error(`链接中未找到视频 BV/av 号: ${raw}`);
  const id = match[1];
  return /^av/i.test(id) ? { aid: id.substring(2) } : { bvid: id };
}

/**
 * 生成跨平台安全的文件名，保留中文与空格。
 * @param {string} name
 * @param {string} fallback
 */
export function sanitizeFileName(name, fallback = 'danmaku') {
  let value = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');

  if (!value) value = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) value = `_${value}`;
  if (value.length > 120) value = value.slice(0, 120).trim();
  return value || fallback;
}

/**
 * 解析分P选择，支持 all / 1,3 / 1-3,5。
 * @param {string|number[]|null|undefined} spec
 * @param {number} totalPages
 * @returns {number[]}
 */
export function parsePageSelection(spec, totalPages) {
  const total = Number(totalPages) || 0;
  if (total <= 0) throw new Error('视频没有可下载的分P');

  const asText = Array.isArray(spec) ? spec.join(',') : String(spec ?? '').trim();
  if (!asText || asText.toLowerCase() === 'all') {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  const selected = new Set();
  for (const token of asText.split(',').map(s => s.trim()).filter(Boolean)) {
    const range = token.match(/^(\d+)(?:-(\d+))?$/);
    if (!range) throw new Error(`无法识别的分P范围: ${token}`);
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : start;
    if (start < 1 || end < start || end > total) {
      throw new Error(`分P范围 ${token} 超出有效范围 1-${total}`);
    }
    for (let p = start; p <= end; p++) selected.add(p);
  }

  if (selected.size === 0) throw new Error('未选择任何分P');
  return [...selected].sort((a, b) => a - b);
}

function escapeXmlAttribute(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeXmlText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 将 protobuf 解析出的弹幕对象转换为 B 站标准 XML。
 * p 字段：时间,类型,字号,颜色,发送时间,弹幕池,用户Hash,弹幕ID,权重
 * @param {number|string} cid
 * @param {Array<object>} elems
 */
export function buildDanmakuXml(cid, elems) {
  const sorted = [...(elems || [])].sort((a, b) => (a.progress || 0) - (b.progress || 0));
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<i>',
    '  <chatserver>chat.bilibili.com</chatserver>',
    `  <chatid>${escapeXmlText(cid)}</chatid>`,
    '  <mission>0</mission>',
    `  <maxlimit>${sorted.length}</maxlimit>`,
    '  <state>0</state>',
    '  <real_name>0</real_name>',
    '  <source>k-v</source>',
  ];

  for (const elem of sorted) {
    const p = [
      ((elem.progress || 0) / 1000).toFixed(3),
      elem.mode ?? 1,
      elem.fontsize ?? 25,
      elem.color ?? 16777215,
      elem.ctime ?? 0,
      elem.pool ?? 0,
      elem.midHash ?? '',
      elem.idStr ?? (elem.id != null ? String(elem.id) : ''),
      elem.weight ?? 0,
    ].join(',');
    lines.push(`  <d p="${escapeXmlAttribute(p)}">${escapeXmlText(elem.content)}</d>`);
  }

  lines.push('</i>', '');
  return lines.join('\n');
}

/**
 * 解析命令行参数。
 * @param {string[]} argv
 */
export function parseCliArgs(argv) {
  const options = {
    input: null,
    output: null,
    pageSpec: null,
    concurrency: 4,
    cookie: null,
    noMeta: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const readValue = name => {
      const next = argv[++i];
      if (next == null || next.startsWith('--')) throw new Error(`${name} 缺少参数值`);
      return next;
    };

    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '-o' || arg === '--output') options.output = readValue(arg);
    else if (arg === '--pages') options.pageSpec = readValue(arg);
    else if (arg === '--concurrency') options.concurrency = Number(readValue(arg));
    else if (arg === '--cookie') options.cookie = readValue(arg);
    else if (arg === '--no-meta') options.noMeta = true;
    else if (arg.startsWith('--output=')) options.output = arg.slice('--output='.length);
    else if (arg.startsWith('--pages=')) options.pageSpec = arg.slice('--pages='.length);
    else if (arg.startsWith('--concurrency=')) options.concurrency = Number(arg.slice('--concurrency='.length));
    else if (arg.startsWith('--cookie=')) options.cookie = arg.slice('--cookie='.length);
    else if (arg.startsWith('-')) throw new Error(`未知参数: ${arg}`);
    else if (!options.input) options.input = arg;
    else throw new Error(`多余参数: ${arg}`);
  }

  if (!options.help && !options.input) throw new Error('缺少视频链接、BV号或 av号');
  if (!Number.isFinite(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) {
    throw new Error('--concurrency 必须是 1-8 之间的整数');
  }
  options.concurrency = Math.floor(options.concurrency);
  return options;
}

function loadEnvFiles() {
  for (const file of [path.join(ROOT_DIR, 'config', '.env'), path.join(ROOT_DIR, '.env')]) {
    try {
      dotenv.config({ path: file, override: false });
    } catch {
      // 配置文件不存在时忽略，允许纯环境变量运行
    }
  }
}

export function buildHeaders(cookie) {
  const headers = {
    'User-Agent': USER_AGENT,
    Referer: 'https://www.bilibili.com/',
  };
  if (cookie) headers.Cookie = cookie;
  return headers;
}

async function withRetry(fn, { retries = 3, logger = console, label = '请求' } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        const delay = 600 * 2 ** attempt + Math.floor(Math.random() * 400);
        logger.warn?.(`[retry] ${label} 失败: ${error.message}，${delay}ms 后重试 (${attempt + 1}/${retries})`);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

export async function fetchView(video, { headers, fetchImpl = fetch, logger = console } = {}) {
  const query = video.bvid
    ? `bvid=${encodeURIComponent(video.bvid)}`
    : `aid=${encodeURIComponent(video.aid)}`;
  const url = `${VIEW_API}?${query}`;
  return withRetry(async () => {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data.code !== 0 || !data.data) throw new Error(`API ${data.code}: ${data.message || '获取视频信息失败'}`);
    return data.data;
  }, { retries: 3, logger, label: 'view' });
}

export async function fetchSegment({ cid, aid, index, headers, fetchImpl = fetch, logger = console }) {
  const url = `${SEGMENT_API}?type=1&oid=${cid}&pid=${aid}&segment_index=${index}`;
  return withRetry(async () => {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(45000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) return [];
    return parseDanmakuBase64(buffer.toString('base64'));
  }, { retries: 4, logger, label: `seg ${index}` });
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 下载一个视频的全部分P（或指定分P）弹幕。
 * @param {object} options
 * @returns {Promise<{dir: string, metaPath: string|null, files: Array, totalDanmaku: number, failures: Array}>}
 */
export async function downloadVideoDanmaku({
  input,
  outputDir = null,
  pageSpec = null,
  cookie = '',
  concurrency = 4,
  noMeta = false,
  fetchImpl = fetch,
  logger = console,
} = {}) {
  const video = parseVideoInput(input);
  const headers = buildHeaders(cookie);
  const view = await fetchView(video, { headers, fetchImpl, logger });

  const pages = Array.isArray(view.pages) ? view.pages : [];
  if (pages.length === 0) throw new Error('该视频没有分P数据');

  const bvid = view.bvid || video.bvid || '';
  const aid = view.aid ?? video.aid;
  const selected = parsePageSelection(pageSpec, pages.length);
  const title = view.title || bvid || `av${aid}`;
  const targetDir = outputDir
    ? path.resolve(outputDir)
    : path.join(DEFAULT_OUTPUT_DIR, sanitizeFileName(`${title}_${bvid || `av${aid}`}`, `${bvid || `av${aid}`}`));

  await fs.mkdir(targetDir, { recursive: true });
  logger.log?.(`[view] ${title} | ${bvid || `av${aid}`} | 分P ${pages.length} 个 | 已选 ${selected.length} 个`);
  logger.log?.(`[out] ${targetDir}`);

  const files = [];
  const failures = [];
  const usedNames = new Map();
  let totalDanmaku = 0;
  let totalBytes = 0;
  const started = Date.now();

  for (let i = 0; i < selected.length; i++) {
    const pageNumber = selected[i];
    const page = pages[pageNumber - 1];
    if (!page) {
      failures.push({ page: pageNumber, error: '分P不存在' });
      continue;
    }

    const part = String(page.part || `P${page.page || pageNumber}`).trim();
    const baseName = sanitizeFileName(part, `P${pageNumber}`);
    const duplicateCount = (usedNames.get(baseName) || 0) + 1;
    usedNames.set(baseName, duplicateCount);
    const fileName = `${duplicateCount > 1 ? `${baseName} (${duplicateCount})` : baseName}.xml`;
    const filePath = path.join(targetDir, fileName);
    const segmentCount = Math.max(1, Math.ceil((Number(page.duration) || 0) / SEGMENT_SECONDS));

    try {
      const segmentResults = await mapLimit(
        Array.from({ length: segmentCount }, (_, index) => index + 1),
        concurrency,
        index => fetchSegment({ cid: page.cid, aid, index, headers, fetchImpl, logger })
      );
      const elems = segmentResults.flat();
      const xml = buildDanmakuXml(page.cid, elems);
      await fs.writeFile(filePath, xml, 'utf8');

      const bytes = Buffer.byteLength(xml);
      totalDanmaku += elems.length;
      totalBytes += bytes;
      files.push({
        page: page.page ?? pageNumber,
        part,
        cid: page.cid,
        duration: page.duration,
        segments: segmentCount,
        danmaku: elems.length,
        file: fileName,
      });
      logger.log?.(`[${i + 1}/${selected.length}] ${fileName} | ${segmentCount} 分片 | ${elems.length} 条 | ${(bytes / 1024 / 1024).toFixed(2)} MB`);
    } catch (error) {
      failures.push({ page: page.page ?? pageNumber, part, cid: page.cid, error: error.message });
      logger.error?.(`[${i + 1}/${selected.length}] 失败 ${fileName}: ${error.message}`);
    }
  }

  let metaPath = null;
  if (!noMeta) {
    metaPath = path.join(targetDir, '_meta.json');
    const meta = {
      aid,
      bvid,
      title,
      generatedAt: new Date().toISOString(),
      totalPages: pages.length,
      selectedPages: selected,
      totalDanmaku,
      totalBytes,
      pages: files,
      failures,
    };
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(0);
  logger.log?.(`[done] ${files.length}/${selected.length} 个分P | ${totalDanmaku} 条弹幕 | ${(totalBytes / 1024 / 1024).toFixed(1)} MB | ${elapsed}s | 失败 ${failures.length}`);
  return { dir: targetDir, metaPath, files, totalDanmaku, failures };
}

function printHelp() {
  console.log(`下载 B 站指定视频的全部分P弹幕（按分P名导出为 XML）

用法:
  node scripts/bilibili-danmaku-download.mjs <视频链接|BV号|av号> [选项]
  npm run download:bilibili-danmaku -- <视频链接|BV号|av号> [选项]

选项:
  -o, --output <dir>       指定输出目录（默认 .cache/bilibili_danmaku/<标题>_<BV号>）
      --pages <范围>       只下载指定分P，如 1,3-5（默认全部）
      --concurrency <n>    分片并发数，1-8（默认 4）
      --cookie <cookie>    B站 Cookie（默认读取 BILIBILI_COOKIE 或 config/.env）
      --no-meta            不生成 _meta.json
  -h, --help               显示帮助

示例:
  node scripts/bilibili-danmaku-download.mjs https://www.bilibili.com/video/av117227776903200
  node scripts/bilibili-danmaku-download.mjs BV1JMbw62E72 -o ./danmaku --pages 1-3,5

Cookie 也可写入 config/.env:
  BILIBILI_COOKIE=SESSDATA=xxx; bili_jct=xxx
`);
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  loadEnvFiles();
  const cookie = options.cookie || process.env.BILIBILI_COOKIE || '';
  if (!cookie) {
    console.warn('[warn] 未配置 BILIBILI_COOKIE，部分视频可能返回不完整弹幕或触发风控');
  }

  const result = await downloadVideoDanmaku({
    input: options.input,
    outputDir: options.output,
    pageSpec: options.pageSpec,
    cookie,
    concurrency: options.concurrency,
    noMeta: options.noMeta,
  });

  if (result.failures.length > 0) {
    process.exitCode = 2;
  }
}

const isDirectRun = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  main().catch(error => {
    console.error(`[error] ${error.message}`);
    process.exit(1);
  });
}
