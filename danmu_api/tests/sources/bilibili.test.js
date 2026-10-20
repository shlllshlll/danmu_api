// B站源：b23.tv 短链解析
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import { Globals } from '../../configs/globals.js';
import BilibiliSource from '../../sources/bilibili.js';
import { mockJsonResponse, resetSearchState, withMockFetch } from '../helpers/context.js';

test('BilibiliSource should resolve b23.tv short links from redirect location', async () => {
    Globals.init({});
    const source = new BilibiliSource();
    const shortUrl = 'https://b23.tv/BV1GJ411x7h7';
    const targetUrl = 'https://www.bilibili.com/video/BV1GJ411x7h7';
    let seenRedirectMode;

    await withMockFetch(async (url, options) => {
      assert.equal(url, shortUrl);
      seenRedirectMode = options.redirect;
      return {
        ok: false,
        status: 302,
        url: shortUrl,
        headers: new Headers({ location: targetUrl }),
        text: async () => '',
      };
    }, async () => {
      const resolvedUrl = await source.resolveB23Link(shortUrl);
      assert.equal(resolvedUrl, targetUrl);
    });

    assert.equal(seenRedirectMode, 'manual');
  });

test('BilibiliSource should map search_type=video results to UGC media and keep bangumi results intact', async () => {
  Globals.init({ BILIBILI_COOKIE: 'SESSDATA=test' });
  const source = new BilibiliSource();

  const videoPayload = {
    code: 0,
    data: {
      result: [
        {
          type: 'video',
          bvid: 'BV1JMbw62E72',
          aid: 117227776903200,
          title: '【合集】<em class="keyword">克拉克森的农场</em> 1-5季',
          pic: '//i0.hdslb.com/bfs/archive/cover.jpg',
          pubdate: 1788755131,
          duration: '3129:27',
          author: 'UP',
          typename: '影视剪辑',
        },
      ],
    },
  };
  const bangumiPayload = {
    code: 0,
    data: {
      result: [
        {
          type: 'media_bangumi',
          season_id: 100,
          media_id: 200,
          season_type_name: '番剧',
          title: '<em class="keyword">克拉克森的农场</em>',
          org_title: "Clarkson's Farm",
          cover: 'https://i0.hdslb.com/bfs/archive/bangumi.jpg',
          pubdate: 1600000000,
          ep_size: 8,
          eps: [{ id: 1, title: '1' }],
        },
      ],
    },
  };

  await withMockFetch(async url => {
    const searchType = new URL(url).searchParams.get('search_type');
    assert.ok(searchType);
    return mockJsonResponse(searchType === 'video' ? videoPayload : bangumiPayload, url);
  }, async () => {
    const videos = await source._searchByType('克拉克森的农场', 'video', 'mixin-key');
    assert.equal(videos.length, 1);
    assert.equal(videos[0].mediaId, 'bvBV1JMbw62E72');
    assert.equal(videos[0].type, '视频');
    assert.equal(videos[0].imageUrl, 'https://i0.hdslb.com/bfs/archive/cover.jpg');
    assert.equal(videos[0].episodeCount, 0);
    assert.equal(videos[0]._isUgcVideo, true);
    assert.equal(videos[0]._searchIndex, 0);
    assert.equal(videos[0]._eps, undefined);

    const bangumi = await source._searchByType('克拉克森的农场', 'media_bangumi', 'mixin-key');
    assert.equal(bangumi.length, 1);
    assert.equal(bangumi[0].mediaId, 'ss100');
    assert.equal(bangumi[0].mdId, 'md200');
    assert.equal(bangumi[0].type, '动漫');
    assert.equal(bangumi[0].episodeCount, 8);
    assert.equal(bangumi[0]._eps.length, 1);
    assert.equal(bangumi[0]._isUgcVideo, undefined);
  });
});

test('BilibiliSource should list all pages for bv/av UGC videos', async () => {
  Globals.init({ BILIBILI_COOKIE: 'SESSDATA=test' });
  const source = new BilibiliSource();
  const seenUrls = [];

  await withMockFetch(async url => {
    seenUrls.push(url);
    if (url.includes('bvid=BV1JMbw62E72')) {
      return mockJsonResponse({
        code: 0,
        data: {
          aid: 117227776903200,
          bvid: 'BV1JMbw62E72',
          title: '合集',
          pages: [
            { cid: 41644919075, page: 1, part: 'S01E01 拖拉机', duration: 5395 },
            { cid: 41645047829, page: 2, part: 'S01E02 放羊', duration: 4711 },
          ],
        },
      }, url);
    }
    if (url.includes('aid=117227776903200')) {
      return mockJsonResponse({
        code: 0,
        data: {
          aid: 117227776903200,
          bvid: 'BV1JMbw62E72',
          title: '合集',
          pages: [
            { cid: 41644919075, page: 1, part: 'S01E01 拖拉机', duration: 5395 },
          ],
        },
      }, url);
    }
    throw new Error(`unexpected url: ${url}`);
  }, async () => {
    const bvEpisodes = await source.getEpisodes('bvBV1JMbw62E72');
    assert.equal(bvEpisodes.length, 2);
    assert.equal(bvEpisodes[0].title, 'S01E01 拖拉机');
    assert.equal(bvEpisodes[1].vid, '117227776903200,41645047829');
    assert.equal(bvEpisodes[1].link, 'https://www.bilibili.com/video/BV1JMbw62E72?p=2');

    const avEpisodes = await source.getEpisodes('av117227776903200');
    assert.equal(avEpisodes.length, 1);
    assert.equal(avEpisodes[0].link, 'https://www.bilibili.com/video/BV1JMbw62E72?p=1');
  });

  assert.ok(seenUrls.some(url => url === 'https://api.bilibili.com/x/web-interface/view?bvid=BV1JMbw62E72'));
  assert.ok(seenUrls.some(url => url === 'https://api.bilibili.com/x/web-interface/view?aid=117227776903200'));
});

test('BilibiliSource should build UGC episode URLs without season_id and rank them after PGC results', async () => {
  resetSearchState();
  const source = new BilibiliSource();
  source.getEpisodes = async id => {
    if (id === 'ss100') {
      return [{ id: '111', title: '第1集', link: 'https://www.bilibili.com/bangumi/play/ep111' }];
    }
    if (id === 'bvBV1JMbw62E72') {
      return [
        { id: '222', title: 'S01E01 拖拉机', link: 'https://www.bilibili.com/video/BV1JMbw62E72?p=1' },
        { id: '223', title: 'S01E02 放羊', link: 'https://www.bilibili.com/video/BV1JMbw62E72?p=2' },
      ];
    }
    return [];
  };

  const detailStore = new Map();
  const curAnimes = [];
  await source.handleAnimes([
    {
      provider: 'bilibili',
      mediaId: 'ss100',
      title: '克拉克森的农场',
      type: '电视剧',
      year: 2024,
      imageUrl: '',
      episodeCount: 1,
      aliases: [],
    },
    {
      provider: 'bilibili',
      mediaId: 'bvBV1JMbw62E72',
      title: '克拉克森的农场 合集',
      type: '视频',
      year: 2026,
      imageUrl: '',
      episodeCount: 0,
      aliases: [],
      _isUgcVideo: true,
      _searchIndex: 0,
    },
  ], '克拉克森的农场', curAnimes, detailStore);

  assert.deepEqual(curAnimes.map(anime => anime.bangumiId), ['ss100', 'bvBV1JMbw62E72']);

  const details = [...detailStore.values()];
  const pgcDetail = details.find(anime => anime.bangumiId === 'ss100');
  const ugcDetail = details.find(anime => anime.bangumiId === 'bvBV1JMbw62E72');

  assert.equal(pgcDetail.links[0].url, 'https://www.bilibili.com/bangumi/play/ep111?season_id=100');
  assert.equal(ugcDetail.links.length, 2);
  assert.equal(ugcDetail.links[0].url, 'https://www.bilibili.com/video/BV1JMbw62E72?p=1');
  assert.equal(ugcDetail.links[1].url, 'https://www.bilibili.com/video/BV1JMbw62E72?p=2');
  assert.equal(ugcDetail.links[0].url.includes('season_id'), false);
  assert.match(ugcDetail.animeTitle, /【视频】from bilibili/);
});

test('BilibiliSource should keep multi-P UGC results when the query contains SxxExx', async () => {
  resetSearchState();
  const source = new BilibiliSource();
  source.getEpisodes = async () => [
    { id: '222', title: 'S01E01 拖拉机', link: 'https://www.bilibili.com/video/BV1JMbw62E72?p=1' },
  ];

  const curAnimes = [];
  const detailStore = new Map();
  await source.handleAnimes([{
    provider: 'bilibili',
    mediaId: 'bvBV1JMbw62E72',
    title: '【收藏版 4K：UHD】特效字幕【克拉克森的农场：1-5季】',
    type: '视频',
    year: 2026,
    imageUrl: '',
    episodeCount: 0,
    aliases: [],
    _isUgcVideo: true,
    _searchIndex: 0,
  }], '克拉克森的农场 S01E01', curAnimes, detailStore);

  assert.equal(curAnimes.length, 1);
  assert.equal(curAnimes[0].bangumiId, 'bvBV1JMbw62E72');
  assert.equal(curAnimes[0].episodeCount, 1);
});

test('BilibiliSource search should run the third type=video query', async () => {
  Globals.init({});
  const source = new BilibiliSource();
  source._getWbiMixinKey = async () => 'mixin-key';
  source._hasBilibiliProxy = () => false;

  const searchedTypes = [];
  source._searchByType = async (_keyword, searchType) => {
    searchedTypes.push(searchType);
    if (searchType !== 'video') return [];
    return [{
      provider: 'bilibili',
      mediaId: 'bvBV1JMbw62E72',
      title: '克拉克森的农场 合集',
      type: '视频',
      year: 2026,
      imageUrl: '',
      episodeCount: 0,
      aliases: [],
      _isUgcVideo: true,
      _searchIndex: 0,
    }];
  };

  const results = await source.search('克拉克森的农场');
  assert.deepEqual(searchedTypes.sort(), ['media_bangumi', 'media_ft', 'video']);
  assert.equal(results.length, 1);
  assert.equal(results[0].mediaId, 'bvBV1JMbw62E72');
});
