# YouTube Music - Play albums songs

A userscript for [YouTube Music](https://music.youtube.com) that plays the **song version** of album tracks instead of their **music videos**.

When you play an album, YouTube Music swaps in the official music video for every track that has one. Music videos often have intros, skits, different mixes or a different length. This script keeps the album as released: every track plays the audio of the album itself.

> **Unofficial.** This script is an independent port of the "Play albums songs" patch of the Morphe project's YouTube Music patches, rewritten for the browser. It is not made, endorsed or supported by Morphe or by Google. Please report issues here, not to Morphe.

## Features

- Album tracks play their song version, in the queue, the player, the player bar and the system media controls.
- The queue keeps its place when tracks change, including when you tap a track in the middle.
- A whole album added to the queue plays the song of every track.
- Songs show the square album art and the length of the album track.
- Everything outside of albums is left alone: music videos from search, playlists, radio and recommendations play as usual.
- If an album cannot be looked up within 5 seconds, its music videos play as before.

## Install

1. Install a userscript manager: [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Install `ytm-album-songs.user.js`: open the raw file and confirm in the manager, or create a new script and paste the file.
3. Reload music.youtube.com.

Tested on Firefox with a userscript manager. Other browsers with Tampermonkey or Violentmonkey should work the same.

## Settings

In the userscript manager menu on music.youtube.com:

- **Play album songs: ON/OFF** turns the script on or off.
- **Debug logging: ON/OFF** logs what the script does to the browser console, prefixed with `[ytm-album-songs]`. Include these lines when reporting an issue.

Both reload the page.
