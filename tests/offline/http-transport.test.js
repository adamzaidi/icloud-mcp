// Streamable HTTP auth, DNS-rebinding checks, and startup gates. JWKS is local.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'child_process';
import { createHmac, createSign, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const projectDir = fileURLToPath(new URL('../..', import.meta.url));
const {
  assertHttpStartup,
  authenticate,
  clientIp,
  consumeRateLimit,
  hostAllowed,
  originAllowed,
  rateBucketCount,
  resetHttpForTests,
  setJwksFetcherForTests,
  setJwksTimeoutForTests,
  startHttpServer,
  verifyAccessJwt,
} = await import('../../lib/http.js');

const TEAM = 'team.cloudflareaccess.com';
const AUD = 'access-aud-tag';
const EMAIL = 'you@example.com';
const OTHER = 'other@example.com';
const BEARER = 'local-test-bearer-token';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
jwk.kid = 'test-key';
jwk.alg = 'RS256';
jwk.use = 'sig';

function signJwt(payload, { kid = 'test-key', alg = 'RS256', key = privateKey } = {}) {
  const header = Buffer.from(JSON.stringify({ alg, typ: 'JWT', kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const input = `${header}.${body}`;
  const signature = createSign('RSA-SHA256').update(input).sign(key).toString('base64url');
  return `${input}.${signature}`;
}

function claims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    aud: [AUD],
    email: EMAIL,
    exp: now + 600,
    nbf: now - 10,
    iat: now - 10,
    iss: `https://${TEAM}`,
    ...overrides,
  };
}

function accessEnv(extra = {}) {
  return {
    ICLOUD_MCP_SEND_MODE: 'off',
    ICLOUD_MCP_TOOL_PROFILE: 'remote-safe',
    CF_ACCESS_TEAM_DOMAIN: `https://${TEAM}`,
    CF_ACCESS_AUD: AUD,
    ICLOUD_MCP_ALLOWED_EMAILS: ` ${EMAIL} , second@example.com `,
    ICLOUD_MCP_RATE_LIMIT_PER_MINUTE: '100',
    ...extra,
  };
}

function createServer() {
  const server = new Server(
    { name: 'icloud-mail', version: 'test' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  return server;
}

function post(port, { host, origin, headers = {}, body }) {
  const payload = body ?? JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'http-test', version: '1.0.0' },
    },
  });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        host: host ?? `127.0.0.1:${port}`,
        ...(origin ? { origin } : {}),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'content-length': Buffer.byteLength(payload),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
        headers: res.headers,
      }));
    });
    req.setTimeout(4000, () => {
      req.destroy();
      reject(new Error('request timed out'));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function listen(env, logs = []) {
  resetHttpForTests();
  setJwksFetcherForTests(async () => ({ keys: [jwk] }));
  return startHttpServer(createServer, {
    env,
    port: 0,
    log: (line) => logs.push(line),
  });
}

test('HTTP startup refuses an open send mode and missing auth', async () => {
  assert.throws(() => assertHttpStartup({ ICLOUD_MCP_BEARER_TOKEN: BEARER }), /SEND_MODE is on/);
  assert.throws(
    () => assertHttpStartup({ ICLOUD_MCP_SEND_MODE: 'on', ICLOUD_MCP_BEARER_TOKEN: BEARER }),
    /SEND_MODE is on/
  );
  assert.throws(
    () => assertHttpStartup({
      ICLOUD_MCP_SEND_MODE: 'on',
      ICLOUD_MCP_ALLOW_REMOTE_SEND: '1',
      ICLOUD_MCP_TOOL_PROFILE: 'remote-safe',
      ICLOUD_MCP_BEARER_TOKEN: BEARER,
    }),
    /SEND_MODE is on/
  );
  assert.throws(
    () => assertHttpStartup({
      ICLOUD_MCP_SEND_MODE: 'off',
      ICLOUD_MCP_BEARER_TOKEN: BEARER,
    }),
    /must be remote-safe/
  );
  assert.throws(
    () => assertHttpStartup({
      ICLOUD_MCP_SEND_MODE: 'drafts',
      ICLOUD_MCP_TOOL_PROFILE: 'remote-safe',
      CF_ACCESS_TEAM_DOMAIN: TEAM,
      CF_ACCESS_AUD: AUD,
    }),
    /configure Cloudflare Access/
  );
  assert.throws(
    () => assertHttpStartup({ ICLOUD_MCP_SEND_MODE: 'sideways', ICLOUD_MCP_BEARER_TOKEN: BEARER }),
    /must be off, drafts, self-only, or on/
  );
  const logs = [];
  const opened = await startHttpServer(createServer, {
    env: {
      ICLOUD_MCP_SEND_MODE: 'off',
      ICLOUD_MCP_TOOL_PROFILE: 'full',
      ICLOUD_MCP_ALLOW_FULL_REMOTE: '1',
      ICLOUD_MCP_BEARER_TOKEN: BEARER,
    },
    port: 0,
    log: (line) => logs.push(line),
  });
  await opened.close();
  assert.match(logs.join(''), /ICLOUD_MCP_ALLOW_FULL_REMOTE/);
  assert.equal(logs.join('').includes(BEARER), false);
  assert.doesNotThrow(() => assertHttpStartup(accessEnv({ ICLOUD_MCP_SEND_MODE: 'self-only' })));
  assert.doesNotThrow(() => assertHttpStartup(accessEnv({ ICLOUD_MCP_SEND_MODE: 'drafts' })));
});

test('startup failure does not listen, and a good config binds loopback only', async () => {
  await assert.rejects(
    () => startHttpServer(createServer, { env: { ICLOUD_MCP_BEARER_TOKEN: BEARER }, port: 0 }),
    /SEND_MODE is on/
  );
  const logs = [];
  const server = await listen(accessEnv({ ICLOUD_MCP_BEARER_TOKEN: BEARER }), logs);
  try {
    assert.equal(server.host, '127.0.0.1');
    assert.match(logs.join(''), new RegExp(`HTTP listening on 127.0.0.1:${server.port}`));
    const response = await post(server.port, { headers: { authorization: `Bearer ${BEARER}` } });
    assert.equal(response.status, 200);
    assert.match(response.body, /icloud-mail/);
    assert.equal(logs.join('').includes(BEARER), false);
  } finally {
    await server.close();
  }
});

test('Cloudflare Access JWT: valid, expired, wrong aud, wrong email, missing', async () => {
  const logs = [];
  const env = accessEnv();
  const server = await listen(env, logs);
  const valid = signJwt(claims());
  try {
    const ok = await post(server.port, { headers: { 'cf-access-jwt-assertion': valid } });
    assert.equal(ok.status, 200, ok.body);
    assert.match(ok.body, /icloud-mail/);

    const expiredToken = signJwt(claims({ exp: Math.floor(Date.now() / 1000) - 120 }));
    const expired = await post(server.port, { headers: { 'cf-access-jwt-assertion': expiredToken } });
    assert.equal(expired.status, 401);
    assert.equal(JSON.parse(expired.body).error, 'expired');

    const wrongAud = await post(server.port, {
      headers: { 'cf-access-jwt-assertion': signJwt(claims({ aud: ['someone-else'] })) },
    });
    assert.equal(wrongAud.status, 401);
    assert.equal(JSON.parse(wrongAud.body).error, 'wrong_audience');

    const wrongEmail = await post(server.port, {
      headers: { 'cf-access-jwt-assertion': signJwt(claims({ email: OTHER })) },
    });
    assert.equal(wrongEmail.status, 401);
    assert.equal(JSON.parse(wrongEmail.body).error, 'email_not_allowed');
    assert.equal(wrongEmail.body.includes(OTHER), false);
    assert.equal(wrongEmail.body.includes(EMAIL), false);

    const missing = await post(server.port, {});
    assert.equal(missing.status, 401);
    assert.equal(JSON.parse(missing.body).error, 'missing_token');

    const badSig = await post(server.port, {
      headers: { 'cf-access-jwt-assertion': signJwt(claims(), { key: otherPair.privateKey }) },
    });
    assert.equal(badSig.status, 401);
    assert.equal(JSON.parse(badSig.body).error, 'invalid_token');

    const text = logs.join('');
    assert.equal(text.includes(valid), false);
    assert.equal(text.includes(expiredToken), false);
    assert.equal(text.includes(BEARER), false);
    assert.equal(text.includes(EMAIL), false);
    assert.equal(text.includes(OTHER), false);
  } finally {
    await server.close();
    resetHttpForTests();
  }
});

test('bearer token is a second auth option and a mismatch is rejected', async () => {
  const env = {
    ICLOUD_MCP_SEND_MODE: 'drafts',
    ICLOUD_MCP_TOOL_PROFILE: 'remote-safe',
    ICLOUD_MCP_BEARER_TOKEN: BEARER,
    ICLOUD_MCP_RATE_LIMIT_PER_MINUTE: '20',
  };
  const server = await listen(env);
  try {
    const ok = await post(server.port, { headers: { authorization: `Bearer ${BEARER}` } });
    assert.equal(ok.status, 200);
    const bad = await post(server.port, { headers: { authorization: 'Bearer not-the-token' } });
    assert.equal(bad.status, 401);
    assert.equal(JSON.parse(bad.body).error, 'invalid_token');
    assert.equal(bad.body.includes(BEARER), false);
    assert.equal(bad.body.includes('not-the-token'), false);
  } finally {
    await server.close();
  }
});

test('Host and Origin headers block DNS rebinding', async () => {
  assert.equal(hostAllowed('evil.example', {}), false);
  assert.equal(hostAllowed('127.0.0.1:8787', {}), true);
  assert.equal(hostAllowed('localhost:8787', {}), true);
  assert.equal(hostAllowed('[::1]:8787', {}), true);
  assert.equal(hostAllowed('mail.example.com', { ICLOUD_MCP_ALLOWED_HOSTS: 'mail.example.com' }), true);
  assert.equal(originAllowed('https://evil.example', 8787, {}), false);
  assert.equal(originAllowed(undefined, 8787, {}), true);
  assert.equal(originAllowed('null', 8787, {}), false);
  assert.equal(originAllowed('', 8787, {}), false);
  assert.equal(originAllowed('http://127.0.0.1:8787', 8787, {}), true);
  assert.equal(originAllowed('https://mail.example.com', 8787, { ICLOUD_MCP_ALLOWED_HOSTS: 'mail.example.com' }), true);

  const server = await listen(accessEnv({ ICLOUD_MCP_BEARER_TOKEN: BEARER }));
  try {
    const badHost = await post(server.port, {
      host: 'evil.example',
      headers: { authorization: `Bearer ${BEARER}` },
    });
    assert.equal(badHost.status, 403);
    assert.equal(JSON.parse(badHost.body).error, 'invalid_host');

    const badOrigin = await post(server.port, {
      origin: 'https://evil.example',
      headers: { authorization: `Bearer ${BEARER}` },
    });
    assert.equal(badOrigin.status, 403);
    assert.equal(JSON.parse(badOrigin.body).error, 'invalid_origin');

    const noOrigin = await post(server.port, { headers: { authorization: `Bearer ${BEARER}` } });
    assert.equal(noOrigin.status, 200);
    const nullOrigin = await post(server.port, {
      origin: 'null',
      headers: { authorization: `Bearer ${BEARER}` },
    });
    assert.equal(nullOrigin.status, 403);
    assert.equal(JSON.parse(nullOrigin.body).error, 'invalid_origin');
  } finally {
    await server.close();
  }
});

test('per-minute rate limit rejects the next request', async () => {
  const server = await listen({
    ICLOUD_MCP_SEND_MODE: 'off',
    ICLOUD_MCP_TOOL_PROFILE: 'remote-safe',
    ICLOUD_MCP_BEARER_TOKEN: BEARER,
    ICLOUD_MCP_RATE_LIMIT_PER_MINUTE: '2',
  });
  try {
    const first = await post(server.port, { headers: { authorization: `Bearer ${BEARER}` } });
    const second = await post(server.port, { headers: { authorization: `Bearer ${BEARER}` } });
    const third = await post(server.port, { headers: { authorization: `Bearer ${BEARER}` } });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(third.status, 429);
    assert.equal(JSON.parse(third.body).error, 'rate_limited');
  } finally {
    await server.close();
    resetHttpForTests();
  }
});

test('unauthenticated floods do not spend the authenticated rate limit', async () => {
  const server = await listen({
    ICLOUD_MCP_SEND_MODE: 'off',
    ICLOUD_MCP_TOOL_PROFILE: 'remote-safe',
    ICLOUD_MCP_BEARER_TOKEN: BEARER,
    ICLOUD_MCP_RATE_LIMIT_PER_MINUTE: '2',
  });
  try {
    for (let i = 0; i < 10; i += 1) {
      const flood = await post(server.port, {});
      assert.equal(flood.status, 401);
    }
    const blocked = await post(server.port, {});
    assert.equal(blocked.status, 429);
    const first = await post(server.port, { headers: { authorization: `Bearer ${BEARER}` } });
    const second = await post(server.port, { headers: { authorization: `Bearer ${BEARER}` } });
    const third = await post(server.port, { headers: { authorization: `Bearer ${BEARER}` } });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(third.status, 429);
  } finally {
    await server.close();
    resetHttpForTests();
  }
});

test('JWT rejects alg none, HMAC confusion, bad issuer, nbf, and throttles unknown kids', async () => {
  resetHttpForTests();
  setJwksFetcherForTests(async () => ({ keys: [jwk] }));
  const env = accessEnv();

  const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT', kid: 'test-key' })).toString('base64url');
  const noneBody = Buffer.from(JSON.stringify(claims())).toString('base64url');
  const none = await verifyAccessJwt(`${noneHeader}.${noneBody}.e30`, env);
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'invalid_token');

  const hsHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'test-key' })).toString('base64url');
  const hsBody = Buffer.from(JSON.stringify(claims())).toString('base64url');
  const hsSig = createHmac('sha256', Buffer.from(JSON.stringify(jwk))).update(`${hsHeader}.${hsBody}`).digest('base64url');
  const hmac = await verifyAccessJwt(`${hsHeader}.${hsBody}.${hsSig}`, env);
  assert.equal(hmac.ok, false);
  assert.equal(hmac.reason, 'invalid_token');

  const issuer = await verifyAccessJwt(signJwt(claims({ iss: 'https://evil.example' })), env);
  assert.equal(issuer.reason, 'invalid_issuer');
  const early = await verifyAccessJwt(signJwt(claims({ nbf: Math.floor(Date.now() / 1000) + 3600 })), env);
  assert.equal(early.reason, 'not_yet_valid');

  resetHttpForTests();
  let fetches = 0;
  setJwksFetcherForTests(async () => {
    fetches += 1;
    if (fetches === 1) return { keys: [jwk] };
    const rotated = otherPair.publicKey.export({ format: 'jwk' });
    rotated.kid = 'rotated-key';
    rotated.alg = 'RS256';
    rotated.use = 'sig';
    return { keys: [jwk, rotated] };
  });
  const rotated = await verifyAccessJwt(signJwt(claims(), { kid: 'rotated-key', key: otherPair.privateKey }), env);
  assert.equal(rotated.ok, true);
  assert.equal(fetches, 2);
  const unknown = await verifyAccessJwt(signJwt(claims(), { kid: 'missing-key' }), env);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'invalid_token');
  assert.equal(fetches, 2);

  resetHttpForTests();
  setJwksTimeoutForTests(40);
  setJwksFetcherForTests(() => new Promise(() => {}));
  const started = Date.now();
  const timedOut = await verifyAccessJwt(signJwt(claims()), env);
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.reason, 'invalid_token');
  assert.ok(Date.now() - started < 1000);
});

test('verifyAccessJwt accepts a matching allow-list entry regardless of case', async () => {
  resetHttpForTests();
  setJwksFetcherForTests(async () => ({ keys: [jwk] }));
  const env = accessEnv();
  const result = await verifyAccessJwt(signJwt(claims({ email: 'You@Example.com' })), env);
  assert.equal(result.ok, true);
  assert.equal(result.email, 'you@example.com');
  const direct = await authenticate({
    headers: { authorization: `Bearer ${BEARER}`, 'cf-access-jwt-assertion': 'not-a-jwt' },
  }, { ...env, ICLOUD_MCP_BEARER_TOKEN: BEARER });
  assert.equal(direct.ok, true);
  assert.equal(direct.identity, 'bearer');
});

function listToolsBody() {
  return JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
}

test('an unknown session id is 404 and a missing id on a non-initialize call is 400', async () => {
  const server = await listen({
    ICLOUD_MCP_SEND_MODE: 'off',
    ICLOUD_MCP_TOOL_PROFILE: 'remote-safe',
    ICLOUD_MCP_BEARER_TOKEN: BEARER,
  });
  try {
    const auth = { authorization: `Bearer ${BEARER}` };
    const missing = await post(server.port, { headers: auth, body: listToolsBody() });
    assert.equal(missing.status, 400);
    assert.equal(JSON.parse(missing.body).error, 'invalid_session');

    const unknown = await post(server.port, {
      headers: { ...auth, 'mcp-session-id': 'missing-session' },
      body: listToolsBody(),
    });
    assert.equal(unknown.status, 404);
    assert.equal(JSON.parse(unknown.body).error, 'session_not_found');

    const staleInitialize = await post(server.port, {
      headers: { ...auth, 'mcp-session-id': 'ended-session' },
    });
    assert.equal(staleInitialize.status, 404);

    const opened = await post(server.port, { headers: auth });
    assert.equal(opened.status, 200);
    const sessionId = opened.headers['mcp-session-id'];
    assert.equal(typeof sessionId, 'string');
    const listed = await post(server.port, {
      headers: { ...auth, 'mcp-session-id': sessionId },
      body: listToolsBody(),
    });
    assert.equal(listed.status, 200);
  } finally {
    await server.close();
    resetHttpForTests();
  }
});

test('sessions expire when idle, stop at the cap, and stay bound to one identity', async () => {
  let extra = 0;
  resetHttpForTests();
  setJwksFetcherForTests(async () => ({ keys: [jwk] }));
  const server = await startHttpServer(createServer, {
    env: accessEnv({ ICLOUD_MCP_BEARER_TOKEN: BEARER }),
    port: 0,
    sessionIdleMs: 1000,
    sessionSweepMs: 60_000,
    maxSessions: 1,
    now: () => Date.now() + extra,
    log: () => {},
  });
  try {
    assert.equal(server.sweepTimer.hasRef(), false);
    const firstToken = signJwt(claims({ email: EMAIL }));
    const secondToken = signJwt(claims({ email: 'second@example.com' }));
    const opened = await post(server.port, {
      headers: { 'cf-access-jwt-assertion': firstToken },
    });
    assert.equal(opened.status, 200, opened.body);
    const sessionId = opened.headers['mcp-session-id'];
    const again = await post(server.port, { headers: { authorization: `Bearer ${BEARER}` } });
    assert.equal(again.status, 503);
    assert.equal(JSON.parse(again.body).error, 'session_limit');

    const other = await post(server.port, {
      headers: { 'cf-access-jwt-assertion': secondToken, 'mcp-session-id': sessionId },
      body: listToolsBody(),
    });
    assert.equal(other.status, 403);
    assert.equal(JSON.parse(other.body).error, 'session_identity');
    assert.equal(other.body.includes(EMAIL), false);
    assert.equal(other.body.includes('second@example.com'), false);

    const same = await post(server.port, {
      headers: { 'cf-access-jwt-assertion': firstToken, 'mcp-session-id': sessionId },
      body: listToolsBody(),
    });
    assert.equal(same.status, 200);

    extra += 1000;
    const expired = await post(server.port, {
      headers: { 'cf-access-jwt-assertion': firstToken, 'mcp-session-id': sessionId },
      body: listToolsBody(),
    });
    assert.equal(expired.status, 404);
    const reopened = await post(server.port, {
      headers: { 'cf-access-jwt-assertion': firstToken },
    });
    assert.equal(reopened.status, 200);
  } finally {
    await server.close();
    resetHttpForTests();
  }
});

test('pre-auth limits use Cf-Connecting-Ip only for loopback peers when Access is configured', async () => {
  const access = await listen(accessEnv());
  try {
    for (let i = 0; i < 10; i += 1) {
      const flood = await post(access.port, { headers: { 'cf-connecting-ip': '203.0.113.10' } });
      assert.equal(flood.status, 401);
    }
    const blocked = await post(access.port, { headers: { 'cf-connecting-ip': '203.0.113.10' } });
    assert.equal(blocked.status, 429);
    const other = await post(access.port, { headers: { 'cf-connecting-ip': '203.0.113.11' } });
    assert.equal(other.status, 401);
    const garbage = await post(access.port, { headers: { 'cf-connecting-ip': 'not-an-ip' } });
    assert.equal(garbage.status, 401);
    const direct = await post(access.port, {});
    assert.equal(direct.status, 401);
  } finally {
    await access.close();
    resetHttpForTests();
  }

  const bearerOnly = await listen({
    ICLOUD_MCP_SEND_MODE: 'off',
    ICLOUD_MCP_TOOL_PROFILE: 'remote-safe',
    ICLOUD_MCP_BEARER_TOKEN: BEARER,
  });
  try {
    for (let i = 0; i < 10; i += 1) {
      const flood = await post(bearerOnly.port, { headers: { 'cf-connecting-ip': `203.0.113.${i}` } });
      assert.equal(flood.status, 401);
    }
    const blocked = await post(bearerOnly.port, { headers: { 'cf-connecting-ip': '198.51.100.20' } });
    assert.equal(blocked.status, 429);
  } finally {
    await bearerOnly.close();
    resetHttpForTests();
  }

  const env = accessEnv();
  assert.equal(clientIp({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'cf-connecting-ip': '203.0.113.8' },
  }, env), '203.0.113.8');
  assert.equal(clientIp({
    socket: { remoteAddress: '::ffff:127.0.0.1' },
    headers: { 'cf-connecting-ip': '::ffff:203.0.113.9' },
  }, env), '203.0.113.9');
  assert.equal(clientIp({
    socket: { remoteAddress: '203.0.113.1' },
    headers: { 'cf-connecting-ip': '203.0.113.8' },
  }, env), '203.0.113.1');
  assert.equal(clientIp({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'cf-connecting-ip': 'not-an-ip' },
  }, env), '127.0.0.1');
  assert.equal(clientIp({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'cf-connecting-ip': '203.0.113.8' },
  }, { ICLOUD_MCP_BEARER_TOKEN: BEARER }), '127.0.0.1');

  resetHttpForTests();
  consumeRateLimit('preauth:203.0.113.1', 10, 0);
  consumeRateLimit('preauth:203.0.113.2', 10, 1);
  assert.equal(rateBucketCount(), 2);
  consumeRateLimit('preauth:203.0.113.3', 10, 60_001);
  assert.equal(rateBucketCount(), 1);
});

test('icloud-mcp --http refuses to start while send mode is on, and serves when it is off', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'icloud-mcp-http-'));
  function childEnv(extra) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('IMAP_') || key.startsWith('ICLOUD_') || key.startsWith('CF_')) delete env[key];
    }
    env.IMAP_USER = 'you@icloud.com';
    env.IMAP_PASSWORD = 'fake-app-password';
    env.ICLOUD_MCP_DATA_DIR = dataRoot;
    return { ...env, ...extra };
  }

  const refused = spawn(process.execPath, ['index.js', '--http'], {
    cwd: projectDir,
    env: childEnv({ ICLOUD_MCP_BEARER_TOKEN: BEARER }),
  });
  let refusedErr = '';
  refused.stderr.on('data', (chunk) => { refusedErr += chunk; });
  const refusedCode = await new Promise((resolve) => refused.on('exit', resolve));
  assert.notEqual(refusedCode, 0);
  assert.match(refusedErr, /Refusing to start HTTP/);
  assert.equal(refusedErr.includes(BEARER), false);
  assert.equal(refusedErr.includes('fake-app-password'), false);

  const child = spawn(process.execPath, ['index.js', '--http'], {
    cwd: projectDir,
    env: childEnv({
      ICLOUD_MCP_SEND_MODE: 'off',
      ICLOUD_MCP_TOOL_PROFILE: 'remote-safe',
      ICLOUD_MCP_BEARER_TOKEN: BEARER,
      ICLOUD_MCP_HTTP_PORT: '0',
    }),
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no listen line\n${stderr}`)), 5000);
      child.stderr.on('data', () => {
        const match = stderr.match(/HTTP listening on 127\.0\.0\.1:(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`exited ${code}\n${stderr}`));
      });
    });
    const response = await post(port, { headers: { authorization: `Bearer ${BEARER}` } });
    assert.equal(response.status, 200, response.body);
    assert.match(response.body, /icloud-mail/);
    assert.equal(stderr.includes(BEARER), false);
    assert.equal(stderr.includes('fake-app-password'), false);
  } finally {
    child.kill();
  }
});
