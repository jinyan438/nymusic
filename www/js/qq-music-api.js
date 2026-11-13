// QQ 请求与参数参考 Rain120/qq-music-api，授权见 third-party/qq-music-api.LICENSE。
const QQ_ENDPOINTS = {
    search: 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp',
    playlist: 'https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg',
    toplists: 'https://c.y.qq.com/v8/fcg-bin/fcg_myqq_toplist.fcg',
    lyric: 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg',
    music: 'https://u.y.qq.com/cgi-bin/musicu.fcg'
};

const QQMusic = {
    cookie: '',
    songInfoCache: new Map(),

    isNative() { return !!globalThis.Capacitor?.isNativePlatform?.(); },

    setCookie(cookie) {
        this.cookie = String(cookie || '').trim().replace(/^cookie:\s*/i, '');
        this.songInfoCache.clear();
    },

    getUin() {
        return this.cookie.match(/(?:^|;\s*)(?:uin|qqmusic_uin|p_uin)=o?(\d+)/)?.[1] || '0';
    },

    headers() {
        const headers = { Referer: 'https://y.qq.com/', Accept: 'application/json' };
        if (this.cookie) headers.Cookie = this.cookie;
        return headers;
    },

    buildUrl(endpoint, params) {
        const url = new URL(QQ_ENDPOINTS[endpoint]);
        for (const [key, value] of Object.entries(params)) {
            if (value != null) url.searchParams.set(key, String(value));
        }
        return url.href;
    },

    async request(endpoint, params = {}) {
        const url = this.buildUrl(endpoint, { format: 'json', outCharset: 'utf-8', ...params });
        let data;
        if (this.isNative()) {
            const capacitor = globalThis.Capacitor;
            const http = capacitor.Plugins?.CapacitorHttp || capacitor.CapacitorHttp || capacitor.registerPlugin('CapacitorHttp');
            const response = await http.get({
                url, headers: this.headers(), responseType: 'text', connectTimeout: 15000, readTimeout: 15000
            });
            if (response.status !== 200) throw new Error(`QQ 音乐请求失败（HTTP ${response.status}）`);
            data = response.data;
        } else {
            const response = await fetch(`/api/qq?url=${encodeURIComponent(url)}`, {
                headers: this.cookie ? { 'X-QQ-Cookie': this.cookie } : {},
                signal: AbortSignal.timeout(15000)
            });
            if (!response.ok) throw new Error(`QQ 音乐请求失败（HTTP ${response.status}）；网页预览请使用 npm start`);
            data = await response.text();
        }
        if (typeof data === 'string') {
            // 个别 QQ 接口即使传 format=json 仍可能返回 JSONP。
            const text = data.trim().replace(/^\w+\s*\(/, '').replace(/\);?\s*$/, '');
            try { data = JSON.parse(text); }
            catch (_) { throw new Error('QQ 音乐返回了无效数据'); }
        }
        return this.checkResponse(data);
    },

    checkResponse(data) {
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('QQ 音乐返回了无效数据');
        if (data.code != null && Number(data.code) !== 0) {
            throw new Error(data.message || data.msg || `QQ 音乐接口错误（${data.code}）`);
        }
        return data;
    },

    normalizeSong(entry) {
        const song = entry.musicData || entry;
        const album = song.album || {};
        return {
            id: String(song.mid || song.songmid || song.id || song.songid || ''),
            songId: song.id || song.songid || '',
            name: song.title || song.name || song.songname || '',
            artist: (song.singer || []).map(singer => singer.name).filter(Boolean).join(' / ') || song.singername || '未知歌手',
            album: album.title || album.name || song.albumname || '',
            albumMid: album.mid || song.albummid || '',
            mediaId: song.file?.media_mid || song.strMediaMid || '',
            platform: 'qq'
        };
    },

    async search(keyword) {
        const response = await this.request('search', {
            w: keyword, n: 30, p: 1, catZhida: 1, remoteplace: 'txt.yqq.song',
            ct: 24, qqmusic_ver: 1298, t: 0, aggr: 1, cr: 1, lossless: 0, flag_qc: 0, platform: 'yqq.json'
        });
        const songs = response.data?.song?.list;
        if (!Array.isArray(songs)) throw new Error('QQ 音乐搜索结果格式异常');
        return songs.map(song => this.normalizeSong(song)).filter(song => song.id);
    },

    async getSongInfo(track) {
        const id = String(track.trackId);
        if (!this.songInfoCache.has(id)) {
            const pending = this.request('music', {
                data: JSON.stringify({
                    comm: { ct: 24, cv: 0 },
                    songinfo: {
                        module: 'music.pf_song_detail_svr', method: 'get_song_detail_yqq',
                        param: { song_type: 0, song_mid: /^\d+$/.test(id) ? '' : id, song_id: /^\d+$/.test(id) ? Number(id) : 0 }
                    }
                })
            }).then(response => {
                const info = this.checkResponse(response.songinfo);
                const song = info.data?.track_info;
                if (!song?.mid) throw new Error('无法获取 QQ 歌曲信息');
                return this.normalizeSong(song);
            }).catch(error => { this.songInfoCache.delete(id); throw error; });
            this.songInfoCache.set(id, pending);
        }
        return this.songInfoCache.get(id);
    },

    async resolveTrack(track) {
        if (!/^\d+$/.test(String(track.trackId))) return track;
        const info = await this.getSongInfo(track);
        return { ...track, trackId: info.id, albumMid: info.albumMid, mediaId: info.mediaId };
    },

    quality(quality) {
        return ({ '128k': '128', '320k': '320', flac24bit: 'flac', flac: 'flac' })[quality] || '128';
    },

    getPlaybackRequest(track, quality) {
        const songmid = String(track.trackId);
        const type = this.quality(quality);
        const [prefix, extension] = type === 'flac' ? ['F000', '.flac'] : type === '320' ? ['M800', '.mp3'] : ['M500', '.mp3'];
        const uin = this.getUin();
        const data = {
            req_0: {
                module: 'vkey.GetVkeyServer', method: 'CgiGetVkey',
                param: {
                    filename: [`${prefix}${songmid}${track.mediaId || songmid}${extension}`],
                    guid: '1429839143', songmid: [songmid], songtype: [0], uin, loginflag: 1, platform: '20'
                }
            },
            loginUin: uin, comm: { uin, format: 'json', ct: 24, cv: 0 }
        };
        return {
            uri: this.buildUrl('music', { format: 'json', sign: 'zzannc1o6o9b4i971602f3554385022046ab796512b7012', data: JSON.stringify(data) }),
            resolveQqMusicUrl: true,
            requestHeaders: this.headers()
        };
    },

    parsePlaybackUrl(response, songmid) {
        this.checkResponse(response);
        const result = this.checkResponse(response.req_0);
        const info = result.data?.midurlinfo?.find(item => item.songmid === songmid);
        const domains = result.data?.sip || [];
        const domain = domains.find(item => !item.startsWith('http://ws')) || domains[0];
        if (!info?.purl || !domain) throw new Error('QQ 音乐未提供该音质的播放地址，请切换音质或重新扫码登录');
        const url = new URL(info.purl, domain);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('QQ 音乐返回了无效播放地址');
        return url.href;
    },

    async getSongUrl(track, quality) {
        const resolved = await this.resolveTrack(track);
        const request = new URL(this.getPlaybackRequest(resolved, quality).uri);
        const response = await this.request('music', Object.fromEntries(request.searchParams));
        return this.mediaUrl(this.parsePlaybackUrl(response, String(resolved.trackId)));
    },

    mediaUrl(url) {
        return this.isNative() ? url : `/api/qq-media?url=${encodeURIComponent(url)}`;
    },

    async getCoverUrl(track) {
        const albumMid = track.albumMid || (await this.getSongInfo(track)).albumMid;
        if (!albumMid) throw new Error('QQ 歌曲没有专辑封面');
        return `https://y.gtimg.cn/music/photo_new/T002R300x300M000${encodeURIComponent(albumMid)}.jpg?max_age=2592000`;
    },

    async getLyrics(track) {
        const resolved = await this.resolveTrack(track);
        const response = await this.request('lyric', { songmid: resolved.trackId, pcachetime: Date.now() });
        if (!response.lyric) return '';
        const bytes = Uint8Array.from(atob(response.lyric), char => char.charCodeAt(0));
        return new TextDecoder().decode(bytes);
    },

    async getPlaylist(id) {
        const response = await this.request('playlist', { disstid: id, type: 1, json: 1, utf8: 1, onlysong: 0, new_format: 1 });
        const info = response.cdlist?.[0];
        if (!info || !Array.isArray(info.songlist)) throw new Error('无法读取 QQ 歌单，请检查歌单 ID 和访问权限');
        return {
            info: { name: info.dissname || info.disstname || '歌单', author: info.nickname || '未知' },
            list: info.songlist.map(song => this.normalizeSong(song)).filter(song => song.id)
        };
    },

    async getToplists() {
        const response = await this.request('toplists', { platform: 'h5', needNewCode: 1 });
        const lists = response.data?.topList;
        if (!Array.isArray(lists)) throw new Error('QQ 音乐榜单格式异常');
        return lists.map(item => ({ id: item.id, name: item.topTitle, updateFrequency: '' }));
    },

    async getToplist(id) {
        const response = await this.request('music', {
            data: JSON.stringify({
                comm: { ct: 24, cv: 4747474, format: 'json', uin: 0 },
                req_1: { module: 'musicToplist.ToplistInfoServer', method: 'GetDetail', param: { topId: Number(id), offset: 0, num: 100, period: '' } }
            })
        });
        const result = this.checkResponse(response.req_1);
        const songs = result.data?.songInfoList;
        if (!Array.isArray(songs)) throw new Error('QQ 音乐榜单歌曲格式异常');
        return songs.map(song => this.normalizeSong(song)).filter(song => song.id);
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = { QQ_ENDPOINTS, QQMusic };
