#!/usr/bin/env node
// Minimal CDP runner for the in-page differential tests in this directory.
// Talks to the haitai-cdp bridge (https://github.com/... local project, see
// ~/tmp_1/cdp-probe): picks a discovered tab by URL substring, evaluates the
// test script with Runtime.evaluate({awaitPromise, returnByValue}) and prints
// the resolved JSON summary.
//
// Usage:
//   node cdp.js list                                # print discovered tabs
//   node cdp.js run <tabUrlSubstring|targetId> @<script.js> [maxWaitMs]
// (a 32-hex target id selects the tab by id, useful with several tabs on
//  the same URL)
//
// <script.js> is an async IIFE run in the page; its resolution value (must be
// JSON-serializable) is printed to stdout. Exit status: 0 when the evaluation
// completed AND the result has no non-empty `mismatches`/`error` field, 1
// otherwise. maxWaitMs (default 120000) bounds the whole run.
//
// Environment:
//   CDP_BRIDGE      bridge base URL (default http://127.0.0.1:9222)
//   CDP_WS_PATH     directory containing the `ws` npm package (default:
//                   ~/tmp_1/cdp-probe/node_modules)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const BRIDGE = process.env.CDP_BRIDGE || 'http://127.0.0.1:9222';
const WS_CANDIDATES = [
    process.env.CDP_WS_PATH,
    path.join(os.homedir(), 'tmp_1', 'cdp-probe', 'node_modules'),
    path.join(process.cwd(), 'node_modules'),
].filter(Boolean);
let WebSocket = null;
for (const dir of WS_CANDIDATES) {
    try { WebSocket = require(path.join(dir, 'ws')); break; } catch (e) { /* try next */ }
}
if (!WebSocket) {
    console.error(`cdp.js: could not load the 'ws' module (tried ${WS_CANDIDATES.join(', ')})`);
    process.exit(2);
}

async function getJson(p) {
    const res = await fetch(BRIDGE + p);
    if (!res.ok) throw new Error(`GET ${p} -> ${res.status}`);
    return res.json();
}

async function listTabs() {
    const targets = await getJson('/json/list');
    for (const t of targets) {
        console.log(`${t.id}\t${t.url}\t${t.title || ''}`);
    }
    return targets;
}

function connect(wsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
        let nextId = 1;
        const pending = new Map();
        const api = {
            send(method, params) {
                const id = nextId++;
                return new Promise((res, rej) => {
                    pending.set(id, { res, rej, method });
                    ws.send(JSON.stringify({ id, method, params: params || {} }));
                });
            },
            close() { try { ws.close(); } catch (e) {} },
        };
        ws.on('message', (data) => {
            let msg;
            try { msg = JSON.parse(data.toString()); } catch (e) { return; }
            if (msg.id && pending.has(msg.id)) {
                const p = pending.get(msg.id);
                pending.delete(msg.id);
                if (msg.error) p.rej(new Error(`${p.method}: ${JSON.stringify(msg.error)}`));
                else p.res(msg.result);
            } else if (msg.method === 'Runtime.consoleAPICalled') {
                const args = (msg.params.args || []).map(a => a.value !== undefined ? a.value : a.description).join(' ');
                console.error(`[page:${msg.params.type}] ${args}`);
            }
        });
        ws.on('open', () => resolve(api));
        ws.on('error', (e) => reject(e));
    });
}

async function run(tabPattern, scriptPath, maxWaitMs) {
    const targets = await getJson('/json/list');
    const isId = /^[0-9A-Fa-f]{32}$/.test(tabPattern);
    const tab = targets.find(t => isId ? t.id === tabPattern.toUpperCase() : (t.url || '').includes(tabPattern));
    if (!tab) {
        console.error(`cdp.js: no tab matching "${tabPattern}". Discovered tabs:`);
        for (const t of targets) console.error(`  ${t.id}  ${t.url}`);
        process.exit(2);
    }
    let src = fs.readFileSync(scriptPath, 'utf8');
    if (src.startsWith('#!')) src = '//' + src;
    const ws = await connect(tab.webSocketDebuggerUrl);
    const deadline = Date.now() + maxWaitMs;
    try {
        await ws.send('Runtime.enable');
        // Tests fall back to setTimeout(0) if absent. Hidden tabs get intensive
        // timer throttling (~1/min), which freezes setTimeout-based yields for
        // minutes; MessageChannel posts are never throttled.
        await ws.send('Runtime.evaluate', {
            expression: 'window.__yield = window.__yield || (() => new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = r; c.port2.postMessage(0); })); undefined',
        });
        const evalPromise = ws.send('Runtime.evaluate', {
            expression: src,
            awaitPromise: true,
            returnByValue: true,
        });
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error(`run timed out after ${maxWaitMs}ms`)), maxWaitMs));
        const result = await Promise.race([evalPromise, timeout]);
        if (result.exceptionDetails) {
            console.log(JSON.stringify({
                error: 'page exception',
                text: result.exceptionDetails.text,
                exception: result.exceptionDetails.exception && result.exceptionDetails.exception.description,
            }, null, 2));
            process.exitCode = 1;
            return;
        }
        const value = result.result ? result.result.value : undefined;
        console.log(JSON.stringify(value, null, 2));
        const bad = value && (value.error || (Array.isArray(value.mismatches) && value.mismatches.length));
        process.exitCode = bad ? 1 : 0;
    } finally {
        ws.close();
    }
}

(async () => {
    const [, , cmd, ...rest] = process.argv;
    try {
        if (cmd === 'list') { await listTabs(); return; }
        if (cmd === 'run') {
            const [tab, script, maxWait] = rest;
            if (!tab || !script) {
                console.error('usage: node cdp.js run <tabUrlSubstring> @<script.js> [maxWaitMs]');
                process.exit(2);
            }
            await run(tab, script.replace(/^@/, ''), Number(maxWait) || 120000);
            return;
        }
        console.error('usage: node cdp.js list | node cdp.js run <tabUrlSubstring> @<script.js> [maxWaitMs]');
        process.exit(2);
    } catch (e) {
        console.error(`cdp.js: ${e.message}`);
        process.exit(2);
    }
})();
