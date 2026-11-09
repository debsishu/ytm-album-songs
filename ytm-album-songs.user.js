// ==UserScript==
// @name         YouTube Music - Play albums songs
// @namespace    ytm-album-songs
// @version      1.0.0
// @description  Plays the song version of album tracks on YouTube Music instead of their music videos. Unofficial userscript port of a patch of the Morphe project.
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

    /**
     * Replaces a video id everywhere in a renderer, including thumbnail urls and endpoints.
     * @param retype Whether the music video type is also changed to the song type.
     * @param art Album art that replaces the frames of the music video, if known. Otherwise the
     *            frames are of the song, which is the album art in a 16:9 frame.
     */
    function replaceVideoId(node, fromId, toId, retype, art) {
        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i++) {
                const v = node[i];
                if (typeof v === 'string') node[i] = replaceInString(v, fromId, toId, retype);
                else if (v && typeof v === 'object') replaceVideoId(v, fromId, toId, retype, art);
            }
        } else if (node && typeof node === 'object') {
            for (const key of Object.keys(node)) {
                const v = node[key];
                if (typeof v === 'string') {
                    node[key] = replaceInString(v, fromId, toId, retype);
                } else if (key === 'thumbnails' && art && Array.isArray(v)
                    && v.some((t) => t && typeof t.url === 'string' && t.url.includes(fromId))) {
                    node[key] = cloneThumbnails(art);
                } else if (v && typeof v === 'object') {
                    replaceVideoId(v, fromId, toId, retype, art);
                }
            }
        }
    }

    function replaceInString(value, fromId, toId, retype) {
        if (value === fromId) return toId;
        if (retype && MUSIC_VIDEO_TYPES_TO_REPLACE.has(value)) return MUSIC_VIDEO_TYPE_SONG;
        return value.includes(fromId) ? value.split(fromId).join(toId) : value;
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
                /** Fetch of the album art in flight, or null. */
                artPromise: null,
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
        if (atIndex && titlesMatch(atIndex.title, item.title)) return atIndex;
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
        const fetchSongArt = deps.fetchSongArt || (async () => null);
        const cache = new AlbumCache({ sendLookup: deps.sendLookup, now, sleep, log });

        function applyGroup(playlistId, group, songs) {
            const indexes = group.map((item) => item.index).filter(Number.isInteger);
            // An album added to the queue can give every track the position of its first track.
            // Two videos cannot be the same album track, so then the positions are not used.
            const indexTrusted = indexes.length === group.length && new Set(indexes).size === indexes.length;
            // Without positions, the order is only trusted when the whole album is listed.
            const orderTrusted = group.length === songs.length;

            const art = cache.getArt(playlistId);
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
                replaceVideoId(item.renderer, item.videoId, song.videoId, true, art);
                if (song.durationSeconds > 0) item.setLength(formatDuration(song.durationSeconds));
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
        function applyCurrentVideo(json) {
            const endpoint = json.currentVideoEndpoint && json.currentVideoEndpoint.watchEndpoint;
            if (!endpoint || !isAlbum(endpoint.playlistId) || typeof endpoint.videoId !== 'string') return false;
            const song = cache.getPair(endpoint.playlistId, endpoint.videoId);
            if (!song) return false;
            // Includes the art of the media session, which the player bar and the system show.
            replaceVideoId(json, endpoint.videoId, song.videoId, false, cache.getArt(endpoint.playlistId));
            return true;
        }

        /**
         * Song entries show the square art of their album, while music videos show a video frame.
         * The art is taken from a song of the album the queue already has, or else fetched once.
         */
        async function ensureAlbumArt(playlistId, group, songs, timeoutMs) {
            for (const item of group) {
                if (item.musicVideoType === MUSIC_VIDEO_TYPE_SONG) cache.setArt(playlistId, item.thumbnails());
            }
            const entry = cache.entries.get(playlistId);
            if (!entry || entry.art || group.every((item) => item.musicVideoType === MUSIC_VIDEO_TYPE_SONG)) return;
            if (!entry.artPromise) {
                const song = songs.find(Boolean);
                if (!song) return;
                entry.artPromise = Promise.resolve()
                    .then(() => fetchSongArt(song.videoId))
                    .catch(() => null)
                    .then((thumbnails) => {
                        cache.setArt(playlistId, thumbnails);
                        // Retried by the next queue when it failed.
                        if (!entry.art) entry.artPromise = null;
                    });
            }
            await withTimeout(entry.artPromise, timeoutMs);
        }

        /**
         * Puts the songs of album tracks in the queue of a next or get_queue response.
         * @return Whether the response was changed.
         */
        async function processQueueResponse(json, waitMs = MAX_WAIT_FOR_ALBUM_MS) {
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
                await ensureAlbumArt(playlistId, group, songs, deadline - now());
                changed = applyGroup(playlistId, group, songs) || changed;
            }

            return applyCurrentVideo(json) || changed;
        }

        /** Gives the album fetch a head start as soon as an album is shown. */
        function prefetchAlbums(json) {
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
        function rewriteNextRequest(body) {
            if (!body || !isAlbum(body.playlistId) || typeof body.videoId !== 'string') return null;
            const musicVideoId = cache.getReversePair(body.playlistId, body.videoId);
            if (!musicVideoId) return null;
            body.videoId = musicVideoId;
            log('Asking for the queue of:', musicVideoId, 'instead of its song');
            return body;
        }

        /**
         * Plays the song of an album music video the queue still holds.
         * @return The request body to send, or null to send it unchanged.
         */
        async function rewritePlayerRequest(body) {
            if (!body || !isAlbum(body.playlistId) || typeof body.videoId !== 'string') return null;
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
            rewriteNextRequest,
            rewritePlayerRequest,
        };
    }

    // endregion

    // region Browser glue

    function endpointOf(url) {
        const match = /\/youtubei\/v1\/(next|player|browse|music\/get_queue)(?:\?|$)/.exec(url);
        return match ? match[1] : null;
    }

    function install() {
        const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        const settings = {
            enabled: GM_getValue('enabled', true),
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

        // A song queued on its own carries the square art of its album.
        const fetchSongArt = async (songVideoId) => {
            const json = await postSignedOut('music/get_queue', null, { videoIds: [songVideoId] });
            const item = json && collectQueueItems(json).items.find((i) => i.videoId === songVideoId);
            return item ? item.thumbnails() : null;
        };

        const core = createCore({ sendLookup, fetchPageQueue, fetchSongArt, log });

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
                : core.rewriteNextRequest(body);
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
            endpointOf,
            buildLookupBody,
            install,
        };
    } else {
        install();
    }
})();
