import { courseColor, courseName, liveMarkers } from "../store";
import type { Note } from "../types";
import { isDue, recallable } from "../study";
import { $, agoLong, esc, reducedMotion } from "../util";

/* The shelf: everything inside one time folder. The dial only ever shows a folder's newest few notes, so a folder
   holding dozens or hundreds opens here instead: one searchable wall of notes, newest first, with a course filter.
   Cards get smaller as the count grows, and only the first screenfuls are drawn until you ask for more. */

const PAGE = 120;
let escHandler: ((e: KeyboardEvent) => void) | null = null;

export const shelfOpen = () => !!$("#shelf");

export function openShelf(opts: { title: string; color: string; ink: string; notes: Note[]; from: HTMLElement | null; openNote: (id: string) => void }) {
  closeShelf(true);
  const notes = [...opts.notes].sort((a, b) => b.openedAt - a.openedAt);
  const marks = new Map<string, { n: number; due: boolean }>();
  for (const m of liveMarkers()) {
    const r = marks.get(m.noteId) || { n: 0, due: false };
    r.n++; if (isDue(m) && recallable(m)) r.due = true;
    marks.set(m.noteId, r);
  }
  const byCourse = new Map<string, number>();
  notes.forEach(n => byCourse.set(n.courseId, (byCourse.get(n.courseId) || 0) + 1));
  const courses = [...byCourse].sort((a, b) => b[1] - a[1]);
  const density = notes.length > 150 ? "dense" : notes.length > 48 ? "snug" : "roomy";

  const el = document.createElement("div");
  el.id = "shelf";
  el.className = `shelf ${density}`;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", `${opts.title}: all notes`);
  el.style.top = ($(".top")?.getBoundingClientRect().bottom ?? 0) + "px";
  el.style.setProperty("--fc", opts.color);
  el.style.setProperty("--ft", opts.ink);
  el.innerHTML = `<header class="shelfhead"><span class="shelftab">${esc(opts.title)}</span>
      <div class="shelfttl"><h2><b id="shelfN">${notes.length}</b> note${notes.length === 1 ? "" : "s"}</h2></div>
      <label class="shelfsearch"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><input id="shelfQ" type="search" placeholder="Find a note in ${esc(opts.title.toLowerCase())}…" autocomplete="off" aria-label="Find a note"></label>
      <button class="mapclose" id="shelfClose" aria-label="Close">Close<kbd>Esc</kbd></button></header>
    ${courses.length > 1 ? `<div class="shelfchips" role="group" aria-label="Filter by course"><button data-c="" aria-pressed="true">All</button>${courses.slice(0, 12).map(([c, k]) => `<button data-c="${esc(c)}" aria-pressed="false" style="--c:${courseColor(c)}"><i></i>${esc(courseName(c))}<small>${k}</small></button>`).join("")}</div>` : ""}
    <div class="shelfgrid" id="shelfGrid"></div>`;
  document.body.appendChild(el);

  const grid = $("#shelfGrid", el)!, q = $("#shelfQ", el) as HTMLInputElement;
  let course = "", shown = PAGE;
  const draw = () => {
    const term = q.value.trim().toLowerCase();
    const hit = notes.filter(n => (!course || n.courseId === course) && (!term || n.title.toLowerCase().includes(term) || courseName(n.courseId).toLowerCase().includes(term)));
    $("#shelfN", el)!.textContent = String(hit.length);
    grid.innerHTML = hit.length ? hit.slice(0, shown).map((n, i) => {
      const mk = marks.get(n.id);
      return `<button class="snote" data-n="${n.id}" style="--c:${courseColor(n.courseId)};--i:${Math.min(i, 30)}"><span class="sc"><i></i>${esc(courseName(n.courseId))}</span><b>${esc(n.title || "Untitled")}</b><span class="sm">${agoLong(n.openedAt)}${mk ? ` · ${mk.n} marker${mk.n === 1 ? "" : "s"}` : ""}</span>${mk?.due ? '<span class="sdue" title="Has markers due for recall"></span>' : ""}</button>`;
    }).join("") + (hit.length > shown ? `<button class="smore" id="shelfMore">Show ${Math.min(PAGE, hit.length - shown)} more <small>${hit.length - shown} left</small></button>` : "")
      : `<p class="shelfempty">Nothing here matches${term ? ` “${esc(q.value.trim())}”` : ""}.</p>`;
    const more = $("#shelfMore", el);
    if (more) more.onclick = () => { shown += PAGE; draw(); };
  };
  draw();
  q.oninput = () => { shown = PAGE; draw(); };
  el.querySelectorAll<HTMLButtonElement>(".shelfchips button").forEach(b => b.onclick = () => {
    course = b.dataset.c || ""; shown = PAGE;
    el.querySelectorAll(".shelfchips button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    draw();
  });
  grid.addEventListener("click", e => {
    const b = (e.target as Element).closest<HTMLElement>(".snote");
    if (!b) return;
    closeShelf(true);
    opts.openNote(b.dataset.n!);
  });
  $("#shelfClose", el)!.onclick = () => closeShelf();
  escHandler = e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeShelf(); } };
  document.addEventListener("keydown", escHandler, true);
  if (matchMedia("(hover: hover)").matches) q.focus({ preventScroll: true }); // no keyboard popping up on touch

  // unfold out of the folder it came from
  const fr = opts.from?.getBoundingClientRect(), vr = el.getBoundingClientRect();
  if (fr && fr.width > 20 && !reducedMotion() && el.animate) {
    const s = Math.max(0.12, fr.width / vr.width);
    const dx = fr.left + fr.width / 2 - (vr.left + vr.width / 2), dy = fr.top + fr.height / 2 - (vr.top + vr.height / 2);
    el.dataset.from = `${dx.toFixed(0)},${dy.toFixed(0)},${s.toFixed(3)}`;
    el.animate([{ opacity: 0, transform: `perspective(1600px) translate(${dx}px, ${dy}px) scale(${s}) rotateX(-18deg)` }, { opacity: 1, offset: 0.4 }, { opacity: 1, transform: "perspective(1600px) translate(0, 0) scale(1) rotateX(0deg)" }],
      { duration: 460, easing: "cubic-bezier(.2, .8, .2, 1)" });
  }
}

export function closeShelf(now = false) {
  const el = $("#shelf");
  if (escHandler) { document.removeEventListener("keydown", escHandler, true); escHandler = null; }
  if (!el) return;
  const from = el.dataset.from?.split(",").map(Number);
  if (now || !from || reducedMotion() || !el.animate) { el.remove(); return; }
  el.id = "shelfClosing"; // a new shelf can open while this one folds away
  const done = () => el.remove();
  el.animate([{ opacity: 1, transform: "perspective(1600px) translate(0, 0) scale(1) rotateX(0deg)" }, { opacity: 0, transform: `perspective(1600px) translate(${from[0]}px, ${from[1]}px) scale(${from[2]}) rotateX(-12deg)` }],
    { duration: 260, easing: "cubic-bezier(.5, 0, .8, .4)", fill: "forwards" }).finished.then(done, done);
}
