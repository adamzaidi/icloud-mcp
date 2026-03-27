#!/usr/bin/env node
// MCP tool caller — spawns the MCP server and calls a single tool via JSON-RPC.
// Usage: node mcp-call.mjs <toolName> '<json args>'
// Reads env from .env file in this directory automatically.

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

// Load .env
const envLines = readFileSync(resolve(__dir, '.env'), 'utf8').split('\n');
const env = { ...process.env };
for (const line of envLines) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const toolName = process.argv[2];
const toolArgs = process.argv[3] ? JSON.parse(process.argv[3]) : {};

if (!toolName) {
  console.error('Usage: node mcp-call.mjs <toolName> [jsonArgs]');
  process.exit(1);
}

const child = spawn(process.execPath, [resolve(__dir, 'index.js')], {
  env,
  stdio: ['pipe', 'pipe', 'pipe']
});

let buf = '';
let msgId = 0;

function send(obj) {
  const s = JSON.stringify(obj);
  child.stdin.write(s + '\n');
}

child.stderr.on('data', () => {}); // suppress MCP server stderr

child.stdout.on('data', chunk => {
  buf += chunk.toString();
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }

    if (msg.id === 1) {
      // initialize response — now call the tool
      send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: toolName, arguments: toolArgs }
      });
    } else if (msg.id === 2) {
      // tool response
      if (msg.error) {
        console.error(JSON.stringify({ error: msg.error }));
        child.kill();
        process.exit(1);
      }
      const content = msg.result?.content;
      if (Array.isArray(content)) {
        const text = content.map(c => c.text ?? '').join('');
        console.log(text);
      } else {
        console.log(JSON.stringify(msg.result));
      }
      child.stdin.end();
      child.kill();
      process.exit(0);
    }
  }
});

child.on('close', code => {
  if (code !== 0 && code !== null) process.exit(code);
});

// Start: send initialize
send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'digest-runner', version: '1.0' }
  }
});

// Timeout safety
setTimeout(() => {
  console.error('TIMEOUT');
  child.kill();
  process.exit(1);
}, 120000);
