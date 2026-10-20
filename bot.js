const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const express = require('express');

// --- 1. EXPRESS WEB SERVER (Required for Render to stay online) ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Discord bot is active and running!');
});

app.listen(PORT, () => {
  console.log(`Web server is listening on port ${PORT}`);
});

// --- 2. DISCORD BOT SETUP ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // Required to read message text
  ],
});

client.once('ready', () => {
  console.log(`Logged in successfully as ${client.user.tag}!`);
});

// Regular expression to match Discord invite links
const inviteRegex = /(https?:\/\/)?(www\.)?(discord\.(gg|io|me|li|link|plus)|discordapp\.com\/invite|discord\.com\/invite)\/[a-zA-Z0-9]+/i;

client.on('messageCreate', async (message) => {
  // Ignore messages from bots or direct messages
  if (message.author.bot || !message.guild) return;

  // Allow administrators or users with 'Manage Messages' to post links if desired
  if (message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
    return;
  }

  // Check if the message contains a Discord invite link
  if (inviteRegex.test(message.content)) {
    try {
      // Delete the message
      await message.delete();
      
      // Send a warning message (and auto-delete it after 5 seconds)
      const warning = await message.channel.send(
        `${message.author}, sharing Discord server links is not allowed here!`
      );
      setTimeout(() => warning.delete().catch(() => {}), 5000);
      
      console.log(`Deleted invite link sent by ${message.author.tag} in #${message.channel.name}`);
    } catch (error) {
      console.error('Failed to delete message or send warning:', error);
    }
  }
});

// Log in using your token from environment variables
client.login(process.env.DISCORD_TOKEN);
