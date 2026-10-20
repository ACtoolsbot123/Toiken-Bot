require('dotenv').config();

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

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
    constructor(appToken, deviceCert, privateKeyPem) {
        this.baseUrl = 'https://graph.facebook-hardware.com';
        this.appToken = appToken;
        this.deviceCert = deviceCert;
        this.privateKeyPem = privateKeyPem;
    }

    getHeaders() {
        return {
            'Content-Type': 'application/json',
            'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 10; Build/QQ3A.200805.001) [FBAN/DeviceAuthServer;FBAV/295.0.0.0.0;FBBV/275123456;FBLC/en_US;FBPN/com.oculus.deviceauthserver;FBHV/Quest2;]'
        };
    }

    async step1LoginRequest() {
        const url = `${this.baseUrl}/login_request`;
        // Flatten deviceCert to a single line to prevent literal escaped \n causing 400 errors
        const flatCert = this.deviceCert.replace(/\\r/g, '').replace(/\\n/g, '').replace(/\r?\n|\r/g, '');

        const body = {
            access_token: this.appToken,
            auth_protocol_version: 1,
            device_certificate: flatCert,
            supported_algorithms: [
                'sha256WithRSAEncryption',
                'sha384WithRSAEncryption',
                'sha512WithRSAEncryption'
            ]
        };

        const response = await axios.post(url, body, { headers: this.getHeaders() });
        return response.data;
    }

    signChallenge(challenge) {
        const sign = crypto.createSign('SHA256');
        sign.update(challenge);
        sign.end();
        return sign.sign(this.privateKeyPem, 'base64');
    }

    async step2Login(challenge, socSerial, existingEntId = '0') {
        const signedChallenge = this.signChallenge(challenge);
        const url = `${this.baseUrl}/login`;
        const flatCert = this.deviceCert.replace(/\\r/g, '').replace(/\\n/g, '').replace(/\r?\n|\r/g, '');

        const body = {
            access_token: this.appToken,
            auth_protocol_version: 1,
            device_certificate: flatCert,
            challenge: challenge,
            signed_challenge: signedChallenge,
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
            .setDescription('Run Horizon hardware attestation flow')
    ].map(command => command.toJSON());

    try {
        const rest = new REST({ version: '10' }).setToken(token);
        const CLIENT_ID = process.env.CLIENT_ID;
        const GUILD_ID = process.env.GUILD_ID;

        if (CLIENT_ID && GUILD_ID) {
            await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
            console.log('🔗 Successfully registered guild slash commands instantly.');
        } else if (CLIENT_ID) {
            await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
            console.log('🔗 Successfully registered global slash commands.');
        } else {
            console.log('⚠️ CLIENT_ID missing; skipped command registration.');
        }
    } catch (error) {
        console.error('❌ Failed to register slash commands:', error);
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'attest') {
        await interaction.deferReply();

        // Config values loaded from ones_config.json
        const appToken = 'HW|430457441064115|a7332e35cdd419007366bcf2703befa6';
        
        const deviceCert = `-----BEGIN CERTIFICATE-----
MIIC4zCCAcugAwIBAgIUE0eD43fV59brTDxUjfhkAwhgRD0wDQYJKoZIhvcNAQEL
BQAwITEfMB0GA1UEAwwWb2N1bHVzLWRldmljZS1pZGVudGl0eTAeFw0yNjEwMTIx
NDI1NTRaFw0zMTEwMTIxNDI1NTRaMCExHzAdBgNVBAMMFm9jdWx1cy1kZXZpY2Ut
aWRlbnRpdHkwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCJ1/SZZjCM
nXTu9hW5fXtlPHQUeaUuKI51MMRqn94cOOi9R/DsGIkM9r4oUVSrBRyBsETxOQYgz
Qe13IViokpwWHLBzYNmhQKaDcrDYaw4hSt7wXKtt2MnwqsgDQk/9nDYrIF0HK8qP
nMpA4GeY2VNYLcnxUVpo4IXAQ8H+LD/YpUEy9Hm3sa/tVuXReMSoeQj3VYjT3WYvG
2yQtTCBh2et7xCUvWD65tC7ExYVkVOOCVS6dfxssj6YjxEUzU7gkM69gWF7KJtHf
aIFCc8QD/b3ZlrZQcKURkeT/qeAaQ4qrBp5KRDQ9tzrrV+rv9BQdVgeFOLATi/cA
6KeEKGXe2lIRAgMBAAGjEzARMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQEL
BQADggEBACl4daAYMqEAbIv2POyjoAlXLtvkMp84xboo+Skl8aYkyyURBqZ5FOqO
9vUvSl1ZDfHbbGFDakf0gs98ZxdFupa/Vt/U8RgxZdRDgmVKNRoXRSiS6BDuj56+
WMhlsy/Zs8r4h1Tf5Eq5+HxgaOO8yCZdTPsoruc6NHgFkple4TW503DhpNg7nxbu
ixLvZ3Cth2pye6LP20Atjttpyr/tdB8i2Hqkz8QtWUnZvkuRPk7IkVijyKnQVEdp
nGPR5ETNRfEscdA1m8L7h8ou7Ah9M07p9/BhVu0MO6KBMOTbXs7W0kCUsho720pZB
Zq9inj1vzVRjpZ4tBdsax+LlpbB4Dk0=
-----END CERTIFICATE-----`;

        const privateKey = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCJ1/SZZjCMXTu9
hW5fXtlPHQUeaUuKI51MMRqn94cOOi9R/DsGIkM9r4oUVSrBRyBsETxOQYgzQe13
IViokpwWHLBzYNmhQKaDcrDYaw4hSt7wXKtt2MnwqsgDQk/9nDYrIF0HK8qPMpA4
GeY2VNYLcnxUVpo4IXAQ8H+LD/YpUEy9Hm3sa/tVuXReMSoeQj3VYjT3WYvG2yQt
TCBh2et7xCUvWD65tC7ExYVkVOOCVS6dfxssj6YjxEUzU7gkM69gWF7KJtHfaIFC
nc8QD/b3ZlrZQcKURkeT/qeAaQ4qrBp5KRDQ9tzrrV+rv9BQdVgeFOLATi/cA6KeE
KGXe2lIRAgMBAAECggEACrTEEeFe1kVsMpaj/B1PpIuSTl/gQZzthobuf+ruSZvE
TspX7UHeVh1bDKQ8G2HtBz0OzDHeecNeRcPzG7izYyucRYHZYA23lnsNzZQBt3KW
E+DRYclA5K6RtWBs+mYry41fxwL5ixtixIYNHDLaTcOjxiB/KZU98TA0v8t1aOpE
s/pof+tV8sDkoqb43bDqG2ck1j8Uclcyx9c5HdVkQ8yiApPENoDhg7swgdtPvfp9
4ZRMpMsyXyNBr3vnpL41Nm9Q7KVNEo6p9W781FchOeAIX0x/MGrNPqre2Tc+Ix96
Xg/A9s68pboc+joJ5wIXEPDSg+QFiKUMIybns05biQKBgQC/bvAeHI5yKI7nXwcc
7QbNWXmb/7dpHryILMouHZbZAcAL9OxMGu/4nLx57Qrg8KYwwpws083H92W4rVyt
WD6TLJEC7Zz6GmErJGKqatw4aW/YXZBkDdyi/r5fjAsyxwCLYwhIt1/m+RDV2NAG
DoE9PpkpDJnYrv2WtErkyPk7dQKBgQC4VeDnS4CZ2BY0VhCz8o2NjeAvwFtp5HbE
WhAEmp+FyfqNbZkDMecFlZ0WT2hOfzsj6BInQ++EarwRwRachZJJW7XBRVzrkSxK
59QUz+1henLqFhIpe04skEQeItcACRegaL2u5LbcoMGccgcnsle5bz2Kw2RYnBI8
97ZELagUrQKBgH2SGsXVu4acniidCABsZnLbB09R7RByTf8RSkn3tNSCNmRhc4L0
nhIbS4TslR2aH1KvVbDZndOt/l+UNKua2JM3LhQ+jp73TAfwXsPTShcQnPWty7F0F
Tr5IVb49EbdsHCpSesOgLbNHm0h7IPFoIFR5NGRd1KjzGHr7psjuH7ZlAoGAC/Ze
wwPOU62HO1w+dz8NWptTaiXkiMmvv2xMz8+s/ISwAs+S93cck+syp4j9ruJo1xqv
Wub4uzImBEzwh7XPWX1fHSzAK/Ve13mV9MfNkt7caD6IbTK4TwIJuZ7vLuxoIRvK
+3eSOl0gU2O+/R+Au+LxLnkhoPJ36Ib2yBPibX0CgYA1YHgTVPawEpq+htcVqvsL
fgIcNmDooksYd2/qbmp3MOnDFYhXEEkygRtoHNlLcz1drOwepoYZYXiQTxJYJ/1O
krxVBClzu6sFLflzFTztq40+GI/9Ig8KL2mvyPGdiUHyL1Czge7SkmRs2hlafnBz
nm0mDZGssTycEzbTtc9CjCw==
-----END PRIVATE KEY-----`;

        const socSerial = '2068095509';
        const packageName = 'com.VinciGames.ProjectM';
        const packageSig = 'MIIEqDCCA5CgAwIBAgIJAJNurL4H8gHfMA0GCSqGSIb3DQEBBQUAMIGUMQswCQYDVQQGEwJVUzETMBEGA1UECBMKQ2FsaWZvcm5pYTEWMBQGA1UEBxMNTW91bnRhaW4gVmlldzEQMA4GA1UEChMHQW5kcm9pZDEQMA4GA1UECxMHQW5kcm9pZDEQMA4GA1UEAxMHQW5kcm9pZDEiMCAGCSqGSIb3DQEJARYTYW5kcm9pZEBhbmRyb2lkLmNvbTAeFw0wODAyMjkwMTMzNDZaFw0zNTA3MTcwMTMzNDZaMIGUMQswCQYDVQQGEwJVUzETMBEGA1UECBMKQ2FsaWZvcm5pYTEWMBQGA1UEBxMNTW91bnRhaW4gVmlldzEQMA4GA1UEChMHQW5kcm9pZDEQMA4GA1UECxMHQW5kcm9pZDEQMA4GA1UEAxMHQW5kcm9pZDEiMCAGCSqGSIb3DQEJARYTYW5kcm9pZEBhbmRyb2lkLmNvbTCCASAwDQYJKoZIhvcNAQEBBQADggENADCCAQgCggEBANaTGQTexgskse3HYuDZ2CU+Ps1s6x3i/waMqOi8qM1r03hupwqnbOYOuw+ZNVn/2T53qUPn6D1LZLjk/qLT5lbx4meoG7+yMLV4wgRDvkxyGLhG9SEVhvA4oU6Jwr44f46+z4/Kw9oe4zDJ6pPQp8PcSvNQIg1QCAcy4ICXF+5qBTNZ5qaU7Cyz8oSgpGbIepTYOzEJOmc3Li9kEsBubULxWBjf/gOBzAzURNps3cO4JFgZSAGzJWQTT7/emMkod0jb9WdqVA2BVMi7yge54kdVMxHEa5r3b97szI5p58ii0I54JiCUP5lyfTwE/nKZHZnfm644oLIXf6MdW2r+6R8CAQOjgfwwgfkwHQYDVR0OBBYEFEhZAFY9JyxGrhGGBaR0GawJyowRMIHJBgNVHSMEgcEwgb6AFEhZAFY9JyxGrhGGBaR0GawJyowRoYGapIGXMIGUMQswCQYDVQQGEwJVUzETMBEGA1UECBMKQ2FsaWZvcm5pYTEWMBQGA1UEBxMNTW91bnRhaW4gVmlldzEQMA4GA1UEChMHQW5kcm9pZDEQMA4GA1UECxMHQW5kcm9pZDEQMA4GA1UEAxMHQW5kcm9pZDEiMCAGCSqGSIb3DQEJARYTYW5kcm9pZEBhbmRyb2lkLmNvbYIJAJNurL4H8gHfMAwGA1UdEwQFMAMBAf8wDQYJKoZIhvcNAQEFBQADggEBAHqvlozrUMRBBVEY0NqrrwFbinZaJ6cVosK0TyIUFf/azgMJWr+kLfcHCHJsIGnlw27drgQAvilFLAhLwn62oX6snb4YLCBOsVMR9FXYJLZW2+TcIkCRLXWG/oiVHQGo/rWuWkJgU134NDEFJCJGjDbiLCpe+ZTWHdcwauTJ9pUbo8EvHRkU3cYfGmLaLfgn9gP+pWA7LFQNvXwBnDa6sppCccEX31I828XzgXpJ4O+mDL1/dBd+ek8ZPUP0IgdyZm5MTYPhvVqGCHzzTy3sIeJFymwrsBbmg2OAUNLEMO6nwmocSdN2ClirfxqCzJOLSDE4QyS9BAH6EhY6UFcOaE0=';
        const packageVersion = '1316';

        const authClient = new HardwareAuthClient(appToken, deviceCert, privateKey);

        try {
            const step1 = await authClient.step1LoginRequest();
            const step2 = await authClient.step2Login(step1.challenge, socSerial);
            const dat = step2.access_token;

            const traceId = Buffer.from(Date.now().toString()).toString('base64url').substring(0, 20);
            const nonce = await authClient.step3GetNonce(dat, packageName, traceId);

            const signedChallenge = authClient.signChallenge(step1.challenge);
            const payloadObj = {
                payload: {
                    hlos_metadata: {
                        client_challenge: traceId,
                        server_challenge: nonce,
                        package_metadata: {
                            package_id: packageName,
                            signatures: packageSig,
                            version_code: packageVersion
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
                payload_signature: signedChallenge,
                version: '2'
            };

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
        <title>Discord Bot Status</title>
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

client.login(token);
