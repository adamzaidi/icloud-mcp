#!/usr/bin/env node
// MCP tool caller — spawns the MCP server and calls a single tool via JSON-RPC.
// Usage: node mcp-call.mjs <toolName> '<json args>'
// Loads .env from this directory when the file exists. Otherwise uses the process environment.

import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

export function loadEnvFile(file, env = { ...process.env }) {
  if (!existsSync(file)) return env;
  const lines = readFileSync(file, 'utf8').split('\n');
  for (const line of lines) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) env[match[1]] = match[2].trim();
  }
  return env;
}

function main() {
  const toolName = process.argv[2];
  const toolArgs = process.argv[3] ? JSON.parse(process.argv[3]) : {};

  if (!toolName) {
    console.error('Usage: node mcp-call.mjs <toolName> [jsonArgs]');
    process.exit(1);
  }

  const env = loadEnvFile(resolve(__dir, '.env'), { ...process.env });

  const child = spawn(process.execPath, [resolve(__dir, 'index.js')], {
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let buf = '';

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
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) main();
