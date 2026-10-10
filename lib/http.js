// Streamable HTTP transport. Stdio stays the default. This server binds to
// 127.0.0.1 only; expose it with a tunnel, not by listening on a public interface.
import http from 'node:http';
import { createHash, createPublicKey, createVerify, randomUUID, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

const SEND_MODES = new Set(['off', 'drafts', 'self-only', 'on']);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const BODY_LIMIT = 1_000_000;
const JWKS_TTL_MS = 10 * 60 * 1000;
const CLOCK_SKEW_SEC = 60;

const sessions = new Map();
const rateBuckets = new Map();
let jwksCache = { fetchedAt: 0, keys: [] };
let jwksFetcher = defaultFetchJwks;

export function setJwksFetcherForTests(fetcher) {
  jwksFetcher = fetcher ?? defaultFetchJwks;
  jwksCache = { fetchedAt: 0, keys: [] };
}

export function resetHttpForTests() {
  rateBuckets.clear();
  jwksCache = { fetchedAt: 0, keys: [] };
  jwksFetcher = defaultFetchJwks;
  sessions.clear();
}

function sendMode(env) {
  const raw = env.ICLOUD_MCP_SEND_MODE;
  if (raw == null || String(raw).trim() === '') return 'on';
  return String(raw).trim().toLowerCase();
}

function configuredAccess(env) {
  return ['CF_ACCESS_TEAM_DOMAIN', 'CF_ACCESS_AUD', 'ICLOUD_MCP_ALLOWED_EMAILS']
    .every((key) => String(env[key] ?? '').trim() !== '');
}

// Refuse to listen unless auth exists and sending is not wide open.
export function assertHttpStartup(env = process.env) {
  const mode = sendMode(env);
  if (!SEND_MODES.has(mode)) {
    throw new Error('Refusing to start HTTP: ICLOUD_MCP_SEND_MODE must be off, drafts, self-only, or on.');
  }
  if (mode === 'on' && env.ICLOUD_MCP_ALLOW_REMOTE_SEND !== '1') {
    throw new Error('Refusing to start HTTP: ICLOUD_MCP_SEND_MODE is on. Set it to off, drafts, or self-only, or set ICLOUD_MCP_ALLOW_REMOTE_SEND=1 to override.');
  }
  const bearer = String(env.ICLOUD_MCP_BEARER_TOKEN ?? '').trim();
  if (!bearer && !configuredAccess(env)) {
    throw new Error('Refusing to start HTTP: configure Cloudflare Access (CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD, ICLOUD_MCP_ALLOWED_EMAILS) or ICLOUD_MCP_BEARER_TOKEN.');
  }
}

export function normalizeTeamDomain(value) {
  return String(value ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export function hostnameFromHostHeader(hostHeader) {
  if (!hostHeader || typeof hostHeader !== 'string') return null;
  try {
    // Node reports the IPv6 loopback hostname as "[::1]".
    return new URL(`http://${hostHeader}`).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

export function extraList(value) {
  return String(value ?? '').split(',').map((part) => part.trim()).filter(Boolean);
}

export function hostAllowed(hostHeader, env = process.env) {
  const hostname = hostnameFromHostHeader(hostHeader);
  if (!hostname) return false;
  if (LOOPBACK.has(hostname)) return true;
  const allowed = extraList(env.ICLOUD_MCP_ALLOWED_HOSTS).map((host) => host.toLowerCase());
  return allowed.includes(hostname);
}

export function originAllowed(origin, port, env = process.env) {
  if (origin == null || origin === '' || origin === 'null') return true;
  const allowed = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ]);
  for (const value of extraList(env.ICLOUD_MCP_ALLOWED_ORIGINS)) allowed.add(value);
  for (const host of extraList(env.ICLOUD_MCP_ALLOWED_HOSTS)) {
    allowed.add(`https://${host}`);
    allowed.add(`http://${host}`);
  }
  return allowed.has(origin);
}

function sha256Equal(left, right) {
  const a = createHash('sha256').update(String(left)).digest();
  const b = createHash('sha256').update(String(right)).digest();
  return timingSafeEqual(a, b);
}

function bearerToken(header) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return match ? match[1] : null;
}

function decodeJsonPart(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

async function defaultFetchJwks(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error('jwks_unavailable');
    error.code = 'jwks_unavailable';
    throw error;
  }
  return response.json();
}

async function loadJwks(env, force) {
  if (!force && jwksCache.keys.length > 0 && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const team = normalizeTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
  const body = await jwksFetcher(`https://${team}/cdn-cgi/access/certs`);
  const keys = Array.isArray(body?.keys) ? body.keys : [];
  jwksCache = { fetchedAt: Date.now(), keys };
  return keys;
}

async function keyForKid(env, kid) {
  let keys = await loadJwks(env, false);
  let match = keys.find((key) => key.kid === kid);
  if (!match) {
    keys = await loadJwks(env, true);
    match = keys.find((key) => key.kid === kid);
  }
  return match ?? null;
}

// Returns { ok: true, email } or { ok: false, reason }. Reasons are fixed codes.
// The token and the email address are not included in a failure.
export async function verifyAccessJwt(token, env = process.env, nowMs = Date.now()) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3 || parts.some((part) => part === '')) return { ok: false, reason: 'invalid_token' };
  let header;
  let payload;
  try {
    header = decodeJsonPart(parts[0]);
    payload = decodeJsonPart(parts[1]);
  } catch {
    return { ok: false, reason: 'invalid_token' };
  }
  if (header?.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid === '') {
    return { ok: false, reason: 'invalid_token' };
  }
  let jwk;
  try {
    jwk = await keyForKid(env, header.kid);
  } catch {
    return { ok: false, reason: 'invalid_token' };
  }
  if (!jwk) return { ok: false, reason: 'invalid_token' };
  let verified = false;
  try {
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const signature = Buffer.from(parts[2], 'base64url');
    verified = createVerify('RSA-SHA256').update(`${parts[0]}.${parts[1]}`).verify(key, signature);
  } catch {
    return { ok: false, reason: 'invalid_token' };
  }
  if (!verified) return { ok: false, reason: 'invalid_token' };

  const nowSec = Math.floor(nowMs / 1000);
  if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_SEC < nowSec) {
    return { ok: false, reason: 'expired' };
  }
  if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_SEC > nowSec) {
    return { ok: false, reason: 'not_yet_valid' };
  }
  const team = normalizeTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
  if (payload.iss !== `https://${team}`) return { ok: false, reason: 'invalid_issuer' };
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(String(env.CF_ACCESS_AUD ?? '').trim())) {
    return { ok: false, reason: 'wrong_audience' };
  }
  const email = String(payload.email ?? '').trim().toLowerCase();
  const allow = extraList(env.ICLOUD_MCP_ALLOWED_EMAILS).map((item) => item.toLowerCase());
  if (!email || !allow.includes(email)) return { ok: false, reason: 'email_not_allowed' };
  return { ok: true, email };
}

export async function authenticate(req, env = process.env, nowMs = Date.now()) {
  const expected = String(env.ICLOUD_MCP_BEARER_TOKEN ?? '').trim();
  const presented = bearerToken(req.headers.authorization);
  if (expected && presented && sha256Equal(presented, expected)) {
    return { ok: true, identity: 'bearer' };
  }
  const jwt = req.headers['cf-access-jwt-assertion'];
  if (typeof jwt === 'string' && jwt !== '' && configuredAccess(env)) {
    const result = await verifyAccessJwt(jwt, env, nowMs);
    if (!result.ok) return result;
    return { ok: true, identity: result.email };
  }
  if (presented || (typeof jwt === 'string' && jwt !== '')) return { ok: false, reason: 'invalid_token' };
  return { ok: false, reason: 'missing_token' };
}

export function consumeRateLimit(key, limit, nowMs = Date.now()) {
  const windowMs = 60_000;
  let bucket = rateBuckets.get(key);
  if (!bucket || nowMs - bucket.start >= windowMs) {
    bucket = { start: nowMs, count: 0 };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

function rateLimitPerMinute(env) {
  const raw = env.ICLOUD_MCP_RATE_LIMIT_PER_MINUTE;
  if (raw == null || String(raw).trim() === '') return 60;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('ICLOUD_MCP_RATE_LIMIT_PER_MINUTE must be a positive integer.');
  }
  return value;
}

function readPort(env) {
  const raw = env.ICLOUD_MCP_HTTP_PORT;
  if (raw == null || String(raw).trim() === '') return 8787;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('ICLOUD_MCP_HTTP_PORT must be an integer from 0 to 65535.');
  }
  return port;
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function safeLog(log, code) {
  log(`[http] ${code}\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        const error = new Error('body_too_large');
        error.status = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleSession(req, res, body, createServer) {
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId && sessions.has(sessionId)) {
    await sessions.get(sessionId).handleRequest(req, res, body);
    return;
  }
  if (!sessionId && req.method === 'POST' && isInitializeRequest(body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    const server = createServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }
  writeJson(res, 400, { error: 'invalid_session' });
}

export async function startHttpServer(createServer, options = {}) {
  const env = options.env ?? process.env;
  assertHttpStartup(env);
  const limit = rateLimitPerMinute(env);
  const port = options.port ?? readPort(env);
  const log = options.log ?? ((line) => { process.stderr.write(line); });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/mcp') {
        writeJson(res, 404, { error: 'not_found' });
        return;
      }
      const listenPort = server.address()?.port ?? port;
      if (!hostAllowed(req.headers.host, env)) {
        safeLog(log, 'rejected_host');
        writeJson(res, 403, { error: 'invalid_host' });
        return;
      }
      if (!originAllowed(req.headers.origin, listenPort, env)) {
        safeLog(log, 'rejected_origin');
        writeJson(res, 403, { error: 'invalid_origin' });
        return;
      }
      if (!consumeRateLimit('global', limit, options.now?.() ?? Date.now())) {
        safeLog(log, 'rate_limited');
        writeJson(res, 429, { error: 'rate_limited' });
        return;
      }
      const auth = await authenticate(req, env, options.now?.() ?? Date.now());
      if (!auth.ok) {
        safeLog(log, auth.reason);
        writeJson(res, 401, { error: auth.reason });
        return;
      }
      let body;
      if (req.method === 'POST') {
        const raw = await readBody(req);
        if (raw.length === 0) {
          writeJson(res, 400, { error: 'invalid_json' });
          return;
        }
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          writeJson(res, 400, { error: 'invalid_json' });
          return;
        }
      }
      await handleSession(req, res, body, createServer);
    } catch (error) {
      if (res.headersSent) return;
      const status = error?.status === 413 ? 413 : 500;
      safeLog(log, status === 413 ? 'body_too_large' : 'internal_error');
      writeJson(res, status, { error: status === 413 ? 'body_too_large' : 'internal_error' });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  log(`HTTP listening on 127.0.0.1:${address.port}\n`);
  return {
    server,
    host: address.address,
    port: address.port,
    async close() {
      for (const transport of sessions.values()) {
        try { await transport.close(); } catch { /* already closed */ }
      }
      sessions.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
