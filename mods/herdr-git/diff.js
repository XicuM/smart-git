// The diff pane (lazygit's main panel): shows what the sidebar selected, unified or side by side.
// On a file it stages, unstages or discards single lines and hunks; on a commit it moves lines
// out of it; on a conflicted file it picks a side, conflict by conflict.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { shared, theme, settings, run, setShared, exec, panes, focused } from "herdr";
import { ask, keyOf } from "./ask.js";
import { git, writeThere, rebaseWith, diffRows, splitRows, partialPatch, parseConflicts } from "./git.js";

const ROW = 20, CHAR = 7.3;
const BANDS = ["s", "f", "@", "h", "<", "|", "=", ">"];
const isChange = (r) => r?.kind === "+" || r?.kind === "-";

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

// The git commands that show each kind of selection, as labelled sections.
function sources(s, o) {
  const flags = ["--no-color", `--submodule=${o.sub}`, `-U${o.context}`, ...(o.ws ? ["-w"] : [])];
  if (s.kind === "file") {
    const out = [], path = ["--", s.path];
    if (s.unstaged) out.push(["Unstaged changes", s.untracked ? ["diff", "--no-index", ...flags, "--", "/dev/null", s.path] : ["diff", ...flags, ...path]]);
    if (s.staged) out.push(["Staged changes", ["diff", "--cached", ...flags, ...path]]);
    return out;
  }
  if (s.kind === "commit") return [[null, ["show", ...flags, "--format=commit %H%nAuthor: %an <%ae>%nDate:   %ad%n%n%w(0,4,4)%B", s.hash]]];
  if (s.kind === "range") return [[null, ["diff", ...flags, s.from, s.to]]];
  if (s.kind === "stash") return [[null, ["stash", "show", "-p", ...flags, "--include-untracked", s.ref]]];
  if (s.kind === "branch") return [[null, ["log", "--graph", "--no-color", "--format=%h %s (%ar, %an)%d", "-n", "300", s.name, "--"]]];
  if (s.kind === "remote") return [[null, ["log", "--graph", "--no-color", "--format=%h %s (%ar)%d", "-n", "300", `--remotes=${s.name}`]]];
  return [[null, ["log", "--graph", "--no-color", "--all", "--format=%h %s (%ar)%d", "-n", "300"]]];
}

// A file's conflicts as rows: the plain lines, and each conflict's markers and sides (`c` its number).
function conflictRows(parts) {
  const rows = [];
  let line = 1, c = 0;
  for (const p of parts) {
    if (Array.isArray(p)) { for (const text of p) rows.push({ kind: " ", new: line++, text }); continue; }
    rows.push({ kind: "<", text: p.head, c, new: line++ });
    for (const text of p.ours) rows.push({ kind: "o", side: "ours", text, c, new: line++ });
    if (p.base) { rows.push({ kind: "|", text: p.mid, c, new: line++ }); for (const text of p.base) rows.push({ kind: "b", text, c, new: line++ }); }
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
    this.split = shared("herdr-git:split") ?? false; this.wrap = shared("herdr-git:wrap") ?? true;
    this.ws = shared("herdr-git:ws") ?? false; this.context = shared("herdr-git:context") ?? 3; this.sub = shared("herdr-git:sub") ?? "log";
    this.cur = -1; this.anchor = null; this.hunk = false; this.ci = 0; this.side = "ours"; this.undo = [];
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
  }

  // What the sidebar selected; reloads when it (or how it's shown) changes. Render calls this.
  sync(cx) {
    const s = shared("herdr-git:show");
    const key = JSON.stringify([s, this.ws, this.context, this.sub]);
    if (!s || key === this.loaded) return;
    // The same thing again (changed on disk, or a line staged): keep the place.
    const same = s.kind === this.shown?.kind && s.title === this.shown?.title;
    this.loaded = key; this.shown = s; this.title = s.title; this.error = null;
    cx.spawn(async (cx) => {
      const rows = [], texts = [];
      let conflict = null;
      try {
        if (s.kind === "conflict") {
          const r = await exec("cat", ["--", s.path], { cwd: s.repo.root, on: s.repo.on });
          if (r.code !== 0) throw new Error(r.stderr.trim());
          conflict = parseConflicts(r.stdout);
          rows.push(...conflictRows(conflict));
        } else for (const [label, args] of sources(s, this)) {
          const text = await git(s.repo, args);
          if (label && !text.trim()) continue;
          if (label) rows.push({ kind: "s", text: label });
          const src = texts.push({ label, text }) - 1;
          rows.push(...diffRows(text).map((r) => ({ ...r, src })));
        }
      } catch (e) { if (this.loaded === key) this.error = String(e.message ?? e); }
      if (this.loaded !== key) return;
      rows.forEach((r, i) => { r.i = i; });
      this.rows = rows; this.texts = texts; this.conflict = conflict; this.pairs = null; this.vis = null;
      this.longest = rows.reduce((n, r) => Math.max(n, r.text.length), 0);
      if (!same) { this.cur = -1; this.anchor = null; this.hunk = false; this.ci = 0; this.side = "ours"; this.undo = []; this.scroll.scroll_to_item(0); }
      if (conflict) this.ci = Math.min(this.ci, Math.max(0, conflict.filter((p) => !Array.isArray(p)).length - 1));
      // The cursor stays on a changed line: the nearest one at or after where it was.
      else if (!isChange(rows[this.cur])) {
        const n = rows.findIndex((r, i) => i >= Math.max(0, this.cur) && isChange(r));
        let last = rows.length - 1;
        while (last >= 0 && !isChange(rows[last])) last--;
        this.cur = n >= 0 ? n : last;
        this.anchor = null;
      }
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

  // Moves the cursor to the next changed line that way, or the first one of the next hunk.
  step(dir) {
    const rows = this.rows;
    let i = this.cur;
    if (this.hunk) {
      while (i > 0 && rows[i].kind !== "@") i--;
      do i += dir; while (i >= 0 && i < rows.length && rows[i].kind !== "@");
      if (i < 0 || i >= rows.length) return;
      dir = 1;
    }
    for (i += dir; i >= 0 && i < rows.length; i += dir) if (isChange(rows[i])) { this.cur = i; break; }
    this.reveal(this.cur);
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
      try { await work(cx); }
      catch (e) { this.error = String(e.message ?? e); }
      finally { this.busy = false; this.loaded = null; setShared("herdr-git:bump", Date.now()); cx.notify(); }
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
    const file = `${(await git(repo, ["rev-parse", "--absolute-git-dir"])).trim()}/herdr-git.patch`;
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
        this.error = "The file is tracked now: pick its lines again";
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
      if (conflicts.length > 1) return;
      if (await ask({ title: "All conflicts resolved", detail: `Stage ${s.path}?`, items: [{ key: "enter", label: "Stage it", value: true }] }))
        await git(s.repo, ["add", "--", s.path], { write: true });
    }, cx);
  }

  undoResolve(cx) {
    const s = this.shown, text = this.undo.pop();
    if (text === undefined) return;
    this.act(async () => { const w = await writeThere(s.repo, s.path, text); if (w.code !== 0) throw new Error(w.stderr.trim()); }, cx);
  }

  key(k, cx) {
    const s = this.shown ?? {}, conflicts = this.conflict?.filter((p) => !Array.isArray(p)).length ?? 0;
    const toConflict = (n) => {
      this.ci = Math.max(0, Math.min(n, conflicts - 1));
      const first = this.rows.findIndex((r) => r.c === this.ci);
      if (first >= 0) this.reveal(first);
    };
    const keys = this.conflict ? {
      j: () => toConflict(this.ci + 1), down: () => toConflict(this.ci + 1), k: () => toConflict(this.ci - 1), up: () => toConflict(this.ci - 1),
      h: () => { this.side = "ours"; }, left: () => { this.side = "ours"; }, l: () => { this.side = "theirs"; }, right: () => { this.side = "theirs"; },
      space: () => this.resolve(this.side, cx), enter: () => this.resolve(this.side, cx), b: () => this.resolve("both", cx), z: () => this.undoResolve(cx),
    } : {
      j: () => this.step(1), down: () => this.step(1), k: () => this.step(-1), up: () => this.step(-1),
      g: () => { this.cur = -1; this.step(1); }, G: () => { this.cur = this.rows.length; this.step(-1); },
      v: () => { this.anchor = this.anchor === null ? this.cur : null; this.hunk = false; },
      a: () => { this.hunk = !this.hunk; this.anchor = null; },
      ...(s.kind === "file" ? { space: () => this.stageLines(cx), d: () => this.discardLines(cx) } : {}),
      ...(s.kind === "commit" ? { space: () => this.commitPatch(cx), "ctrl-p": () => this.commitPatch(cx) } : {}),
      h: () => this.back(),
    };
    const common = {
      s: () => this.toggle("split"), w: () => this.toggle("wrap"), "ctrl-w": () => this.toggle("ws"),
      S: () => { this.sub = this.sub === "log" ? "diff" : "log"; setShared("herdr-git:sub", this.sub); },
      "{": () => { this.context = Math.max(0, this.context - 1); setShared("herdr-git:context", this.context); },
      "}": () => { this.context++; setShared("herdr-git:context", this.context); },
      z: () => this.zoom(),
      escape: () => { if (this.anchor !== null || this.hunk) { this.anchor = null; this.hunk = false; } else this.back(); },
      q: () => this.back(),
    };
    const a = keys[k] ?? common[k];
    if (!a) return false;
    a();
    cx.notify();
    return true;
  }

  pane() { return panes().find((p) => p.pane === focused()?.pane && p.mod === "herdr-git") ?? panes().find((p) => p.tab === focused()?.tab && p.mod === "herdr-git"); }
  zoom() { const p = this.pane(); if (p) run("pane.zoom", { pane: p.pane }); }
  // Back to the sidebar, and the layout back as it was.
  back() { if (this.pane()?.zoomed) this.zoom(); run("pane.go", { direction: "right" }); }

  toggle(what) { this[what] = !this[what]; setShared(`herdr-git:${what}`, this[what]); this.vis = null; }

  // The rows as drawn: wrapped to the pane's width (each piece its own row, so every row
  // keeps the list's one height), or as they are, for scrolling sideways.
  visual() {
    const split = this.split && !this.conflict;
    const pairs = split ? (this.pairs ??= splitRows(this.rows)) : null;
    if (!this.wrap) return pairs ?? this.rows;
    const key = `${split}|${Math.round(this.width)}|${this.rows.length}`;
    if (this.vis?.key === key && this.vis.rows0 === this.rows) return this.vis.rows;
    const out = [], full = Math.floor((this.width - 24) / CHAR);
    // A piece after the first keeps its row's kind and place, without its line numbers.
    const piece = (r, text, n) => n === 0 ? { ...r, text } : { kind: r.kind, text, i: r.i, c: r.c, side: r.side };
    const bandRows = (r) => wrapText(r.text, full).map((text, n) => piece(r, text, n));
    if (!pairs) {
      const n = Math.floor((this.width - 110) / CHAR);
      for (const r of this.rows) {
        if (BANDS.includes(r.kind)) { out.push(...bandRows(r)); continue; }
        wrapText(r.text, n).forEach((text, j) => out.push(piece(r, text, j)));
      }
    } else {
      const n = Math.floor((Math.floor(this.width / 2) - 56) / CHAR);
      for (const p of pairs) {
        if (p.kind !== "~" && BANDS.includes(p.kind)) { out.push(...bandRows(p.left).map((r) => ({ kind: r.kind, left: r, right: r }))); continue; }
        const L = p.left ? wrapText(p.left.text, n) : [], R = p.right ? wrapText(p.right.text, n) : [];
        // A side that runs out keeps its color on blank rows; a missing side stays missing.
        const side = (r, parts, j) => !r ? null : piece(r, parts[j] ?? "", j);
        for (let j = 0; j < Math.max(L.length, R.length, 1); j++) out.push({ kind: p.kind, left: side(p.left, L, j), right: side(p.right, R, j) });
      }
    }
    this.vis = { key, rows0: this.rows, rows: out };
    return out;
  }

  hints() {
    const s = this.shown;
    if (this.conflict) return "j/k conflict · h/l side · space pick · b both · z undo the last pick · esc back";
    const pick = "j/k line · v range · a hunk";
    if (s?.kind === "file") return `${pick} · space stage · d discard · z zoom · {/} context · esc back`;
    if (s?.kind === "commit") return `${pick} · space move out of commit · z zoom · esc back`;
    return "s side by side · w wrap · z zoom · {/} context · esc back";
  }

  render(cx) {
    this.sync(cx);
    const t = theme(), mono = settings().font_family ?? "JetBrains Mono", focused = this.handle.is_focused();
    const split = this.split && !this.conflict;
    // Wide enough for the longest line, so the pane scrolls sideways instead of cutting it.
    const text = this.wrap ? 0 : Math.ceil((this.longest ?? 0) * CHAR);
    const half = Math.max(200, Math.floor(this.width / 2), text + 50);
    const wide = this.wrap ? this.width : split ? half * 2 + 1 : Math.max(this.width, text + 110);
    const rows = this.visual(), picked = new Set(focused ? this.selected().map((r) => r.i) : []);
    const num = (n) => div().w(40).flex_none().text_right().pr(8).text_color(t.dim).child(n === undefined ? "" : String(n));
    const bg = (r) => {
      if (picked.has(r.i)) return t.selection;
      if (r.side) return r.c === this.ci && r.side === this.side && focused ? t.selection : (r.side === "ours" ? t.ansi2 : t.ansi4) + "22";
      return r.kind === "+" ? t.ansi2 + "22" : r.kind === "-" ? t.ansi1 + "22" : r.kind === "b" ? t.surface : null;
    };
    const band = (r) => {
      if (r.kind === "s") return div().px(10).h(ROW).flex_none().bg(t.raised).text_color(t.accent).font_semibold().child(r.text);
      if (r.kind === "f") return div().px(10).h(ROW).flex_none().bg(t.raised).text_color(t.foreground).font_semibold().truncate().child(r.text);
      if (r.kind === "@") return div().px(10).h(ROW).flex_none().text_color(t.dim).truncate().child(r.text);
      if (r.kind === "h") return div().px(10).h(ROW).flex_none().text_color(t.muted).whitespace_nowrap().child(r.text);
      if (["<", "|", "=", ">"].includes(r.kind)) return h_flex().h(ROW).flex_none().text_color(r.c === this.ci ? t.blocked : t.dim).child(num(r.new)).child(div().w(14).flex_none()).child(div().whitespace_nowrap().child(r.text));
      return null;
    };
    const unified = (r, v) => band(r) ?? h_flex().id(`v-${v}`).h(ROW).flex_none().w_full().when(Boolean(bg(r)), (e) => e.bg(bg(r)))
      .on_click((_e, cx) => { this.handle.focus(); if (isChange(this.rows[r.i])) { this.cur = r.i; } if (r.side) { this.ci = r.c; this.side = r.side; } cx.notify(); })
      .child(num(r.old)).child(num(r.new))
      .child(div().w(14).flex_none().text_color(r.kind === "+" ? t.ansi2 : r.kind === "-" ? t.ansi1 : t.dim).child(isChange(r) ? r.kind : ""))
      .child(div().whitespace_nowrap().child(r.text));
    const side = (r, which) => h_flex().w(half).flex_none().h_full().overflow_hidden().when(Boolean(r && bg(r)), (e) => e.bg(bg(r))).when(!r, (e) => e.bg(t.surface))
      .child(num(r ? (which === "left" ? r.old : r.new) : undefined))
      .child(div().whitespace_nowrap().child(r ? r.text : ""));
    // A "~" pair may have only one side (lines added with none removed): never band it.
    const paired = (p, v) => (p.kind !== "~" && band(p.left)) || h_flex().id(`v-${v}`).h(ROW).flex_none().w_full()
      .on_click((_e, cx) => { this.handle.focus(); const r = p.right ?? p.left; if (r && isChange(this.rows[r.i])) this.cur = r.i; cx.notify(); })
      .child(side(p.left, "left")).child(div().w(1).h_full().bg(t.border)).child(side(p.right, "right"));
    const button = (id, name, on) => div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { on(); cx.notify(); }).child(svg(`mods/herdr-git/${name}.svg`).size(14));
    return v_flex().id("herdr-git-diff").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(12)
      .track_focus(this.handle).on_key_down((e, cx) => { if (this.key(keyOf(e), cx)) cx.stop_propagation(); })
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 1) { this.width = size.width; cx.notify(); } })
      .child(h_flex().h(32).flex_none().px(10).gap(2).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().font_semibold().child((this.title ?? "Select something in the git panel") + ` [rows=${this.rows.length} vis=${rows.length} w=${this.width} loaded=${Boolean(this.loaded)} err=${this.error}]`))
        .when(this.ws, (e) => e.child(div().px(6).text_size(11).text_color(t.blocked).child("ignoring whitespace")))
        .when(this.context !== 3, (e) => e.child(div().px(6).text_size(11).text_color(t.dim).child(`${this.context} lines of context`)))
        .child(button("wrap", this.wrap ? "wrap-text" : "align-left", () => this.toggle("wrap")))
        .when(!this.conflict, (e) => e.child(button("split", this.split ? "columns-2" : "rows-2", () => this.toggle("split")))))
      .when(Boolean(this.error), (e) => e.child(div().id("error").p(10).text_color(t.ansi1).cursor_pointer().on_click((_e, cx) => { this.error = null; cx.notify(); }).child(this.error)))
      .when(Boolean(this.conflict) && !this.conflict.some((p) => !Array.isArray(p)), (e) => e.child(div().p(10).text_color(t.muted).child("No conflict markers left. M in the files list keeps one side of the whole file.")))
      .child(div().flex_1().min_h(0).relative().font_family(mono)
        .child(div().id("herdr-git-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(wide).h_full().child(v_virtual_list("herdr-git-rows", rows.length, ROW, (i) => String(i),
            (range) => rows.slice(range.start, range.end).map((r, k) => h_flex().h(ROW).flex_none().w_full().child(num(r.old)).child(num(r.new)).child(div().whitespace_nowrap().child(r.text ?? "")))).track_scroll(this.scroll).size_full())))
        .child(Scrollbar.vertical("herdr-git-rows").viewport_from_layout().absolute().inset_0()))
      .child(div().flex_none().px(12).py(5).border_t(1).border_color(t.border).text_size(10.5).text_color(t.dim).truncate()
        .child(this.busy ? "Working…" : (this.anchor !== null ? "range · " : this.hunk ? "hunk · " : "") + this.hints()));
  }
}
