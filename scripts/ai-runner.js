#!/usr/bin/env node

// ---- Config ----
const MCP_URL = process.env.MCP_URL || 'http://127.0.0.1:7000';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:3000';
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || '/artifacts';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const TEST_GOAL = process.env.TEST_GOAL || 'Add a todo "MCP smoke" and verify it appears, then take a screenshot.';

// ---- Imports ----
const fs = require('fs');
const path = require('path');
const { mkdirSync } = fs;
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { OpenAI } = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- Helpers ----
function log(kind, msg, obj) {
  const stamp = new Date().toISOString();
  const base = `[${kind}] ${stamp} ${msg}`;
  if (obj) console.log(base + "\\n" + JSON.stringify(obj, null, 2));
  else console.log(base);
}
function ensureDir(dir) { try { mkdirSync(dir, { recursive: true }); } catch (_) {} }
function safeFile(name) { return name.replace(/[^a-zA-Z0-9_.-]/g, '_'); }

function looksLikeErrorDom(domText='') {
  return domText.includes('chrome-error://chromewebdata') || domText.includes('ERR_CONNECTION_REFUSED');
}

async function saveScreenshot(basename, imagePayload) {
  ensureDir(ARTIFACTS_DIR);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');

  let base64 = null;
  let ext = 'png';

  if (typeof imagePayload === 'string') {
    if (imagePayload.startsWith('data:')) {
      const match = imagePayload.match(/^data:([^;]+);base64,(.*)$/);
      if (match) {
        const mime = match[1].toLowerCase();
        base64 = match[2];
        if (mime === 'image/png') ext = 'png';
        else if (mime === 'image/jpeg' || mime === 'image/jpg') ext = 'jpg';
        else if (mime === 'image/webp') ext = 'webp';
        else if (mime === 'image/gif') ext = 'gif';
        else ext = 'bin';
      } else {
        const idx = imagePayload.indexOf(',');
        base64 = idx >= 0 ? imagePayload.slice(idx + 1) : imagePayload;
      }
    } else {
      base64 = imagePayload;
    }
  } else {
    throw new Error('Unknown image payload type');
  }

  const file = path.join(ARTIFACTS_DIR, safeFile(`${basename}-${ts}.${ext}`));
  await fs.promises.writeFile(file, Buffer.from(base64, 'base64'));
  log('ok', `Saved screenshot → ${file}`);
  return file;
}

async function saveDOMSnapshot(domContent) {
  ensureDir(ARTIFACTS_DIR);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(ARTIFACTS_DIR, safeFile(`dom-snapshot-${ts}.html`));
  await fs.promises.writeFile(file, domContent, 'utf8');
  log('ok', `Saved DOM snapshot → ${file}`);
  return file;
}

// ---- MCP Client ----
async function connectMCP() {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  const client = new Client({ name: 'ai-runner', version: '1.0.1' });
  await client.connect(transport);
  log('ok', `Connected to MCP at ${MCP_URL}`);
  return client;
}
async function callMcpTool(client, name, args = {}) {
  return await client.callTool({ name, arguments: args });
}


async function captureApplicationState(client) {
  const state = { url: APP_URL, timestamp: new Date().toISOString() };
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      log('info', `Capturing DOM structure... (attempt ${attempt})`);
      const domSnapshot = await callMcpTool(client, 'browser_snapshot', {});
      const txt = domSnapshot?.content?.[0]?.text || '';
      if (txt && !looksLikeErrorDom(txt)) {
        state.dom = txt;
        await saveDOMSnapshot(state.dom);
        log('ok', 'DOM snapshot captured successfully');
        break;
      }
    } catch (e) {
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!state.dom) log('warn', 'DOM snapshot failed or was an error page');
  return state;
}

// ---- LLM planning ----
async function askLLMForSteps(state, goal, appUrl) {
  const domInfo = state.dom ? `DOM (truncated):\\n${state.dom.slice(0, 12000)}` : 'DOM not available';

  const system = [
    'You are an expert web automation planner using Playwright MCP.',
    'Return ONLY a JSON array of MCP tool calls: [{"name":"...","arguments":{...}}, ...]',
    'Available tools:',
    '- browser_navigate { "url": "..." }',
    '- browser_click { "selector": "CSS" }',
    '- browser_type { "selector": "CSS", "text": "..." }',
    '- browser_press_key { "key": "Enter|Tab|..." }',
    '- browser_wait_for { "selector": "CSS", "timeout": 5000 }',
    '- browser_take_screenshot { "raw": true }',
    'Prefer specific CSS selectors from the DOM. For TodoMVC: ".new-todo", ".todo-list", ".toggle".'
  ].join('\\n');

  const userPrompt = [
    `GOAL: ${goal}`,
    `App URL: ${appUrl}`,
    '',
    domInfo,
    '',
    'Return only the JSON array of steps:'
  ].join('\\n');

  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.1,
    messages: [{ role: 'system', content: system }, { role: 'user', content: userPrompt }]
  });

  const content = resp.choices?.[0]?.message?.content?.trim() || '[]';
  log('info', 'LLM response received', { content: content.slice(0, 500) + '...' });

  // Extract JSON array
  let jsonText = content;
  const first = content.indexOf('[');
  const last = content.lastIndexOf(']');
  if (first !== -1 && last !== -1 && last > first) jsonText = content.slice(first, last + 1);

  let steps;
  try {
    steps = JSON.parse(jsonText);
    if (!Array.isArray(steps)) throw new Error('Response is not an array');
  } catch (e) {
    log('error', 'Failed to parse LLM response as JSON array', { content, error: e.message });
    throw new Error(`LLM returned invalid JSON: ${e.message}`);
  }
  return steps;
}

// ---- Execution ----
async function executeSteps(client, steps) {
  const results = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || typeof step.name !== 'string') throw new Error(`Invalid step at index ${i}: ${JSON.stringify(step)}`);

    const args = step.arguments || {};
    log('info', `→ Step ${i + 1}/${steps.length}: ${step.name}`, args);

    try {
      const result = await callMcpTool(client, step.name, args);

      // Save screenshots only when present, extracting base64/payload correctly
      if (step.name === 'browser_take_screenshot' && result?.content?.length) {
        const part = result.content.find(p => (p.type === 'image' && p.data) || (p.type === 'text' && p.text));
        const payload = part?.data || part?.text;
        if (payload) {
          try { await saveScreenshot(`step-${i + 1}-${step.name}`, payload); }
          catch (err) { log('warn', `Failed to save screenshot for step ${i + 1}: ${err.message}`); }
        }
      }

      results.push({ step, result, success: true });
    } catch (error) {
      log('error', `Step ${i + 1} failed: ${step.name}`, { args, error: error.message });
      results.push({ step, error: error.message, success: false });
      throw error; // fail fast
    }
  }
  return results;
}

// ---- JUnit ----
async function writeJUnitReport({ name = 'AI MCP Test Suite', steps = [], error = null }) {
  ensureDir(path.join(process.cwd(), 'reports'));
  const failures = error ? 1 : 0;
  const tests = Math.max(steps.length, 1);
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="${name}" tests="${tests}" failures="${failures}">`,
    error
      ? `  <testcase name="ai-runner"><failure><![CDATA[${error.stack || error.message || error}]]></failure></testcase>`
      : `  <testcase name="ai-runner"/>`,
    '</testsuite>'
  ].join('\\n');
  const reportFile = path.join('reports', 'junit.xml');
  await fs.promises.writeFile(reportFile, xml);
  log('ok', `JUnit report saved → ${reportFile}`);
}

// ---- Main ----
async function main() {
  let client;
  try {
    ensureDir(ARTIFACTS_DIR);

    // Connect
    const connectionTimeout = 30000;
    const deadline = Date.now() + connectionTimeout;
    let connected = false, lastError;
    log('info', `Attempting to connect to MCP at ${MCP_URL}`);

    while (!connected && Date.now() < deadline) {
      try { client = await connectMCP(); connected = true; }
      catch (error) { lastError = error; log('warn', 'Connection failed, retrying in 2s...', { error: error.message }); await new Promise(r => setTimeout(r, 2000)); }
    }
    if (!connected) throw new Error(`Failed to connect to MCP after ${connectionTimeout}ms: ${lastError?.message}`);

    // Navigate
    log('info', `Navigating to application: ${APP_URL}`);
    await callMcpTool(client, 'browser_navigate', { url: APP_URL });
    await new Promise(r => setTimeout(r, 1000));

    // Wait for app readiness (.new-todo) with retries
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        await callMcpTool(client, 'browser_wait_for', { selector: '.new-todo', timeout: 2000 });
        break; // app is ready
      } catch {
        await callMcpTool(client, 'browser_navigate', { url: APP_URL });
        await new Promise(r => setTimeout(r, 1000));
        if (attempt === 10) throw new Error('App never became ready: .new-todo not found');
      }
    }

    // Process Flow
    const state = await captureApplicationState(client);
    const steps = await askLLMForSteps(state, TEST_GOAL, APP_URL);
    log('ok', `Generated ${steps.length} test steps`);
    if (steps.length > 30) throw new Error(`Too many steps generated: ${steps.length} (max 30)`);
    await executeSteps(client, steps);
    log('ok', `Successfully executed all ${steps.length} steps`);
    await writeJUnitReport({ steps });
    process.exit(0);

  } catch (error) {
    log('error', 'Test execution failed', { message: error.message, stack: error.stack });
    await writeJUnitReport({ error });
    process.exit(1);
  } finally {
    if (client) {
      try { await client.close(); log('info', 'MCP client connection closed'); }
      catch (e) { log('warn', 'Error closing MCP client', { error: e.message }); }
    }
  }
}
main().catch((e) => { console.error('Unhandled error:', e); process.exit(1); });