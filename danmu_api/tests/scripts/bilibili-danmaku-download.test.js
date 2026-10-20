// B站弹幕下载命令行脚本：参数解析、分P选择、文件名与 XML 生成

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseVideoInput,
  sanitizeFileName,
  parsePageSelection,
  buildDanmakuXml,
  parseCliArgs,
  buildHeaders,
  downloadVideoDanmaku,
} from '../../../scripts/bilibili-danmaku-download.mjs';

test('parseVideoInput should accept video URLs, BV ids, av ids and numeric aids', () => {
  assert.deepEqual(
    parseVideoInput('https://www.bilibili.com/video/av117227776903200/?vd_source=abc&spm_id_from=333.788'),
    { aid: '117227776903200' }
  );
  assert.deepEqual(
    parseVideoInput('https://www.bilibili.com/video/BV1JMbw62E72/?p=2'),
    { bvid: 'BV1JMbw62E72' }
  );
  assert.deepEqual(parseVideoInput('BV1JMbw62E72'), { bvid: 'BV1JMbw62E72' });
  assert.deepEqual(parseVideoInput('av12345'), { aid: '12345' });
  assert.deepEqual(parseVideoInput('12345'), { aid: '12345' });
  assert.throws(() => parseVideoInput('https://www.bilibili.com/bangumi/play/ep123'), /未找到视频/);
  assert.throws(() => parseVideoInput(''), /缺少视频/);
});

test('sanitizeFileName should keep readable names and replace unsafe characters', () => {
  assert.equal(sanitizeFileName('S01E01 拖拉机'), 'S01E01 拖拉机');
  const sanitized = sanitizeFileName('a/b:c*?"<>|');
  assert.equal(sanitized, 'a_b_c______');
  assert.equal(sanitizeFileName('   ', 'P1'), 'P1');
  assert.equal(sanitizeFileName('...', 'fallback'), 'fallback');
  assert.equal(sanitizeFileName('CON'), '_CON');
  assert.equal(sanitizeFileName('x'.repeat(200)).length, 120);
});

test('parsePageSelection should support all, single pages and ranges', () => {
  assert.deepEqual(parsePageSelection(null, 3), [1, 2, 3]);
  assert.deepEqual(parsePageSelection('all', 3), [1, 2, 3]);
  assert.deepEqual(parsePageSelection('1,3-4', 5), [1, 3, 4]);
  assert.deepEqual(parsePageSelection('3,1,2', 3), [1, 2, 3]);
  assert.throws(() => parsePageSelection('0', 3), /超出有效范围/);
  assert.throws(() => parsePageSelection('4', 3), /超出有效范围/);
  assert.throws(() => parsePageSelection('3-1', 3), /超出有效范围/);
  assert.throws(() => parsePageSelection('x', 3), /无法识别/);
  assert.throws(() => parsePageSelection(null, 0), /没有可下载的分P/);
});

test('buildDanmakuXml should emit sorted, escaped Bilibili XML', () => {
  const xml = buildDanmakuXml(41644919075, [
    {
      progress: 2500,
      mode: 1,
      fontsize: 25,
      color: 16777215,
      ctime: 1788780449,
      pool: 0,
      midHash: 'abc123',
      idStr: '2195208530276718336',
      weight: 2,
      content: '<hello & "world">',
    },
    {
      progress: 1000,
      mode: 5,
      fontsize: 18,
      color: 16711680,
      ctime: 1788780400,
      pool: 1,
      midHash: 'def456',
      id: 42,
      content: '第一条',
    },
  ]);

  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<i>/);
  assert.match(xml, /<chatid>41644919075<\/chatid>/);
  assert.match(xml, /<maxlimit>2<\/maxlimit>/);

  const first = xml.indexOf('1.000,5,18,16711680,1788780400,1,def456,42,0');
  const second = xml.indexOf('2.500,1,25,16777215,1788780449,0,abc123,2195208530276718336,2');
  assert.ok(first > 0 && second > first, '弹幕应按时间升序排列');
  assert.ok(xml.includes('&lt;hello &amp; "world"&gt;'), '文本中的 XML 特殊字符应转义');
  assert.ok(xml.trimEnd().endsWith('</i>'));
});

test('parseCliArgs should parse positional input, output and page options', () => {
  const options = parseCliArgs([
    'https://www.bilibili.com/video/BV1JMbw62E72',
    '-o', './tmp-danmaku',
    '--pages', '1-3,5',
    '--concurrency', '3',
    '--no-meta',
  ]);
  assert.equal(options.input, 'https://www.bilibili.com/video/BV1JMbw62E72');
  assert.equal(options.output, './tmp-danmaku');
  assert.equal(options.pageSpec, '1-3,5');
  assert.equal(options.concurrency, 3);
  assert.equal(options.noMeta, true);

  assert.equal(parseCliArgs(['--help']).help, true);
  assert.equal(parseCliArgs(['BV1x', '--pages=2', '--concurrency=2']).pageSpec, '2');
  assert.throws(() => parseCliArgs(['BV1x', '--concurrency', '9']), /1-8/);
  assert.throws(() => parseCliArgs(['BV1x', '--output']), /缺少参数值/);
  assert.throws(() => parseCliArgs(['BV1x', 'BV2x']), /多余参数/);
});

test('buildHeaders should only attach Cookie when provided', () => {
  const headers = buildHeaders('SESSDATA=test');
  assert.match(headers['User-Agent'], /Mozilla/);
  assert.equal(headers.Referer, 'https://www.bilibili.com/');
  assert.equal(headers.Cookie, 'SESSDATA=test');
  assert.equal(buildHeaders('').Cookie, undefined);
});

test('downloadVideoDanmaku should write one XML per selected page and a metadata file', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-danmaku-test-'));
  const silentLogger = { log() {}, warn() {}, error() {} };
  const fetchImpl = async url => {
    if (url.includes('/x/web-interface/view?')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          data: {
            aid: 117227776903200,
            bvid: 'BV1JMbw62E72',
            title: '测试合集',
            pages: [
              { cid: 11, page: 1, part: 'S01E01 拖拉机', duration: 1 },
              { cid: 22, page: 2, part: 'S01E02 放羊', duration: 1 },
            ],
          },
        }),
      };
    }
    if (url.includes('/x/v2/dm/web/seg.so?')) {
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    throw new Error(`unexpected url: ${url}`);
  };

  try {
    const result = await downloadVideoDanmaku({
      input: 'https://www.bilibili.com/video/av117227776903200',
      outputDir,
      pageSpec: '2',
      fetchImpl,
      logger: silentLogger,
    });

    assert.equal(result.files.length, 1);
    assert.equal(result.failures.length, 0);
    assert.equal(result.files[0].part, 'S01E02 放羊');
    assert.equal(result.files[0].file, 'S01E02 放羊.xml');

    const xml = await fs.readFile(path.join(outputDir, 'S01E02 放羊.xml'), 'utf8');
    assert.match(xml, /<chatid>22<\/chatid>/);
    assert.match(xml, /<maxlimit>0<\/maxlimit>/);

    const meta = JSON.parse(await fs.readFile(path.join(outputDir, '_meta.json'), 'utf8'));
    assert.equal(meta.bvid, 'BV1JMbw62E72');
    assert.deepEqual(meta.selectedPages, [2]);
    assert.equal(meta.pages[0].part, 'S01E02 放羊');
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});
