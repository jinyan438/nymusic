// 应用状态
let currentTrackData = null;
let playlist = [];
let currentPlaylistIndex = -1;
let imageObserver;
let currentLyrics = [];
let currentLyricIndex = -1;
let playbackMode = 'order'; // 'order', 'random', 'repeat'
let activeSearchId = null;
let importedPlaylists = [];
let currentToplistSource = 'aggregate';
let aggregatedToplists = {};
