import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { commandBuilders } from './commands.js';

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !DISCORD_GUILD_ID) {
  console.error('Missing DISCORD_TOKEN, DISCORD_CLIENT_ID, or DISCORD_GUILD_ID in environment.');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

async function deploy() {
  await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), {
    body: commandBuilders,
  });

  console.log(`Deployed ${commandBuilders.length} guild slash commands.`);
}

deploy().catch((error) => {
  console.error('Failed to deploy commands:', error);
  process.exit(1);
});
