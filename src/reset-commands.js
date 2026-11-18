import 'dotenv/config';
import { REST, Routes } from 'discord.js';

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in environment.');
  process.exit(1);
}

const guildIds = DISCORD_GUILD_ID
  ? DISCORD_GUILD_ID.split(',').map((id) => id.trim()).filter(Boolean)
  : [];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

async function resetCommands() {
  if (guildIds.length > 0) {
    for (const guildId of guildIds) {
      await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, guildId), {
        body: [],
      });
      console.log(`Cleared guild commands for guild ${guildId}.`);
    }
  } else {
    console.log('DISCORD_GUILD_ID not set, skipping guild command reset.');
  }

  await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), {
    body: [],
  });
  console.log('Cleared global application commands.');
}

resetCommands().catch((error) => {
  console.error('Failed to reset commands:', error);
  process.exit(1);
});
