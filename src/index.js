import 'dotenv/config';
import { Client, Events, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { GuildMusicManager } from './music/GuildMusicManager.js';

const GUILD_VOICE_STATES = GatewayIntentBits.GuildVoiceStates;

const token = process.env.DISCORD_TOKEN;

if (!token) {
  console.error('Missing DISCORD_TOKEN in environment.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GUILD_VOICE_STATES],
});

const musicManager = new GuildMusicManager();

function getVoicePermissionIssue(guild, voiceChannel) {
  const me = guild.members.me;
  if (!me) {
    return 'Bot member cache is not ready yet. Try again in a moment.';
  }

  const permissions = voiceChannel.permissionsFor(me);
  if (!permissions) {
    return 'Unable to read channel permissions for the bot.';
  }

  const required = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.Connect,
    PermissionFlagsBits.Speak,
  ];

  const missing = required.filter((permission) => !permissions.has(permission));
  if (missing.length === 0) {
    return null;
  }

  const labels = missing.map((permission) => {
    if (permission === PermissionFlagsBits.ViewChannel) {
      return 'View Channel';
    }

    if (permission === PermissionFlagsBits.Connect) {
      return 'Connect';
    }

    if (permission === PermissionFlagsBits.Speak) {
      return 'Speak';
    }

    return String(permission);
  });

  return `Missing voice permissions: ${labels.join(', ')}`;
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const guildId = newState.guild?.id || oldState.guild?.id;
  if (!guildId) {
    return;
  }

  const state = musicManager.getExistingState(guildId);
  if (!state) {
    return;
  }

  state.disconnectIfAlone();
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  const guildId = interaction.guildId;
  if (!guildId || !interaction.guild) {
    await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
    return;
  }

  const member = interaction.member;
  const voiceChannel = member?.voice?.channel;

  const state = musicManager.getState(guildId);

  try {
    switch (interaction.commandName) {
      case 'search': {
        const query = interaction.options.getString('query', true);
        const pick = interaction.options.getInteger('pick', false);

        await interaction.deferReply({ ephemeral: true });
        const results = await state.searchYouTube(query, 5);

        if (results.length === 0) {
          await interaction.editReply('No YouTube results found.');
          return;
        }

        if (!pick) {
          const lines = results.map(
            (track, index) =>
              `${index + 1}. ${track.title} (${track.durationText}) - ${track.channel}`,
          );

          await interaction.editReply(
            ['Top YouTube results:', ...lines, 'Use /search with pick:<number> to queue one.'].join(
              '\n',
            ),
          );
          return;
        }

        if (!voiceChannel) {
          await interaction.editReply('Join a voice channel first to queue a result.');
          return;
        }

        const permissionIssue = getVoicePermissionIssue(interaction.guild, voiceChannel);
        if (permissionIssue) {
          await interaction.editReply(permissionIssue);
          return;
        }

        const selected = results[pick - 1];
        if (!selected) {
          await interaction.editReply('That pick number is out of range for the current results.');
          return;
        }

        const joinedNow = await state.ensureConnection(voiceChannel);
        if (joinedNow) {
          await state.playConnectedCue();
        }
        const track = await state.enqueueByUrl(selected.sourceUrl, interaction.user.tag);

        const nowPlaying = state.getQueueSnapshot().current;
        const startedNow = nowPlaying?.sourceUrl === track.sourceUrl;

        await interaction.editReply(
          startedNow
            ? `Now playing: **${track.title}** (${track.durationText})`
            : `Queued: **${track.title}** (${track.durationText})`,
        );
        break;
      }
      case 'play': {
        if (!voiceChannel) {
          await interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });
          return;
        }

        const permissionIssue = getVoicePermissionIssue(interaction.guild, voiceChannel);
        if (permissionIssue) {
          await interaction.reply({ content: permissionIssue, ephemeral: true });
          return;
        }

        await interaction.deferReply();
        const joinedNow = await state.ensureConnection(voiceChannel);
        if (joinedNow) {
          await state.playConnectedCue();
        }

        const input = interaction.options.getString('input', true);
        const track = await state.enqueue(input, interaction.user.tag);

        const nowPlaying = state.getQueueSnapshot().current;
        const startedNow = nowPlaying?.sourceUrl === track.sourceUrl;

        await interaction.editReply(
          startedNow
            ? `Now playing: **${track.title}** (${track.durationText})`
            : `Queued: **${track.title}** (${track.durationText})`,
        );
        break;
      }
      case 'upload': {
        if (!voiceChannel) {
          await interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });
          return;
        }

        const permissionIssueUpload = getVoicePermissionIssue(interaction.guild, voiceChannel);
        if (permissionIssueUpload) {
          await interaction.reply({ content: permissionIssueUpload, ephemeral: true });
          return;
        }

        const attachment = interaction.options.getAttachment('file', true);
        await interaction.deferReply();
        const joinedNowUpload = await state.ensureConnection(voiceChannel);
        if (joinedNowUpload) {
          await state.playConnectedCue();
        }

        const uploadTrack = await state.enqueueAttachment(attachment, interaction.user.tag);
        const nowPlayingUpload = state.getQueueSnapshot().current;
        const startedNowUpload = nowPlayingUpload?.filePath === uploadTrack.filePath;

        await interaction.editReply(
          startedNowUpload
            ? `Now playing: **${uploadTrack.title}**`
            : `Queued: **${uploadTrack.title}**`,
        );
        break;
      }
      case 'skip': {
        const position = interaction.options.getInteger('position', false);
        if (position !== null) {
          const removed = state.removeFromQueue(position);
          if (!removed) {
            await interaction.reply({ content: `No track at position ${position} in the queue.`, ephemeral: true });
            return;
          }
          await interaction.reply(`Removed **${removed.title}** from position ${position} in the queue.`);
        } else {
          state.skip();
          await interaction.reply('Skipped current track.');
        }
        break;
      }
      case 'stop': {
        await interaction.reply('Stopped playback and cleared the queue.');
        void state.stopWithPoweroff();
        break;
      }
      case 'pause': {
        const paused = state.pause();
        await interaction.reply(paused ? 'Paused playback.' : 'Nothing is currently playing.');
        break;
      }
      case 'resume': {
        const resumed = state.resume();
        await interaction.reply(resumed ? 'Resumed playback.' : 'Playback is not paused.');
        break;
      }
      case 'queue': {
        const snapshot = state.getQueueSnapshot();
        if (!snapshot.current && snapshot.upcoming.length === 0) {
          await interaction.reply('Queue is empty.');
          return;
        }

        const lines = [];
        if (snapshot.current) {
          lines.push(`Now: **${snapshot.current.title}** (${snapshot.current.durationText})`);
        }

        snapshot.upcoming.slice(0, 10).forEach((track, index) => {
          lines.push(`${index + 1}. ${track.title} (${track.durationText})`);
        });

        const remaining = snapshot.upcoming.length - 10;
        if (remaining > 0) {
          lines.push(`...and ${remaining} more.`);
        }

        await interaction.reply(lines.join('\n'));
        break;
      }
      case 'nowplaying': {
        const snapshot = state.getQueueSnapshot();
        if (!snapshot.current) {
          await interaction.reply('Nothing is playing right now.');
          return;
        }

        await interaction.reply(
          `Now playing: **${snapshot.current.title}** (${snapshot.current.durationText}) · requested by ${snapshot.current.requestedByTag}`,
        );
        break;
      }
      default:
        await interaction.reply({ content: 'Unknown command.', ephemeral: true });
    }
  } catch (error) {
    console.error('Command handling failed:', error);

    const baseMessage = `Something went wrong: ${error.message}`;
    const isBinaryMissing = error?.code === 'ENOENT' || /Failed to start yt-dlp|not found/i.test(error?.message || '');
    const message = isBinaryMissing
      ? `${baseMessage}\nMake sure yt-dlp is installed and available in PATH (or set YTDLP_PATH).`
      : baseMessage;

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message);
      return;
    }

    await interaction.reply({ content: message, ephemeral: true });
  }
});

client.login(token);
