/**
 * Parse the `claude -p --output-format=stream-json` event stream into a readable
 * activity log and the agent's final text.
 *
 * The CLI emits one JSON object per line. We only need three shapes:
 *   - {type:'system', subtype:'init', mcp_servers, session_id}   — the run started
 *   - {type:'assistant', message:{content:[{type:'text',text} | {type:'tool_use',name,input}]}}
 *   - {type:'result', subtype, result, is_error, num_turns}      — the run ended
 *
 * The point is observability: turning the opaque stdout blob into a line-by-line
 * record of what the agent actually did (which knowledge file it Read, which
 * element it clicked, which step it recorded, where it got stuck). Pure functions
 * here so the parsing is unit-testable without spawning anything.
 */

/**
 * A line splitter that tolerates partial lines across chunk boundaries — a chunk
 * from a child's stdout can end mid-line. Feed it chunks; it yields whole lines
 * and keeps the trailing partial for the next feed. `flush()` returns whatever
 * partial remains at end-of-stream.
 */
export function makeLineBuffer() {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';   // last element is the (possibly empty) partial
      return lines;
    },
    flush() {
      const rest = buf;
      buf = '';
      return rest ? [rest] : [];
    },
  };
}

/**
 * Parse one stream-json line into an event object, or null if the line is blank
 * or not valid JSON (the CLI can interleave a stray non-JSON line; skip it rather
 * than crash the whole recording).
 */
export function parseEventLine(line) {
  const t = line.trim();
  if (!t) return null;
  try { return JSON.parse(t); }
  catch { return null; }
}

/** Shorten a value for a one-line activity entry. */
function brief(v, max = 60) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * The most identifying argument of a tool call, for the activity line. Different
 * tools name their target differently; pick whatever is present, in rough order
 * of usefulness. Returns '' when nothing recognisable is there.
 */
function toolArg(name, input) {
  if (!input || typeof input !== 'object') return '';
  // Read/Write/Edit: the file path.
  if (input.file_path) return brief(input.file_path);
  // record_step: the feature step being recorded.
  if (input.step) return brief(input.step);
  // Playwright actions: the element description / text / ref / selector.
  for (const k of ['element', 'text', 'name', 'selector', 'ref', 'url', 'value', 'key']) {
    if (input[k]) return `${k}=${brief(input[k])}`;
  }
  return '';
}

/**
 * Turn one parsed event into human-readable activity lines (zero or more).
 *
 * - assistant tool_use   → `→ <tool> <arg>`   (what the agent is doing)
 * - assistant text       → `· <text>`         (what the agent is saying/thinking)
 * - system init          → `[start] mcp: <servers>` / session id
 * - result               → `[done] <ok|error> turns=<n>`
 * Anything else (tool_result, unknown) → [] (kept out of the readable log).
 */
export function eventToActivity(ev) {
  if (!ev || typeof ev !== 'object') return [];
  const lines = [];
  if (ev.type === 'system' && ev.subtype === 'init') {
    const servers = Array.isArray(ev.mcp_servers)
      ? ev.mcp_servers.map(s => `${s.name}:${s.status}`).join(', ')
      : '';
    lines.push(`[start] mcp: ${servers}`);
  } else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    for (const c of ev.message.content) {
      if (c.type === 'tool_use') {
        const arg = toolArg(c.name, c.input);
        lines.push(`→ ${c.name}${arg ? ' ' + arg : ''}`);
      } else if (c.type === 'text' && c.text && c.text.trim()) {
        lines.push(`· ${brief(c.text, 200)}`);
      }
    }
  } else if (ev.type === 'result') {
    lines.push(`[done] ${ev.is_error ? 'ERROR' : (ev.subtype ?? 'ok')} turns=${ev.num_turns ?? '?'}`);
  }
  return lines;
}

/**
 * The agent's final text — the `result` field of the terminal result event.
 * Returns null for any other event, so the caller can keep the last non-null as
 * the equivalent of the old `stdout.trim()`.
 */
export function finalTextFromEvent(ev) {
  if (ev && ev.type === 'result' && typeof ev.result === 'string') return ev.result;
  return null;
}
