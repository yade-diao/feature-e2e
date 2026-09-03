/**
 * The Judger's read-only MCP server.
 *
 * The Judger is a second LLM (the `judger` agent) summoned per state-changing
 * step to decide whether that step's business intent actually happened on the
 * page — the "clicked but nothing got selected" case the whole design targets. To
 * decide well it must LOOK at the live shadow the way a person would: read the URL,
 * count rows, find whether a chip appeared. This server is the only door it looks
 * through, and the door opens outward for reads ONLY.
 *
 * Topology: the shadow-runner (a resident second browser) listens on a unix
 * socket; the proxy connects to drive each `step`, and this MCP server connects to
 * the SAME socket to `probe` the SAME accumulated page — so the Judger sees
 * exactly the state the step just produced, not a fresh browser. The socket path
 * arrives in SHADOW_SOCK.
 *
 * Why read-only is enforced HERE and not just trusted: an arbiter that can change
 * the page can manufacture the very effect it is meant to observe — a fake green.
 * So this server exposes no click/fill/goto; only snapshot/find/count/eval, and
 * `eval` is refused by the shadow if it assigns or drives (shadow-runner `_probe`).
 * There is no tool here that mutates, by construction.
 *
 * It speaks minimal MCP over stdio (initialize / tools/list / tools/call) — enough
 * for `claude -p --mcp-config` to connect and call the four tools.
 */

import { connect as netConnect } from 'net';

const SHADOW_TOOLS = [
  {
    name: 'shadow_snapshot',
    description: 'Read an accessibility (aria) snapshot of the shadow page as it stands now — the YAML tree of roles/names, the same form browser_snapshot returns. Optionally scope to a CSS selector to narrow a dense page. Read-only.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'optional CSS selector to scope the snapshot' } } },
  },
  {
    name: 'shadow_url',
    description: 'Read the shadow page\'s current URL. Use it to confirm a step that should navigate actually did. Read-only.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'shadow_find',
    description: 'Find visible text on the shadow page: pass `text` (substring) or `regex`. Returns the inner texts that matched (up to 50). Use it to confirm a value/label/row appeared. Read-only.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, regex: { type: 'string' } } },
  },
  {
    name: 'shadow_count',
    description: 'Count how many elements a locator candidate matches on the shadow page now. `candidate` is a trace candidate object ({kind:"role",role:"row",name:"…"} etc.). Use it to check "N products are now selected". Read-only.',
    inputSchema: { type: 'object', properties: { candidate: { type: 'object' } }, required: ['candidate'] },
  },
  {
    name: 'shadow_eval',
    description: 'Evaluate a read-only JS function on the shadow page and return its value, e.g. `() => document.querySelectorAll(".selected").length`. REFUSED if it assigns or drives the page (no `=` assignment, no .click()/.dispatchEvent). Read-only by enforcement.',
    inputSchema: { type: 'object', properties: { fn: { type: 'string', description: 'a read-only arrow function returning a value' } }, required: ['fn'] },
  },
];

/**
 * SCOUT-ONLY tool: try a real interaction to find out how the step should be
 * driven. Exposed only when JUDGER_SCOUT=1 (the proxy sets it when escalating a
 * step stuck ≥3 rejections). It is the one write the Judger ever gets, and it is
 * safe because the proxy resets the shadow to the clean pre-step prefix around
 * scouting — nothing the scout does reaches a recorded step.
 */
const SCOUT_TOOL = {
  name: 'shadow_try',
  description: 'SCOUT ONLY: try a real interaction on the shadow to discover how to make the step work — a different click target, a double-click, the row leading checkbox cell. `candidate` is a trace candidate object; `method` is one of click/dblclick/check/hover/press (default click); optional `probeAfter` runs a read right after ({kind:"count",candidate:{…}} or {kind:"eval",fn:"…"}) so you see the effect. Returns what the interaction did (urlBefore/After, the probeAfter reading).',
  inputSchema: { type: 'object', properties: {
    candidate: { type: 'object' },
    method: { type: 'string' },
    key: { type: 'string' },
    probeAfter: { type: 'object' },
  }, required: ['candidate'] },
};

/**
 * SCOUT-ONLY tool: replay the clean prefix to return the shadow to this step's
 * starting state. This is the HEAVY fallback — a full prefix replay (login + every
 * prior step) — so use it only when you judge it necessary, NOT by default:
 *   - BEFORE exploring, if the shadow is not at this step's starting state (the
 *     failing step navigated the page away — a terminal action — so you cannot
 *     explore this step from where the page now sits);
 *   - AFTER exploring, if your shadow_try interactions changed the page and the
 *     Writer needs a clean starting state to re-record on.
 * If the shadow is already at the right state (a same-page failure, nothing driven),
 * you do NOT need this — explore in place and skip it. Replaying is the expensive
 * safety net, not the routine.
 */
const SCOUT_RESET_TOOL = {
  name: 'shadow_reset',
  description: 'SCOUT ONLY, HEAVY: replay the clean prefix to bring the shadow back to this step\'s starting state. Use ONLY when you judge it necessary — before exploring if the page navigated away from this step, or after exploring if your shadow_try interactions dirtied the page and the Writer needs a clean start. If the shadow is already at the right state, skip it: a full prefix replay (login + all prior steps) is slow. Returns { ok, replayed } or { ok:false, error }.',
  inputSchema: { type: 'object', properties: {} },
};

/** A client to the resident shadow socket, request/reply paired by id. */
function shadowClient(socketPath) {
  const conn = netConnect(socketPath);
  const pending = new Map();
  let nextId = 1;
  let buf = '';
  let dead = null;   // set to an Error once the connection is gone
  const ready = new Promise((resolve, reject) => {
    conn.once('connect', resolve);
    conn.once('error', reject);
  });
  conn.on('data', chunk => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); p.resolve(m); }
    }
  });
  // If the shadow goes away, reject every waiting send rather than leaving them to
  // hang forever — a hung send would freeze the Judger's tools/call, which freezes
  // the Writer waiting on record_step, which freezes the whole recording.
  const fail = (e) => {
    dead = e instanceof Error ? e : new Error(String(e || 'shadow connection closed'));
    for (const [, p] of pending) p.reject(dead);
    pending.clear();
  };
  conn.on('close', () => fail(new Error('shadow connection closed')));
  conn.on('error', (e) => fail(e));
  return {
    ready,
    send(cmd, extra = {}) {
      return new Promise((resolve, reject) => {
        if (dead) return reject(dead);
        const id = nextId++;
        pending.set(id, { resolve, reject });
        conn.write(JSON.stringify({ id, cmd, ...extra }) + '\n');
      });
    },
  };
}

/** Map a tools/call to a shadow probe, return the MCP tool result text. */
async function callShadowTool(shadow, name, args) {
  const toText = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
  switch (name) {
    case 'shadow_snapshot': {
      const r = await shadow.send('snapshot', { opts: { selector: args.selector } });
      return r.ok ? { content: [{ type: 'text', text: r.snapshot }] } : toText({ error: r.error });
    }
    case 'shadow_url':    return toText(await shadow.send('probe', { kind: 'url' }));
    case 'shadow_find':   return toText(await shadow.send('probe', { kind: 'find', text: args.text, regex: args.regex }));
    case 'shadow_count':  return toText(await shadow.send('probe', { kind: 'count', candidate: args.candidate }));
    case 'shadow_eval':   return toText(await shadow.send('probe', { kind: 'eval', fn: args.fn }));
    case 'shadow_try':    return toText(await shadow.send('tryClick', { candidate: args.candidate, method: args.method, key: args.key, probeAfter: args.probeAfter }));
    case 'shadow_reset':  return toText(await shadow.send('reset'));
    default:              return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
  }
}

export function main() {
  const socketPath = process.env.SHADOW_SOCK;
  if (!socketPath) { process.stderr.write('judger-mcp: SHADOW_SOCK not set\n'); process.exit(1); }
  const shadow = shadowClient(socketPath);

  let buf = '';
  const reply = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  process.stdin.on('data', async (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.method === 'initialize') {
        reply({ jsonrpc: '2.0', id: msg.id, result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'judger-shadow', version: '1.0.0' },
        }});
      } else if (msg.method === 'notifications/initialized') {
        // no reply to a notification
      } else if (msg.method === 'tools/list') {
        // Scout tool only when the proxy escalated this step (JUDGER_SCOUT=1) — in
        // normal judging the Judger stays strictly read-only.
        const tools = process.env.JUDGER_SCOUT === '1' ? [...SHADOW_TOOLS, SCOUT_TOOL, SCOUT_RESET_TOOL] : SHADOW_TOOLS;
        reply({ jsonrpc: '2.0', id: msg.id, result: { tools } });
      } else if (msg.method === 'tools/call') {
        try {
          await shadow.ready;
          const result = await callShadowTool(shadow, msg.params?.name, msg.params?.arguments ?? {});
          reply({ jsonrpc: '2.0', id: msg.id, result });
        } catch (e) {
          reply({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `shadow probe failed: ${e?.message ?? e}` }], isError: true } });
        }
      } else if (msg.id != null) {
        // Any other request: reply with an empty result so the client is not left hanging.
        reply({ jsonrpc: '2.0', id: msg.id, result: {} });
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

if (process.argv[1] && process.argv[1].endsWith('judger-mcp.mjs')) main();
