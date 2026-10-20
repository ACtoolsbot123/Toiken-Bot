require('dotenv').config();

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');

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
// SETUP CONFIG  (written by /set_up and by ones_config.bat)
// ============================================

const ATTEST_DIR = path.join(os.homedir(), 'Desktop', 'Attest');

function resolveSetupPath() {
  if (process.env.SETUP_CONFIG) return process.env.SETUP_CONFIG;
  if (fs.existsSync(ATTEST_DIR)) return path.join(ATTEST_DIR, 'set_up.json');
  return path.join(__dirname, 'set_up.json');
}

const SETUP_PATH = resolveSetupPath();

function loadSetup() {
  try {
    return JSON.parse(fs.readFileSync(SETUP_PATH, 'utf8')) || {};
  } catch (e) {
    return {};
  }
}

function saveSetup(next) {
  fs.writeFileSync(SETUP_PATH, JSON.stringify(next, null, 2), 'utf8');
  return SETUP_PATH;
}

function trim(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// a pasted pem often carries literal \n instead of real newlines - restore them
function restorePem(v) {
  return String(v == null ? '' : v).replace(/\\n/g, '\n').trim();
}

function certInfo(pem) {
  try {
    const x = new crypto.X509Certificate(pem);
    const fp = crypto.createHash('sha256').update(x.raw).digest('hex');
    const subject = x.subject.replace(/\n/g, ', ');
    const self = x.issuer === x.subject ? ' self-signed' : '';
    return `subject=[${subject}] sha256=${fp.slice(0, 32)} raw=${x.raw.length}B${self}`;
  } catch (e) {
    return `UNPARSEABLE: ${e.message}`;
  }
}

function keyMatchesCert(keyPem, certPem) {
  try {
    const a = crypto.createPublicKey(crypto.createPrivateKey(keyPem)).export({ type: 'spki', format: 'der' });
    const b = new crypto.X509Certificate(certPem).publicKey.export({ type: 'spki', format: 'der' });
    return Buffer.compare(a, b) === 0;
  } catch (e) {
    return null;
  }
}

// ============================================
// HARDWARE AUTHENTICATION SERVICE CLIENT
// flow from xn1d2wm.txt:
//   /login_request (pem) -> sign -> /login (b64 DER cert) -> graphql nonce ->
//   build payload -> sign -> graphql jwt
//   /register first when the server has never seen the identity
// ============================================

const SUPPORTED_ALGS = [
  'sha256WithRSAEncryption',
  'sha384WithRSAEncryption',
  'sha512WithRSAEncryption',
];

const SUBCODE_CERT_BAD = 2699002;    // device certificate invalid / not recognized
const SUBCODE_CERT_BAD_ALT = 1891224; // same rejection, other mask on this host
const SUBCODE_CHALLENGE = 2699003;   // challenge already used / signature no good
const SUBCODE_REAUTH = 2699012;      // wants a different existing_device_ent_id

function newEntId(err) {
  const data = err && err.error_data;
  if (data && typeof data === 'object') return data.new_device_ent_id || data.device_ent_id;
  if (Array.isArray(data)) {
    for (const item of data) if (item && item.new_device_ent_id) return item.new_device_ent_id;
  }
  return err && err.new_device_ent_id;
}

function isCertReject(error) {
  const g = error.graph;
  if (!g) return false;
  if (g.error_subcode === SUBCODE_CERT_BAD || g.error_subcode === SUBCODE_CERT_BAD_ALT) return true;
  return String(g.message || '').toLowerCase().includes('device certificate');
}

// strict b64 challenge -> decoded bytes, otherwise the raw string
// (ones.py signs the b64 form with a local key and the raw form off the device)
function challengeBytesAuto(challenge) {
  const s = String(challenge);
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(s) && s.length % 4 !== 1) {
    return Buffer.from(s, 'base64');
  }
  return Buffer.from(s, 'utf8');
}

// headset signer (device_signer.py style): bytes on stdin, b64 sig on stdout
// the identity private key never leaves trustzone, so this is what actually
// signs when a real device cert is in use
function runSignerOnce(cmd, data) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, { shell: true, windowsHide: true });
        let out = '';
        let err = '';
        const timer = setTimeout(() => {
            try { p.kill(); } catch (e) {}
            reject(new Error('signer timed out after 30s'));
        }, 30000);
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { err += d; });
        p.on('error', (e) => { clearTimeout(timer); reject(e); });
        p.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(`signer exit ${code}: ${trim(err.split('\n').filter(Boolean).pop() || '(no stderr)', 400)}`));
            } else {
                try {
                    resolve(pickSignature(out));
                } catch (e) {
                    reject(e);
                }
            }
        });
        p.stdin.on('error', () => {});
        p.stdin.write(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
        p.stdin.end();
    });
}

async function runSigner(cmd, data) {
    try {
        return await runSignerOnce(cmd, data);
    } catch (e) {
        // signer flakes on frida/adb reconnects - same bytes, one more go
        await new Promise((r) => setTimeout(r, 800));
        return runSignerOnce(cmd, data);
    }
}

// raw b64 on stdout normally; json {signature:...} tolerated like ones.py does
function pickSignature(out) {
    const trimmed = out.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            const j = JSON.parse(trimmed);
            const v = j.signature || j.signed_challenge || j.sig || j.b64;
            if (v) return String(v).trim();
        } catch (e) { /* not json after all */ }
    }
    const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) throw new Error('signer gave no signature');
    return lines[lines.length - 1];
}

class HardwareAuthClient {
    constructor(appToken, deviceCert, privateKeyPem, sigCmd) {
        this.baseUrl = 'https://graph.facebook-hardware.com';
        this.appToken = String(appToken || '').trim();
        this.deviceCert = restorePem(deviceCert);
        this.privateKeyPem = restorePem(privateKeyPem);
        this.sigCmd = String(sigCmd || '').trim();
        this.signatureAlgorithm = 'SHA256';
        this.registered = false;
        this.certInfo = certInfo(this.deviceCert);
    }

    getHeaders() {
        return {
            'Content-Type': 'application/json',
            'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 10; Build/QQ3A.200805.001) [FBAN/DeviceAuthServer;FBAV/295.0.0.0.0;FBBV/275123456;FBLC/en_US;FBPN/com.oculus.deviceauthserver;FBHV/Quest2;]'
        };
    }

    async post(path, body) {
        const resp = await axios.post(`${this.baseUrl}${path}`, body, {
            headers: this.getHeaders(),
            timeout: 30000,
            validateStatus: () => true,
        });
        const data = resp.data;
        if (data && typeof data === 'object' && data.error) {
            const e = new Error(data.error.message || 'graph error');
            e.graph = data.error;
            e.response = resp;
            e.config = resp.config;
            throw e;
        }
        if (resp.status >= 400) {
            const e = new Error(`http ${resp.status} on ${path}`);
            e.response = resp;
            e.config = resp.config;
            throw e;
        }
        return data || {};
    }

    async gql(params) {
        const resp = await axios.get(`${this.baseUrl}/graphql`, {
            params,
            headers: this.getHeaders(),
            timeout: 30000,
            validateStatus: () => true,
        });
        const data = resp.data;
        if (data && typeof data === 'object' && data.error) {
            const e = new Error(data.error.message || 'graphql error');
            e.graph = data.error;
            e.response = resp;
            e.config = resp.config;
            throw e;
        }
        if (resp.status >= 400) {
            const e = new Error(`http ${resp.status} on graphql`);
            e.response = resp;
            e.config = resp.config;
            throw e;
        }
        return data || {};
    }

    // /login wants compact base64 DER, /login_request wants the PEM
    b64Der() {
        return new crypto.X509Certificate(this.deviceCert).raw.toString('base64');
    }

    async step1LoginRequest() {
        const body = {
            access_token: this.appToken,
            auth_protocol_version: 1,
            device_certificate: this.deviceCert,
            supported_algorithms: SUPPORTED_ALGS,
        };

        let r;
        try {
            r = await this.post('/login_request', body);
        } catch (e) {
            if (!isCertReject(e)) throw e;

            const x = (() => { try { return new crypto.X509Certificate(this.deviceCert); } catch (err) { return null; } })();
            if (x && x.issuer === x.subject) {
                // self-signed identity: /register rejects it with the same
                // 2699002, so don't waste the call - the cert itself is the problem
                e.registerDetail = 'cert is self-signed - /register refuses it too; use the device identity cert';
                throw e;
            }

            // CA-chained cert the server has never seen - enroll it, then retry
            let regErr = null;
            try {
                await this.post('/register', {
                    access_token: this.appToken,
                    auth_protocol_version: 1,
                    device_certificates: [this.deviceCert],
                });
                this.registered = true;
            } catch (re) {
                regErr = re;
            }

            try {
                r = await this.post('/login_request', body);
            } catch (e2) {
                if (regErr) {
                    const g = regErr.graph || {};
                    e2.registerDetail = (g.error_user_msg || g.message || regErr.message || 'no detail') +
                        (g.error_subcode ? ` (subcode ${g.error_subcode})` : '');
                } else {
                    e2.registerDetail = 'register accepted the cert but login_request still rejects it';
                }
                throw e2;
            }
        }

        if (!r || !r.challenge) {
            const e = new Error('no challenge in login_request response');
            e.step = 'step1 login_request';
            throw e;
        }
        if (r.signature_algorithm) this.signatureAlgorithm = this.mapAlg(r.signature_algorithm);
        return r;
    }

    mapAlg(alg) {
        if (!alg) return 'SHA256';
        const a = alg.toLowerCase();
        if (a.includes('sha512')) return 'SHA512';
        if (a.includes('sha384')) return 'SHA384';
        return 'SHA256';
    }

    signData(data, algorithm) {
        const sign = crypto.createSign(algorithm || this.signatureAlgorithm);
        sign.update(data);
        sign.end();
        return sign.sign(this.privateKeyPem, 'base64');
    }

    // sig_cmd (headset) first, local key as fallback - same order as ones.py
    async sign(data) {
        if (this.sigCmd) return runSigner(this.sigCmd, data);
        if (this.privateKeyPem) return this.signData(data);
        throw new Error('nothing to sign with - no sig_cmd and no private_key in the setup');
    }

    async signChallenge(challenge, format) {
        // the headset signs the challenge string exactly as login_request
        // handed it over - with sig_cmd, always raw (ones.py does the same)
        const mode = this.sigCmd && format !== 'raw' ? 'raw' : format;
        const data = mode === 'raw'
            ? Buffer.from(String(challenge), 'utf8')
            : challengeBytesAuto(challenge);
        return this.sign(data);
    }

    async step2Login(challenge, socSerial, entId, format) {
        const signed = await this.signChallenge(challenge, format);
        return this.post('/login', {
            access_token: this.appToken,
            auth_protocol_version: 1,
            device_certificate: this.b64Der(),
            challenge: challenge,
            signed_challenge: signed,
            soc_serial: socSerial || '',
            existing_device_ent_id: String(entId || '0'),
        });
    }

    async step3GetNonce(dat, packageName, traceId) {
        const data = await this.gql({
            doc_id: '7677950845590217',
            variables: JSON.stringify({ package_name: packageName, trace_id: traceId }),
            access_token: dat,
        });
        return data && data.data && data.data.me && data.data.me.hwm_device
            ? data.data.me.hwm_device.device_attestation_challenge_nonce
            : undefined;
    }

    async step5GetJwt(dat, payloadObj, traceId) {
        const data = await this.gql({
            doc_id: '7295135397248539',
            variables: JSON.stringify({ json: JSON.stringify(payloadObj), trace_id: traceId }),
            access_token: dat,
        });
        return data && data.data && data.data.me && data.data.me.hwm_device
            ? data.data.me.hwm_device.device_attestation_jwt
            : undefined;
    }
}

// ============================================
// FULL FLOW: login chain -> nonce -> payload -> attest
// ============================================

async function flowLogin(auth, setup) {
    let format = 'auto';
    let entId = String(setup.existing_device_ent_id || '0');

    let step1;
    try {
        step1 = await auth.step1LoginRequest();
    } catch (e) {
        if (!e.step) e.step = 'step1 login_request';
        throw e;
    }

    for (let i = 0; i < 6; i++) {
        try {
            const r = await auth.step2Login(step1.challenge, setup.soc_serial, entId, format);
            if (r && r.access_token) return r;
            const e = new Error('login returned no access_token: ' + trim(JSON.stringify(r || {}), 200));
            e.step = 'step2 login';
            throw e;
        } catch (e) {
            if (!e.step) e.step = 'step2 login';
            const g = e.graph;
            if (g && g.error_subcode === SUBCODE_REAUTH && newEntId(g) && String(newEntId(g)) !== entId) {
                entId = String(newEntId(g));
            } else if (g && g.error_subcode === SUBCODE_CHALLENGE && format !== 'raw') {
                format = 'raw';
            } else {
                throw e;
            }
            // the challenge is single use - fetch a fresh one before retrying
            try {
                step1 = await auth.step1LoginRequest();
            } catch (e2) {
                if (!e2.step) e2.step = 'step1 login_request';
                throw e2;
            }
        }
    }
    const e = new Error('login never settled after reauth retries');
    e.step = 'step2 login';
    throw e;
}

function buildPayload(setup, nonce, clientChallenge) {
    return {
        hlos_metadata: {
            client_challenge: clientChallenge,
            server_challenge: nonce,
            package_metadata: {
                package_id: setup.package_name,
                signatures: setup.pkg_sig || '',
                version_code: setup.pkg_ver || '',
            },
            superuser_properties: {},
            shell_properties: {},
        },
        tz_metadata: {
            avb_boot_hash: '',
            avb_locked: 'true',
            avb_state: 'green',
            serial: setup.soc_serial || '',
            secure_state: 'green',
            hlos_tamper_fuse: 'false',
            ts: Math.floor(Date.now() / 1000).toString(),
        },
    };
}

async function flowAttest(setup) {
    const cert = restorePem(setup.device_cert);
    const key = restorePem(setup.private_key);

    const missing = [];
    if (!String(setup.app_token || '').trim()) missing.push('app_token');
    if (!cert) missing.push('device_cert');
    if (!key) missing.push('private_key');
    if (!String(setup.soc_serial || '').trim()) missing.push('soc_serial');
    if (!String(setup.package_name || '').trim()) missing.push('package_name');
    if (missing.length) {
        throw new Error(`set_up is missing: ${missing.join(', ')} - run /set_up first`);
    }

    const auth = new HardwareAuthClient(setup.app_token, cert, key, setup.sig_cmd);

    const login = await flowLogin(auth, setup);
    const dat = login.access_token;

    const clientChallenge = crypto.randomBytes(16).toString('hex');
    const traceId = crypto.createHash('sha1')
        .update(Buffer.from(clientChallenge, 'hex'))
        .digest('base64url');

    let nonce;
    try {
        nonce = await auth.step3GetNonce(dat, setup.package_name, traceId);
    } catch (e) {
        if (!e.step) e.step = 'step3 graphql nonce';
        throw e;
    }
    if (!nonce) {
        const e = new Error('no device_attestation_challenge_nonce in response');
        e.step = 'step3 graphql nonce';
        throw e;
    }

    const payload = buildPayload(setup, nonce, clientChallenge);
    const payloadSignature = await auth.sign(JSON.stringify(payload));
    const inner = { payload: payload, payload_signature: payloadSignature, version: '2' };

    let jwt;
    try {
        jwt = await auth.step5GetJwt(dat, inner, traceId);
    } catch (e) {
        if (!e.step) e.step = 'step5 graphql jwt';
        throw e;
    }
    if (!jwt) {
        const e = new Error('no device_attestation_jwt in response');
        e.step = 'step5 graphql jwt';
        throw e;
    }
    return jwt;
}

// ============================================
// HEADSET MINT (attest_mint.py) - real token, real claims
// ============================================

const MINT_CANDIDATES = [
    path.join(ATTEST_DIR, 'attest_mint.py'),
    path.join(__dirname, 'Attest', 'attest_mint.py'),
    path.join(__dirname, 'attest_mint.py'),
    path.join(os.homedir(), 'Desktop', 'Stuff 111', 'attest_mint.py'),
];

function findMintScript() {
    for (const p of MINT_CANDIDATES) {
        try { if (p && fs.existsSync(p)) return p; } catch (e) {}
    }
    return null;
}

function runMint(pkg) {
    return new Promise((resolve, reject) => {
        const script = findMintScript();
        if (!script) {
            reject(new Error('no mint script (attest_mint.py not found)'));
            return;
        }
        const args = pkg ? [script, 'mint', pkg] : [script, 'mint'];
        execFile('python', args, {
            timeout: 240000,
            maxBuffer: 32 * 1024 * 1024,
            windowsHide: true,
            cwd: path.dirname(script),
        }, (err, stdout, stderr) => {
            const out = String(stdout || '');
            const lines = out.split(/\r?\n/);
            const idx = lines.findIndex((l) => l.trim().startsWith('{'));
            if (idx !== -1) {
                try {
                    const data = JSON.parse(lines.slice(idx).join('\n'));
                    if (data && data.jwt) {
                        resolve(data);
                        return;
                    }
                    reject(new Error('mint failed: ' + trim(data && data.err || 'no jwt', 300)));
                    return;
                } catch (e) { /* fall through to the tail report */ }
            }
            const tail = out.trim() || String(stderr || '').trim() || '(no output)';
            const why = err ? (err.killed ? ', timed out' : `, exit ${err.code != null ? err.code : err.message}`) : '';
            reject(new Error('mint gave no token: ' + trim(tail, 300) + why));
        });
    });
}

// ============================================
// VERDICT DECODE - show what the token actually says
// ============================================

function b64urlJson(seg) {
    let s = String(seg).replace(/-/g, '+').replace(/_/g, '/');
    s += '='.repeat((4 - (s.length % 4)) % 4);
    return JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
}

function findScalar(node, key) {
    if (!node || typeof node !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(node, key)) {
        const v = node[key];
        if (v === null || typeof v !== 'object') return v;
        if (Object.prototype.hasOwnProperty.call(v, key) &&
            (v[key] === null || typeof v[key] !== 'object')) {
            return v[key];
        }
    }
    for (const k of Object.keys(node)) {
        const r = findScalar(node[k], key);
        if (r !== undefined) return r;
    }
    return undefined;
}

function firstScalar(node, keys) {
    for (const k of keys) {
        const v = findScalar(node, k);
        if (v !== undefined) return v;
    }
    return undefined;
}

function verdictOf(jwt) {
    let claims = null;
    try {
        const parts = String(jwt).split('.');
        if (parts.length === 3) claims = b64urlJson(parts[1]);
    } catch (e) { claims = null; }
    if (!claims) {
        return {
            deviceIntegrity: 'undecodable',
            appIntegrity: 'undecodable',
            isBanned: 'undecodable',
            securityUpdateDays: 'undecodable',
        };
    }

    const show = (v) => {
        if (v === undefined) return undefined;
        if (typeof v === 'boolean') return v ? 'True' : 'False';
        return String(v);
    };

    const banned = firstScalar(claims, ['is_banned']);
    const days = firstScalar(claims, ['security_update_pending_days']);

    return {
        deviceIntegrity: show(firstScalar(claims, ['device_integrity_state', 'device_integrity'])) || 'not present',
        appIntegrity: show(firstScalar(claims, ['app_integrity_state', 'app_integrity'])) || 'not present',
        // no device_ban section in a token means it carries no ban flag
        isBanned: banned === undefined ? 'False' : show(banned),
        securityUpdateDays: days === undefined ? 'not present' : show(days),
    };
}

// ============================================
// ERROR FORMATTING
// ============================================

function errorDetail(error, setup) {
    let detail = error.message;
    if (error.step) detail = `[${error.step}] ${detail}`;

    const g = error.graph || (error.response && error.response.data && error.response.data.error);
    if (g) {
        if (g.error_user_msg) detail += ` | ${g.error_user_msg}`;
        else if (g.message) detail += ` | ${g.message}`;
        if (g.error_subcode) detail += ` (subcode ${g.error_subcode})`;
        else if (g.code) detail += ` (code ${g.code})`;

        const sub = g.error_subcode;
        if (sub === SUBCODE_CERT_BAD || sub === SUBCODE_CERT_BAD_ALT) {
            detail += `\n→ server does not recognize device_cert - /set_up with the device identity cert (Attest\\device_identity.pem)`;
        } else if (sub === SUBCODE_CHALLENGE) {
            detail += `\n→ signed_challenge rejected - private_key does not match device_cert (sig_cmd / headset signer is what signs a real cert)`;
        } else if (sub === SUBCODE_REAUTH) {
            detail += `\n→ server wants a different existing_device_ent_id`;
        }
    }
    if (error.registerDetail) detail += `\n📌 /register said: ${error.registerDetail}`;
    if (setup && setup.device_cert) detail += `\n📐 cert: \`${certInfo(restorePem(setup.device_cert))}\``;
    return detail;
}

async function send(interaction, content) {
    if (content.length > 1990) content = content.slice(0, 1990) + '…';
    try {
        if (interaction.deferred || interaction.replied) await interaction.editReply(content);
        else await interaction.reply(content);
    } catch (e) {
        console.error('❌ reply failed:', e.message);
    }
}

// ============================================
// SLASH COMMANDS
// ============================================

async function handleSetUps(interaction) {
    await interaction.deferReply();

    const deviceCert = restorePem(interaction.options.getString('device_cert', true));
    const privateKey = restorePem(interaction.options.getString('private_key', true));
    const socSerial = String(interaction.options.getString('soc_serial', true) || '').trim();
    const packageName = String(interaction.options.getString('package_name', true) || '').trim();
    const appToken = String(interaction.options.getString('app_token') || '').trim();

    let x509 = null;
    try {
        x509 = new crypto.X509Certificate(deviceCert);
    } catch (e) {
        await send(interaction, `❌ device_cert is not a PEM certificate: ${e.message}`);
        return;
    }

    try {
        crypto.createPrivateKey(privateKey);
    } catch (e) {
        await send(interaction, `❌ private_key is not a PEM private key: ${e.message}`);
        return;
    }

    if (!socSerial || !packageName) {
        await send(interaction, '❌ soc_serial and package_name must not be empty.');
        return;
    }

    const prev = loadSetup();
    const setup = {
        ...prev,
        app_token: appToken || prev.app_token || '',
        device_cert: deviceCert,
        private_key: privateKey,
        soc_serial: socSerial,
        package_name: packageName,
    };

    let saved;
    try {
        saved = saveSetup(setup);
    } catch (e) {
        await send(interaction, `❌ could not write ${SETUP_PATH}: ${e.message}`);
        return;
    }

    const match = keyMatchesCert(privateKey, deviceCert);
    const selfSigned = x509.issuer === x509.subject;
    const hasSigner = Boolean(String(setup.sig_cmd || '').trim());

    const lines = [
        '✅ **set_up saved**',
        `- 📄 \`${saved}\``,
        `- 📐 cert: \`${certInfo(deviceCert)}\``,
        `- 🔑 key matches cert: **${match === true ? 'yes' : match === false ? (hasSigner ? 'NO - sig_cmd (headset) does the signing, local key is fallback only' : 'NO - step2 login will come back 2699003') : 'unknown'}**`,
        `- 🧷 signer: \`${setup.sig_cmd ? 'sig_cmd (headset)' : 'local private_key'}\``,
        `- 📦 \`${packageName}\`  🔢 serial \`${socSerial}\``,
    ];
    if (selfSigned) {
        lines.push('- ⚠️ cert is self-signed - the server answers 400 (2699002/1891224) and /register refuses it too; use the device identity cert (Attest\\device_identity.pem)');
    }
    if (!setup.app_token) {
        lines.push('- ⚠️ no app_token saved - pass `app_token` here or the flow cannot log in');
    }

    await send(interaction, lines.join('\n'));
}

async function handleGenAttestationToken(interaction) {
    await interaction.deferReply();

    const setup = loadSetup();
    if (!setup.package_name && !setup.app_token && !setup.device_cert) {
        await send(interaction,
            '❌ no setup found - run **/set_up** first (`device_cert`, `private_key`, `soc_serial`, `package_name`).');
        return;
    }

    let jwt = null;
    let source = '';
    const notes = [];

    // 1) real token minted on the headset
    try {
        const data = await runMint(setup.package_name);
        jwt = data.jwt;
        source = 'headset mint (attest_mint.py)';
    } catch (mintErr) {
        notes.push(`mint: ${trim(mintErr.message, 250)}`);
    }

    // 2) full flow: login_request -> login -> nonce -> payload -> attest
    if (!jwt) {
        try {
            jwt = await flowAttest(setup);
            source = 'full flow (login_request → login → nonce → attest)';
        } catch (flowErr) {
            const lines = ['❌ Attestation workflow failed:'];
            for (const n of notes) lines.push(`- ${n}`);
            lines.push(`- ${trim(errorDetail(flowErr, setup), 700)}`);
            await send(interaction, lines.join('\n'));
            return;
        }
    }

    const v = verdictOf(jwt);
    const out = [
        '✅ **attestation token generated**',
        `- 📦 \`${setup.package_name || 'default pkg'}\`  ⚙️ source: ${source}`,
        `- **device_integrity:** \`${v.deviceIntegrity}\``,
        `- **app_integrityAdvanced:** is_banned:**\`${v.isBanned}\`**  app_integrity:**\`${v.appIntegrity}\`**`,
        `- **security_update_pending_days:** \`${v.securityUpdateDays}\``,
        '',
        '```',
        trim(jwt, 1750),
        '```',
    ];
    await send(interaction, out.join('\n'));
}

// ============================================
// DISCORD EVENTS
// ============================================

client.once('clientReady', async (readyClient) => {
    console.log(`✅ Logged in as ${readyClient.user.tag}`);
    console.log(`📡 Monitoring ${readyClient.guilds.cache.size} server(s)`);
    console.log(`📄 setup config: ${SETUP_PATH}`);

    try {
    // max description length is 100 chars - over that discord.js throws
    // "Invalid string length" and the whole registration dies
    const commands = [
        new SlashCommandBuilder()
            .setName('set_up')
            .setDescription('Save the device setup for the attestation flow')
            .addStringOption(option =>
                option.setName('device_cert')
                    .setDescription('Device Certificate PEM string')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('private_key')
                    .setDescription('Device Private Key PEM string')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('soc_serial')
                    .setDescription('SoC Serial Number')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('package_name')
                    .setDescription('Target package name')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('app_token')
                    .setDescription('Application Hardware Token (optional - keeps the saved one)')),
        new SlashCommandBuilder()
            .setName('gen-attestation-token')
            .setDescription('Generate attestation token and show integrity / is_banned / update days'),
    ].map(command => command.toJSON());

        const rest = new REST({ version: '10' }).setToken(token);
        const CLIENT_ID = process.env.CLIENT_ID;
        const GUILD_ID = process.env.GUILD_ID;

        if (CLIENT_ID && GUILD_ID) {
            await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
            console.log('🔗 Successfully registered guild slash commands instantly.');
        } else if (CLIENT_ID) {
            await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
            console.log('🔗 Successfully registered global slash commands (can take up to an hour to show).');
        } else {
            console.log('⚠️ CLIENT_ID missing; skipped command registration.');
        }
    } catch (error) {
        console.error('❌ Failed to register slash commands:', error.stack || error.message || error);
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
        if (interaction.commandName === 'set_up') {
            await handleSetUps(interaction);
        } else if (interaction.commandName === 'gen-attestation-token') {
            await handleGenAttestationToken(interaction);
        }
    } catch (error) {
        console.error('❌ command error:', error);
        await send(interaction, `❌ command failed: ${trim(error.message, 1900)}`);
    }
});

client.on('error', (error) => {
    console.error('❌ Discord client error:', error && (error.stack || error.message) || error);
});

// async listener rejections otherwise vanish from Render logs
process.on('unhandledRejection', (reason) => {
    console.error('❌ unhandledRejection:', reason && (reason.stack || reason.message) || reason);
});
process.on('uncaughtException', (err) => {
    console.error('❌ uncaughtException:', err && (err.stack || err.message) || err);
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
        <div class="feature">⚙️ <code>/set_up</code> device setup (cert, key, soc serial, package)</div>
        <div class="feature">🎟️ <code>/gen-attestation-token</code> generate token + show verdict</div>
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
