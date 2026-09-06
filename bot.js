require('dotenv').config();

const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const express = require('express');

// ============================================
// DISCORD BOT SETUP
// ============================================

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

// Anti-slur patterns
const slurPatterns = [
  /\bn[iìíîï]gg[ae3]r?\b/i,      // N-word variations
  /\bf[ae]gg[o0]t\b/i,            // Homophobic slur
  /\br[ae]t[ae]rd\b/i,            // Ableist slur
  /\bc[uú]nt\b/i,                  // C-word
  /\bf[uú]ck\b/i,                  // F-word
  /\bsh[iìí]t\b/i,                 // Sh-word
  // Add more patterns as needed
];

client.once('clientReady', (readyClient) => {
  console.log(`✅ Logged in as ${readyClient.user.tag}`);
  console.log(`📡 Monitoring ${readyClient.guilds.cache.size} server(s)`);
  console.log(`🔗 Ready to block Discord invite links and slurs`);
});

client.on('messageCreate', async (message) => {
  // Ignore bots and DMs
  if (message.author.bot || !message.guild) {
    return;
  }

  // Check for invite links OR slurs
  const containsInvite = discordInvitePattern.test(message.content);
  const containsSlur = slurPatterns.some(pattern => pattern.test(message.content));

  if (!containsInvite && !containsSlur) {
    return;
  }

  // Check if bot has permission to delete messages
  if (!message.channel.permissionsFor(client.user).has(PermissionsBitField.Flags.ManageMessages)) {
    console.warn(`⚠️ Cannot delete messages in #${message.channel.name}; missing Manage Messages permission.`);
    return;
  }

  try {
    // Delete the message
    await message.delete();
    
    // Determine the reason
    let reason = '';
    if (containsInvite && containsSlur) {
      reason = 'Discord invite links and inappropriate language';
    } else if (containsInvite) {
      reason = 'Discord invite links';
    } else if (containsSlur) {
      reason = 'inappropriate language';
    }
    
    console.log(`🗑️ Deleted message from ${message.author.tag} in #${message.channel.name} (Reason: ${reason})`);

    // Send DM to the user
    await message.author.send(
      `❌ Your message was removed because it contained ${reason}.`
    ).catch(() => {
      // User has DMs disabled or blocked the bot - silently fail
    });
  } catch (error) {
    console.error('❌ Could not remove message:', error.message);
  }
});

// Handle errors gracefully
client.on('error', (error) => {
  console.error('❌ Discord client error:', error.message);
});

client.on('disconnect', () => {
  console.warn('⚠️ Bot disconnected, attempting to reconnect...');
});

// ============================================
// EXPRESS WEB SERVER (Required for Render Web Services)
// ============================================

const app = express();
const port = process.env.PORT || 10000;

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    bot: client.user ? client.user.tag : 'offline',
    servers: client.guilds ? client.guilds.cache.size : 0,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Simple status page
app.get('/status', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Discord Bot Status</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 40px; max-width: 600px; margin: 0 auto; }
          .status { color: #00ff00; font-weight: bold; }
          .info { background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0; }
          .feature { color: #666; margin: 10px 0; }
        </style>
      </head>
      <body>
        <h1>🤖 Discord Link Blocker Bot</h1>
        <div class="info">
          <p><strong>Status:</strong> <span class="status">✅ Online</span></p>
          <p><strong>Bot:</strong> ${client.user ? client.user.tag : 'Offline'}</p>
          <p><strong>Servers:</strong> ${client.guilds ? client.guilds.cache.size : 0}</p>
          <p><strong>Uptime:</strong> ${Math.floor(process.uptime())} seconds</p>
        </div>
        <h3>🛡️ Features</h3>
        <div class="feature">🔗 Blocks Discord invite links</div>
        <div class="feature">🚫 Blocks inappropriate language</div>
        <div class="feature">📨 Sends DM notifications</div>
        <p style="margin-top: 30px; color: #999; font-size: 14px;">
          Powered by Render.com
        </p>
      </body>
    </html>
  `);
});

// Start the web server
app.listen(port, '0.0.0.0', () => {
  console.log(`🌐 Web server listening on port ${port}`);
  console.log(`📊 Status page: https://your-service.onrender.com/status`);
});

// Login to Discord
client.login(token);
