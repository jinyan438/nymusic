const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const song = {
    id: 1234, mid: 'song-mid', title: '歌曲', singer: [{ name: '甲' }, { name: '乙' }],
    album: { mid: 'album-mid', name: '专辑' }, file: { media_mid: 'media-mid' }
};

function harness(reply) {
    const calls = [];
    const context = vm.createContext({
        URL, URLSearchParams, TextDecoder, Uint8Array, atob, AbortSignal, Response, console,
        Capacitor: { isNativePlatform: () => true, Plugins: { CapacitorHttp: { async get(options) {
            calls.push(options);
            return { status: 200, data: await reply(new URL(options.url), options) };
        } } } }
    });
    for (const file of ['config', 'qq-music-api', 'music-api']) {
        vm.runInContext(readFileSync(join(__dirname, `../www/js/${file}.js`), 'utf8'), context);
    }
    return { qq: vm.runInContext('QQMusic', context), api: vm.runInContext('MusicAPI', context), context, calls };
}

test('QQ search accepts old and new song fields, retains MIDs and media IDs, and does not enable new_json', async () => {
    const { qq, calls } = harness(() => ({ code: 0, data: { song: { list: [song, {
        songid: 987, songmid: 'old-mid', songname: '旧格式', singer: [{ name: '歌手' }], albummid: 'old-album', albumname: '旧专辑'
    }] } } }));
    const tracks = await qq.search('甲 & 乙');
    assert.equal(tracks[0].id, 'song-mid');
    assert.equal(tracks[0].artist, '甲 / 乙');
    assert.equal(tracks[0].albumMid, 'album-mid');
    assert.equal(tracks[0].mediaId, 'media-mid');
    assert.equal(tracks[1].id, 'old-mid');
    const url = new URL(calls[0].url);
    assert.equal(url.hostname, 'c.y.qq.com');
    assert.equal(url.searchParams.get('w'), '甲 & 乙');
    assert.equal(url.searchParams.has('new_json'), false);
    assert.equal(calls[0].headers.Referer, 'https://y.qq.com/');
});

test('QQ playlist and rank songs preserve playback metadata', async () => {
    const { qq } = harness(url => url.pathname.includes('fcg_ucc')
        ? { code: 0, cdlist: [{ dissname: '收藏', nickname: '作者', songlist: [song] }] }
        : { code: 0, req_1: { code: 0, data: { songInfoList: [song] } } });
    const list = await qq.getPlaylist('123456');
    assert.equal(list.info.name, '收藏');
    assert.equal(list.info.author, '作者');
    assert.equal(list.list[0].albumMid, 'album-mid');
    const rank = await qq.getToplist(26);
    assert.equal(rank[0].id, 'song-mid');
    assert.equal(rank[0].mediaId, 'media-mid');
});

test('QQ top lists also accept JSONP responses', async () => {
    const { qq } = harness(() => 'callback({"code":0,"data":{"topList":[{"id":26,"topTitle":"热歌榜"}]}});');
    const lists = await qq.getToplists();
    assert.equal(lists[0].id, 26);
    assert.equal(lists[0].name, '热歌榜');
});

test('QQ lyrics decode UTF-8 base64 to LRC text', async () => {
    const lrc = '[00:01.00]中文歌词\n[00:02.00]第二行';
    const { qq } = harness(() => ({ code: 0, lyric: Buffer.from(lrc).toString('base64') }));
    assert.equal(await qq.getLyrics({ trackId: 'song-mid' }), lrc);
});

test('Old numeric QQ IDs resolve to MIDs before lyric and playback requests', async () => {
    const { qq, calls } = harness(url => {
        const data = JSON.parse(url.searchParams.get('data') || '{}');
        if (data.songinfo) return { code: 0, songinfo: { code: 0, data: { track_info: song } } };
        return { code: 0, req_0: { code: 0, data: {
            sip: ['https://isure.stream.qqmusic.qq.com/'], midurlinfo: [{ songmid: 'song-mid', purl: 'track.mp3?vkey=valid' }]
        } } };
    });
    const url = await qq.getSongUrl({ trackId: '1234' }, '128k');
    assert.equal(new URL(url).pathname, '/track.mp3');
    const details = JSON.parse(new URL(calls[0].url).searchParams.get('data'));
    assert.equal(details.songinfo.param.song_id, 1234);
    const request = JSON.parse(new URL(calls[1].url).searchParams.get('data'));
    assert.equal(request.req_0.param.songmid[0], 'song-mid');
    assert.match(request.req_0.param.filename[0], /media-mid/);
});

test('QQ quality mapping and optional cookie reach the native playback request', () => {
    const { qq } = harness(() => ({}));
    qq.setCookie('uin=o123456; qm_keyst=example');
    for (const [quality, prefix] of [['128k', 'M500'], ['320k', 'M800'], ['flac', 'F000'], ['flac24bit', 'F000']]) {
        const request = qq.getPlaybackRequest({ trackId: 'song-mid', mediaId: 'media-mid' }, quality);
        const data = JSON.parse(new URL(request.uri).searchParams.get('data'));
        assert.equal(data.req_0.param.uin, '123456');
        assert.ok(data.req_0.param.filename[0].startsWith(prefix));
        assert.equal(request.requestHeaders.Cookie, 'uin=o123456; qm_keyst=example');
        assert.equal(request.resolveQqMusicUrl, true);
    }
});

test('QQ playback rejects empty vkeys and upstream errors instead of passing JSON to the decoder', async () => {
    const { qq } = harness(() => ({ code: 0, req_0: { code: 0, data: {
        sip: ['https://isure.stream.qqmusic.qq.com/'], midurlinfo: [{ songmid: 'song-mid', purl: '' }]
    } } }));
    await assert.rejects(qq.getSongUrl({ trackId: 'song-mid' }, 'flac'), /切换音质.*扫码登录/);
    assert.throws(() => qq.parsePlaybackUrl({ code: 0, req_0: { code: 24001 } }, 'song-mid'), /24001/);
});

test('QQ cover URLs use album MIDs, while the cache keeps its original song key', async () => {
    const { qq, calls, context } = harness(() => { throw new Error('Unexpected request'); });
    assert.match(await qq.getCoverUrl({ trackId: 'song-mid', albumMid: 'album-mid' }), /T002R300x300M000album-mid\.jpg/);
    assert.equal(calls.length, 0);
    assert.equal(vm.runInContext("CacheKeys.getSongKey('qq', '1234', 'flac')", context), 'https://music-dl.sayqz.com/api/?source=qq&id=1234&type=url&br=flac');
    assert.match(vm.runInContext("CacheKeys.getSearchKey('test', 'aggregate')", context), /qq-rain120/);
});

test('Aggregate search still returns QQ results when the legacy provider is down', async () => {
    const { api, context } = harness(() => ({ code: 0, data: { song: { list: [song] } } }));
    context.fetch = async () => { throw new Error('Legacy API offline'); };
    const tracks = await api.search('aggregate', '歌曲');
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0].platform, 'qq');
});

test('Browser QQ requests use the same-project proxy and never send forbidden browser headers', async () => {
    const { qq, context } = harness(() => { throw new Error('Native transport should not run'); });
    context.Capacitor.isNativePlatform = () => false;
    const calls = [];
    context.fetch = async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ code: 0, data: { song: { list: [] } } })); };
    qq.setCookie('uin=123');
    assert.equal((await qq.search('test')).length, 0);
    assert.ok(calls[0].url.startsWith('/api/qq?url='));
    assert.equal(calls[0].options.headers['X-QQ-Cookie'], 'uin=123');
    assert.equal(calls[0].options.headers.Cookie, undefined);
    assert.ok(qq.mediaUrl('http://isure.stream.qqmusic.qq.com/test.mp3').startsWith('/api/qq-media?url='));
});
