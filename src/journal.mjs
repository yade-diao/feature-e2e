/**
 * A line per recording attempt, so prompt changes can be judged by something
 * other than the last anecdote.
 *
 * The number that matters is the first-attempt pass rate. A retry is not free —
 * it costs a browser session and a couple of minutes — and a prompt edit that
 * quietly halves the rate looks exactly like one that helped, right up until
 * somebody counts. Every rejection also records which gate stopped it, which is
 * what says whether a rule is doing real work or has never fired.
 *
 * Append-only, gitignored, and never read by the gates: this measures the tool,
 * it does not judge the specs.
 */

import { appendFileSync, readFileSync, existsSync } from 'fs';

const FILE = '.recordings.jsonl';

export function logAttempt(entry) {
  try {
    appendFileSync(FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* measurement must never break the thing it measures */ }
}

function readAttempts() {
  if (!existsSync(FILE)) return [];
  return readFileSync(FILE, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/** First-attempt pass rate, plus which gate rejects most often. */
export function summary(attempts = readAttempts()) {
  const runs = new Map();          // one entry per feature+start, keyed by its first attempt
  for (const a of attempts) {
    const key = `${a.feature}@${a.run}`;
    if (!runs.has(key)) runs.set(key, []);
    runs.get(key).push(a);
  }
  const firstTry = [...runs.values()].filter(r => r[0]?.ok).length;
  const byGate = new Map();
  // An attempt that produced no spec was never judged by a gate, so it lands in
  // none of the counts below. It still lowers the pass rate, and a rate with
  // nothing accounting for it reads as gates rejecting silently — so what
  // happened instead is counted here.
  const byOutcome = new Map();
  for (const a of attempts) {
    if (!a.outcome) continue;
    byOutcome.set(a.outcome, (byOutcome.get(a.outcome) ?? 0) + 1);
  }
  for (const a of attempts) {
    if (a.ok) continue;
    // `gates` is the current shape and names every gate that said no. `gate` is
    // what older lines carry; it was inferred from how many gates passed and can
    // name a gate that actually passed, so those counts are not to be trusted.
    for (const g of a.gates ?? (a.gate ? [a.gate] : [])) {
      byGate.set(g, (byGate.get(g) ?? 0) + 1);
    }
  }
  return {
    runs: runs.size,
    firstTry,
    rate: runs.size ? firstTry / runs.size : 0,
    attempts: attempts.length,
    rejections: [...byGate.entries()].sort((a, b) => b[1] - a[1]),
    outcomes: [...byOutcome.entries()].sort((a, b) => b[1] - a[1]),
  };
}
