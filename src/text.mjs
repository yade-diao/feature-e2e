/**
 * Small, dependency-free text helpers shared across the pipeline.
 *
 * `normalise` lived in two places — checks.mjs (the coverage gate's step-title
 * comparison) and trace.mjs (the same comparison at replay-index time) — as
 * byte-identical copies whose comment each said "matched to the other". Two copies
 * of a matching rule is exactly how they silently drift apart. It lives here now, in
 * a module with no heavyweight imports (checks.mjs pulls in ESLint; trace.mjs is on
 * the hot record path and must not), so both import THE SAME rule and a match here
 * is a match there by construction.
 */

/**
 * Collapse runs of whitespace to one space, fold every quote variant (straight,
 * curly, single, double) to a plain double quote, and trim. So a step title compares
 * equal regardless of the incidental whitespace or quote style the source used.
 */
export const normalise = t => String(t).replace(/\s+/g, ' ').replace(/["'“”‘’]/g, '"').trim();
