// ==UserScript==
// @name         YouTube Music - Play albums songs
// @namespace    ytm-album-songs
// @version      1.1.1
// @description  Plays songs instead of music videos on YouTube Music: album tracks, radios and music videos anywhere. Unofficial userscript port of a patch of the Morphe project.
// @author       Debsishu Pal
// @license      GPL-3.0-only
// @icon         https://music.youtube.com/favicon.ico
// @homepageURL  https://github.com/debsishu/ytm-album-songs
// @supportURL   https://github.com/debsishu/ytm-album-songs/issues
// @updateURL    https://raw.githubusercontent.com/debsishu/ytm-album-songs/main/ytm-album-songs.user.js
// @downloadURL  https://raw.githubusercontent.com/debsishu/ytm-album-songs/main/ytm-album-songs.user.js
// @match        https://music.youtube.com/*
// @run-at       document-start
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      youtubei.googleapis.com
// ==/UserScript==

/*
 * YouTube Music - Play albums songs
 * Copyright (C) 2026 Debsishu Pal
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the
 * GNU General Public License version 3 as published by the Free Software Foundation, with the
 * additional terms below under its Section 7.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
 * even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details: <https://www.gnu.org/licenses/gpl-3.0.html>.
 *
 * Modified version notice (GPLv3 Section 7c):
 * This is an unofficial, independent userscript for the YouTube Music website. It is NOT the
 * original Morphe software and is not made, endorsed or supported by the Morphe project. Its album
 * logic is ported and modified from the "Play albums songs" patch of Morphe Patches
 * (patches/music/misc/album, https://github.com/MorpheApp/morphe-patches/pull/2556), rewritten in
 * JavaScript for the browser. Report issues with this script to its author, not to Morphe.
 *
 * ---------------------------------------------------------------------------------------------
 * Morphe NOTICE
 *
 * https://github.com/MorpheApp/morphe-patches
 *
 * GPLv3 Section 7b: Preservation of User Notices
 *
 * All derivative works (source code and binaries) must include this
 * NOTICE text and provide it to the software user.
 *
 * Portions of this software are provided "AS IS" by the Morphe software project.
 * Any express or implied warranties, including the implied warranties of
 * merchantability and fitness for a particular purpose, are disclaimed.
 *
 * GPLv3 Section 7c: Prohibiting Misrepresentation of Origin
 *
 * You are prohibited from misrepresenting the origin of the Program,
 * and modified versions of the Program must be identified and marked in
 * reasonable ways as different from the original version so as not to cause
 * confusion regarding their origin.
 *
 * GPLv3 Section 7e: Declining Grant of Trademark Rights
 *
 * This License does not grant any rights or permission under trademark law
 * to use the name "Morphe" or any of the Program's trade names, trademarks,
 * service marks, or logos.
 * ---------------------------------------------------------------------------------------------
 *
 * YouTube and YouTube Music are trademarks of Google LLC. This script is not affiliated with Google.
 */

/*
 * How it works (see README.md for details):
 *
 * - Album playlists ("OLAK..." ids) list the music video of every track that has one.
 * - The album itself is looked up once with the same request as the Android patch (ANDROID_VR client
 *   on youtubei.googleapis.com), which lists the song version of every track.
 * - Queue responses (next, music/get_queue) are rewritten so the app queues and plays the songs.
 * - The server never sees the song ids in `next` requests, because it then resets the queue to
 *   the first track. Those requests are mapped back to the music video ids.
 * - `player` requests of an album music video that slipped through are mapped to the song.
 * - Outside of albums nothing is changed, so music videos play as usual.
 */
(function () {
    'use strict';

    const LOG_PREFIX = '[ytm-album-songs]';

    // YouTube Music album playlist ids share a stable "OLAK" prefix.
    const ALBUM_PREFIX = 'OLAK';

    // The queue waits this long for the album. Giving up leaves the music videos playing.
    const MAX_WAIT_FOR_ALBUM_MS = 5000;

    const CONNECTION_TIMEOUT_MS = 8000;
    const MAX_FETCH_ATTEMPTS = 3;
    const RETRY_BACKOFF_MS = 500;

    // Album contents never change, so a fetched album is kept for a whole listening session.
    const CACHE_RETENTION_MS = 30 * 60 * 1000;
    const NUMBER_OF_ALBUMS_TO_CACHE = 5;

    const MUSIC_VIDEO_TYPE_SONG = 'MUSIC_VIDEO_TYPE_ATV';
    const MUSIC_VIDEO_TYPES_TO_REPLACE = new Set(['MUSIC_VIDEO_TYPE_OMV', 'MUSIC_VIDEO_TYPE_UGC']);

    const LOOKUP_URL = 'https://youtubei.googleapis.com/youtubei/v1/next'
        + '?fields=contents.singleColumnWatchNextResults.playlist.playlist&prettyPrint=false';

    // Same client as the Android patch: it needs neither a PoToken nor authentication,
    // and plain YouTube lists the songs of an album rather than its music videos.
    const LOOKUP_CLIENT = {
        id: 28,
        clientName: 'ANDROID_VR',
        clientVersion: '1.73.21',
        deviceMake: 'Pico',
        deviceModel: 'A8110',
        osName: 'Android',
        osVersion: '10',
        androidSdkVersion: '29',
        userAgent: 'com.google.android.apps.youtube.vr.pico/1.73.21 (Linux; U; Android 10; en_US; A8110 Build/5.13.7)',
    };

    // English forced so the "Album" title prefix can be relied on.
    const LOOKUP_LANGUAGE = 'en';

    // region Helpers

    function isAlbum(playlistId) {
        return typeof playlistId === 'string' && playlistId.startsWith(ALBUM_PREFIX);
    }

    function defaultSleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /** @return The value of the promise, or null if it takes longer than the timeout. */
    function withTimeout(promise, ms) {
        if (ms <= 0) return Promise.resolve(null);
        let timer;
        return Promise.race([
            promise,
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(null), ms);
            }),
        ]).finally(() => clearTimeout(timer));
    }

    function runsText(text) {
        if (!text) return '';
        if (typeof text.simpleText === 'string') return text.simpleText;
        const first = Array.isArray(text.runs) ? text.runs[0] : null;
        return first && typeof first.text === 'string' ? first.text : '';
    }

    function setRunsText(text, value) {
        if (!text) return;
        if (Array.isArray(text.runs) && text.runs.length) {
            text.runs = [Object.assign({}, text.runs[0], { text: value })];
        } else if (typeof text.simpleText === 'string') {
            text.simpleText = value;
        }
    }

    /** @return Seconds of a "m:ss" or "h:mm:ss" length, or zero if it cannot be read. */
    function parseDuration(lengthText) {
        if (!lengthText) return 0;
        let seconds = 0;
        for (const part of String(lengthText).split(':')) {
            const trimmed = part.trim();
            if (!/^\d+$/.test(trimmed)) return 0;
            seconds = seconds * 60 + Number(trimmed);
        }
        return seconds;
    }

    function formatDuration(totalSeconds) {
        const h = Math.floor(totalSeconds / 3600);
        const m = Math.floor((totalSeconds % 3600) / 60);
        const s = String(totalSeconds % 60).padStart(2, '0');
        return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
    }

    function normalizeTitle(title, keepBrackets) {
        let t = String(title || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
        if (!keepBrackets) t = t.replace(/\([^)]*\)|\[[^\]]*\]/g, '');
        t = t.replace(/[^\p{L}\p{N}]+/gu, '');
        // A title that is only a bracket, such as "(Intro)", is kept whole.
        return t || (keepBrackets ? '' : normalizeTitle(title, true));
    }

    function titlesMatch(a, b) {
        const x = normalizeTitle(a);
        const y = normalizeTitle(b);
        if (!x || !y) return false;
        return x === y || x.startsWith(y) || y.startsWith(x);
    }

    /**
     * Whether a queue entry's title is the song's title with what marks it as a video, such as
     * "Song (Official Video)", "Song (Audio)" or "Artist - Song". The album lookup is in English,
     * so a title the queue writes differently, such as in another script, is not taken to be it.
     */
    function isVideoTitleOf(videoTitle, songTitle) {
        const video = normalizeTitle(videoTitle);
        const song = normalizeTitle(songTitle);
        return !!video && !!song && video.includes(song);
    }

    function musicVideoTypeOf(watchEndpoint) {
        return watchEndpoint
            && watchEndpoint.watchEndpointMusicSupportedConfigs
            && watchEndpoint.watchEndpointMusicSupportedConfigs.watchEndpointMusicConfig
            && watchEndpoint.watchEndpointMusicSupportedConfigs.watchEndpointMusicConfig.musicVideoType;
    }

    /** @return Whether the thumbnails are square album art, as song entries have, rather than video frames. */
    function isAlbumArt(thumbnails) {
        return Array.isArray(thumbnails) && thumbnails.length > 0
            && thumbnails.every((t) => t && typeof t.url === 'string' && !t.url.includes('ytimg.com/'));
    }

    function cloneThumbnails(thumbnails) {
        return thumbnails.map((t) => Object.assign({}, t));
    }

    const isBylineSeparator = (run) => !!run && typeof run.text === 'string' && run.text.trim() === '•';

    function pageTypeOf(run) {
        const browse = run && run.navigationEndpoint && run.navigationEndpoint.browseEndpoint;
        const configs = browse && browse.browseEndpointContextSupportedConfigs;
        return configs && configs.browseEndpointContextMusicConfig && configs.browseEndpointContextMusicConfig.pageType;
    }

    /**
     * @return The part of a song's byline after its artists, " • Album • Year" with the album
     *         linked, or null if the byline names no album, as the one of a music video
     *         (" • 1B views • 6.1M likes").
     */
    function albumBylineOf(longBylineText) {
        const runs = longBylineText && Array.isArray(longBylineText.runs) ? longBylineText.runs : null;
        const start = runs ? runs.findIndex(isBylineSeparator) : -1;
        if (start < 0) return null;
        const tail = runs.slice(start);
        if (!tail.some((run) => pageTypeOf(run) === 'MUSIC_PAGE_TYPE_ALBUM')) return null;
        return JSON.parse(JSON.stringify(tail));
    }

    /** @return The runs of a byline that name its artists, before the first separator. */
    function artistRunsOf(longBylineText) {
        const runs = longBylineText && Array.isArray(longBylineText.runs) ? longBylineText.runs : [];
        const end = runs.findIndex(isBylineSeparator);
        return end < 0 ? runs : runs.slice(0, end);
    }

    /**
     * Replaces a video id everywhere in a renderer, including thumbnail urls and endpoints.
     * @param retype Whether the music video type is also changed to the song type.
     * @param art Album art that replaces the frames of the music video, if known. Otherwise the
     *            frames are of the song, which is the album art in a 16:9 frame.
     */
    function replaceVideoId(node, fromId, toId, retype, art, urlsOnly) {
        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i++) {
                const v = node[i];
                if (typeof v === 'string') node[i] = replaceInString(v, fromId, toId, retype, urlsOnly);
                else if (v && typeof v === 'object') replaceVideoId(v, fromId, toId, retype, art, urlsOnly);
            }
        } else if (node && typeof node === 'object') {
            for (const key of Object.keys(node)) {
                const v = node[key];
                if (typeof v === 'string') {
                    node[key] = replaceInString(v, fromId, toId, retype, urlsOnly);
                } else if (key === 'thumbnails' && art && Array.isArray(v)
                    && v.some((t) => t && typeof t.url === 'string' && t.url.includes(fromId))) {
                    node[key] = cloneThumbnails(art);
                } else if (v && typeof v === 'object') {
                    replaceVideoId(v, fromId, toId, retype, art, urlsOnly);
                }
            }
        }
    }

    function replaceInString(value, fromId, toId, retype, urlsOnly) {
        if (value === fromId) return toId;
        if (retype && MUSIC_VIDEO_TYPES_TO_REPLACE.has(value)) return MUSIC_VIDEO_TYPE_SONG;
        if (!value.includes(fromId)) return value;
        // Ids that contain the video id, such as the radio of the video ("RDAMVM" + id), name
        // something else than the video, so only urls of the video, as thumbnails, are changed then.
        if (urlsOnly && !value.startsWith('https://')) return value;
        return value.split(fromId).join(toId);
    }

    // endregion

    // region Album lookup (port of PlaylistRequest)

    /**
     * @typedef {{videoId: string, title: string, artist: string, durationSeconds: number}} Song
     * An album track as the album itself lists it, rather than as the queue plays it.
     */

    function buildLookupBody(playlistId, videoId, gl) {
        let timeZone = 'UTC';
        try {
            timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        } catch (e) { /* ignore */ }
        const body = {
            context: {
                client: {
                    deviceMake: LOOKUP_CLIENT.deviceMake,
                    deviceModel: LOOKUP_CLIENT.deviceModel,
                    clientName: LOOKUP_CLIENT.clientName,
                    clientVersion: LOOKUP_CLIENT.clientVersion,
                    osName: LOOKUP_CLIENT.osName,
                    osVersion: LOOKUP_CLIENT.osVersion,
                    androidSdkVersion: LOOKUP_CLIENT.androidSdkVersion,
                    hl: LOOKUP_LANGUAGE,
                    gl: gl || 'US',
                    timeZone,
                    utcOffsetMinutes: String(-new Date().getTimezoneOffset()),
                },
            },
            contentCheckOk: true,
            racyCheckOk: true,
            playlistId,
        };
        if (videoId) body.videoId = videoId;
        return body;
    }

    /** @return {Array<Song|null>} Album tracks by position, or empty if it is not an album. */
    function parseAlbumResponse(json) {
        const playlist = json && json.contents && json.contents.singleColumnWatchNextResults
            && json.contents.singleColumnWatchNextResults.playlist
            && json.contents.singleColumnWatchNextResults.playlist.playlist;
        if (!playlist) return [];
        // Top Songs reuses the album playlist id, and is only an album when the title says so.
        if (!String(playlist.title || '').startsWith('Album')) return [];
        const contents = Array.isArray(playlist.contents) ? playlist.contents : [];
        return contents.map(parseSong);
    }

    function parseSong(entry) {
        const renderer = entry && entry.playlistPanelVideoRenderer;
        if (!renderer) return null;
        const watchEndpoint = renderer.navigationEndpoint && renderer.navigationEndpoint.watchEndpoint;
        const videoId = (watchEndpoint && watchEndpoint.videoId) || renderer.videoId;
        if (!videoId) return null;
        return {
            videoId,
            title: runsText(renderer.title),
            artist: runsText(renderer.longBylineText),
            durationSeconds: parseDuration(runsText(renderer.lengthText)),
        };
    }

    class AlbumCache {
        constructor({ sendLookup, now, sleep, log }) {
            this.sendLookup = sendLookup;
            this.now = now;
            this.sleep = sleep;
            this.log = log;
            /** Insertion ordered, oldest first. */
            this.entries = new Map();
        }

        isExpired(entry, now) {
            // Keep in flight requests, and drop failed ones at once so the next track can retry.
            if (entry.songs === null) return false;
            if (entry.songs.length === 0) return true;
            return now - entry.timeFetched > CACHE_RETENTION_MS;
        }

        removeExpired() {
            const now = this.now();
            for (const [playlistId, entry] of this.entries) {
                if (this.isExpired(entry, now)) {
                    this.log('Removing expired album:', playlistId);
                    this.entries.delete(playlistId);
                }
            }
        }

        /** Starts fetching the album, unless it is already cached or a fetch is in flight. */
        fetchIfNeeded(playlistId, videoId) {
            this.removeExpired();
            const existing = this.entries.get(playlistId);
            if (existing) return existing;

            const entry = {
                playlistId,
                timeFetched: this.now(),
                songs: null,
                /** Music video id -> song, or null when the video is left as is. */
                pairs: new Map(),
                /** Song id -> music video id it replaced. */
                reversePairs: new Map(),
                promise: null,
                /** Square album art of the songs, or null if not seen yet. */
                art: null,
                /** " • Album • Year" of the bylines of the songs, or null if not seen yet. */
                albumByline: null,
                /** Fetch of the album art and byline in flight, or null. */
                detailsPromise: null,
            };
            entry.promise = this.fetch(playlistId, videoId).then((songs) => {
                entry.songs = songs;
                return songs;
            });
            this.entries.set(playlistId, entry);
            while (this.entries.size > NUMBER_OF_ALBUMS_TO_CACHE) {
                this.entries.delete(this.entries.keys().next().value);
            }
            return entry;
        }

        /** @return The songs of the album, or null if it could not be fetched in time. */
        async awaitSongs(playlistId, videoId, timeoutMs) {
            const entry = this.fetchIfNeeded(playlistId, videoId);
            const songs = entry.songs !== null ? entry.songs : await withTimeout(entry.promise, timeoutMs);
            if (!songs) this.log('Timed out waiting for album:', playlistId);
            return songs && songs.length ? songs : null;
        }

        peekSongs(playlistId) {
            const entry = this.entries.get(playlistId);
            return entry && entry.songs && entry.songs.length ? entry.songs : null;
        }

        recordPair(playlistId, videoId, song) {
            const entry = this.entries.get(playlistId);
            if (!entry) return;
            entry.pairs.set(videoId, song);
            if (song) entry.reversePairs.set(song.videoId, videoId);
        }

        /** @return The song, null if the video is left as is, or undefined if not known yet. */
        getPair(playlistId, videoId) {
            this.removeExpired();
            const entry = this.entries.get(playlistId);
            return entry && entry.pairs.has(videoId) ? entry.pairs.get(videoId) : undefined;
        }

        /** Keeps the first square album art seen for the album. */
        setArt(playlistId, thumbnails) {
            const entry = this.entries.get(playlistId);
            if (entry && !entry.art && isAlbumArt(thumbnails)) entry.art = cloneThumbnails(thumbnails);
        }

        getArt(playlistId) {
            const entry = this.entries.get(playlistId);
            return entry ? entry.art : null;
        }

        /** Keeps the album part of the first song byline seen for the album. */
        setAlbumByline(playlistId, longBylineText) {
            const entry = this.entries.get(playlistId);
            if (!entry || entry.albumByline) return;
            entry.albumByline = albumBylineOf(longBylineText);
        }

        getAlbumByline(playlistId) {
            const entry = this.entries.get(playlistId);
            return entry ? entry.albumByline : null;
        }

        /** @return The name of the album, as its songs name it, or null if not seen yet. */
        getAlbumName(playlistId) {
            const byline = this.getAlbumByline(playlistId);
            const run = byline && byline.find((r) => pageTypeOf(r) === 'MUSIC_PAGE_TYPE_ALBUM');
            return run ? run.text : null;
        }

        /** @return The music video a song replaced in the album, or undefined. */
        getReversePair(playlistId, songVideoId) {
            const entry = this.entries.get(playlistId);
            return entry ? entry.reversePairs.get(songVideoId) : undefined;
        }

        async fetch(playlistId, videoId) {
            for (let attempt = 1; ; attempt++) {
                const startTime = this.now();
                let json = null;
                try {
                    json = await this.sendLookup(playlistId, videoId);
                } catch (e) {
                    this.log('Album request failed:', e);
                }
                this.log('Album:', playlistId, 'took:', this.now() - startTime, 'ms');
                if (json) {
                    const songs = parseAlbumResponse(json);
                    this.log('Album:', playlistId, 'songs:', songs.length);
                    return songs;
                }
                if (attempt >= MAX_FETCH_ATTEMPTS) return [];
                await this.sleep(RETRY_BACKOFF_MS * attempt);
            }
        }
    }

    // endregion

    // region Response rewriting

    function panelItem(renderer) {
        const watchEndpoint = (renderer.navigationEndpoint && renderer.navigationEndpoint.watchEndpoint) || {};
        return {
            renderer,
            videoId: renderer.videoId,
            playlistId: watchEndpoint.playlistId,
            index: watchEndpoint.index,
            title: runsText(renderer.title),
            musicVideoType: musicVideoTypeOf(watchEndpoint),
            thumbnails: () => renderer.thumbnail && renderer.thumbnail.thumbnails,
            setLength: (text) => setRunsText(renderer.lengthText, text),
            setTitle: (text) => setRunsText(renderer.title, text),
            byline: () => renderer.longBylineText,
            setByline: (runs) => {
                renderer.longBylineText = Object.assign({}, renderer.longBylineText, { runs });
            },
        };
    }

    /** Collects the queue entries of a response, which are the only places the songs are put. */
    function collectQueueItems(root) {
        const items = [];
        const wrappers = [];
        (function walk(node) {
            if (Array.isArray(node)) {
                for (const v of node) if (v && typeof v === 'object') walk(v);
                return;
            }
            if (node.playlistPanelVideoWrapperRenderer) {
                wrappers.push(node);
                return;
            }
            for (const key of Object.keys(node)) {
                const v = node[key];
                if (!v || typeof v !== 'object') continue;
                if (key === 'playlistPanelVideoRenderer' && typeof v.videoId === 'string') {
                    items.push(panelItem(v));
                } else {
                    walk(v);
                }
            }
        })(root);
        return { items, wrappers };
    }

    /**
     * @return The album whose tracks a page lists, or null. Other albums the page links to,
     *         such as "More from", are not tracks and would only push it out of the cache.
     */
    function findListedAlbum(root) {
        const counts = new Map();
        (function walk(node) {
            if (Array.isArray(node)) {
                for (const v of node) if (v && typeof v === 'object') walk(v);
                return;
            }
            for (const key of Object.keys(node)) {
                const v = node[key];
                if (!v || typeof v !== 'object') continue;
                if (key === 'watchEndpoint' && typeof v.videoId === 'string' && isAlbum(v.playlistId)) {
                    counts.set(v.playlistId, (counts.get(v.playlistId) || 0) + 1);
                }
                walk(v);
            }
        })(root);
        let best = null;
        for (const [playlistId, count] of counts) if (!best || count > counts.get(best)) best = playlistId;
        return best;
    }

    /** @return The art of the album a page shows in its header, or null. */
    function findHeaderArt(root) {
        let header = null;
        (function walk(node) {
            if (header || !node || typeof node !== 'object') return;
            if (Array.isArray(node)) return node.forEach(walk);
            for (const key of Object.keys(node)) {
                if (key === 'musicResponsiveHeaderRenderer' || key === 'musicDetailHeaderRenderer') {
                    header = node[key];
                    return;
                }
                walk(node[key]);
            }
        })(root);
        let art = null;
        (function walk(node) {
            if (art || !node || typeof node !== 'object') return;
            if (Array.isArray(node)) return node.forEach(walk);
            for (const key of Object.keys(node)) {
                if (key === 'thumbnails' && isAlbumArt(node[key])) {
                    art = node[key];
                    return;
                }
                walk(node[key]);
            }
        })(header);
        return art;
    }

    function matchSong(songs, item, index, positionTrusted) {
        const atIndex = Number.isInteger(index) && index >= 0 && index < songs.length ? songs[index] : null;
        if (atIndex && (titlesMatch(atIndex.title, item.title) || isVideoTitleOf(item.title, atIndex.title))) {
            return atIndex;
        }
        // Unavailable tracks can shift the positions, so the track is looked up by its title.
        const wanted = normalizeTitle(item.title);
        if (wanted) {
            const same = songs.filter((s) => s && normalizeTitle(s.title) === wanted);
            if (same.length === 1) return same[0];
        }
        // Titles can be localized differently, and the position alone is then trusted like on Android.
        return positionTrusted ? atIndex : null;
    }

    function createCore(deps) {
        const now = deps.now || Date.now;
        const sleep = deps.sleep || defaultSleep;
        const log = deps.log || (() => {});
        const fetchPageQueue = deps.fetchPageQueue || (async () => null);
        const fetchSongDetails = deps.fetchSongDetails || (async () => null);
        const searchSongs = deps.searchSongs || (async () => null);
        const fetchSongEntries = deps.fetchSongEntries || (async () => null);
        // Whether music videos outside of albums play their song too, found by a search.
        const everywhere = typeof deps.everywhere === 'function' ? deps.everywhere : () => deps.everywhere !== false;
        const cache = new AlbumCache({ sendLookup: deps.sendLookup, now, sleep, log });

        /** Music videos seen in responses: what finding their song needs. */
        const videos = new SizeRestrictedMap(NUMBER_OF_VIDEOS_TO_REMEMBER);
        /** Waiting for the details of a music video, by its id. */
        const videoWaiters = new Map();
        /** Music video -> song id, from albums, which is exact. */
        const exactSongs = new SizeRestrictedMap(NUMBER_OF_VIDEOS_TO_REMEMBER);
        /** Music video -> lookup of its song: { promise, song } with song null when there is none. */
        const songLookups = new SizeRestrictedMap(NUMBER_OF_VIDEOS_TO_REMEMBER);
        /** Song id -> its own queue entry, signed out, which has its title, art, byline and length. */
        const songEntries = new SizeRestrictedMap(NUMBER_OF_SONG_ENTRIES_TO_REMEMBER);
        /** Playlist id (not an album) -> { pairs: music video -> song id, reverse: song id -> music video }. */
        const playlistPairs = new SizeRestrictedMap(NUMBER_OF_PLAYLISTS_TO_REMEMBER);
        /** "RDAMVM" + music video -> "RDAMVM" + its song: a radio started from the song instead. */
        const radioFlips = new SizeRestrictedMap(NUMBER_OF_PLAYLISTS_TO_REMEMBER);
        /** Lookups of what a video is that no response showed yet, by its id. */
        const videoProbes = new SizeRestrictedMap(NUMBER_OF_PLAYLISTS_TO_REMEMBER);
        /** Music videos the player was asked for as they are: their queue entry stays the music video. */
        const playedAsVideo = new SizeRestrictedMap(NUMBER_OF_PLAYLISTS_TO_REMEMBER);

        function applyGroup(playlistId, group, songs) {
            const indexes = group.map((item) => item.index).filter(Number.isInteger);
            // An album added to the queue can give every track the position of its first track.
            // Two videos cannot be the same album track, so then the positions are not used.
            const indexTrusted = indexes.length === group.length && new Set(indexes).size === indexes.length;
            // Without positions, the order is only trusted when the whole album is listed.
            const orderTrusted = group.length === songs.length;

            const art = cache.getArt(playlistId);
            const albumByline = cache.getAlbumByline(playlistId);
            let changed = false;
            group.forEach((item, position) => {
                const index = indexTrusted ? item.index : position;
                const song = matchSong(songs, item, index, indexTrusted || orderTrusted);

                if (!song || song.videoId === item.videoId || item.musicVideoType === MUSIC_VIDEO_TYPE_SONG) {
                    // A track already queued as the song is never replaced.
                    if (cache.getReversePair(playlistId, item.videoId) === undefined) {
                        cache.recordPair(playlistId, item.videoId, null);
                    }
                    if (!song) log('Official song not found, videoId:', item.videoId, item.title);
                    return;
                }

                cache.recordPair(playlistId, item.videoId, song);
                exactSongs.set(item.videoId, song.videoId);
                replaceVideoId(item.renderer, item.videoId, song.videoId, true, art);
                if (song.durationSeconds > 0) item.setLength(formatDuration(song.durationSeconds));
                // The queue can name the track as its video does. The player bar and the media
                // controls show this title too.
                if (song.title && song.title !== item.title && isVideoTitleOf(item.title, song.title)) {
                    item.setTitle(song.title);
                }
                // A music video's byline has its views and likes where a song's has its album and
                // year. What reads the album from it, such as the player bar and other extensions,
                // otherwise finds none.
                const artists = artistRunsOf(item.byline());
                if (albumByline && artists.length) {
                    item.setByline(artists.concat(JSON.parse(JSON.stringify(albumByline))));
                }
                log('Queueing song:', song.videoId, 'instead of:', item.videoId, item.title);
                changed = true;
            });
            return changed;
        }

        /**
         * A signed in queue can pair the music video with its song itself, and then the song is
         * used directly instead of the pair, so it plays without any lookup.
         */
        function applyWrapper(container) {
            const wrapper = container.playlistPanelVideoWrapperRenderer;
            const primary = wrapper.primaryRenderer && wrapper.primaryRenderer.playlistPanelVideoRenderer;
            if (!primary) return false;
            const primaryEndpoint = (primary.navigationEndpoint && primary.navigationEndpoint.watchEndpoint) || {};
            if (!isAlbum(primaryEndpoint.playlistId) || musicVideoTypeOf(primaryEndpoint) === MUSIC_VIDEO_TYPE_SONG) {
                return false;
            }
            const counterparts = Array.isArray(wrapper.counterpart) ? wrapper.counterpart : [];
            const song = counterparts
                .map((c) => c && c.counterpartRenderer && c.counterpartRenderer.playlistPanelVideoRenderer)
                .find((r) => r && musicVideoTypeOf(r.navigationEndpoint && r.navigationEndpoint.watchEndpoint)
                    === MUSIC_VIDEO_TYPE_SONG);
            if (!song) return false;

            const merged = JSON.parse(JSON.stringify(song));
            merged.navigationEndpoint = merged.navigationEndpoint || {};
            const endpoint = merged.navigationEndpoint.watchEndpoint = merged.navigationEndpoint.watchEndpoint || {};
            for (const key of ['playlistId', 'index', 'playlistSetVideoId', 'params']) {
                if (endpoint[key] === undefined && primaryEndpoint[key] !== undefined) endpoint[key] = primaryEndpoint[key];
            }
            if (primary.selected !== undefined) merged.selected = primary.selected;

            const playlistId = primaryEndpoint.playlistId;
            cache.fetchIfNeeded(playlistId, primary.videoId);
            cache.setArt(playlistId, merged.thumbnail && merged.thumbnail.thumbnails);
            cache.setAlbumByline(playlistId, merged.longBylineText);
            cache.recordPair(playlistId, primary.videoId, {
                videoId: merged.videoId,
                title: runsText(merged.title),
                artist: runsText(merged.longBylineText),
                durationSeconds: parseDuration(runsText(merged.lengthText)),
            });
            delete container.playlistPanelVideoWrapperRenderer;
            container.playlistPanelVideoRenderer = merged;
            log('Queueing paired song:', merged.videoId, 'instead of:', primary.videoId);
            return true;
        }

        /** The video the response is about follows its queue entry. */
        function applyCurrentVideo(json, swapped) {
            const endpoint = json.currentVideoEndpoint && json.currentVideoEndpoint.watchEndpoint;
            if (!endpoint || typeof endpoint.videoId !== 'string') return false;
            const other = swapped && swapped.get(endpoint.videoId);
            if (other) {
                replaceVideoId(json, endpoint.videoId, other.videoId, false, other.art, true);
                setMediaSessionAlbum(json, other.albumName);
                return true;
            }
            if (!isAlbum(endpoint.playlistId)) return false;
            const song = cache.getPair(endpoint.playlistId, endpoint.videoId);
            if (!song) return false;
            // Includes the art of the media session, which the player bar and the system show.
            replaceVideoId(json, endpoint.videoId, song.videoId, false, cache.getArt(endpoint.playlistId), true);

            setMediaSessionAlbum(json, cache.getAlbumName(endpoint.playlistId));
            return true;
        }

        /** A music video's media session has no album, while a song's names it. */
        function setMediaSessionAlbum(json, albumName) {
            const overlay = json.playerOverlays && json.playerOverlays.playerOverlayRenderer;
            const session = overlay && overlay.browserMediaSession && overlay.browserMediaSession.browserMediaSessionRenderer;
            if (session && albumName && !runsText(session.album)) session.album = { runs: [{ text: albumName }] };
        }

        // region Music videos outside of albums

        /** Remembers the music videos a response shows, and the songs of the ones an album page names. */
        function learnMusicVideos(json) {
            for (const video of collectMusicVideos(json)) {
                const known = videos.get(video.videoId);
                const merged = {
                    videoId: video.videoId,
                    title: video.title || (known && known.title),
                    artists: video.artists.length ? video.artists : (known ? known.artists : []),
                    durationSeconds: video.durationSeconds || (known ? known.durationSeconds : 0),
                };
                videos.set(video.videoId, merged);
                const waiters = videoWaiters.get(video.videoId);
                if (waiters && merged.durationSeconds && merged.artists.length) {
                    videoWaiters.delete(video.videoId);
                    waiters.forEach((resolve) => resolve(merged));
                }
            }
            for (const pair of collectAlbumCredits(json)) exactSongs.set(pair.videoId, pair.songVideoId);
        }

        function isKnownMusicVideo(videoId) {
            return videos.has(videoId) || exactSongs.has(videoId);
        }

        /**
         * Finds out what a video no response showed is, from its own queue entry, signed out.
         * @return Whether it is a music video.
         */
        async function probeVideo(videoId, timeoutMs) {
            if (isKnownMusicVideo(videoId)) return true;
            if (!everywhere()) return false;
            if (!videoProbes.has(videoId)) {
                videoProbes.set(videoId, Promise.resolve()
                    .then(() => fetchSongEntries([videoId]))
                    .catch(() => null)
                    .then((json) => {
                        if (json) learnMusicVideos(json);
                        else videoProbes.delete(videoId);
                    }));
            }
            await withTimeout(videoProbes.get(videoId), timeoutMs);
            return isKnownMusicVideo(videoId);
        }

        /** @return The details of a music video complete enough to search its song, waiting for them a while. */
        function videoDetails(videoId, timeoutMs) {
            const video = videos.get(videoId);
            if (video && video.durationSeconds && video.artists.length) return Promise.resolve(video);
            let resolve;
            const arrived = new Promise((r) => { resolve = r; });
            if (!videoWaiters.has(videoId)) videoWaiters.set(videoId, []);
            videoWaiters.get(videoId).push(resolve);
            return withTimeout(arrived, timeoutMs);
        }

        /**
         * @return The song of a music video, or null when there is none for sure, it is not found
         *         in time, or music videos outside of albums are left as they are.
         */
        async function songOfVideo(videoId, timeoutMs) {
            if (exactSongs.has(videoId)) return { videoId: exactSongs.get(videoId) };
            if (!everywhere()) return null;
            const known = songLookups.get(videoId);
            if (known && known.song !== undefined) return known.song;

            let lookup = known;
            if (!lookup) {
                lookup = { song: undefined, promise: null };
                const deadline = now() + timeoutMs;
                lookup.promise = (async () => {
                    const video = await videoDetails(videoId, Math.max(0, deadline - now()));
                    if (!video) return undefined; // Not known enough yet: asked again later.
                    let json = null;
                    try {
                        json = await searchSongs(songQueryOf(video));
                    } catch (e) {
                        log('Song search failed:', e);
                    }
                    if (!json) return undefined; // Failed: the next play searches again.
                    const hits = parseSongSearch(json).slice(0, NUMBER_OF_SEARCH_HITS_TO_CHECK);
                    const hit = hits.find((h) => isSongOfVideo(video, h)) || null;
                    log(hit ? 'Song of music video:' : 'No sure song of music video:', videoId, video.title,
                        hit ? `-> ${hit.videoId} ${hit.title}` : '');
                    return hit && { videoId: hit.videoId, title: hit.title, durationSeconds: hit.durationSeconds };
                })().then((song) => {
                    if (song === undefined) songLookups.delete(videoId);
                    else lookup.song = song;
                    return song;
                });
                songLookups.set(videoId, lookup);
            }
            const song = await withTimeout(lookup.promise, timeoutMs);
            return song || null;
        }

        /** @return The own queue entries of songs, by id, fetching the missing ones in one request. */
        async function entriesOfSongs(songIds, timeoutMs) {
            const missing = songIds.filter((id) => !songEntries.has(id));
            if (missing.length) {
                const json = await withTimeout(
                    Promise.resolve().then(() => fetchSongEntries(missing)).catch(() => null), timeoutMs);
                for (const item of json ? collectQueueItems(json).items : []) {
                    if (item.musicVideoType === MUSIC_VIDEO_TYPE_SONG) songEntries.set(item.videoId, item.renderer);
                }
            }
            return new Map(songIds.filter((id) => songEntries.has(id)).map((id) => [id, songEntries.get(id)]));
        }

        function pairsOfPlaylist(playlistId) {
            const key = playlistId || '';
            if (!playlistPairs.has(key)) playlistPairs.set(key, { pairs: new Map(), reverse: new Map() });
            return playlistPairs.get(key);
        }

        /**
         * The queue entry of a music video becomes the song's own entry, in the place of the music video:
         * its position, playlist and selection stay.
         */
        function putSongEntry(item, songRenderer) {
            const merged = JSON.parse(JSON.stringify(songRenderer));
            const videoEndpoint = (item.renderer.navigationEndpoint && item.renderer.navigationEndpoint.watchEndpoint) || {};
            merged.navigationEndpoint = merged.navigationEndpoint || {};
            const endpoint = merged.navigationEndpoint.watchEndpoint = merged.navigationEndpoint.watchEndpoint || {};
            for (const key of ['playlistId', 'index', 'playlistSetVideoId', 'params']) {
                if (videoEndpoint[key] !== undefined) endpoint[key] = videoEndpoint[key];
                else delete endpoint[key];
            }
            if (item.renderer.selected !== undefined) merged.selected = item.renderer.selected;
            for (const key of Object.keys(item.renderer)) delete item.renderer[key];
            Object.assign(item.renderer, merged);
        }

        /**
         * Puts the songs of music videos in a queue that is not an album: the playing one before the
         * queue is shown, if it is found in time, and any found before. The next few are looked up for
         * the next track changes, which ask for the queue again.
         * @return Songs put in place of music videos, by music video id.
         */
        async function applyOtherQueues(json, items, deadline) {
            const swapped = new Map();
            const current = json.currentVideoEndpoint && json.currentVideoEndpoint.watchEndpoint;
            const videosInQueue = items.filter((item) => !isAlbum(item.playlistId)
                && item.musicVideoType === 'MUSIC_VIDEO_TYPE_OMV');
            if (!videosInQueue.length) return swapped;

            let playingIndex = videosInQueue.findIndex((item) => item.renderer.selected
                || (current && current.videoId === item.videoId));
            const playing = playingIndex >= 0 ? videosInQueue[playingIndex] : null;
            // The player already plays it as the music video, so its entry says so.
            const keptAsVideo = playing && playedAsVideo.has(playing.videoId) ? playing : null;
            if (playingIndex < 0) playingIndex = 0;
            const ahead = videosInQueue.slice(playingIndex, playingIndex + 1 + NUMBER_OF_TRACKS_TO_LOOK_UP_AHEAD);
            for (const item of ahead) if (item !== playing) void songOfVideo(item.videoId, MAX_WAIT_FOR_ALBUM_MS);
            if (playing && !keptAsVideo) await songOfVideo(playing.videoId, Math.max(0, deadline - now()));

            const songOf = (item) => {
                if (exactSongs.has(item.videoId)) return exactSongs.get(item.videoId);
                const lookup = songLookups.get(item.videoId);
                return lookup && lookup.song ? lookup.song.videoId : null;
            };
            const found = videosInQueue.filter((item) => item !== keptAsVideo && songOf(item));
            if (!found.length) return swapped;
            const entries = await entriesOfSongs([...new Set(found.map(songOf))], Math.max(0, deadline - now()));

            for (const item of found) {
                const songId = songOf(item);
                const entry = entries.get(songId);
                if (!entry) continue; // Without the song's entry the music video stays.
                const videoId = item.videoId;
                const pairs = pairsOfPlaylist(item.playlistId);
                pairs.pairs.set(videoId, songId);
                pairs.reverse.set(songId, videoId);
                putSongEntry(item, entry);
                swapped.set(videoId, {
                    videoId: songId,
                    art: isAlbumArt(entry.thumbnail && entry.thumbnail.thumbnails) ? entry.thumbnail.thumbnails : null,
                    albumName: (() => {
                        const byline = albumBylineOf(entry.longBylineText);
                        const run = byline && byline.find((r) => pageTypeOf(r) === 'MUSIC_PAGE_TYPE_ALBUM');
                        return run ? run.text : null;
                    })(),
                });
                log('Queueing song:', songId, 'instead of music video:', videoId, item.title);
            }
            return swapped;
        }

        /**
         * A radio started from a music video is music videos. Started from its song, it is songs.
         * Only a radio being started is started from the song: one already playing asked for another
         * radio would have the server start that one from its first track.
         * @return The radio to ask for instead, or null.
         */
        async function flippedRadio(playlistId, videoId) {
            if (radioFlips.has(playlistId)) return radioFlips.get(playlistId);
            const seed = radioSeedOf(playlistId);
            if (!seed || (videoId !== undefined && videoId !== seed)) return null;
            // A radio is often started from a video no response showed, as on a page opened directly.
            const deadline = now() + MAX_WAIT_FOR_ALBUM_MS;
            if (!(await probeVideo(seed, MAX_WAIT_FOR_ALBUM_MS))) return null;
            const song = await songOfVideo(seed, Math.max(0, deadline - now()));
            if (!song) return null;
            const flipped = RADIO_PREFIX + song.videoId;
            radioFlips.set(playlistId, flipped);
            log('Starting the radio of song:', song.videoId, 'instead of music video:', seed);
            return flipped;
        }

        // endregion

        /**
         * Song entries show the square art of their album, and name the album in their byline, while
         * music videos show a video frame and their views. Both are taken from a song of the album
         * the queue already has, or else fetched once.
         */
        async function ensureAlbumDetails(playlistId, group, songs, timeoutMs) {
            for (const item of group) {
                if (item.musicVideoType !== MUSIC_VIDEO_TYPE_SONG) continue;
                cache.setArt(playlistId, item.thumbnails());
                cache.setAlbumByline(playlistId, item.byline());
            }
            const entry = cache.entries.get(playlistId);
            if (!entry || (entry.art && entry.albumByline)) return;
            if (group.every((item) => item.musicVideoType === MUSIC_VIDEO_TYPE_SONG)) return;
            if (!entry.detailsPromise) {
                const song = songs.find(Boolean);
                if (!song) return;
                entry.detailsPromise = Promise.resolve()
                    .then(() => fetchSongDetails(song.videoId))
                    .catch(() => null)
                    .then((details) => {
                        // Retried by the next queue when it failed.
                        if (!details) {
                            entry.detailsPromise = null;
                            return;
                        }
                        cache.setArt(playlistId, details.thumbnails);
                        cache.setAlbumByline(playlistId, details.longBylineText);
                    });
            }
            await withTimeout(entry.detailsPromise, timeoutMs);
        }

        /**
         * Puts the songs of album tracks in the queue of a next or get_queue response.
         * @return Whether the response was changed.
         */
        async function processQueueResponse(json, waitMs = MAX_WAIT_FOR_ALBUM_MS) {
            learnMusicVideos(json);
            const { items, wrappers } = collectQueueItems(json);
            let changed = false;
            for (const wrapper of wrappers) changed = applyWrapper(wrapper) || changed;

            const groups = new Map();
            for (const item of items) {
                if (!isAlbum(item.playlistId)) continue;
                if (!groups.has(item.playlistId)) groups.set(item.playlistId, []);
                groups.get(item.playlistId).push(item);
            }

            const deadline = now() + waitMs;
            for (const [playlistId, group] of groups) cache.fetchIfNeeded(playlistId, group[0].videoId);
            for (const [playlistId, group] of groups) {
                const songs = await cache.awaitSongs(playlistId, group[0].videoId, deadline - now());
                if (!songs) continue;
                await ensureAlbumDetails(playlistId, group, songs, deadline - now());
                changed = applyGroup(playlistId, group, songs) || changed;
            }

            const swapped = await applyOtherQueues(json, items, deadline);
            return applyCurrentVideo(json, swapped) || swapped.size > 0 || changed;
        }

        /** Gives the album fetch a head start as soon as an album is shown. */
        function prefetchAlbums(json) {
            learnMusicVideos(json);
            const playlistId = findListedAlbum(json);
            if (!playlistId) return;
            cache.fetchIfNeeded(playlistId, null);
            cache.setArt(playlistId, findHeaderArt(json));
        }

        /**
         * The server only knows the music videos of an album, and resets the queue to the first track
         * when it is asked about a song it replaced, so it is asked about the music video instead.
         * @return The request body to send, or null to send it unchanged.
         */
        async function rewriteNextRequest(body) {
            if (!body || typeof body !== 'object') return null;
            if (isAlbum(body.playlistId)) {
                if (typeof body.videoId !== 'string') return null;
                const musicVideoId = cache.getReversePair(body.playlistId, body.videoId);
                if (!musicVideoId) return null;
                body.videoId = musicVideoId;
                log('Asking for the queue of:', musicVideoId, 'instead of its song');
                return body;
            }

            // A radio of a music video, also as it is asked for again on every track change.
            const radio = body.playlistId ? await flippedRadio(body.playlistId, body.videoId) : null;
            if (radio) {
                const seed = radioSeedOf(body.playlistId);
                body.playlistId = radio;
                if (body.videoId === seed) body.videoId = radio.slice(RADIO_PREFIX.length);
                return body;
            }
            if (typeof body.videoId !== 'string') return null;

            // A queue the server lists with music videos, where this script put songs.
            if (body.playlistId) {
                const musicVideoId = playlistPairs.has(body.playlistId)
                    && playlistPairs.get(body.playlistId).reverse.get(body.videoId);
                if (!musicVideoId) return null;
                body.videoId = musicVideoId;
                log('Asking for the queue of:', musicVideoId, 'instead of its song');
                return body;
            }

            // A music video played on its own, which then goes on with its radio.
            if (!isKnownMusicVideo(body.videoId)) return null;
            const song = await songOfVideo(body.videoId, MAX_WAIT_FOR_ALBUM_MS);
            if (!song) return null;
            log('Playing song:', song.videoId, 'instead of music video:', body.videoId);
            body.videoId = song.videoId;
            return body;
        }

        /**
         * Plays the song of an album music video the queue still holds.
         * @return The request body to send, or null to send it unchanged.
         */
        async function rewritePlayerRequest(body) {
            if (!body || typeof body.videoId !== 'string') return null;
            if (!isAlbum(body.playlistId)) {
                const videoId = body.videoId;
                const deadline = now() + MAX_WAIT_FOR_ALBUM_MS;
                const isRadioStart = radioSeedOf(body.playlistId) === videoId;
                const isMusicVideo = isRadioStart
                    ? await probeVideo(videoId, MAX_WAIT_FOR_ALBUM_MS)
                    : isKnownMusicVideo(videoId);
                const song = isMusicVideo ? await songOfVideo(videoId, Math.max(0, deadline - now())) : null;
                if (!song) {
                    // Plays as the music video: the queue must not show its song in its place.
                    playedAsVideo.set(videoId, true);
                    return null;
                }
                playedAsVideo.delete(videoId);
                log('Playing song:', song.videoId, 'instead of music video:', videoId);
                body.videoId = song.videoId;
                if (radioFlips.has(body.playlistId)) body.playlistId = radioFlips.get(body.playlistId);
                return body;
            }
            const song = await resolveAlbumSong(body.playlistId, body.videoId, body.context);
            if (!song) return null;
            log('Playing song:', song.videoId, 'instead of:', body.videoId);
            body.videoId = song.videoId;
            return body;
        }

        async function resolveAlbumSong(playlistId, videoId, context) {
            const known = cache.getPair(playlistId, videoId);
            if (known !== undefined) return known;
            if (cache.getReversePair(playlistId, videoId)) return null; // Already the song.

            const deadline = now() + MAX_WAIT_FOR_ALBUM_MS;
            const songs = await cache.awaitSongs(playlistId, videoId, MAX_WAIT_FOR_ALBUM_MS);
            if (!songs) return null;
            if (songs.some((s) => s && s.videoId === videoId)) return null; // Already the song.

            // The queue response may have landed meanwhile.
            const landed = cache.getPair(playlistId, videoId);
            if (landed !== undefined) return landed;

            // Otherwise the album queue is read to find the position of this music video.
            const queue = await withTimeout(
                Promise.resolve(fetchPageQueue(videoId, playlistId, context)).catch(() => null),
                deadline - now());
            if (queue) await processQueueResponse(queue, 0);
            const pair = cache.getPair(playlistId, videoId);
            return pair === undefined ? null : pair;
        }

        return {
            cache,
            processQueueResponse,
            prefetchAlbums,
            learnMusicVideos,
            rewriteNextRequest,
            rewritePlayerRequest,
        };
    }

    // endregion

    // region Music videos outside of albums: finding their song

    // Music videos have no exact link to their song outside of albums, so the song is searched for
    // and only a sure match is taken. Port of the matching of ytm-rs (src/ytm.rs, same_song).

    const SONG_SEARCH_PARAMS = 'EgWKAQIIAWoQEAMQBBAJEAoQBRAREBAQFQ%3D%3D';
    const NUMBER_OF_SEARCH_HITS_TO_CHECK = 5;
    const NUMBER_OF_VIDEOS_TO_REMEMBER = 500;
    const NUMBER_OF_SONG_ENTRIES_TO_REMEMBER = 200;
    const NUMBER_OF_PLAYLISTS_TO_REMEMBER = 20;
    // Tracks after the playing one whose songs are looked up ahead, for the next track changes.
    const NUMBER_OF_TRACKS_TO_LOOK_UP_AHEAD = 3;
    const RADIO_PREFIX = 'RDAMVM';

    const VIDEO_WORDS = new Set(('official video music lyric lyrics lyrical audio visualizer visualiser hd 4k hq mv '
        + 'clip videoclip officiel full song with').split(' '));
    const VIDEO_TITLE_ENDINGS = ['official music video', 'official lyric video', 'official video', 'official audio',
        'official visualizer', 'music video', 'lyric video', 'lyrical video', 'video song', 'full video'];
    const RECORDING_VARIANTS = new Set(('live acoustic remix remixed cover instrumental karaoke sped slowed reverb '
        + 'nightcore 8d demo unplugged orchestral extended version mashup rehearsal edit mix rework bootleg').split(' '));
    const ARTIST_SEPARATORS = [' | ', ' & ', ', ', ' x ', ' feat. ', ' ft. ', ' and ', ' with '];

    /** A Map that forgets its oldest entries past a size. */
    class SizeRestrictedMap extends Map {
        constructor(maxSize) {
            super();
            this.maxSize = maxSize;
        }

        set(key, value) {
            if (this.has(key)) this.delete(key);
            super.set(key, value);
            while (this.size > this.maxSize) this.delete(this.keys().next().value);
            return this;
        }
    }

    /** Lowercase words, punctuation dropped ("Don't" = "dont"). */
    function words(text) {
        return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean).join(' ');
    }

    /** A music video's title without what marks it as a video: "(Official Video)", "[4K]", "| Lyric Video". */
    function songTitleOf(videoTitle) {
        let rest = String(videoTitle || '').split(' | ')[0];
        let out = '';
        for (;;) {
            const open = rest.search(/[([]/);
            if (open < 0) break;
            const close = rest.indexOf(rest[open] === '(' ? ')' : ']', open);
            if (close < 0) break;
            out += rest.slice(0, open);
            // Bracketed parts only about the video go. "(Remix Official Video)" says more and stays.
            const inner = words(rest.slice(open + 1, close)).split(' ').filter(Boolean);
            if (!inner.every((w) => VIDEO_WORDS.has(w))) out += rest.slice(open, close + 1);
            rest = rest.slice(close + 1);
        }
        let title = (out + rest).trim();
        for (;;) {
            const ending = VIDEO_TITLE_ENDINGS.find((e) => title.toLowerCase().endsWith(e));
            if (!ending) break;
            const shorter = title.slice(0, title.length - ending.length).replace(/[\s\-–|:"']+$/u, '');
            if (!shorter) break;
            title = shorter;
        }
        return title;
    }

    /** A title without the "Artist - " some music videos lead with. */
    function withoutArtist(title, artists) {
        const cut = title.indexOf(' - ');
        if (cut < 0) return title;
        const lead = words(title.slice(0, cut));
        const rest = title.slice(cut + 3).trim();
        return rest && artists.some((a) => words(a) === lead) ? rest : title;
    }

    /** The title's words without anything in brackets ("(feat. X)", "(2009 Remaster)"). */
    function baseTitleOf(title) {
        let out = '';
        let depth = 0;
        for (const c of String(title)) {
            if (c === '(' || c === '[') depth++;
            else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
            else if (depth === 0) out += c;
        }
        return words(out);
    }

    /** Words that make a recording something other than the song itself. */
    function variantsOf(title) {
        return [...new Set(words(title).split(' ').filter((w) => RECORDING_VARIANTS.has(w)))].sort();
    }

    /** The words of each bracketed part of a title. */
    function qualifiersOf(title) {
        const out = [];
        let depth = 0;
        let part = '';
        for (const c of String(title)) {
            if (c === '(' || c === '[') {
                if (depth === 0) part = '';
                depth++;
            } else if ((c === ')' || c === ']') && depth > 0) {
                depth--;
                if (depth === 0) out.push(words(part));
            } else if (depth > 0) {
                part += c;
            }
        }
        return out;
    }

    /**
     * Bracketed parts on one title only must be ones that do not change the recording: a featured
     * artist, where it is from, a remaster, a year.
     */
    function qualifiersAgree(a, b) {
        const harmless = (q) => {
            const w = q.split(' ');
            return ['feat', 'ft', 'featuring', 'with', 'from'].includes(w[0])
                || w.some((x) => x.startsWith('remaster'))
                || w.every((x) => /^\d+$/.test(x));
        };
        const qa = qualifiersOf(a);
        const qb = qualifiersOf(b);
        return qa.filter((q) => !qb.includes(q)).concat(qb.filter((q) => !qa.includes(q))).every(harmless);
    }

    /** The same artist: the same name, also as one of the names in a longer credit ("A & B"). */
    function sameArtist(name, credit) {
        const wanted = words(name);
        if (!wanted) return false;
        let parts = [String(credit).toLowerCase()];
        for (const separator of ARTIST_SEPARATORS) parts = parts.flatMap((p) => p.split(separator));
        return parts.some((p) => words(p) === wanted);
    }

    /**
     * Whether a song from a search is the song of a music video: the same title once the video's own
     * markings are off, the same kind of recording, everyone on the video credited on the song, and a
     * length that fits. A video can run longer (an intro, a skit), and often shorter.
     */
    function isSongOfVideo(video, hit) {
        const title = withoutArtist(songTitleOf(video.title), video.artists);
        const base = baseTitleOf(title);
        const v = video.durationSeconds;
        const s = hit.durationSeconds;
        const fits = v > 0 && s > 0 && s + Math.max(30, Math.floor(v / 5)) >= v && s <= v * 2;
        return hit.isSong
            && !!base && base === baseTitleOf(hit.title)
            && variantsOf(video.title).join() === variantsOf(hit.title).join()
            && qualifiersAgree(title, hit.title)
            && video.artists.length > 0
            && video.artists.every((a) => hit.artists.some((b) => sameArtist(a, b)))
            && fits;
    }

    /** @return The search query that finds the song of a music video. */
    function songQueryOf(video) {
        return `${withoutArtist(songTitleOf(video.title), video.artists)} ${video.artists[0] || ''}`.trim();
    }

    const isDuration = (text) => /^\d+(:\d\d)+$/.test(String(text || '').trim());

    function linkedArtistsOf(runs) {
        // The artists come before the views, the album or the length, and link to their page.
        return (runs || [])
            .filter((r) => {
                const browse = r && r.navigationEndpoint && r.navigationEndpoint.browseEndpoint;
                const pageType = pageTypeOf(r);
                return browse && (pageType === 'MUSIC_PAGE_TYPE_ARTIST' || pageType === 'MUSIC_PAGE_TYPE_USER_CHANNEL'
                    || String(browse.browseId || '').startsWith('UC'));
            })
            .map((r) => r.text);
    }

    function durationOfRuns(runs) {
        const run = (runs || []).find((r) => r && isDuration(r.text));
        return run ? parseDuration(run.text) : 0;
    }

    /** The songs of a song search, best match first. */
    function parseSongSearch(json) {
        const hits = [];
        (function walk(node) {
            if (Array.isArray(node)) return node.forEach((v) => v && typeof v === 'object' && walk(v));
            for (const key of Object.keys(node)) {
                const v = node[key];
                if (!v || typeof v !== 'object') continue;
                if (key === 'musicResponsiveListItemRenderer' && v.playlistItemData && v.playlistItemData.videoId) {
                    const columns = (v.flexColumns || []).map((c) => c.musicResponsiveListItemFlexColumnRenderer
                        && c.musicResponsiveListItemFlexColumnRenderer.text);
                    const details = (columns[1] && columns[1].runs) || [];
                    hits.push({
                        videoId: v.playlistItemData.videoId,
                        title: runsText(columns[0]),
                        artists: linkedArtistsOf(details),
                        durationSeconds: durationOfRuns(details),
                        isSong: JSON.stringify(v).includes(`"${MUSIC_VIDEO_TYPE_SONG}"`),
                    });
                } else {
                    walk(v);
                }
            }
        })(json);
        return hits;
    }

    /** The id and type of the first video a renderer plays. */
    function watchedVideoOf(renderer) {
        let found = null;
        (function walk(node) {
            if (found || !node || typeof node !== 'object') return;
            if (Array.isArray(node)) return node.forEach(walk);
            if (node.watchEndpoint && typeof node.watchEndpoint.videoId === 'string') {
                found = { videoId: node.watchEndpoint.videoId, type: musicVideoTypeOf(node.watchEndpoint) };
                return;
            }
            Object.values(node).forEach(walk);
        })(renderer);
        return found;
    }

    /**
     * @return The music videos a response shows, with what finding their song needs: title,
     *         artists and length (missing in some cards).
     */
    function collectMusicVideos(json) {
        const videos = [];
        const add = (videoId, title, artists, durationSeconds) => {
            if (videoId && title) videos.push({ videoId, title, artists, durationSeconds });
        };
        (function walk(node) {
            if (Array.isArray(node)) return node.forEach((v) => v && typeof v === 'object' && walk(v));
            for (const key of Object.keys(node)) {
                const v = node[key];
                if (!v || typeof v !== 'object') continue;
                if (key === 'playlistPanelVideoRenderer' && typeof v.videoId === 'string') {
                    const endpoint = v.navigationEndpoint && v.navigationEndpoint.watchEndpoint;
                    if (musicVideoTypeOf(endpoint) === 'MUSIC_VIDEO_TYPE_OMV') {
                        const artistRuns = artistRunsOf(v.longBylineText);
                        const linked = linkedArtistsOf(artistRuns);
                        const named = artistRuns.map((r) => String(r.text || '').trim())
                            .filter((t) => t && t !== '&' && t !== ',');
                        add(v.videoId, runsText(v.title), linked.length ? linked : named,
                            parseDuration(runsText(v.lengthText)));
                    }
                    continue;
                }
                if (key === 'musicResponsiveListItemRenderer') {
                    const watched = watchedVideoOf(v);
                    const videoId = (v.playlistItemData && v.playlistItemData.videoId) || (watched && watched.videoId);
                    if (watched && watched.videoId === videoId && watched.type === 'MUSIC_VIDEO_TYPE_OMV') {
                        const columns = (v.flexColumns || []).map((c) => c.musicResponsiveListItemFlexColumnRenderer
                            && c.musicResponsiveListItemFlexColumnRenderer.text);
                        const details = (columns[1] && columns[1].runs) || [];
                        const fixed = v.fixedColumns && v.fixedColumns[0]
                            && v.fixedColumns[0].musicResponsiveListItemFixedColumnRenderer;
                        add(videoId, runsText(columns[0]), linkedArtistsOf(details),
                            durationOfRuns(details) || parseDuration(runsText(fixed && fixed.text)));
                    }
                    continue;
                }
                if (key === 'musicCardShelfRenderer' || key === 'musicTwoRowItemRenderer') {
                    const watched = watchedVideoOf(v.title || v.navigationEndpoint || v);
                    if (watched && watched.type === 'MUSIC_VIDEO_TYPE_OMV') {
                        const runs = (v.subtitle && v.subtitle.runs) || [];
                        add(watched.videoId, runsText(v.title), linkedArtistsOf(runs), durationOfRuns(runs));
                    }
                }
                walk(v);
            }
        })(json);
        return videos;
    }

    /**
     * @return The music video rows of an album page with the song their credits name
     *         ("View song credits" opens MPTC + the song id), which is exact.
     */
    function collectAlbumCredits(json) {
        const pairs = [];
        (function walk(node) {
            if (Array.isArray(node)) return node.forEach((v) => v && typeof v === 'object' && walk(v));
            for (const key of Object.keys(node)) {
                const v = node[key];
                if (!v || typeof v !== 'object') continue;
                if (key === 'musicResponsiveListItemRenderer' && v.playlistItemData && v.playlistItemData.videoId) {
                    const watched = watchedVideoOf(v);
                    if (!watched || watched.type !== 'MUSIC_VIDEO_TYPE_OMV') continue;
                    const credits = JSON.stringify(v).match(/"browseId":"MPTC([\w-]{11})"/);
                    if (credits && credits[1] !== v.playlistItemData.videoId) {
                        pairs.push({ videoId: v.playlistItemData.videoId, songVideoId: credits[1] });
                    }
                    continue;
                }
                walk(v);
            }
        })(json);
        return pairs;
    }

    const JS_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };

    /** The value of a single-quoted JavaScript string literal, as the page writes its data. */
    function decodeJsString(text) {
        return text.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[\s\S])/g, (match, escape) => {
            if (escape[0] === 'x' || escape[0] === 'u') return String.fromCharCode(parseInt(escape.slice(1), 16));
            return JS_ESCAPES[escape] !== undefined ? JS_ESCAPES[escape] : escape;
        });
    }

    /**
     * @return The responses a page opened directly embeds in its HTML instead of fetching them,
     *         from the text of its inline scripts ("initialData.push({path: ..., data: '...'})").
     */
    function parseInitialData(scriptText) {
        const responses = [];
        if (!scriptText || !scriptText.includes('initialData.push')) return responses;
        const pattern = /data:\s*'((?:[^'\\]|\\[\s\S])*)'/g;
        let match;
        while ((match = pattern.exec(scriptText)) !== null) {
            try {
                responses.push(JSON.parse(decodeJsString(match[1])));
            } catch (e) { /* not a response */ }
        }
        return responses;
    }

    /** @return The video a radio is started from ("RDAMVM" + its id), or null. */
    function radioSeedOf(playlistId) {
        const match = /^RDAMVM([\w-]{11})$/.exec(String(playlistId || ''));
        return match ? match[1] : null;
    }

    // endregion

    // region Browser glue

    function endpointOf(url) {
        const match = /\/youtubei\/v1\/(next|player|browse|search|music\/get_queue)(?:\?|$)/.exec(url);
        return match ? match[1] : null;
    }

    function install() {
        const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        const settings = {
            enabled: GM_getValue('enabled', true),
            everywhere: GM_getValue('everywhere', true),
            debug: GM_getValue('debug', false),
        };
        const log = (...args) => {
            if (settings.debug) console.log(LOG_PREFIX, ...args);
        };
        const warn = (...args) => console.warn(LOG_PREFIX, ...args);

        GM_registerMenuCommand(`Play album songs: ${settings.enabled ? 'ON' : 'OFF'} (click to toggle)`, () => {
            GM_setValue('enabled', !settings.enabled);
            win.location.reload();
        });
        GM_registerMenuCommand(`Outside albums too: ${settings.everywhere ? 'ON' : 'OFF'} (click to toggle)`, () => {
            GM_setValue('everywhere', !settings.everywhere);
            win.location.reload();
        });
        GM_registerMenuCommand(`Debug logging: ${settings.debug ? 'ON' : 'OFF'} (click to toggle)`, () => {
            GM_setValue('debug', !settings.debug);
            win.location.reload();
        });

        if (!settings.enabled) return;

        const originalFetch = win.fetch;
        const gl = ((win.navigator.language || '').split('-')[1] || 'US').toUpperCase();

        const sendLookup = (playlistId, videoId) => new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: LOOKUP_URL,
                anonymous: true,
                timeout: CONNECTION_TIMEOUT_MS,
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': LOOKUP_CLIENT.userAgent,
                    'X-YouTube-Client-Name': String(LOOKUP_CLIENT.id),
                    'X-YouTube-Client-Version': LOOKUP_CLIENT.clientVersion,
                    'X-GOOG-API-FORMAT-VERSION': '2',
                },
                data: JSON.stringify(buildLookupBody(playlistId, videoId, gl)),
                onload: (r) => {
                    if (r.status !== 200) {
                        log('Album request failed:', r.status, r.statusText);
                        resolve(null);
                        return;
                    }
                    try {
                        resolve(JSON.parse(r.responseText));
                    } catch (e) {
                        resolve(null);
                    }
                },
                onerror: () => resolve(null),
                ontimeout: () => resolve(null),
                onabort: () => resolve(null),
            });
        });

        // Client of the page, from its own requests, for the requests made by this script.
        let pageClient = null;
        const clientOf = (context) => {
            const client = (context && context.client) || pageClient || {};
            let clientVersion = client.clientVersion;
            if (!clientVersion) {
                try {
                    clientVersion = win.ytcfg && win.ytcfg.get && win.ytcfg.get('INNERTUBE_CLIENT_VERSION');
                } catch (e) { /* ignore */ }
            }
            return {
                clientName: client.clientName || 'WEB_REMIX',
                clientVersion: clientVersion || '',
                hl: client.hl || 'en',
                gl: client.gl || gl,
            };
        };

        // Signed out, so the server answers as it does for everyone, without the account.
        const postSignedOut = async (endpoint, context, fields) => {
            const client = clientOf(context);
            const response = await originalFetch.call(win, `${win.location.origin}/youtubei/v1/${endpoint}?prettyPrint=false`, {
                method: 'POST',
                credentials: 'omit',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Youtube-Client-Name': '67',
                    'X-Youtube-Client-Version': client.clientVersion,
                },
                body: JSON.stringify(Object.assign({ context: { client } }, fields)),
            });
            return response.ok ? response.json() : null;
        };

        // The queue of the album, which lists every track as the server does.
        const fetchPageQueue = (videoId, playlistId, context) => postSignedOut('next', context, { videoId, playlistId });

        // A song queued on its own carries the square art of its album, and its byline names the album.
        const fetchSongDetails = async (songVideoId) => {
            const json = await postSignedOut('music/get_queue', null, { videoIds: [songVideoId] });
            const item = json && collectQueueItems(json).items.find((i) => i.videoId === songVideoId);
            return item ? { thumbnails: item.thumbnails(), longBylineText: item.byline() } : null;
        };

        // Signed out, so the searches stay out of the account's search history.
        const searchSongs = (query) => postSignedOut('search', null, { query, params: SONG_SEARCH_PARAMS });

        // Songs queued on their own, in one request: their entries as the queue shows songs.
        const fetchSongEntries = (songVideoIds) => postSignedOut('music/get_queue', null, { videoIds: songVideoIds });

        const core = createCore({
            sendLookup, fetchPageQueue, fetchSongDetails, searchSongs, fetchSongEntries,
            everywhere: settings.everywhere, log,
        });

        const hasInitBody = (init) => !!init && init.body !== undefined && init.body !== null;
        const isRequest = (input) => !!input && typeof input === 'object'
            && typeof input.url === 'string' && typeof input.arrayBuffer === 'function';

        async function bytesOf(body) {
            const tag = Object.prototype.toString.call(body);
            if (tag === '[object ArrayBuffer]') return new Uint8Array(body);
            if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
            if (body && typeof body.arrayBuffer === 'function') return new Uint8Array(await body.arrayBuffer());
            return null;
        }

        async function gunzip(bytes) {
            const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
            return new Uint8Array(await new Response(stream).arrayBuffer());
        }

        /**
         * The app gzips the bodies of its requests when an experiment of it is on
         * ("wug_networking_gzip_request"), and then sends them in a Request object.
         * @return {{text: string, compressed: boolean} | null}
         */
        async function readRequestBody(input, init) {
            let body;
            if (hasInitBody(init)) body = init.body;
            else if (isRequest(input)) body = await input.clone().arrayBuffer();
            else return null;
            if (typeof body === 'string') return { text: body, compressed: false };

            let bytes = await bytesOf(body);
            if (!bytes) return null;
            const compressed = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
            if (compressed) bytes = await gunzip(bytes);
            return { text: new TextDecoder().decode(bytes), compressed };
        }

        /** The rewritten body is sent as plain JSON, which the server takes as it does with the experiment off. */
        function headersWithoutContentEncoding(headers) {
            const result = new win.Headers(headers || undefined);
            result.delete('content-encoding');
            return result;
        }

        async function rewriteRequest(endpoint, input, init) {
            const read = await readRequestBody(input, init);
            if (!read) return null;
            let body;
            try {
                body = JSON.parse(read.text);
            } catch (e) {
                log(endpoint, 'request body is not JSON, left as is:', read.text.slice(0, 16));
                return null;
            }
            if (body && body.context && body.context.client) pageClient = body.context.client;
            const rewritten = endpoint === 'player'
                ? await core.rewritePlayerRequest(body)
                : await core.rewriteNextRequest(body);
            if (!rewritten) return null;

            const newBody = JSON.stringify(rewritten);
            if (hasInitBody(init)) {
                const newInit = Object.assign({}, init, { body: newBody });
                if (read.compressed) newInit.headers = headersWithoutContentEncoding(init.headers || (isRequest(input) && input.headers));
                return { input, init: newInit };
            }
            const overrides = { body: newBody };
            if (read.compressed) overrides.headers = headersWithoutContentEncoding(input.headers);
            return { input: new win.Request(input, overrides), init };
        }

        async function rewriteResponse(endpoint, response) {
            if (!response.ok) return response;
            const json = await response.clone().json();
            if (endpoint === 'browse') {
                core.prefetchAlbums(json);
                return response;
            }
            if (endpoint === 'search') {
                core.learnMusicVideos(json);
                return response;
            }
            if (!(await core.processQueueResponse(json))) return response;

            const headers = new win.Headers(response.headers);
            headers.delete('content-length');
            headers.delete('content-encoding');
            const rewritten = new win.Response(JSON.stringify(json), {
                status: response.status,
                statusText: response.statusText,
                headers,
            });
            try {
                Object.defineProperty(rewritten, 'url', { value: response.url });
            } catch (e) { /* ignore */ }
            return rewritten;
        }

        win.fetch = async function (input, init) {
            let endpoint = null;
            try {
                const url = typeof input === 'string' ? input : (input && input.url) || String(input);
                endpoint = endpointOf(url);
            } catch (e) { /* ignore */ }
            if (!endpoint) return originalFetch.call(win, input, init);

            if (endpoint === 'player' || endpoint === 'next') {
                try {
                    const rewritten = await rewriteRequest(endpoint, input, init);
                    if (rewritten) ({ input, init } = rewritten);
                } catch (e) {
                    warn(`${endpoint} request rewrite failure`, e);
                }
            }

            const response = await originalFetch.call(win, input, init);
            if (endpoint === 'player') return response;
            try {
                return await rewriteResponse(endpoint, response);
            } catch (e) {
                warn(`${endpoint} response rewrite failure`, e);
                return response;
            }
        };

        // A page opened directly embeds its first responses in its HTML instead of fetching them.
        const readInitialData = () => {
            try {
                for (const script of win.document.querySelectorAll('script:not([src])')) {
                    for (const json of parseInitialData(script.textContent)) core.prefetchAlbums(json);
                }
            } catch (e) {
                warn('initial data read failure', e);
            }
        };
        if (win.document.readyState === 'loading') {
            win.document.addEventListener('DOMContentLoaded', readInitialData, { once: true });
        } else {
            readInitialData();
        }

        // Only fetch is handled. Report XMLHttpRequest use so it is noticed if the app switches to it.
        const originalOpen = win.XMLHttpRequest.prototype.open;
        win.XMLHttpRequest.prototype.open = function (method, url) {
            try {
                const endpoint = endpointOf(String(url));
                if (endpoint) warn('XMLHttpRequest used for', endpoint, '- not handled by this script');
            } catch (e) { /* ignore */ }
            return originalOpen.apply(this, arguments);
        };

        log('Installed');
    }

    // endregion

    if (typeof module === 'object' && module.exports) {
        module.exports = {
            createCore,
            AlbumCache,
            parseAlbumResponse,
            parseDuration,
            formatDuration,
            normalizeTitle,
            titlesMatch,
            isVideoTitleOf,
            isSongOfVideo,
            songTitleOf,
            songQueryOf,
            parseSongSearch,
            collectMusicVideos,
            collectAlbumCredits,
            radioSeedOf,
            parseInitialData,
            decodeJsString,
            endpointOf,
            buildLookupBody,
            install,
        };
    } else {
        install();
    }
})();
