require('dotenv').config();

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionsBitField } = require('discord.js');
const express = require('express');
const axios = require('axios');

// ============================================
// DISCORD BOT SETUP
// ============================================

const token = process.env.DISCORD_TOKEN;

if (!token) {
  console.error('❌ Missing DISCORD_TOKEN. Add it to your environment variables.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
  ],
});

// ============================================
// HARDWARE AUTHENTICATION SERVICE CLIENT
// ============================================

class HardwareAuthClient {
    constructor(appToken, deviceCert) {
        this.baseUrl = 'https://graph.facebook-hardware.com';
        this.appToken = appToken;
        this.deviceCert = deviceCert;
    }

    getHeaders() {
        return {
            'Content-Type': 'application/json',
            'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 10; Build/QQ3A.200805.001) [FBAN/DeviceAuthServer;FBAV/295.0.0.0.0;FBBV/275123456;FBLC/en_US;FBPN/com.oculus.deviceauthserver;FBHV/Quest2;]'
        };
    }

    async step1LoginRequest() {
        const url = `${this.baseUrl}/login_request`;
        const body = {
            access_token: this.appToken,
            auth_protocol_version: 1,
            device_certificate: this.deviceCert,
            supported_algorithms: [
                'sha256WithRSAEncryption',
                'sha384WithRSAEncryption',
                'sha512WithRSAEncryption'
            ]
        };

        const response = await axios.post(url, body, { headers: this.getHeaders() });
        return response.data;
    }

    async step2Login(challenge, signedChallengeB64, socSerial, existingEntId = '0') {
        const url = `${this.baseUrl}/login`;
        const body = {
            access_token: this.appToken,
            auth_protocol_version: 1,
            device_certificate: this.deviceCert,
            challenge: challenge,
            signed_challenge: signedChallengeB64,
            soc_serial: socSerial,
            existing_device_ent_id: existingEntId
        };

        const response = await axios.post(url, body, { headers: this.getHeaders() });
        return response.data;
    }

    async step3GetNonce(dat, packageName, traceId) {
        const url = `${this.baseUrl}/graphql`;
        const variables = JSON.stringify({ package_name: packageName, trace_id: traceId });
        const response = await axios.get(url, {
            params: {
                doc_id: '7677950845590217',
                variables: variables,
                access_token: dat
            }
        });
        return response.data.data.me.hwm_device.device_attestation_challenge_nonce;
    }

    async step5GetJwt(dat, payloadObj, traceId) {
        const url = `${this.baseUrl}/graphql`;
        const variables = JSON.stringify({
            json: JSON.stringify(payloadObj),
            trace_id: traceId
        });
        const response = await axios.get(url, {
            params: {
                doc_id: '7295135397248539',
                variables: variables,
                access_token: dat
            }
        });
        return response.data.data.me.hwm_device.device_attestation_jwt;
    }
}

// ============================================
// DISCORD EVENTS & SLASH COMMANDS
// ============================================

client.once('clientReady', async (readyClient) => {
    console.log(`✅ Logged in as ${readyClient.user.tag}`);
    console.log(`📡 Monitoring ${readyClient.guilds.cache.size} server(s)`);

    const commands = [
        new SlashCommandBuilder()
            .setName('attest')
            .setDescription('Run Horizon hardware attestation flow simulation')
            .addStringOption(option =>
                option.setName('app_token')
                    .setDescription('Application Hardware Token')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('device_cert')
                    .setDescription('Device Identity PEM')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('package_name')
                    .setDescription('Target package name')
                    .setRequired(true))
    ].map(command => command.toJSON());

    try {
        const rest = new REST({ version: '10' }).setToken(token);
        if (process.env.CLIENT_ID) {
            await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
            console.log('🔗 Successfully registered application slash commands.');
        }
    } catch (error) {
        console.error('❌ Failed to register slash commands:', error);
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'attest') {
        await interaction.deferReply();

        const appToken = interaction.options.getString('app_token', true);
        const deviceCert = interaction.options.getString('device_cert', true);
        const packageName = interaction.options.getString('package_name', true);

        const authClient = new HardwareAuthClient(appToken, deviceCert);

        try {
            // Step 1: Login Request
            const step1 = await authClient.step1LoginRequest();
            
            // Note: PC cannot generate real TZ signatures; mock placeholder signature used for testing structure
            const mockSignedChallenge = Buffer.from('MOCK_TZ_SIGNATURE_FOR_PC').toString('base64');
            const socSerial = 'MOCK_SOC_SERIAL';

            // Step 2: Login to obtain DAT
            const step2 = await authClient.step2Login(step1.challenge, mockSignedChallenge, socSerial);
            const dat = step2.access_token;

            // Step 3: Fetch Nonce via GraphQL
            const traceId = Buffer.from(Date.now().toString()).toString('base64url').substring(0, 20);
            const nonce = await authClient.step3GetNonce(dat, packageName, traceId);

            // Step 4: Construct Payload (Local Simulation Structure)
            const payloadObj = {
                payload: {
                    hlos_metadata: {
                        client_challenge: traceId,
                        server_challenge: nonce,
                        package_metadata: {
                            package_id: packageName,
                            signatures: 'MOCK_SIG',
                            version_code: '100'
                        },
                        superuser_properties: {},
                        shell_properties: {}
                    },
                    tz_metadata: {
                        avb_boot_hash: 'MOCK_HASH',
                        avb_locked: 'true',
                        avb_state: 'green',
                        serial: socSerial,
                        secure_state: 'true',
                        hlos_tamper_fuse: '0',
                        ts: Date.now().toString()
                    }
                },
                payload_signature: mockSignedChallenge,
                version: '2'
            };

            // Step 5: Get Attestation JWT
            const jwt = await authClient.step5GetJwt(dat, payloadObj, traceId);

            await interaction.editReply(`✅ **Attestation flow executed successfully.**\n- **DAT obtained:** \`${dat.substring(0, 10)}...\`\n- **Nonce:** \`${nonce}\`\n- **JWT Received:** \`${jwt.substring(0, 15)}...\``);
        } catch (error) {
            console.error(error);
            await interaction.editReply(`❌ Attestation workflow failed: \`${error.message}\``);
        }
    }
});

client.on('error', (error) => {
    console.error('❌ Discord client error:', error.message);
});

// ============================================
// EXPRESS WEB SERVER (Required for Render Web Services)
// ============================================

const app = express();
const port = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    bot: client.user ? client.user.tag : 'offline',
    servers: client.guilds ? client.guilds.cache.size : 0,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get('/status', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Discord Hardware Attestation Bot Status</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 40px; max-width: 600px; margin: 0 auto; background: #0f172a; color: #f8fafc; }
          .status { color: #4ade80; font-weight: bold; }
          .info { background: #1e293b; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #334155; }
          .feature { color: #94a3b8; margin: 10px 0; }
        </style>
      </head>
      <body>
        <h1>🤖 Hardware Attestation Bot</h1>
        <div class="info">
          <p><strong>Status:</strong> <span class="status">✅ Online</span></p>
          <p><strong>Bot:</strong> ${client.user ? client.user.tag : 'Offline'}</p>
          <p><strong>Servers:</strong> ${client.guilds ? client.guilds.cache.size : 0}</p>
          <p><strong>Uptime:</strong> ${Math.floor(process.uptime())} seconds</p>
        </div>
        <h3>🛡️ Features</h3>
        <div class="feature">⚙️ `/attest` Horizon Hardware Attestation Workflow</div>
        <p style="margin-top: 30px; color: #64748b; font-size: 14px;">
          Powered by Render.com
        </p>
      </body>
    </html>
  `);
});

app.listen(port, '0.0.0.0', () => {
  console.log(`🌐 Web server listening on port ${port}`);
});

// Login to Discord
client.login(token);
