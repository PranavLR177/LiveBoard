import type { Editor } from "@tiptap/core";

/* Suggested markers: sentences that look worth marking (a definition, a formula, a rule or a cause), found on the
   device with plain pattern matching. Nothing is sent anywhere and nothing is marked until the student taps one. */

export interface Candidate { from: number; to: number; text: string; score: number }

const DEFINES = /\b(is|are|was|were)\s+(defined as|called|known as|when|where|how|what|why|the\s+(\w+\s+){0,3}(of|that|by|in|for|which))\b|\b(means|refers to|is measured (by|in|as)|consists of|is made (up )?of)\b/i;
const FORMULA = /[=≈≤≥∝→⇒]|[∑∫Δ√π]|\^\s*-?\d|\b\d+(\.\d+)?\s?%/;
const WEIGHTY = /\b(key|important|crucial|essential|remember|note that|always|never|must|only if|because|therefore|thus|rule|law|theorem|principle|causes?|results? in|leads? to|depends on|in order to)\b/i;
const LEAF = "￼"; // stands in for a marker dot or other non-text node, so text offsets line up with document positions

function scoreOf(t: string, afterHeading: boolean) {
  let s = 0;
  if (DEFINES.test(t)) s += 3;
  if (FORMULA.test(t)) s += 3;
  if (WEIGHTY.test(t)) s += 2;
  if (t.length >= 40 && t.length <= 200) s += 1;
  if (afterHeading) s += 1;
  if (t.length < 28 || t.length > 260) s -= 3;
  if (/\?\s*$/.test(t)) s -= 2;
  return s;
}

/** Up to `max` passages worth marking, in reading order: at most one per paragraph, never inside existing markers or marker writing. */
export function findCandidates(ed: Editor, max = 5): Candidate[] {
  const doc = ed.state.doc, markType = ed.schema.marks.marker;
  const found: Candidate[] = [];
  let afterHeading = false;
  doc.descendants((node, pos) => {
    if (node.type.name === "markerOutput" || node.type.name === "codeBlock" || node.type.name === "diagram") return false;
    if (node.type.name === "heading") { afterHeading = true; return false; }
    if (!node.isTextblock) return true;
    const text = node.textBetween(0, node.content.size, undefined, LEAF);
    let best: Candidate | null = null, first = true;
    for (const m of text.matchAll(/[^.!?\n\uFFFC]+(?:[.!?]+(?=\s|\uFFFC|$)|(?=\uFFFC)|$)/g)) {
      const raw = m[0], lead = raw.length - raw.trimStart().length, body = raw.trim();
      const head = first && afterHeading;
      first = false;
      if (!body || body.includes(LEAF)) continue;
      const from = pos + 1 + m.index! + lead, to = from + body.length;
      if (doc.rangeHasMark(from, to, markType)) continue;
      const score = scoreOf(body, head);
      if (score >= 3 && (!best || score > best.score)) best = { from, to, text: body, score };
    }
    if (best) found.push(best);
    afterHeading = false;
    return false;
  });
  return found.sort((a, b) => b.score - a.score).slice(0, max).sort((a, b) => a.from - b.from);
}
