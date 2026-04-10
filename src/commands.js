import { SlashCommandBuilder } from 'discord.js';

export const commandBuilders = [
  new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search YouTube and optionally queue a selected result')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('Search terms for YouTube')
        .setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName('pick')
        .setDescription('Pick a result number to queue (1-5)')
        .setMinValue(1)
        .setMaxValue(5)
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song from YouTube URL or search terms')
    .addStringOption((option) =>
      option
        .setName('input')
        .setDescription('YouTube URL or search text')
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('upload')
    .setDescription('Upload an mp3 or wav file and add it to the queue')
    .addAttachmentOption((option) =>
      option
        .setName('file')
        .setDescription('The mp3 or wav file to queue')
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current song, or remove a queued song by position')
    .addIntegerOption((option) =>
      option
        .setName('position')
        .setDescription('Queue position to remove (1 = next song). Omit to skip the current song.')
        .setMinValue(1)
        .setRequired(false),
    ),
  new SlashCommandBuilder().setName('stop').setDescription('Stop playback and clear the queue'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  new SlashCommandBuilder().setName('queue').setDescription('Show the upcoming queue'),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show the current song'),
].map((builder) => builder.toJSON());
