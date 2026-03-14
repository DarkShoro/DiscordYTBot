# Discord Music Bot (discord.js v14 + yt-dlp)

A queue-based Discord music bot for Node.js using:
- `discord.js` (latest v14)
- `@discordjs/voice`
- `yt-dlp` for media extraction/search
- `ffmpeg-static` for transcoding

## Features

- Slash commands: `/play`, `/skip`, `/stop`, `/pause`, `/resume`, `/queue`, `/nowplaying`
- Slash commands: `/search`, `/play`, `/skip`, `/stop`, `/pause`, `/resume`, `/queue`, `/nowplaying`
- YouTube URL playback
- Text search playback (`/play input:<search terms>`)
- Per-guild queue management

## Requirements

- Node.js 18+
- A Discord bot application
- `yt-dlp` installed on your machine and reachable via PATH
  - Or set `YTDLP_PATH` in your `.env`

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy env template:

```bash
copy .env.example .env
```

3. Fill in `.env`:

- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_GUILD_ID` (for guild command deployment)
- Optional: `YTDLP_PATH` (default is `yt-dlp`)
- Optional: `FFMPEG_PATH` (path to ffmpeg executable; when omitted the bot auto-detects system ffmpeg and then falls back to `ffmpeg-static`)

4. Deploy slash commands to your test guild:

```bash
npm run deploy
```

To remove all registered slash commands for this bot:

```bash
npm run reset
```

5. Start the bot:

```bash
npm start
```

## Commands

- `/play input:<url or search text>`
- `/search query:<text>`
- `/search query:<text> pick:<1-5>`
- `/skip`
- `/stop`
- `/pause`
- `/resume`
- `/queue`
- `/nowplaying`

## Notes

- If playback fails, verify both `yt-dlp` and network access to media sources.
- Guild command deployment is immediate, unlike global command registration.
- `npm run reset` clears both guild commands (if `DISCORD_GUILD_ID` is set) and global commands.
