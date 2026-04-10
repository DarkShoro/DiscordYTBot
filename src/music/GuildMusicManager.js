import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import ffmpegStaticPath from 'ffmpeg-static';
import { normalizeDuration, normalizeTrackInfo, runYtDlp } from './ytDlp.js';

const configuredFfmpegPath = process.env.FFMPEG_PATH?.trim();

function getFfmpegCandidates() {
  if (configuredFfmpegPath) {
    return [configuredFfmpegPath, 'ffmpeg', ffmpegStaticPath].filter(Boolean);
  }

  if (process.platform === 'win32') {
    return ['ffmpeg.exe', 'ffmpeg', ffmpegStaticPath].filter(Boolean);
  }

  return ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg', ffmpegStaticPath].filter(Boolean);
}

function canExecuteBinary(binary) {
  const isAbsolutePath = /^(?:[A-Za-z]:\\|\/)/.test(binary);
  if (isAbsolutePath && !existsSync(binary)) {
    return false;
  }

  const result = spawnSync(binary, ['-version'], {
    encoding: 'utf8',
    timeout: 4000,
    windowsHide: true,
  });

  if (result.error) {
    return false;
  }

  return result.status === 0;
}

function resolveFfmpegBinary() {
  const candidates = getFfmpegCandidates();

  for (const candidate of candidates) {
    if (canExecuteBinary(candidate)) {
      return candidate;
    }
  }

  return null;
}

const ffmpegPath = resolveFfmpegBinary();

if (ffmpegPath) {
  console.log(`[ffmpeg] using binary: ${ffmpegPath}`);
} else {
  console.warn('[ffmpeg] no usable ffmpeg binary detected. Set FFMPEG_PATH to a valid executable.');
}

function isLikelyUrl(value) {
  return /^https?:\/\//i.test(value);
}

function isFormatUnavailableError(error) {
  const message = String(error?.message || '');
  return /Requested format is not available|Only images are available/i.test(message);
}

function resolveAssetPath(fileName) {
  return path.resolve(process.cwd(), 'assets', fileName);
}

export class GuildMusicManager {
  constructor() {
    this.guildStates = new Map();
  }

  getExistingState(guildId) {
    return this.guildStates.get(guildId) || null;
  }

  getState(guildId) {
    if (!this.guildStates.has(guildId)) {
      this.guildStates.set(guildId, new GuildMusicState(guildId, () => this.guildStates.delete(guildId)));
    }

    return this.guildStates.get(guildId);
  }
}

class GuildMusicState {
  constructor(guildId, onCleanup) {
    this.guildId = guildId;
    this.onCleanup = onCleanup;

    this.queue = [];
    this.currentTrack = null;
    this.connection = null;
    this.ffmpeg = null;
    this.guild = null;

    this.player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause,
      },
    });

    this.player.on(AudioPlayerStatus.Buffering, () => {
      console.log(`[audio:${this.guildId}] buffering`);
    });

    this.player.on(AudioPlayerStatus.Playing, () => {
      console.log(`[audio:${this.guildId}] playing`);
    });

    this.player.on(AudioPlayerStatus.Paused, () => {
      console.log(`[audio:${this.guildId}] paused`);
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      console.log(`[audio:${this.guildId}] idle`);
      const finished = this.currentTrack;
      this.destroyFfmpeg();
      this.currentTrack = null;
      this.cleanupTempFile(finished);
      void this.playNext();
    });

    this.player.on('error', (error) => {
      console.error(`Audio player error in guild ${this.guildId}:`, error.message);
      const finished = this.currentTrack;
      this.destroyFfmpeg();
      this.currentTrack = null;
      this.cleanupTempFile(finished);
      void this.playNext();
    });
  }

  async ensureConnection(voiceChannel) {
    this.guild = voiceChannel.guild;

    if (this.connection && this.connection.joinConfig.channelId === voiceChannel.id) {
      try {
        await this.waitForConnectionReady(this.connection, 20_000);
        return false;
      } catch (error) {
        console.warn(
          `[voice:${this.guildId}] existing connection was not ready (${error.message}), recreating...`,
        );
        this.connection.destroy();
        this.connection = null;
      }
    }

    this.connection?.destroy();

    const maxAttempts = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const connection = joinVoiceChannel({
        channelId: String(voiceChannel.id),
        guildId: String(voiceChannel.guild.id),
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: true,
      });
      this.connection = connection;

      connection.subscribe(this.player);

      connection.on('stateChange', (oldState, newState) => {
        console.log(`[voice:${this.guildId}] ${oldState.status} -> ${newState.status}`);
      });

      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        if (this.connection === connection && this.disconnectIfAlone()) {
          return;
        }

        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
        } catch {
          if (this.connection === connection) {
            this.stopAndCleanup();
          }
        }
      });

      try {
        await this.waitForConnectionReady(connection, 20_000);
        return true;
      } catch (error) {
        lastError = error;
        console.warn(
          `[voice:${this.guildId}] join attempt ${attempt}/${maxAttempts} failed: ${error.message}`,
        );

        if (this.connection === connection) {
          connection.destroy();
          this.connection = null;
        }

        if (attempt < maxAttempts) {
          console.warn(`[voice:${this.guildId}] retrying voice join...`);
        }
      }
    }

    throw new Error(
      `Failed to establish voice connection after ${maxAttempts} attempts. ${lastError?.message || ''}`.trim(),
    );
  }

  async waitForConnectionReady(connection, timeoutMs = 45_000) {
    const start = Date.now();
    let lastRejoinAt = 0;

    while (Date.now() - start < timeoutMs) {
      if (!connection) {
        throw new Error('Voice connection was closed before becoming ready.');
      }

      if (connection.state.status === VoiceConnectionStatus.Ready) {
        return;
      }

      const elapsed = Date.now() - start;
      if (connection.state.status === VoiceConnectionStatus.Signalling && elapsed - lastRejoinAt >= 7_000) {
        lastRejoinAt = elapsed;
        console.warn(`[voice:${this.guildId}] signalling stall detected, forcing rejoin...`);
        connection.rejoin({
          channelId: connection.joinConfig.channelId,
          selfDeaf: connection.joinConfig.selfDeaf,
          selfMute: connection.joinConfig.selfMute,
        });
      }

      const remaining = timeoutMs - (Date.now() - start);
      const waitSlice = Math.max(1_000, Math.min(5_000, remaining));

      try {
        await entersState(connection, VoiceConnectionStatus.Ready, waitSlice);
        return;
      } catch (error) {
        if (connection.state.status === VoiceConnectionStatus.Ready) {
          return;
        }

        if (connection.state.status === VoiceConnectionStatus.Destroyed) {
          throw new Error('Voice connection was destroyed while joining the channel.');
        }

        if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
          console.warn(
            `[voice:${this.guildId}] still waiting for ready (status=${connection.state.status || 'unknown'})`,
          );
          continue;
        }

        throw error;
      }
    }

    throw new Error(
      'Timed out while joining the voice channel. Verify permissions and ensure only one bot process is running.',
    );
  }

  async enqueue(input, requestedByTag) {
    const metadata = await this.resolveTrack(input, requestedByTag);

    this.queue.push(metadata);

    const shouldStart =
      this.player.state.status !== AudioPlayerStatus.Playing &&
      this.player.state.status !== AudioPlayerStatus.Buffering &&
      this.currentTrack === null;

    if (shouldStart) {
      await this.playNext();
    }

    return metadata;
  }

  async enqueueByUrl(url, requestedByTag) {
    const metadata = await this.resolveTrack(url, requestedByTag);

    this.queue.push(metadata);

    const shouldStart =
      this.player.state.status !== AudioPlayerStatus.Playing &&
      this.player.state.status !== AudioPlayerStatus.Buffering &&
      this.currentTrack === null;

    if (shouldStart) {
      await this.playNext();
    }

    return metadata;
  }

  async enqueueAttachment(attachment, requestedByTag) {
    const ALLOWED_EXTENSIONS = ['.mp3', '.wav'];
    const ALLOWED_TYPES = ['audio/mpeg', 'audio/wav', 'audio/wave', 'audio/x-wav'];
    const MAX_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

    const ext = path.extname(attachment.name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      throw new Error('Only .mp3 and .wav files are supported.');
    }

    const contentType = attachment.contentType?.split(';')[0]?.trim()?.toLowerCase() ?? '';
    if (contentType && !ALLOWED_TYPES.includes(contentType)) {
      throw new Error('Only mp3 and wav audio files are supported.');
    }

    if (attachment.size > MAX_SIZE_BYTES) {
      throw new Error(`File is too large. Maximum allowed size is ${MAX_SIZE_BYTES / 1024 / 1024} MB.`);
    }

    const response = await fetch(attachment.url);
    if (!response.ok) {
      throw new Error(`Failed to download attachment: ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    const tempFileName = `musicbot-${crypto.randomUUID()}${ext}`;
    const tempFilePath = path.join(os.tmpdir(), tempFileName);
    await writeFile(tempFilePath, Buffer.from(buffer));

    const track = {
      filePath: tempFilePath,
      sourceUrl: null,
      title: attachment.name,
      durationText: 'uploaded',
      requestedByTag,
      isLocalTemp: true,
    };

    this.queue.push(track);

    const shouldStart =
      this.player.state.status !== AudioPlayerStatus.Playing &&
      this.player.state.status !== AudioPlayerStatus.Buffering &&
      this.currentTrack === null;

    if (shouldStart) {
      await this.playNext();
    }

    return track;
  }

  async resolveTrack(input, requestedByTag) {
    const target = isLikelyUrl(input) ? input : `ytsearch1:${input}`;

    const output = await runYtDlp(['--dump-single-json', '--no-playlist', '--skip-download', target]);
    const parsed = JSON.parse(output);
    const info = normalizeTrackInfo(parsed);

    if (!info) {
      throw new Error('No playable track found for that query.');
    }

    return {
      sourceUrl: info.webpage_url || info.original_url || input,
      title: info.title || 'Unknown title',
      durationText: normalizeDuration(Number(info.duration)),
      requestedByTag,
    };
  }

  async searchYouTube(query, limit = 5) {
    const clampedLimit = Math.max(1, Math.min(10, Number(limit) || 5));
    const output = await runYtDlp([
      '--dump-single-json',
      '--skip-download',
      '--no-playlist',
      `ytsearch${clampedLimit}:${query}`,
    ]);

    const parsed = JSON.parse(output);
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];

    return entries
      .filter((entry) => Boolean(entry))
      .map((entry) => ({
        sourceUrl: entry.webpage_url || entry.original_url,
        title: entry.title || 'Unknown title',
        durationText: normalizeDuration(Number(entry.duration)),
        channel: entry.channel || entry.uploader || 'Unknown channel',
      }))
      .filter((entry) => Boolean(entry.sourceUrl));
  }

  async playNext() {
    const track = this.queue.shift();

    if (!track) {
      return;
    }

    this.currentTrack = track;

    const resource = track.filePath
      ? this.createResourceFromFile(track.filePath)
      : await this.createResource(track.sourceUrl);
    this.player.play(resource);
  }

  async createResource(trackUrl) {
    if (!ffmpegPath) {
      throw new Error('No usable ffmpeg binary was found. Set FFMPEG_PATH to a valid ffmpeg executable.');
    }

    let directUrlOutput;

    try {
      directUrlOutput = await runYtDlp(['-f', 'bestaudio/best', '-g', '--no-playlist', trackUrl]);
    } catch (error) {
      if (!isFormatUnavailableError(error)) {
        throw error;
      }

      console.warn(
        `[audio:${this.guildId}] bestaudio extraction unavailable, retrying with generic stream selection...`,
      );
      directUrlOutput = await runYtDlp(['-g', '--no-playlist', trackUrl]);
    }

    const directUrl = directUrlOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);

    if (!directUrl) {
      throw new Error('yt-dlp did not return a direct audio URL for playback.');
    }

    console.log(`[audio:${this.guildId}] using direct stream URL from yt-dlp`);

    const ffmpegArgs = [
      '-reconnect',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_delay_max',
      '5',
      '-i',
      directUrl,
      '-f',
      's16le',
      '-ar',
      '48000',
      '-ac',
      '2',
      'pipe:1',
    ];

    this.ffmpeg = spawn(ffmpegPath, ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.ffmpeg.stderr.on('data', (chunk) => {
      const line = chunk.toString().trim();
      if (line) {
        console.log(`[ffmpeg:${this.guildId}] ${line}`);
      }
    });

    this.ffmpeg.on('close', (code, signal) => {
      console.log(`[ffmpeg:${this.guildId}] exited with code=${code} signal=${signal}`);
    });

    this.ffmpeg.on('error', (error) => {
      console.error(`ffmpeg process error in guild ${this.guildId}:`, error.message);
    });

    return createAudioResource(this.ffmpeg.stdout, {
      inputType: StreamType.Raw,
      inlineVolume: true,
      metadata: { trackUrl },
    });
  }

  createResourceFromFile(filePath) {
    if (!ffmpegPath) {
      throw new Error('No usable ffmpeg binary was found. Set FFMPEG_PATH to a valid ffmpeg executable.');
    }

    this.destroyFfmpeg();

    const ffmpegArgs = ['-i', filePath, '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'];

    this.ffmpeg = spawn(ffmpegPath, ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.ffmpeg.stderr.on('data', (chunk) => {
      const line = chunk.toString().trim();
      if (line) {
        console.log(`[ffmpeg:${this.guildId}] ${line}`);
      }
    });

    this.ffmpeg.on('close', (code, signal) => {
      console.log(`[ffmpeg:${this.guildId}] exited with code=${code} signal=${signal}`);
    });

    this.ffmpeg.on('error', (error) => {
      console.error(`ffmpeg process error in guild ${this.guildId}:`, error.message);
    });

    return createAudioResource(this.ffmpeg.stdout, {
      inputType: StreamType.Raw,
      inlineVolume: true,
      metadata: { filePath },
    });
  }

  async playConnectedCue() {    await this.playLocalCueSafely('connected.wav');
  }

  async playLocalCueSafely(fileName) {
    try {
      await this.playLocalCue(fileName);
    } catch (error) {
      console.warn(`[audio:${this.guildId}] failed to play cue ${fileName}: ${error.message}`);
    }
  }

  async playLocalCue(fileName) {
    if (!this.connection) {
      return;
    }

    if (!ffmpegPath) {
      throw new Error('No usable ffmpeg binary was found. Set FFMPEG_PATH to a valid ffmpeg executable.');
    }

    const cuePath = resolveAssetPath(fileName);
    if (!existsSync(cuePath)) {
      throw new Error(`Missing asset file: ${cuePath}`);
    }

    this.destroyFfmpeg();

    this.ffmpeg = spawn(
      ffmpegPath,
      ['-i', cuePath, '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    this.ffmpeg.on('error', (error) => {
      console.error(`ffmpeg process error in guild ${this.guildId}:`, error.message);
    });

    const resource = createAudioResource(this.ffmpeg.stdout, {
      inputType: StreamType.Raw,
      inlineVolume: true,
      metadata: { cue: fileName },
    });

    await new Promise((resolve, reject) => {
      const onIdle = () => {
        cleanup();
        resolve();
      };

      const onError = (error) => {
        cleanup();
        reject(error);
      };

      const cleanup = () => {
        this.player.off(AudioPlayerStatus.Idle, onIdle);
        this.player.off('error', onError);
      };

      this.player.on(AudioPlayerStatus.Idle, onIdle);
      this.player.on('error', onError);
      this.player.play(resource);
    });
  }

  skip() {
    this.player.stop(true);
  }

  removeFromQueue(position) {
    if (position < 1 || position > this.queue.length) {
      return null;
    }

    const [removed] = this.queue.splice(position - 1, 1);
    this.cleanupTempFile(removed);
    return removed;
  }

  pause() {
    return this.player.pause();
  }

  resume() {
    return this.player.unpause();
  }

  disconnectIfAlone() {
    if (!this.connection || !this.guild) {
      return false;
    }

    const channelId = this.connection.joinConfig.channelId;
    if (!channelId) {
      return false;
    }

    const channel = this.guild.channels.cache.get(channelId);
    if (!channel?.isVoiceBased?.()) {
      return false;
    }

    const nonBotMembers = [...channel.members.values()].filter((member) => !member.user.bot);
    if (nonBotMembers.length > 0) {
      return false;
    }

    console.log(`[voice:${this.guildId}] no human listeners left, disconnecting and clearing queue`);
    this.stopAndCleanup();
    return true;
  }

  stopAndCleanup() {
    this.cleanupAllTempFiles();
    this.queue = [];
    this.currentTrack = null;
    this.player.stop(true);
    this.destroyFfmpeg();
    this.connection?.destroy();
    this.connection = null;
    this.guild = null;
    this.onCleanup();
  }

  async stopWithPoweroff() {
    this.cleanupAllTempFiles();
    this.queue = [];
    this.currentTrack = null;
    this.player.stop(true);
    this.destroyFfmpeg();

    if (this.connection) {
      await this.playLocalCueSafely('poweroff.wav');
    }

    this.connection?.destroy();
    this.connection = null;
    this.guild = null;
    this.onCleanup();
  }

  destroyFfmpeg() {
    if (this.ffmpeg && !this.ffmpeg.killed) {
      this.ffmpeg.kill('SIGKILL');
    }

    this.ffmpeg = null;
  }

  cleanupTempFile(track) {
    if (track?.isLocalTemp && track.filePath) {
      unlink(track.filePath).catch((err) => {
        console.warn(`[audio:${this.guildId}] could not delete temp file: ${err.message}`);
      });
    }
  }

  cleanupAllTempFiles() {
    const tracks = this.currentTrack ? [this.currentTrack, ...this.queue] : [...this.queue];
    for (const track of tracks) {
      this.cleanupTempFile(track);
    }
  }

  getQueueSnapshot() {
    return {
      current: this.currentTrack,
      upcoming: [...this.queue],
    };
  }
}
