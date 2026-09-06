require('dotenv').config();

const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');

const token = process.env.DISCORD_TOKEN;

if (!token) {
  console.error('Missing DISCORD_TOKEN. Add it to a .env file or your environment.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const discordInvitePattern = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/[^\s<]+/i;

client.once('clientReady', (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild || !discordInvitePattern.test(message.content)) {
    return;
  }

  if (!message.channel.permissionsFor(client.user).has(PermissionsBitField.Flags.ManageMessages)) {
    console.warn(`Cannot delete messages in #${message.channel.name}; missing Manage Messages permission.`);
    return;
  }

  try {
    await message.delete();

    await message.author.send(
      'Your message was removed because Discord invite links are not allowed here.'
    ).catch(() => {
      // The user may have DMs disabled or blocked the bot.
    });
  } catch (error) {
    console.error('Could not remove a Discord invite link:', error.message);
  }
});

client.login(token);