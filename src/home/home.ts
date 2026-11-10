import { courseColor, courseName, liveMarkers, liveNotes, note, putMeta, putLocalMeta, state, streak, course } from "../store";
import { leaderboard, currentUser, syncConfigured } from "../sync";
import type { Marker, Note } from "../types";
import { $, agoLong, DAY, dayKey, esc, H, reducedMotion, wrapDeg } from "../util";
import { setPendingOpen, TYPE_INFO } from "../editor/markerBox";
import { aiHealth, askMarker } from "../ai";
import { compareAnswer, fingerprint, forecast, gradeMarker, isDue, recallable, recallText, studiedOn, upcomingExams } from "../study";
import { renderSky } from "./sky";

/* The home screen: a morning strip over a spinning dial of notes arranged by when they were last opened.
   Recall plays inside the dial's center while the ring turns to each question's note. */

type Band = { l: string; s: string; max: number; w: number };
// The ring runs clockwise from "now" at the pointer. Everything older than two months shares one folder whose
// name follows what's in it (Months ago, A year ago, Years ago), so the ring never fills with tiny folders.
const BANDS: Band[] = [
  { l: "Recently opened", s: "last 24 hours", max: DAY, w: 2.6 },
  { l: "This week", s: "1–7 days", max: 7 * DAY, w: 1.9 },
  { l: "This month", s: "1–4 weeks", max: 31 * DAY, w: 1.35 },
  { l: "Last month", s: "1–2 months", max: 62 * DAY, w: 1.1 },
  { l: "In the past", s: "2+ months", max: Infinity, w: 1.05 }
];
const FOLDC: [string, string][] = [["--g1", "#fff"], ["--g2", "#2B1500"], ["--g3", "#2A2100"], ["--g4", "#032E2A"], ["--g5", "#fff"], ["--g6", "#fff"], ["--g7", "#fff"]];
const GAPDEG = 5, SAMEGAP = 1.5, MAXFILES = 5, LOOSE = 3;
/** Where the oldest folder ends, in degrees clockwise from the pointer: about 3/4 of the way round, leaving the
 *  last quarter empty so the start and end of time never sit next to each other. */
const ARC_END = 258;

interface Item { b: Band; label: string; ns: Note[]; w: number; loose?: boolean; more?: boolean; span: number; ang: number; W: number; x: number; y: number; near: number; tilt: number }
/** One recall session. `typed` is what the student wrote from memory for the current question; `missed` collects the ones answered "Again". */
interface Recall { queue: string[]; i: number; revealed: boolean; got: number; done: boolean; k: number; typed: string; missed: string[]; cram: string | null; ai: string | null; checking: boolean }

let items: Item[] = [];
let rot = 0, target = 0, sel = -1, hoverF = -1, hoverNote: string | null = null, dragging = false, lastDrawn: number | null = null, raf = 0;
let G: { c: number; rF: number; hub: number; push: number; els: HTMLElement[]; turn: HTMLElement[] } = { c: 0, rF: 0, hub: 0, push: 0, els: [], turn: [] };
let R: Recall | null = null;
let focusNote: string | null = null;
/** Which morning-strip popover is open: "lb" (leaderboard), "fc" (forecast) or "exam:<courseId>". */
let pop: string | null = null;
let aiOn = false;
aiHealth().then(h => { aiOn = h.ai; });
let handlers: { openNote: (id: string) => void; newBlank: () => void; importFile: () => void; openSettings: (section?: string) => void } | null = null;
let alive = false;
const off: (() => void)[] = [];

export const setFocusNote = (id: string | null) => { focusNote = id; };

/* ---------- recall queue ---------- */
const hasDue = (noteId: string) => liveMarkers().some(m => m.noteId === noteId && isDue(m) && recallable(m));
function curCourseId() {
  const n = note(focusNote) || [...liveNotes()].sort((a, b) => b.openedAt - a.openedAt)[0];
  return n?.courseId || null;
}
function inScope(m: Marker) {
  const age = Date.now() - m.createdAt;
  if (m.type === "reminder" && m.remindAt && m.remindAt <= Date.now()) return true;
  if (state.meta.scope === "due") return true;
  if (state.meta.scope === "night") return age < 36 * H;
  if (state.meta.scope === "week") return age < 7 * DAY;
  return note(m.noteId)?.courseId === curCourseId();
}
const queue = () => liveMarkers().filter(m => isDue(m) && recallable(m) && inScope(m)).sort((a, b) => a.due - b.due).slice(0, 20);
const doneToday = () => state.meta.studyDays.includes(dayKey(Date.now()));

/* ---------- morning strip ---------- */
const ring = (pct: number, color: string, cls = "") => `<span class="ering ${cls}" style="--p:${pct};--c:${color}"></span>`;
const inDays = (d: number) => (d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`);

async function renderMorning() {
  const el = $("#morning");
  if (!el) return;
  const hr = new Date().getHours();
  const greet = (hr < 5 ? "Up late" : hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening") + (state.meta.displayName ? `, ${state.meta.displayName.split(" ")[0]}` : "");
  const q = queue(), st = streak();
  const cid = curCourseId();
  const scopeName = { due: "", night: "last night", week: "this week", unit: courseName(cid) }[state.meta.scope];
  const overdue = q.filter(m => m.due < Date.now() - DAY).length;
  const from = scopeName ? ` from ${esc(scopeName)}` : "";
  const wk = [...Array(7)].map((_, i) => { const back = 6 - i, k = dayKey(Date.now() - back * DAY); return `<i class="${state.meta.studyDays.includes(k) ? "on" : ""} ${back === 0 ? "today" : ""}"></i>`; }).join("");
  const c = course(cid);
  const fc = forecast(), fcMax = Math.max(1, ...fc.map(d => d.n));
  const exams = upcomingExams().slice(0, 2);
  el.innerHTML = `<div class="greet"><b>${esc(greet)}</b><span>${q.length ? `${q.length} marker${q.length > 1 ? "s" : ""}${from} to recall${overdue ? ` · ${overdue} overdue` : ""}` : doneToday() ? "Today's recall is done" : `Nothing due${from}`}</span></div>
    <div class="lbwrap"><button class="chip streakchip" data-popbtn="fc" aria-expanded="${pop === "fc"}" title="Study streak: days you finished a recall. Tap for what's coming up."><b>${st}</b><small>day streak</small><span class="wk" aria-hidden="true">${wk}</span></button>
      <div class="lbpop fcpop" data-pop="fc" ${pop === "fc" ? "" : "hidden"}><h3>Coming up · next 7 days</h3>
        <div class="fcbars">${fc.map((d, i) => `<div class="fcd ${i === 0 ? "today" : ""}" title="${d.n} marker${d.n === 1 ? "" : "s"} due ${i === 0 ? "today" : d.day.toLocaleDateString(undefined, { weekday: "long" })}"><b>${d.n || ""}</b><i style="height:${d.n ? Math.max(8, Math.round(56 * d.n / fcMax)) : 3}px"></i><small>${i === 0 ? "Today" : d.day.toLocaleDateString(undefined, { weekday: "narrow" })}</small></div>`).join("")}</div>
        <div class="note">${studiedOn(Date.now()) ? "Today is done. " : ""}Each time you get one right, it comes back later: a day, then a few days, then a week.</div></div></div>
    ${exams.map((x, xi) => {
      const left = x.counts[0] + x.counts[1];
      return `<div class="lbwrap ${xi ? "later" : ""}"><button class="chip examchip" data-popbtn="exam:${x.courseId}" aria-expanded="${pop === "exam:" + x.courseId}" title="${esc(x.name)} exam ${inDays(x.days)}">${ring(x.pct, x.color)}<b>${x.days === 0 ? "Today" : x.days + "d"}</b><small>${esc(x.name)}<span class="xr"> · ${x.pct}% ready</span></small></button>
      <div class="lbpop exampop" data-pop="exam:${x.courseId}" ${pop === "exam:" + x.courseId ? "" : "hidden"}><h3>${esc(x.name)} exam · ${inDays(x.days)}</h3>
        ${x.markers.length ? `<div class="ebig">${ring(x.pct, x.color, "big")}<span class="epct"><b>${x.pct}%</b>ready</span>
          <div class="ebars">${(["Unsure", "Getting it", "Mastered"] as const).map((l, i) => `<div><span>${l}</span><i><u style="width:${Math.round(100 * x.counts[i] / x.markers.length)}%;background:${i === 2 ? "var(--good)" : i ? x.color : "var(--line)"}"></u></i><b>${x.counts[i]}</b></div>`).join("")}</div></div>
          <button class="recallbtn cram" data-cram="${x.courseId}">${left ? `Cram <span class="cnt">${Math.min(left, 30)}</span>` : `Quiz all <span class="cnt">${Math.min(x.markers.length, 30)}</span>`}</button>
          <div class="note">${left ? "Cram quizzes everything in this course you haven't mastered yet, due or not." : "Everything here is mastered. One more pass won't hurt."}</div>`
        : `<div class="note">Place markers in your ${esc(x.name)} notes and your readiness shows up here.</div>`}</div></div>`;
    }).join("")}
    <div class="scope" role="group" aria-label="Recall from">${(["due", "night", "week", "unit"] as const).map(s => `<button data-s="${s}" aria-pressed="${s === state.meta.scope}">${{ due: "All due", night: "Last night", week: "Week", unit: "Course" }[s]}</button>`).join("")}</div>
    <button class="recallbtn" id="recallBtn" ${q.length ? "" : "disabled"}>${q.length ? `Start recall <span class="cnt">${q.length}</span>` : "All caught up"}</button>
    <div class="lbwrap" id="lbWrap">${c?.classId && currentUser()
      ? `<button class="chip lbchip" id="lbBtn" data-popbtn="lb" aria-expanded="${pop === "lb"}" aria-controls="lbPop"><b id="lbRank">#–</b><small>in ${esc(c.name)}</small></button><div class="lbpop" id="lbPop" data-pop="lb" ${pop === "lb" ? "" : "hidden"}><h3>${esc(c.name)} · this week</h3><div id="lbRows">Loading…</div></div>`
      : `<button class="chip lbchip" id="lbJoin"><small>${syncConfigured() ? "Join a class" : "Classes"}</small></button>`}</div>`;
  el.querySelectorAll<HTMLButtonElement>(".scope button").forEach(b => b.onclick = async () => { await putLocalMeta({ scope: b.dataset.s as "due" }); renderMorning(); });
  $("#recallBtn")!.onclick = () => startRecall();
  el.querySelectorAll<HTMLButtonElement>("[data-popbtn]").forEach(b => b.onclick = e => { e.stopPropagation(); setPop(b.dataset.popbtn!); });
  el.querySelectorAll<HTMLButtonElement>("[data-cram]").forEach(b => b.onclick = () => {
    const x = upcomingExams().find(e => e.courseId === b.dataset.cram);
    if (!x) return;
    const weak = x.markers.filter(m => m.mastery < 2);
    startRecall((weak.length ? weak : x.markers).sort((a, z) => a.mastery - z.mastery || a.due - z.due).slice(0, 30), x.name);
  });
  const join = $("#lbJoin");
  if (join) join.onclick = () => handlers?.openSettings("classes");
  if ($("#lbBtn") && c?.classId) {
    const rows = await leaderboard(c.classId);
    if (!alive || !$("#lbRows")) return;
    if (!rows) { $("#lbRows")!.textContent = "Couldn't load the leaderboard."; return; }
    const me = rows.findIndex(r => r.is_me);
    $("#lbRank")!.textContent = me >= 0 ? `#${me + 1}` : "#–";
    $("#lbRows")!.innerHTML = rows.map((r, i) => `<div class="br ${r.is_me ? "me" : ""}"><span class="n">${i + 1}</span><span>${esc(r.display_name)}</span><span class="p">${r.points} pts</span></div>`).join("") + `<div class="note">Points come from recall answers this week.</div>`;
  }
}
/** Open one morning-strip popover (or close it if it's the one already open). */
function setPop(next: string | null) {
  pop = pop === next ? null : next;
  document.querySelectorAll<HTMLElement>("#morning [data-pop]").forEach(x => { x.hidden = x.dataset.pop !== pop; });
  document.querySelectorAll<HTMLElement>("#morning [data-popbtn]").forEach(b => b.setAttribute("aria-expanded", String(b.dataset.popbtn === pop)));
}
const closePop = () => { if (pop) setPop(null); };

/* ---------- Follow a thought: the markers you touched most recently ---------- */
function renderFollow() {
  const el = $("#follow");
  if (!el) return;
  const all = liveMarkers();
  const recent = [...all].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
  if (!recent.length) {
    el.innerHTML = `<div class="followhead"><h2>Follow a thought.</h2></div><p class="followempty">Markers you place show up here, so you can pick a thought back up from anywhere.</p>`;
    return;
  }
  el.innerHTML = `<div class="followhead"><h2>Follow a thought.</h2><span>${all.length} living point${all.length === 1 ? "" : "s"} in your notes</span></div>
    <div class="sky" id="sky"></div>
    <div class="fcards">${recent.map(m => {
      const n = note(m.noteId);
      const saved = m.thread.filter(t => t.role !== "user").length + (m.draft?.trim() ? 1 : 0);
      return `<button class="fcard" data-m="${m.id}" data-type="${m.type}">
        <span class="fpath"><i class="fdot" data-mastery="${m.mastery}"></i>${esc(courseName(n?.courseId))} / ${esc(n?.title || "")}</span>
        <span class="ftext">${m.text ? esc(m.text.length > 140 ? m.text.slice(0, 140) + "…" : m.text) : `<em>A blank point · ${esc(TYPE_INFO[m.type].label.toLowerCase())}</em>`}</span>
        <span class="fmeta">${saved} saved item${saved === 1 ? "" : "s"} · ${agoLong(m.updatedAt)} · <b>Open marker ↗</b></span></button>`;
    }).join("")}</div>`;
  const openMarker = (id: string) => {
    const m = state.markers.get(id);
    if (!m) return;
    setPendingOpen(m.id);
    handlers?.openNote(m.noteId);
  };
  el.querySelectorAll<HTMLButtonElement>(".fcard").forEach(b => b.onclick = () => openMarker(b.dataset.m!));
  renderSky($("#sky")!, openMarker);
}

/* ---------- dial ---------- */
function pastLabel(ns: Note[]) {
  const ages = ns.map(n => Date.now() - n.openedAt), young = Math.min(...ages), old = Math.max(...ages);
  if (old < 365 * DAY) return "Months ago";
  if (young >= 730 * DAY) return "Years ago";
  if (young >= 365 * DAY && old < 730 * DAY) return "A year ago";
  return "In the past";
}
function layout() {
  const notes = liveNotes().sort((a, b) => b.openedAt - a.openedAt);
  const out: Omit<Item, "span" | "ang" | "W" | "x" | "y" | "near" | "tilt">[] = [];
  BANDS.forEach((b, bi) => {
    const lo = bi ? BANDS[bi - 1].max : -Infinity;
    const ns = notes.filter(n => { const age = Date.now() - n.openedAt; return age >= lo && age < b.max; });
    if (!ns.length) return;
    if (bi === 0) {
      ns.slice(0, LOOSE).forEach(n => out.push({ b, label: b.l, ns: [n], w: b.w, loose: true }));
      if (ns.length > LOOSE) out.push({ b, label: b.l, ns: ns.slice(LOOSE), w: 1.25, more: true });
    } else out.push({ b, label: b.max === Infinity ? pastLabel(ns) : b.l, ns, w: b.w });
  });
  // Angles depend on the dial's size, so sizeDial() places them.
  items = out.map(f => ({ ...f, span: 0, ang: 0, W: 0, x: 0, y: 0, near: 0, tilt: 0 }));
}

/** How big each item is next to the newest note: recent work is drawn largest and every step back in time shrinks. */
const SIZE = [1, 0.8, 0.71, 0.63, 0.56], MORE_SIZE = 0.84;
/** How far each item reaches over the center circle, as a share of its width: most at the top, fading to none at
 *  the bottom so folders never cover the hub's Import and Blank page buttons. */
const OVERLAP = 0.14;
const sizeOf = (f: Item) => f.more ? MORE_SIZE : SIZE[BANDS.indexOf(f.b)] ?? SIZE[SIZE.length - 1];
/** Distance from the dial's center to an item's center when it sits at `deg` (0 = the pointer). */
function radiusAt(W: number, deg: number, folder: boolean) {
  const t = deg * Math.PI / 180, cos = Math.cos(t);
  const inward = (W * 0.74 * Math.abs(cos) + W * Math.abs(Math.sin(t))) / 2;
  const tuck = OVERLAP * W * (1 + cos) / 2, peek = folder ? 0.2 * W * Math.max(0, -cos) : 0; // files peek out of a folder's top
  return G.hub / 2 + inward + peek - tuck;
}

/** Packs items clockwise from the pointer by their real size: neighbours in the same band touch, and any room
 *  left before ARC_END goes into the gaps between bands, so recent notes stay bunched near the top and older
 *  folders step down the right side and round the bottom. Shrinks everything if it would run past ARC_END. */
function placeItems(maxW: number) {
  const half = (f: Item, deg: number) => {
    const t = deg * Math.PI / 180, foot = f.W * Math.abs(Math.cos(t)) + f.W * 0.74 * Math.abs(Math.sin(t));
    return Math.asin(Math.min(1, foot / 2 / radiusAt(f.W, deg, !f.loose))) * 180 / Math.PI;
  };
  const pack = () => {
    let a = 0;
    const ends: number[] = [];
    items.forEach((f, i) => {
      if (i) {
        const p = items[i - 1], gap = p.b === f.b ? SAMEGAP : GAPDEG;
        const h1 = half(p, p.ang), guess = p.ang + h1 + gap + half(f, p.ang + h1);
        a = p.ang + h1 + gap + half(f, guess);
      }
      f.ang = a; f.span = 2 * half(f, a);
      ends.push(a + f.span / 2);
    });
    return ends.length ? ends[ends.length - 1] : 0;
  };
  // Shrink a little if the ring is full, but never so much that recent notes stop being readable;
  // past that, neighbours overlap slightly instead (the one under the pointer always comes to the front).
  let scale = 1, end = 0;
  for (;;) {
    items.forEach(f => { f.W = Math.max(64, maxW * sizeOf(f) * scale); });
    end = pack();
    if (end <= ARC_END || scale <= 0.86) break;
    scale *= 0.95;
  }
  if (items.length < 2) return;
  if (end > ARC_END) { const k = ARC_END / end; items.forEach(f => { f.ang *= k; }); return; }
  const breaks = items.reduce((t, f, i) => t + (i && items[i - 1].b !== f.b ? 1 : 0), 0);
  if (!breaks) return;
  let shift = 0;
  items.forEach((f, i) => { if (i && items[i - 1].b !== f.b) shift += (ARC_END - end) / breaks; f.ang += shift; });
}

function itemHTML(f: Item, i: number) {
  const fc = FOLDC[BANDS.indexOf(f.b) % FOLDC.length];
  if (f.loose) {
    const n = f.ns[0], mc = liveMarkers().filter(x => x.noteId === n.id).length;
    return `<div class="folder loose" data-f="${i}" style="--fc:var(${fc[0]});--i:${i}">
      <button class="file solo" data-n="${n.id}" tabindex="-1" style="--c:${courseColor(n.courseId)};--k:0" aria-label="${esc(courseName(n.courseId) + ", " + n.title)}">
        <span class="fc"><span class="dot" style="background:${courseColor(n.courseId)}"></span>${esc(courseName(n.courseId))}</span>
        <span class="ft">${esc(n.title)}</span>${fingerprint(n.id, 10)}<span class="fm">${agoLong(n.openedAt)} · ${mc} marker${mc === 1 ? "" : "s"}</span>${hasDue(n.id) ? '<span class="md"></span>' : ""}</button></div>`;
  }
  const show = f.ns.slice(0, MAXFILES), m = show.length;
  return `<div class="folder" data-f="${i}" style="--fc:var(${fc[0]});--ft:${fc[1]};--i:${i}">
    <div class="fback"><span class="ftab"></span></div>
    ${show.map((n, k) => `<button class="file" data-n="${n.id}" tabindex="-1" style="--c:${courseColor(n.courseId)};--k:${k};z-index:${10 + m - k}" aria-label="${esc(courseName(n.courseId) + ", " + n.title)}"><span class="ft">${esc(n.title)}</span><span class="fm">${esc(courseName(n.courseId))} · ${agoLong(n.openedAt)}</span>${hasDue(n.id) ? '<span class="md"></span>' : ""}</button>`).join("")}
    <div class="ffront"><b>${f.more ? `+${f.ns.length} more` : f.label}</b><span>${f.more ? "recently opened" : `${f.ns.length} note${f.ns.length > 1 ? "s" : ""}${f.ns.length > MAXFILES ? ` · top ${MAXFILES}` : ""}`}</span></div></div>`;
}

/** `keep` re-renders in place (same rotation). `still` skips the spin-in, for when the dial is morphing back from a note. */
export function renderHome(stage: HTMLElement, h: NonNullable<typeof handlers>, keep = false, still = false) {
  handlers = h;
  alive = true;
  layout();
  const prevRot = rot, prevTarget = target;
  stage.innerHTML = `<div class="dialwrap"><div class="morning" id="morning"></div>
    <div id="dial" tabindex="0" role="group" aria-roledescription="dial" aria-label="Your notes, arranged by when you last opened them. Use the arrow keys to spin and Enter to open.">
      <div class="dialglow" aria-hidden="true"></div><div class="ringline" id="ringline"></div><div id="folders"></div><div class="pointer" id="pointer"></div>
      <div class="hub" id="hub"><div class="hubring" id="hubring" aria-hidden="true"></div><div class="hubticks" id="hubticks" aria-hidden="true"></div><svg class="hubprog" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="48" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"/></svg>
        <div class="info" id="info" aria-live="polite"></div>
        <div class="hubacts">
          <button class="hbtn" data-act="import" title="Import lecture" aria-label="Import lecture"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3"/><path d="M7 8l5-5 5 5"/><path d="M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/></svg><span>Import</span></button>
          <button class="hbtn" data-act="blank" title="Blank page" aria-label="Blank page"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M12 12v6M9 15h6"/></svg><span>Blank page</span></button></div></div></div>
    <div id="infoSlot"></div>
    <div class="spinrow"><button class="spinbtn" id="spinPrev" aria-label="Spin toward newer notes">←</button><span class="spinhint">Drag or scroll to move through time · select a folder to peek inside</span><button class="spinbtn" id="spinNext" aria-label="Spin toward older notes">→</button></div>
    <section class="follow" id="follow"></section></div>`;
  $("#folders")!.innerHTML = items.map(itemHTML).join("");
  $("#hub")!.querySelectorAll<HTMLButtonElement>(".hbtn").forEach(b => b.onclick = () => (b.dataset.act === "blank" ? h.newBlank() : h.importFile()));
  renderMorning();
  renderFollow();
  $("#spinPrev")!.onclick = () => goTo(sel - 1);
  $("#spinNext")!.onclick = () => goTo(sel + 1);
  sel = -1; hoverF = -1; hoverNote = null;
  sizeDial();
  bindDial();
  if (keep) { rot = prevRot; target = prevTarget; }
  else {
    let k = items.findIndex(f => f.ns.some(n => n.id === focusNote));
    if (k < 0) k = 0;
    target = items.length ? -items[k].ang : 0;
    rot = reducedMotion() || still ? target : target + 60;
    if (!reducedMotion() && !still) { const d = $("#dial")!; d.classList.add("enter"); setTimeout(() => d.classList.remove("enter"), 1400); }
  }
  lastDrawn = null;
  if (R) $("#dial")!.classList.add("recall");
  if (!items.length) $("#info")!.innerHTML = `<div class="infoin"><span class="pill" style="background:var(--g5)">Start here</span><div class="htitle">Import a lecture or start a blank page</div></div>`;
  cancelAnimationFrame(raf);
  if (items.length) { draw(); lastDrawn = rot; } // placed before the first frame, so a morph from the note page lands on the card
  raf = requestAnimationFrame(loop);
}
/** The card (or file in a folder) that stands for a note on the dial, for the open and close morph. */
export const cardFor = (noteId: string) => document.querySelector<HTMLElement>(`#folders .file[data-n="${CSS.escape(noteId)}"]`);

export function destroyHome() {
  alive = false;
  cancelAnimationFrame(raf);
  off.splice(0).forEach(f => f());
  R = null;
  pop = null;
}

function sizeDial() {
  const st = $("#stage")!, dial = $("#dial");
  if (!dial) return;
  const w = st.clientWidth - 32, h = st.clientHeight - $("#morning")!.offsetHeight - 80;
  const mw = (sz: number) => Math.max(120, Math.min(250, sz * 0.33));
  const rise = (W: number) => (W / 13) * (1.6 + (MAXFILES - 1) * 2) - W * 0.74 * 0.16;
  let size = Math.max(300, Math.min(w, 780));
  if (w >= 560) size = Math.max(320, Math.min(size, h - rise(mw(size)) * 0.5));
  const maxW = mw(size), c = size / 2;
  const rF = c - 10 - maxW * 0.42, hub = Math.max(120, 2 * (rF - maxW * 0.3));
  dial.style.marginTop = Math.max(0, rise(maxW) * 0.5) + "px";
  dial.style.setProperty("--size", size + "px");
  dial.style.setProperty("--hub", hub + "px");
  const ring = $("#ringline")!;
  ring.style.width = ring.style.height = 2 * rF + "px";
  // notes away from the pointer sit a little outside the ring, so they don't crowd the hub or the selected note
  G = { c, rF, hub, push: Math.max(14, Math.min(46, size * 0.06)), els: [...document.querySelectorAll<HTMLElement>("#folders .folder")], turn: [$("#hubring")!, $("#hubticks")!] };
  placeItems(maxW);
  paintRing();
  items.forEach((f, i) => {
    const el = G.els[i];
    el.style.setProperty("--W", f.W + "px");
    el.classList.toggle("small", f.loose ? f.W < 100 : f.W < 140);
    el.classList.toggle("mini", f.W < 78);
  });
  placeInfo();
  dial.classList.toggle("tight", hub < 300);
  lastDrawn = null;
}

/** The note details and recall questions sit inside the hub when it's big enough, and in a card under the dial when
 *  it isn't (phones). On mid-size dials the hub grows during recall instead, so the question stays in the center. */
function placeInfo() {
  const info = $("#info"), hubEl = $("#hub"), slot = $("#infoSlot");
  if (!info || !hubEl || !slot) return;
  const compact = G.hub < 210;
  $("#dial")?.classList.toggle("tiny", compact);
  if (compact && info.parentElement !== slot) slot.appendChild(info);
  else if (!compact && info.parentElement !== hubEl) hubEl.insertBefore(info, hubEl.querySelector(".hubacts"));
}

/** The ring around the hub is the time scale: each stretch takes the color of the note or folder that sits
 *  in that direction, and it turns with the dial. The quarter past the oldest folder stays plain. */
function paintRing() {
  const el = $("#hubring");
  if (!el) return;
  if (!items.length) { el.style.removeProperty("--ring"); return; }
  const col = (f: Item) => (f.loose ? courseColor(f.ns[0].courseId) : `var(${FOLDC[BANDS.indexOf(f.b) % FOLDC.length][0]})`);
  const h0 = items[0].span / 2, last = items[items.length - 1], end = Math.min(last.ang + last.span / 2, 350 - h0);
  const stops = [`${col(items[0])} 0deg`, `${col(items[0])} ${h0.toFixed(1)}deg`];
  items.slice(1).forEach(f => stops.push(`${col(f)} ${Math.max(h0, f.ang - f.span / 2).toFixed(1)}deg`, `${col(f)} ${Math.min(end, f.ang + f.span / 2).toFixed(1)}deg`));
  if (items.length > 1) stops.push(`var(--line) ${(end + 8).toFixed(1)}deg`, `var(--line) ${(352 - h0).toFixed(1)}deg`);
  stops.push(`${col(items[0])} ${(360 - h0).toFixed(1)}deg`, `${col(items[0])} 360deg`);
  el.style.setProperty("--ring", `conic-gradient(${stops.join(", ")})`);
}

function draw() {
  const { c } = G;
  let best = 0, bd = 999;
  items.forEach((f, i) => {
    const a = f.ang + rot, d = wrapDeg(a), t = a * Math.PI / 180;
    if (Math.abs(d) < bd) { bd = Math.abs(d); best = i; }
    const r = radiusAt(f.W, d, !f.loose);
    f.x = c + r * Math.sin(t); f.y = c - r * Math.cos(t); f.near = Math.max(0, 1 - Math.abs(d) / 90);
    f.tilt = Math.sin(t) * 3.5; // cards lean a little as they travel round, upright at the top and bottom
  });
  G.turn.forEach(e => { e.style.transform = `rotate(${rot.toFixed(2)}deg)`; });
  if (best !== sel) {
    const first = sel < 0;
    sel = best;
    updateInfo();
    if (!first && !reducedMotion()) { // a small detent as each note passes the pointer
      $("#pointer")?.animate([{ translate: "0 0" }, { translate: "0 4px" }, { translate: "0 0" }], { duration: 170, easing: "ease-out" });
      if (dragging) navigator.vibrate?.(4);
    }
  }
  paint();
}
function paint() {
  const rk = R && !R.done ? R.k : -1;
  items.forEach((f, i) => {
    const el = G.els[i];
    if (!el) return;
    const open = rk >= 0 ? i === rk : i === sel || i === hoverF;
    const grow = f.loose ? (open ? 1.06 : 1) : open ? Math.min(rk >= 0 ? 1.3 : 9, Math.max(1.04, f.W < 150 ? 150 / f.W : 1)) : 1;
    const sc = (0.92 + 0.08 * f.near) * grow;
    el.style.transform = `translate(${f.x}px,${f.y}px) translate(-50%,-50%) rotate(${open ? 0 : f.tilt.toFixed(2)}deg) scale(${sc})`;
    el.style.zIndex = String(i === hoverF ? 400 : open ? 250 : Math.round(100 + f.near * 50));
    el.style.opacity = String(rk >= 0 ? (i === rk ? 1 : 0.28) : open || f.loose ? 1 : (0.7 + 0.3 * f.near).toFixed(2));
    el.classList.toggle("open", open);
  });
}
function loop() {
  if (!alive || !$("#dial")) return;
  if (!dragging) { const d = target - rot; rot = Math.abs(d) < 0.03 ? target : rot + d * (reducedMotion() ? 1 : 0.14); }
  if (rot !== lastDrawn) { draw(); lastDrawn = rot; }
  raf = requestAnimationFrame(loop);
}
const snapFrom = (r: number) => {
  if (!items.length) return r;
  let bk = 0, bd = 999;
  items.forEach((f, k) => { const d = Math.abs(wrapDeg(f.ang + r)); if (d < bd) { bd = d; bk = k; } });
  return r - wrapDeg(items[bk].ang + r);
};
const goTo = (k: number) => { if (!items.length) return; k = ((k % items.length) + items.length) % items.length; target = rot - wrapDeg(items[k].ang + rot); };

/** Dark text on light course colors (yellow, mint), white on dark ones, so labels stay readable. */
function inkOn(hex: string) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#fff";
  const [r, g, b] = [0, 2, 4].map(i => { const c = parseInt(m[1].slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? "#1B1638" : "#fff";
}
function setHc(v: string, el: HTMLElement) { [$("#dial"), el].forEach(x => { x?.style.setProperty("--hc", v); x?.style.setProperty("--hcink", inkOn(v)); }); }
function updateInfo() {
  if (R) return;
  const el = $("#info"), fi = hoverF >= 0 ? hoverF : sel, f = items[fi];
  if (!el || !f) return;
  const n = hoverNote ? note(hoverNote) : f.loose ? f.ns[0] : null;
  const fc = FOLDC[BANDS.indexOf(f.b) % FOLDC.length];
  const key = n ? n.id : "f" + fi;
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  let html: string;
  if (n) {
    const ms = liveMarkers().filter(m => m.noteId === n.id), due = ms.filter(m => isDue(m) && recallable(m)).length, mastered = ms.filter(m => m.mastery === 2).length;
    const ago = agoLong(n.openedAt), num = (ago.match(/^[\d.]+/) || [""])[0], lab = num ? ago.slice(num.length).trim() : "opened";
    setHc(courseColor(n.courseId), el);
    html = `<span class="pill" style="background:${courseColor(n.courseId)}" title="${esc(f.more ? "More recent" : f.label)}">${esc(courseName(n.courseId))}</span>
      <div class="htitle">${esc(n.title)}</div>${fingerprint(n.id, 18)}
      <div class="stats"><span class="stat"><b>${num || "Now"}</b>${esc(lab)}</span><span class="stat" title="${mastered} mastered"><b>${ms.length}</b>marker${ms.length === 1 ? "" : "s"}</span>${due ? `<span class="stat due"><b>${due}</b>to recall</span>` : ""}</div>
      <button class="openlink">Open note</button>`;
  } else {
    setHc(`var(${fc[0]})`, el);
    const cs = [...new Set(f.ns.map(x => x.courseId))];
    html = `<span class="pill" style="background:var(${fc[0]});color:${fc[1]}">${f.more ? "More recent" : f.label}</span>
      <div class="bignum" style="--a:var(${fc[0]})">${f.ns.length}<small>note${f.ns.length > 1 ? "s" : ""}</small></div>
      <div class="cdots">${cs.slice(0, 8).map(c => `<span title="${esc(courseName(c))}" style="background:${courseColor(c)}"></span>`).join("")}<em>${cs.length} course${cs.length > 1 ? "s" : ""}</em></div>
      <button class="openlink">Open newest</button>`;
  }
  el.innerHTML = `<div class="infoin">${html}</div>`;
  el.querySelector<HTMLButtonElement>(".openlink")!.onclick = () => handlers?.openNote((n || f.ns[0]).id);
}

function bindDial() {
  const d = $("#dial")!;
  let last = 0, v = 0, moved = 0, downEl: HTMLElement | null = null, pid: number | null = null;
  const ang = (e: PointerEvent) => { const r = d.getBoundingClientRect(); return Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2))) * 180 / Math.PI; };
  d.addEventListener("pointerdown", e => {
    if (e.button > 0 || (e.target as Element).closest(".hub")) return;
    dragging = true; moved = 0; v = 0; last = ang(e);
    downEl = (e.target as Element).closest<HTMLElement>(".file,.folder");
    pid = e.pointerId; d.setPointerCapture(pid); d.classList.add("dragging");
  });
  d.addEventListener("pointermove", e => {
    if (!dragging || e.pointerId !== pid) return;
    const a = ang(e), dd = wrapDeg(a - last);
    rot += dd; target = rot; moved += Math.abs(dd); v = dd * 0.6 + v * 0.4; last = a;
    if (moved > 3 && hoverF >= 0) { hoverF = -1; hoverNote = null; paint(); updateInfo(); }
  });
  const up = (e: PointerEvent) => {
    if (!dragging || e.pointerId !== pid) return;
    dragging = false; d.classList.remove("dragging");
    if (moved < 3 && downEl) {
      const fi = Number(downEl.closest<HTMLElement>(".folder")!.dataset.f);
      if (!R && downEl.classList.contains("file") && (fi === sel || fi === hoverF)) handlers?.openNote(downEl.dataset.n!);
      else goTo(fi);
    } else target = snapFrom(rot + (reducedMotion() ? 0 : v * 9));
  };
  d.addEventListener("pointerup", up);
  d.addEventListener("pointercancel", up);
  const folders = $("#folders")!;
  folders.addEventListener("pointerover", e => {
    if (dragging || e.pointerType === "touch" || R) return;
    const fo = (e.target as Element).closest<HTMLElement>(".folder"), fl = (e.target as Element).closest<HTMLElement>(".file");
    const fi = fo ? Number(fo.dataset.f) : -1, nn = fl ? fl.dataset.n! : null;
    if (fi !== hoverF || nn !== hoverNote) { hoverF = fi; hoverNote = nn; paint(); updateInfo(); }
  });
  folders.addEventListener("pointerleave", () => { if (hoverF !== -1) { hoverF = -1; hoverNote = null; paint(); updateInfo(); } });
  let acc = 0;
  d.addEventListener("wheel", e => { e.preventDefault(); acc += e.deltaY + e.deltaX; if (Math.abs(acc) > 50) { goTo(sel + Math.sign(acc)); acc = 0; } }, { passive: false });
  d.addEventListener("keydown", e => {
    if (e.target !== d) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); goTo(sel + 1); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); goTo(sel - 1); }
    else if (e.key === "Home") { e.preventDefault(); goTo(0); }
    else if (e.key === "End") { e.preventDefault(); goTo(items.length - 1); }
    else if (e.key === "Enter" && !R && items[sel]) { e.preventDefault(); handlers?.openNote(items[sel].ns[0].id); }
  });
}

/* ---------- recall in the hub ---------- */
/** Start a recall session: what's due in the chosen scope, or a given set of markers (cramming for one course). */
function startRecall(custom?: Marker[], cram: string | null = null) {
  const q = custom || queue();
  if (!q.length) return;
  closePop();
  R = { queue: q.map(m => m.id), i: 0, revealed: false, got: 0, done: false, k: -1, typed: "", missed: [], cram, ai: null, checking: false };
  hoverF = -1; hoverNote = null;
  $("#dial")!.classList.add("recall");
  placeInfo();
  showRecall();
}
function setProg() {
  const c = document.querySelector<SVGCircleElement>(".hubprog circle");
  if (c && R) c.style.strokeDashoffset = String(100 - 100 * (R.done ? 1 : R.i / R.queue.length));
}
function reveal() {
  if (!R || R.revealed || R.done) return;
  R.typed = (($("#rAns") as HTMLInputElement | null)?.value || "").trim();
  R.revealed = true;
  showRecall();
}
function showRecall() {
  const el = $("#info");
  if (!el || !R) return;
  el.dataset.key = "";
  if (R.done) return showDone();
  const m = state.markers.get(R.queue[R.i]);
  const n = m ? note(m.noteId) : undefined;
  if (!m || !n) { R.i++; if (R.i >= R.queue.length) R.done = true; return showRecall(); }
  R.k = items.findIndex(f => f.ns.some(x => x.id === m.noteId));
  if (R.k >= 0) goTo(R.k);
  setHc(courseColor(n.courseId), el);
  const { q, a } = recallText(m);
  // If the student typed an answer first, show which of the stored answer's key ideas they included.
  const cmp = R.revealed && R.typed ? compareAnswer(R.typed, a) : null;
  const strong = cmp ? cmp.total > 0 && cmp.hit / cmp.total >= 0.6 : true;
  el.innerHTML = `<div class="infoin"><div class="rtop"><span class="pill" style="background:${courseColor(n.courseId)}">${R.cram ? "Cram" : "Recall"} ${R.i + 1} of ${R.queue.length}</span><button class="rx" aria-label="End recall" title="End recall (Esc)">×</button></div>
    <div class="rq">${esc(q)}</div><div class="rsrc">${esc(courseName(n.courseId))} · ${esc(n.title)}</div>
    ${R.revealed
      ? `${R.typed ? `<div class="ryou"><small>You wrote</small>${esc(R.typed)}</div>` : ""}
         <div class="ra">${cmp ? cmp.html : esc(a)}</div>
         ${cmp && cmp.total ? `<div class="rscore ${strong ? "ok" : "low"}"><b>${cmp.hit} of ${cmp.total}</b> key ideas${aiOn && !R.ai ? ` · <button class="rcheck" id="rCheck" ${R.checking ? "disabled" : ""}>${R.checking ? "Checking…" : "Check with AI"}</button>` : ""}</div>` : ""}
         ${R.ai ? `<div class="rai">${esc(R.ai)}</div>` : ""}
         <div class="racts"><button class="again">Again<kbd>1</kbd></button><button class="got">Got it<kbd>2</kbd></button></div>`
      : `<input id="rAns" class="rans" autocomplete="off" autocapitalize="sentences" maxlength="400" placeholder="Type what you remember (optional)" aria-label="Your answer from memory">
         <button class="openlink" id="reveal">Show answer</button>`}</div>`;
  el.querySelector<HTMLButtonElement>(".rx")!.onclick = endRecall;
  if (R.revealed) {
    const again = el.querySelector<HTMLButtonElement>(".again")!, got = el.querySelector<HTMLButtonElement>(".got")!;
    again.onclick = () => grade(m, false);
    got.onclick = () => grade(m, true);
    (strong ? got : again).focus({ preventScroll: true });
    const chk = $("#rCheck");
    if (chk) chk.onclick = () => aiCheck(m.id, q, a);
  } else {
    const b = $("#reveal")!, inp = $("#rAns") as HTMLInputElement;
    b.onclick = reveal;
    inp.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); reveal(); } };
    // a mouse or keyboard goes straight to typing; on touch, focusing would cover the dial with the on-screen keyboard
    (matchMedia("(pointer: fine)").matches ? inp : b).focus({ preventScroll: true });
  }
  setProg();
  paint();
}
/** Ask the AI whether a typed answer captures the stored one. Optional, one tap, and never changes the grade by itself. */
async function aiCheck(id: string, q: string, a: string) {
  if (!R || R.checking) return;
  const typed = R.typed;
  R.checking = true;
  showRecall();
  let verdict: string;
  try {
    const r = await askMarker({ intent: `I answered a recall question from memory. In at most two short sentences, tell me what I got right and what I missed or got wrong. Be direct and kind. Don't restate the full answer.\nQuestion: ${q.slice(0, 160)}\nMy answer: ${typed.slice(0, 260)}`, passage: a.slice(0, 1500), before: "", after: "", note: "", title: note(state.markers.get(id)?.noteId)?.title || "", course: "", thread: [] });
    verdict = r.markdown.replace(/[#*_`>]/g, "").trim().slice(0, 320);
  } catch (e) { verdict = (e as Error).message; }
  if (!R || R.queue[R.i] !== id || !R.revealed) return;
  R.checking = false;
  R.ai = verdict;
  showRecall();
}
async function grade(m: Marker, good: boolean) {
  if (!R) return;
  await gradeMarker(m, good);
  if (good) R.got++; else R.missed.push(m.id);
  R.i++;
  R.revealed = false;
  R.typed = "";
  R.ai = null;
  R.checking = false;
  if (R.i >= R.queue.length) {
    R.done = true;
    if (!doneToday()) await putMeta({ studyDays: [...state.meta.studyDays, dayKey(Date.now())] });
  }
  showRecall();
}
function showDone() {
  const el = $("#info")!;
  setHc("var(--g1)", el);
  const cols = ["--g1", "--g2", "--g3", "--g4", "--g5", "--g6", "--g7"], s = streak();
  const shaky = [...new Set(R!.missed)].map(id => state.markers.get(id)).filter((m): m is Marker => !!m).slice(0, 2);
  el.innerHTML = `<div class="infoin"><div class="burst" aria-hidden="true">${[...Array(22)].map((_, i) => { const a = (i / 22) * Math.PI * 2, r = 70 + (i % 4) * 22; return `<i style="background:var(${cols[i % 7]});--x:${Math.cos(a) * r}px;--y:${Math.sin(a) * r}px;--d:${(i % 5) * 40}ms"></i>`; }).join("")}</div>
    <span class="pill" style="background:var(--g1)">${R!.cram ? "Cram done" : "Recall done"}</span><div class="donebig">${s} day${s === 1 ? "" : "s"}</div>
    <div class="rsrc">${R!.got} of ${R!.queue.length} right · streak kept</div>
    ${shaky.length ? `<div class="shaky"><small>Still shaky · back in 10 minutes</small>${shaky.map(m => `<button data-shaky="${m.id}">${esc((m.recallQ || m.text || "A marker").slice(0, 46))}</button>`).join("")}</div>` : ""}
    <button class="openlink" id="doneBtn">Back to notes</button></div>`;
  $("#doneBtn")!.onclick = endRecall;
  $("#doneBtn")!.focus({ preventScroll: true });
  el.querySelectorAll<HTMLButtonElement>("[data-shaky]").forEach(b => b.onclick = () => {
    const m = state.markers.get(b.dataset.shaky!);
    if (!m) return;
    setPendingOpen(m.id);
    handlers?.openNote(m.noteId);
  });
  setProg();
  paint();
  renderMorning();
}
function endRecall() {
  if (!R) return;
  R = null;
  const d = $("#dial");
  if (d && handlers) { d.classList.remove("recall"); renderHome($("#stage")!, handlers, true); }
}

/* ---------- global listeners (installed once) ---------- */
let installed = false;
export function installHomeListeners() {
  if (installed) return;
  installed = true;
  addEventListener("resize", () => { if (alive && $("#dial")) { sizeDial(); lastDrawn = null; } });
  document.addEventListener("pointerdown", e => { if (pop && !(e.target as Element).closest(".lbwrap")) closePop(); });
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape" || !alive) return;
    if (pop) { closePop(); return; }
    if (R) endRecall();
  });
  // Recall by keyboard: Space or Enter shows the answer, then 1 = Again, 2 = Got it.
  document.addEventListener("keydown", e => {
    if (!alive || !R || R.done || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, [contenteditable='true'], .sheetwrap, .searchwrap")) return;
    if (!R.revealed) { if ((e.key === " " || e.key === "Enter") && t.tagName !== "BUTTON") { e.preventDefault(); reveal(); } return; }
    if (e.key === "1" || e.key === "2") { e.preventDefault(); document.querySelector<HTMLButtonElement>(e.key === "1" ? ".racts .again" : ".racts .got")?.click(); }
  });
}
export const homeAlive = () => alive;
export const inRecall = () => !!R;
