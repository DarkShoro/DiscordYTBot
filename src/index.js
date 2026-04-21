import 'dotenv/config';
import { Client, EmbedBuilder, Events, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
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

// --- Embed helpers ---
const COLORS = {
  primary: 0x5865F2,
  success: 0x57F287,
  warning: 0xFEE75C,
  danger: 0xED4245,
};

function buildTrackEmbed({ label, track, extraFields = [] }) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setAuthor({ name: label })
    .setTitle(track.title);

  if (track.sourceUrl) embed.setURL(track.sourceUrl);
  if (track.thumbnail) embed.setThumbnail(track.thumbnail);

  embed.addFields([
    { name: 'Duration', value: track.durationText || 'unknown', inline: true },
    { name: 'Requested by', value: track.requestedByTag || 'Unknown', inline: true },
    ...extraFields,
  ]);

  if (track.channel) embed.setFooter({ text: track.channel });

  return embed;
}

function simpleEmbed(color, description) {
  return new EmbedBuilder().setColor(color).setDescription(description);
}

function errorEmbed(message) {
  return new EmbedBuilder()
    .setColor(COLORS.danger)
    .setTitle('Something went wrong')
    .setDescription(message);
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
    await interaction.reply({ embeds: [simpleEmbed(COLORS.danger, 'This command can only be used in a server.')], ephemeral: true });
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
          await interaction.editReply({ embeds: [simpleEmbed(COLORS.primary, 'No YouTube results found.')] });
          return;
        }

        if (!pick) {
          const description = results
            .map((r, i) => {
              const title = r.sourceUrl ? `[${r.title}](${r.sourceUrl})` : r.title;
              return `\`${i + 1}.\` ${title}\n　${r.channel} • ${r.durationText}`;
            })
            .join('\n');

          const embed = new EmbedBuilder()
            .setColor(COLORS.primary)
            .setTitle(`Search Results for "${query}"`)
            .setDescription(description)
            .setFooter({ text: 'Use /search with pick:<number> to queue one.' });

          await interaction.editReply({ embeds: [embed] });
          return;
        }

        if (!voiceChannel) {
          await interaction.editReply({ embeds: [simpleEmbed(COLORS.warning, 'Join a voice channel first to queue a result.')] });
          return;
        }

        const permissionIssue = getVoicePermissionIssue(interaction.guild, voiceChannel);
        if (permissionIssue) {
          await interaction.editReply({ embeds: [simpleEmbed(COLORS.danger, permissionIssue)] });
          return;
        }

        const selected = results[pick - 1];
        if (!selected) {
          await interaction.editReply({ embeds: [simpleEmbed(COLORS.danger, 'That pick number is out of range for the current results.')] });
          return;
        }

        const joinedNow = await state.ensureConnection(voiceChannel);
        if (joinedNow) {
          await state.playConnectedCue();
        }
        const track = await state.enqueueByUrl(selected.sourceUrl, interaction.user.tag);

        const snapshot = state.getQueueSnapshot();
        const startedNow = snapshot.current?.sourceUrl === track.sourceUrl;
        const queuePos = startedNow ? null : snapshot.upcoming.indexOf(track) + 1;

        await interaction.editReply({
          embeds: [buildTrackEmbed({
            label: startedNow ? '▶ Now Playing' : '🎵 Added to Queue',
            track,
            extraFields: startedNow ? [] : [{ name: 'Position', value: `#${queuePos}`, inline: true }],
          })],
        });
        break;
      }
      case 'play': {
        if (!voiceChannel) {
          await interaction.reply({ embeds: [simpleEmbed(COLORS.warning, 'Join a voice channel first.')], ephemeral: true });
          return;
        }

        const permissionIssue = getVoicePermissionIssue(interaction.guild, voiceChannel);
        if (permissionIssue) {
          await interaction.reply({ embeds: [simpleEmbed(COLORS.danger, permissionIssue)], ephemeral: true });
          return;
        }

        await interaction.deferReply();
        const joinedNow = await state.ensureConnection(voiceChannel);
        if (joinedNow) {
          await state.playConnectedCue();
        }

        const input = interaction.options.getString('input', true);
        const track = await state.enqueue(input, interaction.user.tag);

        const snapshot = state.getQueueSnapshot();
        const startedNow = snapshot.current?.sourceUrl === track.sourceUrl;
        const queuePos = startedNow ? null : snapshot.upcoming.indexOf(track) + 1;

        await interaction.editReply({
          embeds: [buildTrackEmbed({
            label: startedNow ? '▶ Now Playing' : '🎵 Added to Queue',
            track,
            extraFields: startedNow ? [] : [{ name: 'Position', value: `#${queuePos}`, inline: true }],
          })],
        });
        break;
      }
      case 'upload': {
        if (!voiceChannel) {
          await interaction.reply({ embeds: [simpleEmbed(COLORS.warning, 'Join a voice channel first.')], ephemeral: true });
          return;
        }

        const permissionIssueUpload = getVoicePermissionIssue(interaction.guild, voiceChannel);
        if (permissionIssueUpload) {
          await interaction.reply({ embeds: [simpleEmbed(COLORS.danger, permissionIssueUpload)], ephemeral: true });
          return;
        }

        const attachment = interaction.options.getAttachment('file', true);
        await interaction.deferReply();
        const joinedNowUpload = await state.ensureConnection(voiceChannel);
        if (joinedNowUpload) {
          await state.playConnectedCue();
        }

        const uploadTrack = await state.enqueueAttachment(attachment, interaction.user.tag);
        const uploadSnapshot = state.getQueueSnapshot();
        const startedNowUpload = uploadSnapshot.current?.filePath === uploadTrack.filePath;
        const uploadQueuePos = startedNowUpload ? null : uploadSnapshot.upcoming.indexOf(uploadTrack) + 1;

        await interaction.editReply({
          embeds: [buildTrackEmbed({
            label: startedNowUpload ? '▶ Now Playing' : '🎵 Added to Queue',
            track: uploadTrack,
            extraFields: startedNowUpload ? [] : [{ name: 'Position', value: `#${uploadQueuePos}`, inline: true }],
          })],
        });
        break;
      }
      case 'skip': {
        const position = interaction.options.getInteger('position', false);
        if (position !== null) {
          const removed = state.removeFromQueue(position);
          if (!removed) {
            await interaction.reply({ embeds: [simpleEmbed(COLORS.danger, `No track at position ${position} in the queue.`)], ephemeral: true });
            return;
          }
          await interaction.reply({ embeds: [simpleEmbed(COLORS.success, `⏭ Removed **${removed.title}** from position ${position}.`)] });
        } else {
          const current = state.getQueueSnapshot().current;
          state.skip();
          await interaction.reply({ embeds: [simpleEmbed(COLORS.success, current ? `⏭ Skipped **${current.title}**.` : '⏭ Skipped.')] });
        }
        break;
      }
      case 'stop': {
        await interaction.reply({ embeds: [simpleEmbed(COLORS.danger, '⏹ Stopped playback and cleared the queue.')] });
        void state.stopWithPoweroff();
        break;
      }
      case 'pause': {
        const paused = state.pause();
        await interaction.reply({ embeds: [simpleEmbed(COLORS.warning, paused ? '⏸ Paused playback.' : 'Nothing is currently playing.')] });
        break;
      }
      case 'resume': {
        const resumed = state.resume();
        await interaction.reply({ embeds: [simpleEmbed(COLORS.success, resumed ? '▶ Resumed playback.' : 'Playback is not paused.')] });
        break;
      }
      case 'queue': {
        const snapshot = state.getQueueSnapshot();
        if (!snapshot.current && snapshot.upcoming.length === 0) {
          await interaction.reply({ embeds: [simpleEmbed(COLORS.primary, 'The queue is empty.')], ephemeral: true });
          return;
        }

        const parts = [];
        if (snapshot.current) {
          const cur = snapshot.current;
          const curTitle = cur.sourceUrl ? `[${cur.title}](${cur.sourceUrl})` : cur.title;
          parts.push(`**Now Playing**\n▶ ${curTitle} \`${cur.durationText}\``);
        }

        if (snapshot.upcoming.length > 0) {
          const upcomingLines = snapshot.upcoming.slice(0, 10).map((t, i) => {
            const title = t.sourceUrl ? `[${t.title}](${t.sourceUrl})` : t.title;
            return `\`${i + 1}.\` ${title} \`${t.durationText}\``;
          });
          const remaining = snapshot.upcoming.length - 10;
          if (remaining > 0) upcomingLines.push(`*...and ${remaining} more*`);
          parts.push(`**Up Next**\n${upcomingLines.join('\n')}`);
        }

        const totalTracks = (snapshot.current ? 1 : 0) + snapshot.upcoming.length;
        const embed = new EmbedBuilder()
          .setColor(COLORS.primary)
          .setTitle(`📋 Queue — ${totalTracks} track${totalTracks !== 1 ? 's' : ''}`)
          .setDescription(parts.join('\n\n'));

        await interaction.reply({ embeds: [embed] });
        break;
      }
      case 'nowplaying': {
        const snapshot = state.getQueueSnapshot();
        if (!snapshot.current) {
          await interaction.reply({ embeds: [simpleEmbed(COLORS.primary, 'Nothing is playing right now.')], ephemeral: true });
          return;
        }

        const cur = snapshot.current;
        const next = snapshot.upcoming[0];
        const extraFields = next
          ? [{ name: 'Up Next', value: next.sourceUrl ? `[${next.title}](${next.sourceUrl})` : next.title, inline: false }]
          : [];

        await interaction.reply({
          embeds: [buildTrackEmbed({
            label: '▶ Now Playing',
            track: cur,
            extraFields,
          })],
        });
        break;
      }
      default:
        await interaction.reply({ embeds: [simpleEmbed(COLORS.danger, 'Unknown command.')], ephemeral: true });
    }
  } catch (error) {
    console.error('Command handling failed:', error);

    const baseMessage = error.message;
    const isBinaryMissing = error?.code === 'ENOENT' || /Failed to start yt-dlp|not found/i.test(error?.message || '');
    const message = isBinaryMissing
      ? `${baseMessage}\nMake sure yt-dlp is installed and available in PATH (or set YTDLP_PATH).`
      : baseMessage;

    const embed = errorEmbed(message);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
});

client.login(token);
