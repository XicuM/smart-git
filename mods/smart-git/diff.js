// The diff pane (lazygit's main panel): shows what the sidebar selected, unified or side by side.
// On a file it stages, unstages or discards single lines and hunks; on a commit it moves lines
// out of it; on a conflicted file it picks a side, conflict by conflict.
import { div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { shared, theme, settings, run, setShared, exec, panes, focused } from "herdr";
import { ask, askFrom, keyOf } from "./ask.js";
import { perf, git, writeThere, rebaseWith, openEditor, diffRows, splitRows, partialPatch, parseConflicts, logRows, LOG_GRAPH, untab } from "./git.js";

const ROW = 20, CHAR = 7.3;
const BANDS = ["s", "f", "@", "g", "h", "<", "|", "=", ">"];
const isChange = (r) => r?.kind === "+" || r?.kind === "-";
// Selections shown as a commit graph rather than a diff.
const LOGS = ["branch", "remote", "status"];

// Cuts a line into pieces of at most n characters, at a space when one is near the end.
function wrapText(text, n) {
  if (n <= 0 || text.length <= n) return [text];
  const out = [];
  let rest = text;
  while (rest.length > n) {
    let cut = rest.lastIndexOf(" ", n - 1);
    cut = cut < n * 0.6 ? n : cut + 1;
    out.push(rest.slice(0, cut)); rest = rest.slice(cut);
  }
  out.push(rest);
  return out;
}

// A graph label's parts (the name, then the remotes level with it) and their widths at 11px mono.
const labelParts = (ref) => [(ref.tone === "head" && ref.view ? "✓ " : "") + ref.name, ...(ref.remotes ?? [])]
  .map((text) => ({ text, w: Math.ceil(8 + text.length * 6.6) }));
// The label at x in a graph row: after the hash (10 + 8 chars), the graph, and a gap of 8 each.
function labelAt(r, x, graphW) {
  let left = 10 + CHAR * 8 + 8 + graphW + 8;
  for (const ref of r.refs) {
    const w = labelParts(ref).reduce((n, p) => n + p.w, 2);
    if (x >= left && x < left + w) return ref;
    left += w + 8;
  }
  return null;
}

// The git commands that show each kind of selection, as labelled sections.
function sources(s, o) {
  // a/ and b/ whatever the user's config (diff.mnemonicPrefix, diff.noprefix): rows parse paths.
  const flags = ["--no-color", "--src-prefix=a/", "--dst-prefix=b/", `--submodule=${o.sub}`, `-U${o.context}`, ...(o.ws ? ["-w"] : [])];
  if (s.kind === "file") {
    const out = [], path = ["--", s.path];
    if (s.unstaged) out.push(["Unstaged changes", s.untracked ? ["diff", "--no-index", ...flags, "--", "/dev/null", s.path] : ["diff", ...flags, ...path]]);
    for (const p of s.news ?? []) out.push(["Untracked files", ["diff", "--no-index", ...flags, "--", "/dev/null", p]]);
    if (s.staged) out.push(["Staged changes", ["diff", "--cached", ...flags, ...path]]);
    return out;
  }
  // A meta line (hash, refs, author, when, parents) the pane draws as one row, then the message.
  if (s.kind === "commit") return [[null, ["show", ...flags, "--decorate=full", "--format=meta %h%x1f%D%x1f%an%x1f%ar%x1f%p%n%w(0,4,4)%B", s.hash]]];
  if (s.kind === "range") return [[null, ["diff", ...flags, s.from, s.to]]];
  if (s.kind === "stash") return [[null, ["stash", "show", "-p", ...flags, "--include-untracked", s.ref]]];
  // Children before parents, as the lanes need; a stash's index commit isn't history.
  const log = ["log", "--date-order", "--no-color", "--decorate=full", `--format=${LOG_GRAPH}`, "-n", "300"];
  if (s.kind === "branch") return [[null, [...log, s.name, "--"]]];
  if (s.kind === "remote") return [[null, [...log, `--remotes=${s.name}`]]];
  return [[null, [...log, "--exclude=refs/stash", "--all"]]];
}

// A file's conflicts as rows: the plain lines, and each conflict's markers and sides (`c` its number).
function conflictRows(parts) {
  const rows = [];
  let line = 1, c = 0;
  for (const p of parts) {
    if (Array.isArray(p)) { for (const text of p) rows.push({ kind: " ", new: line++, text }); continue; }
    rows.push({ kind: "<", text: p.head, c, new: line++ });
    for (const text of p.ours) rows.push({ kind: "o", side: "ours", text, c, new: line++ });
    if (p.base) { rows.push({ kind: "|", text: p.mid, c, new: line++ }); for (const text of p.base) rows.push({ kind: "b", side: "base", text, c, new: line++ }); }
    rows.push({ kind: "=", text: "=======", c, new: line++ });
    for (const text of p.theirs) rows.push({ kind: "t", side: "theirs", text, c, new: line++ });
    rows.push({ kind: ">", text: p.tail, c, new: line++ });
    c++;
  }
  return rows;
}
const conflictText = (parts) => parts.flatMap((p) => Array.isArray(p) ? p
  : [p.head, ...p.ours, ...(p.base ? [p.mid, ...p.base] : []), "=======", ...p.theirs, p.tail]).join("\n");

export class Diff {
  constructor(view, cx) {
    this.view = view; this.rows = []; this.texts = []; this.width = 600;
    this.layout = shared("smart-git:layout") ?? "auto"; this.wrap = shared("smart-git:wrap") ?? true;
    this.ws = shared("smart-git:ws") ?? false; this.context = shared("smart-git:context") ?? 3; this.full = shared("smart-git:full") ?? false; this.sub = shared("smart-git:sub") ?? "log";
    this.cur = -1; this.anchor = null; this.hunk = false; this.ci = 0; this.side = "ours"; this.undo = [];
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    // The file panel and pinned bar follow the file at the top of the list; scrolling doesn't
    // redraw this view, so look for a new one now and then.
    this.paneW = 600; this.top = 0; this.stat = null; this.panelW = shared("smart-git:panelW") ?? 240;
    cx.timer.every(100, (cx) => {
      if (!this.stat) return;
      this.top = Math.floor(this.scroll.offset().y / ROW);
      if (this.fileAt() !== this.spied) cx.notify();
    });
  }

  // The file (index in stat.files) at the top of the list, or null above the first one.
  fileAt() {
    const v = this.visual()[this.top];
    return v ? this.rows[v.i ?? v.left?.i ?? v.right?.i]?.fi ?? null : null;
  }

  // A file picked in the panel: its header at the top, the cursor on its first change.
  toFile(n) {
    const f = this.stat?.files[n];
    if (!f) return;
    const c = this.rows.findIndex((x, j) => j > f.i && (isChange(x) || x.kind === "f"));
    if (isChange(this.rows[c])) { this.cur = c; this.hunk = false; this.anchor = null; }
    // The list only scrolls the least it can ("near edge"): a header above the view goes to the
    // top by itself; for one below, the row a screen under it goes to the bottom edge instead.
    const vis = this.visual(), at = vis.findIndex((x) => (x.left ?? x).i === f.i);
    if (at < 0) return;
    const top = Math.floor(this.scroll.offset().y / ROW), screen = Math.max(1, Math.floor(this.scroll.viewport_size().height / ROW));
    this.scroll.scroll_to_item(at > top ? Math.min(at + screen - 1, vis.length - 1) : at);
    this.top = at;
  }

  // What the sidebar selected; reloads when it (or how it's shown) changes. Render calls this.
  sync(cx) {
    const s = shared("smart-git:show");
    const key = JSON.stringify([s, this.ws, this.context, this.sub, this.full]);
    if (!s || key === this.loaded) return;
    // The same thing again (changed on disk, or a line staged): keep the place.
    const same = s.kind === this.shown?.kind && s.title === this.shown?.title;
    if (!same) this.open = new Set();
    // An action's failure survives the reload it triggers; any other reload clears the old message.
    this.loaded = key; this.shown = s; this.title = s.title; this.error = this.failed ?? null; this.failed = null; this.pending = true;
    cx.spawn(async (cx) => {
      const tLoad = Date.now(); // PERF
      const rows = [], texts = [], files = new Map();
      let conflict = null, truncated = 0;
      // A file's lines on the new side of a section, for the gaps that were opened.
      const newSide = async (label, path) => {
        const spec = label === "Unstaged changes" ? "" : label === "Staged changes" ? `:${path}` : s.kind === "commit" ? `${s.hash}:${path}`
          : s.kind === "range" ? `${s.to}:${path}` : s.kind === "stash" ? `${s.ref}:${path}` : null;
        if (spec === null) return null;
        const text = spec ? await git(s.repo, ["show", spec]) : (await exec("cat", ["--", path], { cwd: s.repo.root, on: s.repo.on })).stdout;
        return text.split("\n");
      };
      try {
        if (s.kind === "conflict" && s.none) conflict = [[]];
        else if (s.kind === "conflict") {
          const r = await exec("cat", ["--", s.path], { cwd: s.repo.root, on: s.repo.on });
          if (r.code !== 0) throw new Error(r.stderr.trim());
          conflict = parseConflicts(r.stdout);
          rows.push(...conflictRows(conflict));
        } else for (const [label, args] of sources(s, this)) {
          const text = await git(s.repo, args);
          // A newer selection came while git ran: leave its rows unparsed.
          if (this.loaded !== key) return;
          if (label && !text.trim()) continue;
          if (label && label !== texts[texts.length - 1]?.label) rows.push({ kind: "s", text: label });
          const src = texts.push({ label, text }) - 1;
          if (LOGS.includes(s.kind)) { rows.push(...logRows(text)); continue; }
          const d = diffRows(text, this.context);
          truncated = Math.max(truncated, d.truncated ?? 0);
          for (const r of d) {
            const gap = r.kind === "g" ? `${label}|${r.path}|${r.from}` : null;
            // Whole file (f) opens every gap; a click flips one from how f has it.
            if (gap && this.full !== this.open.has(gap)) {
              const k = `${label}|${r.path}`;
              if (!files.has(k)) files.set(k, await newSide(label, r.path).catch(() => null));
              const lines = files.get(k);
              if (lines) {
                const to = r.to ?? lines.length - (lines.at(-1) === "" ? 1 : 0), n = to - r.from + 1;
                if (n <= 0) continue;
                // The bar stays where it was clicked, now to fold them away again.
                rows.push({ ...r, src, gap, text: `⌃ hide ${n} unchanged line${n > 1 ? "s" : ""}` });
                for (let i = r.from; i <= to; i++) rows.push({ kind: " ", old: r.old + i - r.from, new: i, text: untab(lines[i - 1] ?? "") || " ", src });
                continue;
              }
            }
            rows.push({ ...r, src, gap });
          }
        }
      } catch (e) { if (this.loaded === key) this.error = String(e.message ?? e); }
      if (this.loaded !== key) return;
      this.truncated = truncated; this.pending = false;
      // What a commit, stash or range changes, file by file (lazygit's --stat), for the file panel
      // and the pinned bar. Every row after a file's header knows that file (`fi`).
      let stat = null;
      if (["commit", "stash", "range"].includes(s.kind)) {
        const files = [];
        for (const r of rows) {
          if (r.kind === "f") {
            const n = r.notes ?? [], has = (w) => n.some((x) => x.startsWith(w));
            r.add = r.del = 0; r.name = r.path ?? r.text.replace(/^Submodule (\S+).*/, "$1");
            r.status = has("new file") ? "A" : has("deleted") ? "D" : has("renamed") ? "R" : has("copied") ? "C" : "M";
            files.push(r);
          }
          const f = files.at(-1);
          if (!f) continue;
          r.fi = files.length - 1;
          if (r.kind === "+") f.add++; else if (r.kind === "-") f.del++;
        }
        if (files.length) stat = { files, add: files.reduce((n, f) => n + f.add, 0), del: files.reduce((n, f) => n + f.del, 0), partial: truncated > 0 };
      }
      // A commit's header: the meta line, then the message unindented, its subject bold and its
      // trailers dim, one blank line before the first file.
      if (s.kind === "commit" && rows[0]?.text.startsWith("meta ")) {
        const [short, refs, author, when, parents = ""] = rows[0].text.slice(5).split("\x1f");
        rows[0].meta = { short, author, when, merge: parents.trim().includes(" "), refs: refs ? refs.split(", ") : [] };
        rows[0].text = "";
        let end = rows.findIndex((r) => r.kind !== "h");
        if (end < 0) end = rows.length;
        for (const r of rows.slice(1, end)) { r.text = r.text.replace(/^ {4}/, ""); r.trailer = /^([\w-]+-by|Change-Id): /i.test(r.text); }
        const subject = rows.slice(1, end).find((r) => r.text.trim());
        if (subject) subject.title = true;
        while (end > 2 && !rows[end - 1].text.trim() && !rows[end - 2].text.trim()) rows.splice(--end, 1);
      }
      // Rows added above (a gap opened) keep the cursor on its line while the section is the same.
      const at = this.rows[this.cur], was = at?.kind === "L" ? at.hash : null;
      if (same && at?.raw !== undefined && texts[at.src]?.text === this.texts[at.src]?.text) {
        const n = rows.findIndex((r) => r.src === at.src && r.raw === at.raw);
        const a = this.anchor !== null ? rows.findIndex((r) => r.src === at.src && r.raw === this.rows[this.anchor]?.raw) : -1;
        if (n >= 0) { this.cur = n; this.anchor = a >= 0 ? a : null; }
      }
      rows.forEach((r, i) => { r.i = i; });
      this.rows = rows; this.texts = texts; this.stat = stat; this.conflict = conflict; this.pairs = null; this.vis = null;
      this.longest = rows.reduce((n, r) => Math.max(n, r.text.length), 0);
      if (!same) { this.top = 0; this.drop = false; this.cur = -1; this.anchor = null; this.hunk = false; this.ci = 0; this.side = "ours"; this.undo = []; this.scroll.scroll_to_item(0); }
      if (conflict) {
        const cs = conflict.filter((p) => !Array.isArray(p));
        this.ci = Math.min(this.ci, Math.max(0, cs.length - 1));
        if (this.side === "base" && !cs[this.ci]?.base) this.side = "ours";
      }
      // A graph's cursor stays on its commit, or on none.
      else if (LOGS.includes(s.kind)) this.cur = same && was ? rows.findIndex((r) => r.hash === was) : -1;
      // The cursor stays on a changed line: the nearest one at or after where it was.
      else if (!isChange(rows[this.cur])) {
        const n = rows.findIndex((r, i) => i >= Math.max(0, this.cur) && isChange(r));
        let last = rows.length - 1;
        while (last >= 0 && !isChange(rows[last])) last--;
        this.cur = n >= 0 ? n : last;
        this.anchor = null;
      }
      perf(`diff load ${s.kind}`, tLoad); // PERF
      cx.notify();
    });
  }

  // The rows the next action takes: the cursor's hunk, the range from the anchor, or its line;
  // only changed lines, in the cursor's section.
  selected() {
    const rows = this.rows, c = this.cur;
    if (!isChange(rows[c])) return [];
    let a = c, b = c;
    if (this.hunk) {
      while (a > 0 && !["@", "f", "s"].includes(rows[a - 1].kind)) a--;
      while (b < rows.length - 1 && !["@", "f", "s"].includes(rows[b + 1].kind)) b++;
    } else if (this.anchor !== null) { a = Math.min(this.anchor, c); b = Math.max(this.anchor, c); }
    return rows.slice(a, b + 1).filter((r) => isChange(r) && r.src === rows[c].src);
  }

  // Moves the cursor to the next changed line that way (the next hunk's, selecting hunks).
  step(dir) {
    if (this.hunk) return this.jump("@", dir);
    const rows = this.rows;
    for (let i = this.cur + dir; i >= 0 && i < rows.length; i += dir) if (isChange(rows[i]) || rows[i].kind === "L") { this.cur = i; break; }
    this.reveal(this.cur);
  }

  // Moves the cursor to the first changed line of the next hunk ("@") or file ("f") that way.
  jump(kind, dir) {
    const rows = this.rows;
    let i = Math.min(this.cur, rows.length - 1);
    while (i >= 0 && rows[i].kind !== kind) i--;
    do i += dir; while (i >= 0 && i < rows.length && rows[i].kind !== kind);
    if (i < 0 || i >= rows.length) return;
    const n = rows.findIndex((r, j) => j > i && isChange(r));
    if (n >= 0) { this.cur = n; this.reveal(n); }
  }

  reveal(index) {
    const n = this.visual().findIndex((r) => r.i === index || r.left?.i === index || r.right?.i === index);
    if (n >= 0) this.scroll.scroll_to_item(n);
  }

  // Runs one change, shows what failed, and has every view reload.
  act(work, cx) {
    if (this.busy) return;
    this.busy = true; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      askFrom(cx, this.handle);
      try { await work(cx); }
      catch (e) { this.error = this.failed = String(e.message ?? e); }
      finally { this.busy = false; this.loaded = null; setShared("smart-git:bump", Date.now()); cx.notify(); }
    });
  }

  // A patch of the selected lines and the section they're in.
  patch(reverse) {
    const sel = this.selected();
    if (!sel.length) throw new Error("No changed line selected (j/k moves, v selects a range, a a hunk)");
    if (this.ws) throw new Error("Lines can't be picked while whitespace is ignored (ctrl-w)");
    if (this.sub === "diff") throw new Error("Lines can't be picked while submodules show their diff (S)");
    const src = this.texts[sel[0].src], raws = new Set(sel.map((r) => r.raw));
    return { text: partialPatch(src.text, (i) => raws.has(i), reverse), label: src.label, count: sel.length };
  }

  async apply(repo, text, args) {
    const file = `${(await git(repo, ["rev-parse", "--absolute-git-dir"])).trim()}/smart-git.patch`;
    const w = await writeThere(repo, file, text);
    if (w.code !== 0) throw new Error(w.stderr.trim());
    await git(repo, ["apply", "--recount", ...args, file], { write: true });
  }

  // Stages the selected unstaged lines, or unstages the selected staged ones.
  stageLines(cx) {
    const s = this.shown;
    this.act(async () => {
      const staged = this.texts[this.rows[this.cur]?.src]?.label === "Staged changes";
      if (!staged && s.untracked) {
        // Git can only take part of a file it knows: mark it intended, then lines can be picked.
        await git(s.repo, ["add", "--intent-to-add", "--", s.path], { write: true });
        this.failed = "The file is tracked now: pick its lines again";
        return;
      }
      const p = this.patch(staged);
      await this.apply(s.repo, p.text, staged ? ["--cached", "-R"] : ["--cached"]);
      this.anchor = null;
    }, cx);
  }

  discardLines(cx) {
    const s = this.shown;
    this.act(async () => {
      if (this.texts[this.rows[this.cur]?.src]?.label !== "Unstaged changes" || s.untracked) throw new Error("Only unstaged lines of a tracked file can be discarded here (d in the files list discards whole files)");
      const p = this.patch(true);
      if (!await ask({ title: `Discard ${p.count} line${p.count > 1 ? "s" : ""}?`, detail: s.path, items: [{ key: "enter", label: "Discard", value: true, danger: true }] })) return;
      await this.apply(s.repo, p.text, ["-R"]);
      this.anchor = null;
    }, cx);
  }

  // Lazygit's custom patch: the selected lines of a commit, moved out of it.
  commitPatch(cx) {
    const s = this.shown;
    this.act(async (cx) => {
      const p = this.patch(true), short = s.hash.slice(0, 7);
      const r = await ask({ title: `${p.count} line${p.count > 1 ? "s" : ""} of ${short}`, items: [
        { key: "d", label: "Remove them from the commit", value: "remove", danger: true },
        { key: "n", label: "Move them into a new commit after it", value: "new" },
        { key: "i", label: "Move them out to the working tree (staged)", value: "index" },
        { key: "c", label: "Copy them as a patch", value: "copy" },
      ] });
      if (!r) return;
      if (r === "copy") return cx.write_to_clipboard(this.patch(false).text);
      let msg = null;
      if (r === "new") {
        msg = await ask({ title: "New commit", input: { value: `${s.title.slice(8)} (split)` } });
        if (!msg?.text.trim()) return;
      }
      // Stop at the commit (any work stashed), take the lines out, amend, and go on.
      await rebaseWith(s.repo, s.hash, (t) => { t[0].action = "edit"; });
      await this.apply(s.repo, p.text, ["-R", "--index"]);
      await git(s.repo, ["commit", "--amend", "--no-edit", "--allow-empty", "--no-verify"], { write: true });
      if (msg) {
        await this.apply(s.repo, p.text, ["--index"]);
        await git(s.repo, ["commit", "--no-verify", "-m", msg.text.trim()], { write: true });
      }
      await git(s.repo, ["rebase", "--continue"], { write: true, timeout: 120000 });
      if (r === "index") await this.apply(s.repo, p.text, ["--index"]).catch(() => this.apply(s.repo, p.text, []));
    }, cx);
  }

  // Picks a side of the selected conflict ("ours", "theirs", "both") and writes the file.
  resolve(how, cx) {
    const s = this.shown, parts = this.conflict;
    const conflicts = parts?.filter((p) => !Array.isArray(p)) ?? [], c = conflicts[this.ci];
    if (!c) return;
    this.act(async () => {
      this.undo.push(conflictText(parts));
      parts[parts.indexOf(c)] = how === "both" ? [...c.ours, ...c.theirs] : c[how];
      const w = await writeThere(s.repo, s.path, conflictText(parts));
      if (w.code !== 0) throw new Error(w.stderr.trim());
      // The last one picked: staged, as lazygit does.
      if (conflicts.length > 1) return;
      await git(s.repo, ["add", "--", s.path], { write: true });
    }, cx);
  }

  undoResolve(cx) {
    const s = this.shown, text = this.undo.pop();
    if (text === undefined) return;
    this.act(async () => { const w = await writeThere(s.repo, s.path, text); if (w.code !== 0) throw new Error(w.stderr.trim()); }, cx);
  }

  // A graph row (or one of its labels) acted on with the sidebar's keys for that list ("menu": its
  // right-click menu). The sidebar holds the key tables; the shared value says what was picked.
  pick(view, id, key) {
    const r = this.rows.find((x) => x.hash === id), commit = r && { hash: r.hash, short: r.short, subject: r.subject };
    setShared("smart-git:pick", { root: this.shown?.repo?.root, view, id, key, commit, n: Date.now() });
    run("smart-git.pick");
  }

  key(k, cx) {
    const s = this.shown ?? {}, cs = this.conflict?.filter((p) => !Array.isArray(p)) ?? [], conflicts = cs.length;
    const toConflict = (n) => {
      this.ci = Math.max(0, Math.min(n, conflicts - 1)); sideBy(0);
      const first = this.rows.findIndex((r) => r.c === this.ci);
      if (first >= 0) this.reveal(first);
    };
    // ours, base (when the file has diff3 markers), theirs: h/l step through the selected conflict's.
    const sideBy = (d) => {
      const sides = cs[this.ci]?.base ? ["ours", "base", "theirs"] : ["ours", "theirs"];
      this.side = sides[Math.max(0, Math.min(sides.length - 1, sides.indexOf(this.side) + d))];
    };
    // A labelled key ([label, fn]) is also in the ? list; a bare fn is an alias.
    const keys = this.conflict ? {
      // As lazygit and the diff's own h/l (hunk) and j/k (line): across conflicts, then down the stacked sides.
      h: ["Previous conflict", () => toConflict(this.ci - 1)], left: () => toConflict(this.ci - 1), l: ["Next conflict", () => toConflict(this.ci + 1)], right: () => toConflict(this.ci + 1),
      k: ["Side above (ours, base)", () => sideBy(-1)], up: () => sideBy(-1), j: ["Side below (base, theirs)", () => sideBy(1)], down: () => sideBy(1),
      space: ["Resolve with the picked side", () => this.resolve(this.side, cx)], enter: () => this.resolve(this.side, cx), b: ["Keep both", () => this.resolve("both", cx)], z: ["Undo resolve", () => this.undoResolve(cx)],
      e: ["Edit file at this conflict", () => this.editAt(cx)],
    } : {
      j: ["Next line", () => this.step(1)], down: () => this.step(1), k: ["Previous line", () => this.step(-1)], up: () => this.step(-1),
      g: ["First line", () => { this.cur = -1; this.step(1); }], G: ["Last line", () => { this.cur = this.rows.length; this.step(-1); }],
      v: ["Select lines", () => { this.anchor = this.anchor === null ? this.cur : null; this.hunk = false; }],
      a: ["Hunk mode", () => { this.hunk = !this.hunk; this.anchor = null; }],
      ...(s.kind === "file" ? { space: ["Stage lines", () => this.stageLines(cx)], d: ["Discard lines", () => this.discardLines(cx)], e: ["Edit file here", () => this.editAt(cx)] } : {}),
      ...(s.kind === "commit" ? { space: ["Move lines out of the commit", () => this.commitPatch(cx)] } : {}),
      // Lazygit's hunk keys; files have none there, so J/K (its keys to scroll this panel).
      h: ["Previous hunk", () => this.jump("@", -1)], left: () => this.jump("@", -1), l: ["Next hunk", () => this.jump("@", 1)], right: () => this.jump("@", 1),
      K: ["Previous file", () => this.jump("f", -1)], J: ["Next file", () => this.jump("f", 1)],
    };
    const common = {
      s: ["Change layout", () => this.setLayout({ auto: "split", split: "unified", unified: "auto" }[this.layout])], w: ["Wrap lines", () => this.toggle("wrap")],
      "ctrl-w": ["Ignore whitespace", () => this.toggle("ws")], f: ["Whole file", () => { this.toggle("full"); this.open = new Set(); }],
      S: ["Toggle submodule diff", () => { this.sub = this.sub === "log" ? "diff" : "log"; setShared("smart-git:sub", this.sub); }],
      "{": ["Less context", () => { this.context = Math.max(0, this.context - 1); setShared("smart-git:context", this.context); }],
      "}": ["More context", () => { this.context++; setShared("smart-git:context", this.context); }],
      z: ["Zoom", () => this.zoom()],
      // Side by side, unwrapped: both halves sideways, as lazygit's H/L.
      H: ["Scroll left", () => { this.dx -= 8 * CHAR; }], L: ["Scroll right", () => { this.dx += 8 * CHAR; }],
      escape: () => { if (this.drop) this.drop = false; else if (this.anchor !== null || this.hunk) { this.anchor = null; this.hunk = false; } else this.back(); },
      q: ["Back", () => this.back()],
      // 1–5 jump to that sidebar section, as from the sidebar; the diff stays zoomed.
      ...Object.fromEntries(["Status", "Files", "Branches", "Commits", "Stash"].map((name, n) => [String(n + 1), [`Sidebar: ${name}`, () => run(`smart-git.sidebar:${n + 1}`)]])),
      // The sidebar's ? lists every key; here, the diff's. Picking one runs it.
      "?": () => cx.spawn(async (cx) => {
        askFrom(cx, this.handle);
        const items = [...Object.entries(keys), ...Object.entries(common).filter(([k]) => !(k in keys))].filter(([, a]) => Array.isArray(a)).map(([value, [label]]) => ({ key: "", label: `${value}  ${label}`, value }));
        const k = await ask({ title: "Keys", items });
        if (k) { this.key(k, cx); cx.notify(); }
      }),
    };
    // On a graph, the keys that aren't the pane's own go to the selected commit, as in Commits.
    if (this.isLog()) {
      const own = ["j", "k", "down", "up", "w", "z", "escape", "q", "1", "2", "3", "4", "5"];
      if (!own.includes(k)) { const r = this.rows[this.cur]; if (!r?.hash) return false; this.pick("commits", r.hash, k === "x" || k === "?" ? "menu" : k); return true; }
    }
    const a = keys[k] ?? common[k];
    if (!a) return false;
    (Array.isArray(a) ? a[1] : a)();
    cx.notify();
    return true;
  }

  pane() { return panes().find((p) => p.pane === focused()?.pane && p.mod === "smart-git") ?? panes().find((p) => p.tab === focused()?.tab && p.mod === "smart-git"); }
  // e: the shown file in the editor, at the selected line (a removed line has no number in
  // the file: the next line that does). Opened from here: the sidebar may be hidden in its stack.
  editAt(cx) {
    // On a conflicted file: the selected conflict's first line.
    const s = this.shown, n = this.conflict ? this.rows.find((r) => r.c === this.ci)?.new
      : this.cur >= 0 ? this.rows.slice(this.cur).find((r) => r.new != null)?.new : null;
    if (s.title.endsWith("/")) { this.error = "A folder: pick one of its files to edit it"; return cx.notify(); }
    cx.spawn(async (cx) => {
      try { await openEditor(s.repo, s.path, n ?? null, cx); }
      catch (e) { this.error = String(e.message ?? e); cx.notify(); }
    });
  }
  zoom() { const p = this.pane(); if (p) run("pane.zoom", { pane: p.pane }); }
  // Back to the sidebar, and the layout back as it was.
  // The sidebar focuses itself: pane.go from the (zoomed) diff didn't reach it.
  back() { if (this.pane()?.zoomed) this.zoom(); run("smart-git.sidebar"); }

  isLog() { return LOGS.includes(this.shown?.kind); }
  wrapped() { return this.wrap; }
  // "split", "unified", or "auto": side by side once the pane is as wide as VS Code's breakpoint.
  sideBySide() { return !this.conflict && !this.isLog() && (this.layout === "split" || (this.layout === "auto" && this.width >= 900)); }
  setLayout(layout) { this.layout = layout; setShared("smart-git:layout", layout); this.vis = null; }

  toggle(what) { this[what] = !this[what]; setShared(`smart-git:${what}`, this[what]); this.vis = null; }

  // The rows as drawn: wrapped to the pane's width (each piece its own row, so every row
  // keeps the list's one height), or as they are, for scrolling sideways.
  // The graph column: a lane each, at most 40% of the pane.
  graphW() { return Math.min(12 + (this.rows[0]?.lanes ?? 1) * 12, Math.max(60, this.width * 0.4)); }
  // A graph row's labels, wrapped: the first row keeps room for the subject, author and date
  // columns; the labels that don't fit go on rows below it, the lanes running straight through.
  logPieces(r) {
    const left = 10 + CHAR * 8 + 8 + this.graphW() + 8, wide = (ref) => labelParts(ref).reduce((n, p) => n + p.w, 2) + 8;
    const out = [];
    let refs = [], room = this.width - left - (CHAR * 16 + 8) - (CHAR * 14 + 8) - CHAR * 10 - 10;
    for (const ref of r.refs) {
      if (refs.length && wide(ref) > room) {
        out.push(out.length ? { ...r, refs, cont: true } : { ...r, refs });
        refs = []; room = this.width - left - 10;
      }
      refs.push(ref); room -= wide(ref);
    }
    out.push(out.length ? { ...r, refs, cont: true } : { ...r, refs });
    return out;
  }

  visual() {
    const split = this.sideBySide();
    const pairs = split ? (this.pairs ??= splitRows(this.rows)) : null;
    if (!this.wrapped()) return pairs ?? this.rows;
    const key = `${split}|${Math.round(this.width)}|${this.rows.length}`;
    if (this.vis?.key === key && this.vis.rows0 === this.rows) return this.vis.rows;
    const out = [], full = Math.floor((this.width - 24) / CHAR);
    // A piece after the first keeps its row's kind and place, without its line numbers; `off`
    // is where it starts in the line, for the changed part.
    const pieces = (r, n) => {
      let off = 0;
      return wrapText(r.text, n).map((text, j) => {
        const p = j === 0 ? { ...r, text } : { kind: r.kind, text, i: r.i, c: r.c, side: r.side, gap: r.gap, hl: r.hl, title: r.title, trailer: r.trailer, off };
        off += text.length;
        return p;
      });
    };
    if (!pairs) {
      const n = Math.floor((this.width - 110) / CHAR);
      for (const r of this.rows) {
        if (r.kind === "L") { out.push(...this.logPieces(r)); continue; }
        out.push(...pieces(r, BANDS.includes(r.kind) ? full : n));
      }
    } else {
      const n = Math.floor((Math.floor(this.width / 2) - 56) / CHAR);
      for (const p of pairs) {
        if (p.kind !== "~" && BANDS.includes(p.kind)) { out.push(...pieces(p.left, full).map((r) => ({ kind: r.kind, left: r, right: r }))); continue; }
        const L = p.left ? pieces(p.left, n) : [], R = p.right ? pieces(p.right, n) : [];
        // A side that runs out keeps its color on blank rows; a missing side stays missing.
        const side = (r, parts, j) => !r ? null : parts[j] ?? { kind: r.kind, text: "", i: r.i, c: r.c, side: r.side };
        for (let j = 0; j < Math.max(L.length, R.length, 1); j++) out.push({ kind: p.kind, left: side(p.left, L, j), right: side(p.right, R, j) });
      }
    }
    this.vis = { key, rows0: this.rows, rows: out };
    return out;
  }

  hints() {
    const s = this.shown;
    if (this.conflict) return "h/l conflict · j/k side · space keep it · b both · click a side's name above a conflict · e edit · z undo the last pick · esc back";
    const pick = "j/k line · ←/→ hunk · J/K file · v range · a hunk";
    if (s?.kind === "file") return `${pick} · space stage · d discard · e edit · f full file · z zoom · {/} context · esc back`;
    if (s?.kind === "commit") return `${pick} · space move out of commit · f full file · z zoom · esc back`;
    if (s?.kind === "range" || s?.kind === "stash") return "j/k line · ←/→ hunk · J/K file · s layout · f full file · w wrap · z zoom · {/} context · esc back";
    if (this.isLog()) return "j/k commit · x or right-click menu · Commits' keys act on it · double-click a label checks it out · z zoom · esc back";
    return "s layout · f full file · w wrap · z zoom · {/} context · esc back";
  }

  render(cx) { const t0 = Date.now(), r = this.render2(cx); perf(`diff render (${this.rows.length} rows)`, t0); return r; } // PERF
  render2(cx) { // PERF
    this.sync(cx);
    const t = theme(), mono = settings().font_family ?? "JetBrains Mono", focused = this.handle.is_focused();
    const cs = this.conflict?.filter((p) => !Array.isArray(p)) ?? [];
    const split = this.sideBySide();
    // Wide enough for the longest line, so the pane scrolls sideways instead of cutting it.
    const text = this.wrapped() ? 0 : Math.ceil((this.longest ?? 0) * CHAR);
    // Side by side, both halves and the divider fit the pane exactly, the divider in the middle.
    const half = Math.floor((this.width - 1) / 2);
    const wide = this.wrapped() || split ? this.width : Math.max(this.width, text + 110);
    // Side by side, unwrapped: each half's code scrolls sideways under its fixed line numbers,
    // both halves together (`dx`), as VS Code does.
    const sideways = split && !this.wrap, zoom = Number(settings().zoom) || 1;
    const view = half - 46, content = text + 20, maxDx = sideways ? Math.max(0, content - view) : 0;
    this.dx = Math.max(0, Math.min(this.dx ?? 0, maxDx));
    const track = view - 12, thumb = Math.max(24, track * view / Math.max(content, 1));
    // Shift+wheel may arrive already turned sideways (delta.x), as on Linux.
    const wheel = (ev, cx) => {
      const d = ev.modifiers?.shift ? (ev.delta.y || ev.delta.x) : Math.abs(ev.delta.x) > Math.abs(ev.delta.y) ? ev.delta.x : 0;
      if (!d) return;
      this.dx -= d / zoom; cx.stop_propagation(); cx.notify();
    };
    const bar = (left) => div().absolute().bottom(2).left(left + 46).w(track).h(6)
      .child(div().id(`thumb-${left}`).absolute().top_0().h_full().left(maxDx ? this.dx / maxDx * (track - thumb) : 0).w(thumb).rounded(3)
        .bg(this.drag ? t.muted : t.dim).opacity(0.6).hover((e) => e.opacity(0.9))
        .on_mouse_down("left", (e, cx) => { this.drag = { x: e.position.x, dx: this.dx, k: maxDx / Math.max(1, track - thumb) }; cx.stop_propagation(); cx.notify(); }));
    const rows = this.visual(), picked = new Set(focused ? this.selected().map((r) => r.i) : []);
    // A changed line's own color: faint over the line, strong on what changed in it and its gutter.
    const hue = (r) => r?.kind === "+" ? t.ansi2 : r?.kind === "-" ? t.ansi1 : null;
    const strong = (r) => isChange(r) ? hue(r) + "66" : null;
    const num = (n, r) => div().w(40).flex_none().h_full().text_right().pr(8).text_color(strong(r) ? t.foreground : t.dim).when(Boolean(strong(r)), (e) => e.bg(strong(r)))
      .child(n === undefined ? "" : String(n));
    const bg = (r) => {
      if (picked.has(r.i)) return t.selection;
      if (r.side) return r.c === this.ci && r.side === this.side && focused ? t.selection : r.side === "base" ? t.surface : (r.side === "ours" ? t.ansi2 : t.ansi4) + "22";
      return r.kind === "+" ? t.ansi2 + "22" : r.kind === "-" ? t.ansi1 + "22" : null;
    };
    // Lazygit's colors: lanes cycle, refs by kind (git's own), an author keeps one color.
    const lanes = [t.ansi4, t.ansi5, t.ansi6, t.ansi2, t.ansi3, t.ansi1];
    const refColor = { head: t.ansi6, local: t.ansi2, remote: t.ansi1, tag: t.ansi3, other: t.dim };
    const authorColor = (name) => lanes[[...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % lanes.length];
    // The graph: a lane per branch, each its own color top to bottom, curves where branches fork and
    // merge (one stroked path per color a row). HEAD is a ring, other commits a dot.
    const LANE = 12, graphW = this.graphW();
    const laneX = (n) => 6 + n * LANE + LANE / 2;
    const graph = (r) => {
      const paths = new Map();
      // A wrapped row's continuation: only the lanes leaving the bottom, straight down.
      const segments = r.cont ? r.segments.filter((g) => g[3] === 1).map(([, , b, , c]) => [b, 0, b, 1, c]) : r.segments;
      for (const [a, ya, b, yb, c] of segments) {
        const color = lanes[c % lanes.length];
        let p = (paths.get(color) ?? PathBuilder.stroke(1.5)).move_to(laneX(a), ya * ROW);
        if (a === b) p = p.line_to(laneX(b), yb * ROW);
        else { const mid = (ya + yb) / 2 * ROW; p = p.cubic_bezier_to(laneX(b), yb * ROW, laneX(a), mid, laneX(b), mid); }
        paths.set(color, p);
      }
      const color = lanes[r.lane % lanes.length], dot = div().absolute().left(laneX(r.lane) - 4).top(ROW / 2 - 4).size(8).rounded(4);
      return div().relative().flex_none().w(graphW).h(ROW).overflow_hidden()
        .children([...paths].map(([c, p]) => window.paint_path(p.build(), c).absolute().top(0).left(0).size_full()))
        .when(!r.cont, (e) => e.child(r.head ? dot.bg(t.background).border(2).border_color(color) : dot.bg(color)));
    };
    // A label: the checked out branch filled with a ✓, a local branch with the remotes level with it
    // (`main | origin`). Parts have set widths, so a click's x says which label it hit (labelAt).
    const label = (ref) => {
      const edge = refColor[ref.tone], filled = ref.tone === "head", [main, ...rest] = labelParts(ref);
      return h_flex().flex_none().h(16).rounded(4).border_1().border_color(edge).overflow_hidden().text_size(11).when(filled, (e) => e.bg(edge))
        .child(div().w(main.w).flex_none().px(4).font_semibold().text_color(filled ? t.background : edge).child(main.text))
        .children(rest.map((p) => div().w(p.w).flex_none().px(4).h_full().border_l(1).border_color(edge).bg(filled ? t.background + "33" : edge + "1f")
          .text_color(filled ? t.background : t.muted).child(p.text)));
    };
    // The hash first, in a fixed column, so it lines up however wide the graph is. HEAD's row is
    // tinted with its lane's color; merges are dim.
    const logLine = (r, v) => h_flex().id(`v-${v}`).h(ROW).flex_none().w_full().pr(10).gap(8).items_center().whitespace_nowrap()
      .when(r.head, (e) => e.bg(lanes[r.lane % lanes.length] + "1a")).when(r.i === this.cur, (e) => e.bg(focused ? t.selection : t.hover))
      .child(div().w(CHAR * 8).ml(10).flex_none().text_color(t.ansi3).child(r.cont ? "" : r.short))
      .child(graph(r))
      .children(r.refs.map(label))
      .when(!r.cont, (e) => e
        .child(div().flex_1().min_w(0).truncate().when(r.head, (e) => e.font_semibold()).when(r.parents.length > 1, (e) => e.text_color(t.dim)).child(r.subject))
        .child(div().w(CHAR * 14).flex_none().truncate().text_color(authorColor(r.author)).child(r.author))
        .child(div().w(CHAR * 10).flex_none().text_right().text_color(t.dim).child(r.when.replace(/, \d+ months?/, "").replace(/ ago$/, ""))));
    // A commit's header: labels dim, hash and refs in color, the message in full ink.
    // A ref of the meta line (`git show --decorate=full`), as a graph label.
    const refLabel = (ref) => {
      const [tone, name] = ref.startsWith("HEAD -> ") ? ["head", ref.slice(8)] : ref.startsWith("tag: ") ? ["tag", ref.slice(5)]
        : ref.startsWith("refs/heads/") ? ["local", ref] : ref.startsWith("refs/remotes/") ? ["remote", ref] : ["other", ref];
      return label({ tone, name: name.replace(/^refs\/(heads|remotes|tags)\//, "") });
    };
    // A commit's header: one meta line (hash, refs, author, when), the subject bold, trailers dim.
    const header = (r) => {
      const row = h_flex().px(10).h(ROW).flex_none().items_center().whitespace_nowrap();
      if (r.tone) return row.text_color(r.tone === "+" ? t.ansi2 : t.ansi1).child(r.text);
      const m = r.meta;
      if (m) return row.gap(8).child(div().text_color(t.ansi3).child(m.short)).children(m.refs.map(refLabel))
        .when(m.merge, (e) => e.child(div().text_color(t.dim).child("merge")))
        .child(div().text_color(authorColor(m.author)).child(m.author)).child(div().text_color(t.dim).child(m.when));
      return row.when(Boolean(r.title), (e) => e.font_semibold()).when(Boolean(r.trailer), (e) => e.text_color(t.dim)).child(r.text);
    };
    const band = (r, v) => {
      if (r.kind === "s") return div().px(10).h(ROW).flex_none().bg(t.raised).text_color(t.accent).font_semibold().child(r.text);
      if (r.kind === "f") return h_flex().px(10).gap(10).h(ROW).flex_none().bg(t.raised).whitespace_nowrap()
        .child(div().flex_none().text_color(t.foreground).font_semibold().child(r.text))
        .when(Boolean(r.add || r.del), (e) => e.child(div().flex_none().text_color(t.ansi2).child(r.add ? `+${r.add}` : "")).child(div().flex_none().text_color(t.ansi1).child(r.del ? `−${r.del}` : "")))
        .children((r.notes ?? []).map((n) => div().flex_none().text_color(t.blocked).child(n)));
      // A hunk: the line it starts at and the function it's in (click selects it).
      if (r.kind === "@") return h_flex().px(10).gap(10).h(ROW).flex_none().whitespace_nowrap().cursor_pointer()
        .child(div().flex_none().text_color(t.dim).child(r.line === undefined ? "" : `L${r.line}`))
        .child(div().text_color(t.muted).child(r.text));
      if (r.kind === "g") return div().px(10).h(ROW).flex_none().bg(t.surface).text_color(t.accent).cursor_pointer().whitespace_nowrap().child(r.text);
      if (r.kind === "h") return header(r);
      if (r.kind === "L") return logLine(r, v);
      if (["<", "|", "=", ">"].includes(r.kind)) {
        const line = h_flex().h(ROW).flex_none().text_color(r.c === this.ci ? t.blocked : t.dim).child(num(r.new)).child(div().w(14).flex_none()).child(div().whitespace_nowrap().child(r.text));
        if (r.kind !== "<" || !cs[r.c]) return line;
        // As VS Code's links over a conflict: each keeps a side, named as its marker line names it
        // (HEAD, a branch, a commit), since "ours" and "theirs" swap meaning in a rebase.
        const p = cs[r.c], named = (l, or) => { const n = (l ?? "").replace(/^[<>|]+ ?/, "").trim() || or; return n.length > 32 ? n.slice(0, 31) + "…" : n; };
        const link = (how, label, color) => div().id(`take-${r.c}-${how}`).flex_none().px(6).rounded(4).text_color(color).cursor_pointer().hover((e) => e.bg(t.hover))
          .on_click((_e, cx) => { cx.stop_propagation(); this.handle.focus(); this.ci = r.c; this.resolve(how, cx); }).child(label);
        return line.gap(2).child(div().w(10).flex_none())
          .child(link("ours", `Keep ${named(p.head, "ours")}`, t.ansi2))
          .child(link("theirs", `Keep ${named(p.tail, "theirs")}`, t.ansi4))
          .child(link("both", "Keep both", t.muted))
          .when(Boolean(p.base), (e) => e.child(link("base", `Keep ${named(p.mid, "base")}`, t.muted)));
      }
      return null;
    };
    // A line's text, with the part that changed from its paired line (`hl`) in a stronger color.
    const code = (r) => {
      const o = r?.off ?? 0, a = r?.hl ? Math.max(0, r.hl[0] - o) : 0, b = r?.hl ? Math.min(r.text.length, r.hl[1] - o) : 0;
      if (a >= b) return div().whitespace_nowrap().child(r ? r.text : "");
      return h_flex().whitespace_nowrap().child(div().flex_none().child(r.text.slice(0, a)))
        .child(div().flex_none().rounded(2).bg(strong(r)).child(r.text.slice(a, b)))
        .child(div().flex_none().child(r.text.slice(b)));
    };
    const unified = (r, v) => band(r, v) ?? h_flex().id(`v-${v}`).h(ROW).flex_none().w_full().when(Boolean(bg(r)), (e) => e.bg(bg(r)))
      .child(num(r.old, r)).child(num(r.new, r))
      .child(div().w(14).flex_none().h_full().when(Boolean(strong(r)), (e) => e.bg(strong(r))).child(isChange(r) ? r.kind : ""))
      .child(div().w(6).flex_none())
      .child(code(r));
    const side = (r, which) => h_flex().w(half).flex_none().h_full().overflow_hidden().when(Boolean(r && bg(r)), (e) => e.bg(bg(r))).when(!r, (e) => e.bg(t.surface))
      .child(num(r ? (which === "left" ? r.old : r.new) : undefined, r))
      .child(div().w(6).flex_none())
      .child(code(r).flex_none().ml(-this.dx));
    // A "~" pair may have only one side (lines added with none removed): never band it.
    const paired = (p, v) => (p.kind !== "~" && band(p.left)) || h_flex().id(`v-${v}`).h(ROW).flex_none().w_full()
      .child(side(p.left, "left")).child(div().w(1).h_full().bg(t.border)).child(side(p.right, "right"));
    // A toggle: its icon is what it does, lit while it's on.
    const button = (id, name, active, tip, on) => div().id(id).tooltip(tip).size(24).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
      .text_color(active ? t.foreground : t.dim).when(active, (e) => e.bg(t.selection)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { on(); cx.notify(); }).child(svg(`mods/smart-git/${name}.svg`).size(14));
    // The files a commit, stash or range changes: a panel beside the diff when the pane is wide,
    // else a list the pinned bar opens. The pinned bar names the file at the top of the list.
    const stat = this.stat, files = stat?.files ?? [], at = (this.spied = this.fileAt());
    // Side by side outranks the panel: it shows only when the diff keeps the 900px that auto
    // needs for side by side beside it (520 when unified). Its width is dragged; 0 hides it.
    const room = (w) => this.paneW - w - 1 >= (this.layout === "unified" ? 520 : 902);
    const panel = Boolean(stat) && this.panelW > 0 && room(this.panelW), canShow = Boolean(stat) && this.panelW === 0 && room(240);
    const setPanel = (w) => { this.panelW = w; setShared("smart-git:panelW", w); };
    const counts = (x) => [x.add ? div().flex_none().text_color(t.ansi2).child(`+${x.add}`) : null, x?.del ? div().flex_none().text_color(t.ansi1).child(`−${x.del}`) : null].filter(Boolean);
    const letter = (f) => div().w(CHAR).flex_none().font_semibold().text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : t.blocked).child(f.status);
    const split2 = (f) => { const n = f.name.lastIndexOf("/") + 1; return [f.name.slice(0, n), f.name.slice(n)]; };
    const fileRow = (f, n) => {
      const [dir, base] = split2(f);
      return h_flex().id(`file-${n}`).h(24).px(10).gap(6).items_center().whitespace_nowrap().cursor_pointer()
        .when(n === at, (e) => e.bg(t.selection)).hover((e) => e.bg(t.hover))
        .child(letter(f)).child(div().min_w(0).truncate().child(base))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(dir)).children(counts(f));
    };
    const fileList = (id) => div().flex_1().min_h(0).relative()
      .child(div().absolute().inset_0().child(v_virtual_list(id, files.length, 24, (i) => String(i),
        (range) => files.slice(range.start, range.end).map((f, k) => fileRow(f, range.start + k))).size_full()
        .on_item_click((key, cx) => { this.toFile(Number(key)); this.drop = false; this.handle.focus(); cx.notify(); })))
      .child(Scrollbar.vertical(id).viewport_from_layout().absolute().inset_0());
    const cur = at === null ? null : files[at];
    const pin = h_flex().id("pin").h(26).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border).bg(t.surface).whitespace_nowrap()
      .when(!panel, (e) => e.cursor_pointer().on_click((_e, cx) => { this.drop = !this.drop; cx.notify(); }))
      .when(Boolean(cur), (e) => { const [dir, base] = split2(cur); return e.child(letter(cur))
        .child(div().min_w(0).truncate().text_color(t.dim).child(dir)).child(div().flex_none().font_semibold().child(base)).children(counts(cur))
        .child(div().flex_1()).child(div().flex_none().text_color(t.dim).child(`${at + 1}/${files.length}`)); })
      .when(!cur && Boolean(stat), (e) => e.child(div().font_semibold().child(`${files.length} file${files.length > 1 ? "s" : ""} changed`)).children(counts(stat ?? {}))
        .when(Boolean(stat?.partial), (e) => e.child(div().text_color(t.blocked).child("counted in the first 20000 lines"))).child(div().flex_1()))
      // Dragged shut, with room for it again: a button brings the panel back.
      .when(canShow, (e) => e.child(div().id("show-panel").tooltip("Show the file list").size(20).flex_none().flex().items_center().justify_center().rounded(4)
        .text_color(t.dim).hover((s) => s.bg(t.hover)).cursor_pointer()
        .on_click((_e, cx) => { cx.stop_propagation(); this.drop = false; setPanel(240); cx.notify(); }).child(svg("mods/smart-git/list.svg").size(12))))
      .when(!panel, (e) => e.child(svg(`mods/workspace-chrome/chevron-${this.drop ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim)));
    return v_flex().id("smart-git-diff").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(12)
      .track_focus(this.handle).on_key_down((e, cx) => { if (this.key(keyOf(e), cx)) cx.stop_propagation(); })
      // Sizes come back zoomed; lengths given to elements get zoomed again, so measure unzoomed.
      .on_mouse_move((e, cx) => {
        if (this.drag) { this.dx = this.drag.dx + (e.position.x - this.drag.x) / zoom * this.drag.k; cx.notify(); }
        // The panel's edge: 160px to 40% of the pane; dragged under 120 it closes.
        // Never so wide that the diff loses the room it needs (`room` in render).
        if (this.resize) {
          const w = this.resize.w + (e.position.x - this.resize.x) / zoom, max = Math.min(this.paneW * 0.4, this.paneW - 1 - (this.layout === "unified" ? 520 : 902));
          this.panelW = w < 120 ? 0 : Math.round(Math.max(160, Math.min(w, max))); cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        if (this.drag) { this.drag = null; cx.notify(); }
        if (this.resize) { this.resize = null; setPanel(this.panelW); cx.notify(); }
      })
      .on_size_change((size, cx) => { const w = size.width / (Number(settings().zoom) || 1); if (Math.abs(w - this.paneW) > 1) { this.paneW = w; cx.notify(); } })
      .child(h_flex().h(32).flex_none().px(10).gap(2).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(this.title ?? "Select something in the git panel"))
        .when(cs.length > 0, (e) => e.child(div().px(6).text_size(11).text_color(t.blocked).child(`conflict ${this.ci + 1} of ${cs.length}`)))
        .when(this.ws, (e) => e.child(div().px(6).text_size(11).text_color(t.blocked).child("ignoring whitespace")))
        .when(this.context !== 3 && !this.full, (e) => e.child(div().px(6).text_size(11).text_color(t.dim).child(`${this.context} lines of context`)))
        .when(Boolean(this.truncated), (e) => e.child(div().px(6).text_size(11).text_color(t.blocked).child(`only the first 20000 of ${this.truncated} lines`)))
        // The whole file (git with unlimited context), or only the changes and a few lines round them.
        .when(!this.conflict && !this.isLog(), (e) => e.child(button("full", "unfold-vertical", this.full, "Show the whole file (f)", () => { this.toggle("full"); this.open = new Set(); })))
        .child(button("wrap", "wrap-text", this.wrap, "Wrap long lines (w)", () => this.toggle("wrap")))
        .when(!this.conflict && !this.isLog(), (e) => e.child(div().w(1).h(16).mx(4).bg(t.border))
          .child(button("unified", "rows-2", this.layout === "unified", "Unified: old and new lines in one column (s)", () => this.setLayout("unified")))
          .child(button("split", "columns-2", this.layout === "split", "Side by side: old left, new right (s)", () => this.setLayout("split")))
          .child(button("auto", "move-horizontal", this.layout === "auto", "Auto: side by side when the pane is wide enough (s)", () => this.setLayout("auto")))))
      .when(Boolean(this.error), (e) => e.child(div().id("error").p(10).text_color(t.ansi1).cursor_pointer().on_click((_e, cx) => { this.error = null; cx.notify(); }).child(this.error)))
      .when(!this.pending && !this.error && !this.conflict && !this.rows.length && Boolean(this.shown), (e) => e.child(div().p(10).text_color(t.muted)
        .child(this.ws ? "Nothing to show: only whitespace changed (ctrl-w shows it)" : "Nothing to show here")))
      .when(Boolean(this.conflict) && !this.conflict.some((p) => !Array.isArray(p)), (e) => e.child(div().p(10).text_color(t.muted).child(this.shown?.note ?? "No conflict markers left. M in the files list keeps one side of the whole file.")))
      .child(div().flex_1().min_h(0).relative().child(h_flex().absolute().inset_0().items_start()
       .when(panel, (e) => e.child(v_flex().w(this.panelW).flex_none().h_full()
         .child(h_flex().h(26).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border).whitespace_nowrap()
           .child(div().font_semibold().child(`${files.length} file${files.length > 1 ? "s" : ""}`)).children(counts(stat))
           .when(Boolean(stat?.partial), (e) => e.child(div().text_color(t.blocked).child("partial"))))
         .child(fileList("smart-git-files")))
         // Its edge: drag to resize, double-click for the default width.
         .child(div().id("panel-edge").w(5).h_full().flex_none().cursor_col_resize().border_l(1).border_color(t.border)
           .when(Boolean(this.resize), (e) => e.bg(t.accent)).hover((s) => s.bg(t.hover))
           .on_mouse_down("left", (e, cx) => {
             cx.stop_propagation();
             if (e.click_count >= 2) { this.resize = null; setPanel(240); } else this.resize = { x: e.position.x, w: this.panelW };
             cx.notify();
           })))
       // The diff's own width is what its rows are laid out to.
       .child(v_flex().flex_1().min_w(0).h_full().relative()
        .on_size_change((size, cx) => { const w = size.width / (Number(settings().zoom) || 1); if (Math.abs(w - this.width) > 1) { this.width = w; cx.notify(); } })
        .when(Boolean(stat), (e) => e.child(pin))
      .child(div().flex_1().min_h(0).relative().font_family(mono)
        .child(div().id("smart-git-x").size_full().when(this.wrapped() || split, (e) => e.overflow_hidden()).when(!this.wrapped() && !split, (e) => e.overflow_x_scrollbar())
          .when(sideways, (e) => e.on_scroll_wheel(wheel))
          // Where a press lands says which side of a row was clicked: the list only names the row.
          .child(div().w(wide).h_full().on_mouse_down("left", (e) => { this.downX = (e.local_position?.x ?? 0) / (Number(settings().zoom) || 1); this.clicks = e.click_count; })
            .child(v_virtual_list("smart-git-rows", rows.length, ROW, (i) => String(i),
            (range) => rows.slice(range.start, range.end).map((r, k) => split ? paired(r, range.start + k) : unified(r, range.start + k))).track_scroll(this.scroll).size_full()
            .on_item_click((key, cx) => {
              const v = rows[Number(key)], r = !split ? v : this.downX > half ? (v?.right ?? v?.left) : (v?.left ?? v?.right);
              this.handle.focus();
              if (r?.kind === "g" && r.gap) { this.open.has(r.gap) ? this.open.delete(r.gap) : this.open.add(r.gap); this.loaded = null; }
              if (r?.kind === "@") { const n = this.rows.findIndex((x, j) => j > r.i && isChange(x)); if (n >= 0) { this.cur = n; this.hunk = true; this.anchor = null; } }
              if (r && (isChange(this.rows[r.i]) || r.kind === "L")) this.cur = r.i;
              if (r?.side) { this.ci = r.c; this.side = r.side; }
              if (r?.side) { this.ci = r.c; this.side = r.side; }
              // A double-click on a branch or tag label checks it out, as Space does in its list.
              const hit = r?.kind === "L" && this.clicks >= 2 ? labelAt(r, this.downX, graphW) : null;
              if (hit?.view) this.pick(hit.view, hit.name, "space");
              cx.notify();
            })
            // Right-click: the menu of the label under the pointer, or of the commit.
            .on_item_secondary_click((key, e, cx) => {
              const r = rows[Number(key)];
              if (r?.kind !== "L") return;
              this.cur = r.i; this.handle.focus();
              const hit = labelAt(r, (e.local_position?.x ?? 0) / (Number(settings().zoom) || 1), graphW);
              if (hit?.view) this.pick(hit.view, hit.name, "menu"); else this.pick("commits", r.hash, "menu");
              cx.notify();
            }))))
        .child(Scrollbar.vertical("smart-git-rows").viewport_from_layout().absolute().inset_0())
        .when(sideways && maxDx > 0, (e) => e.child(bar(0)).child(bar(half + 1))))
        // Narrow: the pinned bar opens the file list over the diff.
        .when(Boolean(stat) && !panel && this.drop, (e) => e.child(v_flex().absolute().top(26).left_0().right_0().h(Math.min(files.length, 12) * 24 + 2)
          .bg(t.background).border_b(1).border_color(t.border).child(fileList("smart-git-drop")))))))
      .child(div().flex_none().px(12).py(5).border_t(1).border_color(t.border).text_size(10.5).text_color(t.dim).truncate()
        .child(this.busy ? "Working…" : (this.anchor !== null ? "range · " : this.hunk ? "hunk · " : "") + (sideways ? "H/L scroll · " : "") + this.hints()));
  }
}
