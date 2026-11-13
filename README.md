# Hark

A light audiobook player for free public-domain recordings (LibriVox, via the Internet Archive and LibriVox catalogues). It is a home-screen web app: no App Store, no Mac, no build step, about 160 KB.

## Install on an iPhone

1. Put the `www` folder on any HTTPS static host (GitHub Pages, Cloudflare Pages, Netlify).
2. Open the link in **Safari** on the iPhone.
3. Tap **Share → Add to Home Screen → Add**.
4. Open Hark from the home screen. It runs full screen and keeps its library on the phone.

## Run on this PC

```bash
node dev-server.mjs
```

Then open http://localhost:4173.

## What is in it

- **Home, Search, Library, Settings**, a book page and a full-screen player with a mini player.
- **Two catalogue sources with automatic fallback** (`www/js/sources.js`). Order and on/off are in Settings. A third source is one more object with the same six functions.
- **Playback** (`www/js/player.js`): resume positions, skip, speed, sleep timer, lock-screen controls, and the next chapter prepared in advance so the hand-over works with the screen locked.
- **Downloads** (`www/js/downloads.js`): chapters stored on the phone for offline listening.
- **Ebooks** (`www/js/books.js`): Standard Ebooks and Project Gutenberg (as mirrored by the Internet Archive), asked together; either one is enough. Also imports your own `.epub` and `.txt` files.
- **Reader** (`www/js/reader.js`): pages or scrolling, type settings, contents, bookmarks, highlights with notes, search inside the book, and Read along with the audiobook that is playing.
- **Themes** (`www/js/theme.js`): eight presets, a theme from any photo, a theme from a book cover.

## Known limits

- Both catalogues keep their audio on archive.org. If that site is down, only downloaded books play.
- LibriVox search matches the start of a title or an author's surname only; the Internet Archive search is full.
- Downloads run only while Hark is open on screen (iOS pauses web apps in the background unless audio is playing).
- Read along lines the text up with the recording by chapter heading, or by position in the book when headings differ. It is not word-for-word.
- Project Gutenberg books arrive as plain text (the only format the Internet Archive lets an app fetch), so their layout is simpler than Standard Ebooks editions.
- The Standard Ebooks catalogue is read from its public web pages, so a redesign of that site could break it until the parser is updated.
- Recordings and texts are public domain in the USA; other countries differ.

## Icons

`node make-icons.mjs` redraws the PNG icons in `www/icons`.
