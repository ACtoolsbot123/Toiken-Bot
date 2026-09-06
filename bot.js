require('dotenv').config();

const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');

const token = process.env.DISCORD_TOKEN;

if (!token) {
  console.error('❌ Missing DISCORD_TOKEN. Add it to your Render environment variables.');
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

client.once('ready', (readyClient) => {
  console.log(`✅ Logged in as ${readyClient.user.tag}`);
  console.log(`📡 Monitoring ${readyClient.guilds.cache.size} server(s)`);
  console.log(`🔗 Ready to block Discord invite links`);
});

client.on('messageCreate', async (message) => {
  // Ignore bots, DMs, and messages without invite links
  if (message.author.bot || !message.guild || !discordInvitePattern.test(message.content)) {
    return;
  }

  // Check if bot has permission to delete messages
  if (!message.channel.permissionsFor(client.user).has(PermissionsBitField.Flags.ManageMessages)) {
    console.warn(`⚠️ Cannot delete messages in #${message.channel.name}; missing Manage Messages permission.`);
    return;
  }

  try {
    // Delete the invite message
    await message.delete();
    console.log(`🗑️ Deleted invite link from ${message.author.tag} in #${message.channel.name}`);

    // Send DM to the user
    await message.author.send(
      '❌ Your message was removed because Discord invite links are not allowed here.'
    ).catch(() => {
      // User has DMs disabled or blocked the bot - silently fail
    });
  } catch (error) {
    console.error('❌ Could not remove a Discord invite link:', error.message);
  }
});

// Handle errors gracefully
client.on('error', (error) => {
  console.error('❌ Discord client error:', error.message);
});

client.on('disconnect', () => {
  console.warn('⚠️ Bot disconnected, attempting to reconnect...');
});

// Login to Discord
client.login(token);
