// Smart Git: lazygit's side panels as a herdr sidebar. The same mod draws the diff pane
// (props.view "diff") and its own dialogs (props.view "ask").
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { props, panes, focused, theme, run, shared, setShared, watchFolder, nextCommand, exec, hc, openOverlay, closeOverlay, terminals, checking, agents, knownAgents, layout } from "herdr";
import {
  perf, location, git, findRoot, writeThere, rebaseWith, openEditor, parseStatus, parseLog, parseBranches, parseStash, parseSubmodules, parseWorktrees,
  parseRemotes, parseRefs, parseReflog, LOG_FORMAT, BRANCH_FORMAT, REF_FORMAT, REFLOG_FORMAT,
} from "./git.js";
import { Diff } from "./diff.js";
import { ask, askFrom, confirm, keyOf, Ask, asking, cancelAsks } from "./ask.js";

const ROW = 26, HEAD = 30;
const seen = new Map();
// The repos entered (submodules) per space and folder, so coming back to a space shows the submodule you left.
const entered = new Map();
// The commit box's unsent subject and description, per repo.
const drafts = new Map();
// How each agent in Herdr's table (knownAgents keys) answers one prompt and exits: its arguments
// ("{prompt}" where the prompt goes), the flag that picks a model, its models (a list, or the arguments
// that print them), and the fast model Auto uses. The program is the agent's own `run`, so a
// programs.json override is kept. Agents not here get "Set up…" (saved in smart-git:recipes).
const RECIPES = {
  claude: { args: ["-p", "{prompt}"], model: "--model", models: ["haiku", "sonnet", "opus", "fable"], fast: "haiku" },
  codex: { args: ["exec", "--skip-git-repo-check", "{prompt}"], model: "-m" },
  opencode: { args: ["run", "{prompt}"], model: "-m", list: ["models"] },
  copilot: { args: ["-p", "{prompt}"], model: "--model" },
  cursor: { args: ["-p", "{prompt}"], model: "--model", list: ["models"] },
  grok: { args: ["-p", "{prompt}"], model: "-m", list: ["models"] },
  pi: { args: ["-p", "{prompt}"], model: "--model" },
  omp: { args: ["-p", "{prompt}"], model: "--model" },
  antigravity: { args: ["-p", "{prompt}"], model: "--model", list: ["models"] },
  amp: { args: ["-x", "{prompt}"] },
  gemini: { args: ["-p", "{prompt}"], model: "-m" },
  goose: { args: ["run", "-t", "{prompt}"] },
  crush: { args: ["run", "{prompt}"] },
  kiro: { args: ["chat", "--no-interactive", "{prompt}"] },
};
// Menu keys for long lists.
const KEYS = "123456789abcdefghilmnopqrstuvwxyz"; // no j/k: they move in menus
// A CLI's model list: the first word of each line that looks like a model id (has a digit, - or /).
const modelIds = (text) => [...new Set(text.split("\n").map((l) => /^\s*[*•-]?\s*([\w.\/:@-]+)/.exec(l)?.[1]).filter((m) => m && /[\d\/-]/.test(m) && !m.endsWith(":")))];
const PROMPT = `Write a git commit for the changes below.

Reply with ONE JSON object and nothing else (no markdown, no code fences):
{"subject": "one-line conventional-commit subject, imperative mood, max 72 chars, no trailing period", "body": "optional description: 1-3 sentences or bullet lines on what changed and why, \\n between lines; empty if the subject says it all"}

`;
const icon = (name) => svg(`mods/workspace-chrome/${name}.svg`);
// Status is the title bar; the rest are the sidebar's sections, each with lazygit's tabs.
const PANELS = [
  { id: "status", tabs: [["status", "Status"]] },
  { id: "files", tabs: [["files", "Files"], ["worktrees", "Worktrees"], ["submodules", "Submodules"]] },
  { id: "branches", tabs: [["branches", "Branches"], ["remotes", "Remotes"], ["tags", "Tags"]] },
  { id: "commits", tabs: [["commits", "Commits"], ["reflog", "Reflog"]] },
  { id: "stash", tabs: [["stash", "Stash"]] },
];
// What a repository in the middle of something is doing, by the file git keeps for it.
const OPS = { "rebase-merge": "Rebasing", "rebase-apply": "Rebasing", MERGE_HEAD: "Merging", CHERRY_PICK_HEAD: "Cherry-picking", REVERT_HEAD: "Reverting", BISECT_LOG: "Bisecting" };
// What the commit actions do to history, shown beside them in the menus (hover, or the selected row).
const REWRITE = "Rewrites this commit and every one after it (new hashes): a pushed branch then needs a force push. z undoes it.";
const EXPLAIN = {
  commits: {
    space: "Moves HEAD to this commit without a branch (detached). Commits you make there are lost unless you create a branch.",
    g: "Moves the branch back to this commit. Commits after it leave the branch (the reflog keeps them); soft, mixed or hard says what happens to their changes.",
    r: `Changes this commit's message only. ${REWRITE}`,
    R: `Changes this commit's message in your editor. ${REWRITE}`,
    s: `Melds this commit into the older one below it, keeping both messages. ${REWRITE}`,
    f: `Melds this commit into the older one below it and discards this commit's message. ${REWRITE}`,
    d: `Removes this commit and its changes from the branch; the commits after it are replayed without it and may conflict. ${REWRITE}`,
    e: "Starts a rebase that stops at this commit, so you can amend it or split it; m continues.",
    i: "Starts a rebase that stops just before this commit: reorder, squash or drop what follows, then m continues.",
    "ctrl-j": `Swaps this commit with the older one below it; they may conflict. ${REWRITE}`,
    "ctrl-k": `Swaps this commit with the newer one above it; they may conflict. ${REWRITE}`,
    A: `Adds the staged changes into this commit. ${REWRITE}`,
    F: "Makes a new \"fixup!\" commit of the staged changes, to meld into this one later (S). Nothing is rewritten yet.",
    S: `Melds every "fixup!" commit made for this one into it. ${REWRITE}`,
    t: "Adds a new commit that undoes this one. Nothing is rewritten: safe on pushed branches.",
    V: "Applies the copied commits on top of the current branch as new commits; they may conflict.",
  },
  todo: {
    p: "Keeps this commit as it is.",
    s: "Melds this commit into the one before it, keeping both messages.",
    f: "Melds this commit into the one before it and discards its message.",
    e: "Stops the rebase at this commit, so you can amend it.",
    d: "Takes this commit out of the rebase: its changes leave the branch.",
    "ctrl-j": "Applies this commit earlier; they may conflict.",
    "ctrl-k": "Applies this commit later; they may conflict.",
  },
  reflog: {
    space: "Moves HEAD to this point without a branch (detached). Commits you make there are lost unless you create a branch.",
    g: "Moves the branch to this point of its history; soft, mixed or hard says what happens to the changes in between. The reflog keeps where it was.",
    V: "Applies the copied commits on top of the current branch as new commits; they may conflict.",
  },
};
// The git dir, those files, and the todo of a rebase in progress.
const STATE = 'd=$(git rev-parse --absolute-git-dir) || exit 0; echo "$d"; cd "$d"; for f in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG; do [ -e "$f" ] && echo "$f"; done; [ -f rebase-merge/git-rebase-todo ] && { echo "--todo"; cat rebase-merge/git-rebase-todo; }; true';

// The editor popup's title bar. x ends the editor, and the popup closes with its terminal.
const editBar = () => {
  const p = props(), t = theme();
  return h_flex().id("smart-git-editbar").size_full().px(12).gap(8).items_center().bg(t.popover).border_b_1().border_color(t.border).text_size(12)
    .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(p.title))
    .child(div().flex_none().text_color(t.dim).child(p.editor))
    .child(div().id("close").size(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover))
      .tooltip("Close the editor").on_click(() => { hc(["kill", p.terminal]); closeOverlay(p.overlay); }).child(icon("x").size(14)));
};

export default class HerdrGit extends View {
  init(_props, cx) {
    const view = props()?.view;
    this.part = view === "diff" ? new Diff(this, cx) : view === "ask" ? new Ask(cx) : view === "editbar" ? { render: editBar } : new Sidebar(cx);
    if (view !== "ask" && view !== "editbar" && !checking()) cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.part.handle.focus();
        // From the diff (esc, 1–5) or a key bound to `smart-git.sidebar`: the sidebar takes the keyboard,
        // then presses the key it passed on (`sidebar:2`). Behind Files in its stack, or in a hidden
        // column, focus would go nowhere you can see: it brings itself to the front first.
        else if (c.startsWith("sidebar")) {
          if (!this.part.panel) continue;
          const find = (n, up) => n?.content?.mod === "smart-git" && !n.content.props?.view ? [...up, n] : (n?.children ?? []).reduce((hit, k) => hit ?? find(k, [...up, n]), null);
          const path = find(layout(), []) ?? [];
          for (let i = 1; i < path.length; i++) {
            if (path[i - 1].type === "stack") await run("layout.select", { stack: path[i - 1].id, child: path[i].id });
            else if (path[i].hidden) await run("layout.show", { id: path[i].id });
          }
          await cx.sleep(50);
          this.part.handle.focus(); if (c[7] === ":") this.part.key(c.slice(8), cx);
        }
        // The diff pane's graph picked a commit or label to act on (`smart-git:pick`).
        else if (c === "pick") { if (this.part.panel) this.part.pick(shared("smart-git:pick") ?? {}, cx); }
        // `smart-git.key:<k>` presses a key, for scripts and tests.
        else if (c.startsWith("key:")) this.part.key?.(c.slice(4), cx);
        cx.notify();
      }
    });
  }
  render(cx) { return this.part.render(cx); }
  async close() { this.part.close?.(); }
}

class Sidebar {
  constructor(cx) {
    this.handle = cx.focus_handle();
    this.scrolls = Object.fromEntries(PANELS.map((p) => [p.id, VirtualListScrollHandle.new()]));
    this.folded = new Set(shared("smart-git:folded") ?? []);
    this.tabs = { status: "status", files: "files", branches: "branches", commits: "commits", stash: "stash", ...(shared("smart-git:tabs") ?? {}) };
    this.stack = []; this.panel = "files"; this.collapsed = new Set(); this.copied = [];
    this.tree = shared("smart-git:tree") ?? true;
    this.clear();
    // The commit box. While one of its fields has the keyboard (`typing`), the list's keys are off.
    this.subject = InputState.new({ placeholder: "Commit message" });
    this.body = TextareaState.new({ placeholder: "Description" }); this.body.set_auto_grow(2, 6);
    for (const [name, s] of [["subject", this.subject], ["body", this.body]]) {
      s.on("focus", (_e, cx) => { this.typing = name; cx.notify(); });
      s.on("blur", (_e, cx) => { if (this.typing === name) this.typing = null; cx.notify(); });
    }
    this.subject.on("submit", (_e, cx) => this.act("Committing…", () => this.commit(), cx));
    this.subject.on("change", (_e, cx) => cx.notify());
    this.filter = InputState.new({ placeholder: "Filter" });
    this.filter.on("change", (_e, cx) => { this.filterText = this.filter.value(); this.sel[this.filterView] = 0; cx.notify(); });
    this.filter.on("submit", (_e, cx) => { this.filtering = false; this.handle.focus(); cx.notify(); });
    this.filterText = "";
    this.bump = shared("smart-git:bump");
    // The folder watch keeps a local repo current; the timer is for remote ones (and a watch that failed).
    cx.timer.every(10000, (cx) => { if (!this.watching) this.refresh(cx); });
  }

  clear() {
    this.head = {}; this.files = []; this.branches = []; this.commits = []; this.stash = []; this.submodules = []; this.worktrees = [];
    this.remotes = []; this.remoteBranches = []; this.tags = []; this.reflog = []; this.ops = []; this.todo = []; this.gitDir = ""; this.raw = null;
    this.sel = {}; this.inRemote = null; this.diffBase = null; this.pathFilter = null; this.info = null;
  }

  get repo() { return this.stack[this.stack.length - 1] ?? null; }
  // The list a section shows: its tab, or a remote's branches inside Remotes.
  viewOf(panel) { const v = this.tabs[panel] ?? panel; return v === "remotes" && this.inRemote ? "remote-branches" : v; }
  get view() { return this.viewOf(this.panel); }

  // Follows the focused terminal's repo; submodules entered from it stack on top.
  follow(cx) {
    const loc = location(), key = JSON.stringify(loc);
    // A tab with no terminal (only mods) says nothing about the repo: stay on this one.
    if (loc.guess && this.stack.length && loc.space === this.space) return;
    if (key === this.where || !loc.cwd) return;
    this.where = key; this.space = loc.space;
    cx.spawn(async (cx) => {
      // Just the repo the terminal is in: a submodule opened as its own space is its own instance.
      const root = await findRoot(loc.cwd, loc.on), stack = root ? [{ root, on: loc.on }] : [];
      if (this.where !== key) return;
      const was = entered.get(key);
      if (was?.length > stack.length && stack.every((r, n) => r.root === was[n].root && r.on === was[n].on)) stack.push(...was.slice(stack.length));
      // The same repo, or one entered from it: stay where the person is.
      if (stack.length && stack.every((r, n) => r.root === this.stack[n]?.root && r.on === this.stack[n]?.on)) return;
      this.go(stack, cx);
    });
  }

  // Each repo keeps what it showed, so coming back to it (another space or tab) is instant
  // and the refresh only updates it.
  go(stack, cx) {
    if (this.where) entered.set(this.where, stack);
    const key = (st) => JSON.stringify(st), keep = ["head", "files", "branches", "commits", "stash", "submodules", "worktrees", "remotes", "remoteBranches", "tags", "reflog", "ops", "todo", "gitDir", "sel", "inRemote", "stamp", "raw"];
    if (this.stack.length) seen.set(key(this.stack), Object.fromEntries(keep.map((k) => [k, this[k]])));
    if (this.stack.length) drafts.set(key(this.stack), [this.subject.value(), this.body.value()]);
    const [subject = "", body = ""] = drafts.get(key(stack)) ?? [];
    this.subject.set_value(subject); this.body.set_value(body);
    this.stack = stack;
    this.error = stack.length ? null : "Not a git repository";
    const old = seen.get(key(stack));
    if (old) Object.assign(this, old, { diffBase: null, pathFilter: null, info: null }); else this.clear();
    this.refresh(cx); this.watch(cx); this.show(cx); cx.notify();
  }

  watch(cx) {
    const repo = this.repo;
    if (this.watching === repo?.root) return;
    this.watchCall?.cancel(); this.watching = null;
    if (!repo || repo.on) return;
    // A token, not the root: going A→B→A while a loop sleeps mustn't leave two loops on A.
    const token = this.watchToken = {};
    this.watching = repo.root;
    cx.spawn(async (cx) => {
      try {
        while (this.watchToken === token) {
          this.watchCall = watchFolder(repo.root);
          const changed = await this.watchCall;
          // A save or an agent's edit comes as a burst of changes: refresh once it settles. The refresh
          // reads git after the wait, so changes during it are in it.
          if (changed.length) await cx.sleep(300);
          if (this.watchToken !== token || !changed.length) continue;
          // A file edited again leaves `git status` the same: `edits` still has the diff reload it.
          if (changed.some((p) => !p.includes("/.git/") && !p.endsWith("/.git"))) this.edits = (this.edits ?? 0) + 1;
          this.refresh(cx); this.show(cx);
        }
      } catch { if (this.watchToken === token) this.watching = null; }
    });
  }

  refresh(cx) {
    const repo = this.repo;
    if (!repo) return;
    // A hot reload stops this task before its finally: a lock older than git's 30s timeout is from a task that's gone.
    if (this.loading && Date.now() - this.loading < 40000) { this.again = true; return; }
    this.loading = Date.now(); this.again = false;
    const soft = (p) => p.catch(() => "");
    // Submodules cost a git run in each of them (half a second in a repo of 65): only while their tab shows.
    const subsShown = this.tabs.files === "submodules";
    let same = false;
    cx.spawn(async (cx) => {
      try {
        const [status, branches, log, stash, subs, subConfig, worktrees, remotes, remoteBranches, tags, reflog, state] = await Promise.all([
          git(repo, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"]),
          git(repo, ["for-each-ref", "--sort=-committerdate", `--format=${BRANCH_FORMAT}`, "refs/heads"]),
          soft(git(repo, ["log", `--format=${LOG_FORMAT}`, "-n", "300", "HEAD", "--", ...(this.pathFilter ? [this.pathFilter] : [])])),
          git(repo, ["stash", "list", "--format=%gd%x1f%cr%x1f%gs"]),
          subsShown ? soft(git(repo, ["submodule", "status", "--recursive"])) : null,
          subsShown ? soft(git(repo, ["config", "-z", "--file", ".gitmodules", "--get-regexp", "^submodule\\."])) : null,
          soft(git(repo, ["worktree", "list", "--porcelain"])),
          git(repo, ["remote", "-v"]),
          git(repo, ["for-each-ref", "--sort=-committerdate", `--format=${REF_FORMAT}`, "refs/remotes"]),
          git(repo, ["for-each-ref", "--sort=-creatordate", `--format=${REF_FORMAT}`, "refs/tags"]),
          soft(git(repo, ["reflog", `--format=${REFLOG_FORMAT}`, "-n", "300"])),
          exec("sh", ["-c", STATE], { cwd: repo.root, on: repo.on }).then((r) => r.stdout),
        ]);
        if (repo !== this.repo) return;
        // Nothing changed (the timer, or a change git doesn't show): no redraw.
        const raw = [status, branches, log, stash, subs, subConfig, worktrees, remotes, remoteBranches, tags, reflog, state].join("\0\x1e");
        if (raw === this.raw && !this.error) { same = true; return; }
        this.raw = raw;
        const s = parseStatus(status);
        this.head = s.head; this.files = s.files; this.branches = parseBranches(branches);
        this.commits = parseLog(log); this.stash = parseStash(stash); if (subs !== null) this.submodules = parseSubmodules(subs, subConfig);
        this.worktrees = parseWorktrees(worktrees); this.remotes = parseRemotes(remotes); this.remoteBranches = parseRefs(remoteBranches);
        this.tags = parseRefs(tags); this.reflog = parseReflog(reflog);
        const [dir, ...rest] = state.split("\n"), t = rest.indexOf("--todo");
        this.gitDir = dir; this.ops = (t < 0 ? rest : rest.slice(0, t)).filter(Boolean);
        this.todo = t < 0 ? [] : rest.slice(t + 1).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
          .map((l) => { const m = /^(\S+)\s*(.*)$/.exec(l); return { action: m[1], rest: m[2] }; });
        // Tells the diff pane the files changed, so it reloads what it shows.
        let h = 0;
        for (let i = 0; i < status.length; i++) h = (h * 31 + status.charCodeAt(i)) | 0;
        this.stamp = h; this.error = null;
      } catch (e) { if (repo === this.repo) this.error = String(e.message ?? e); }
      finally { this.loading = 0; if (this.again) this.refresh(cx); if (!same) { this.show(cx); cx.notify(); } }
    });
  }

  // The rows of a list, as drawn and as acted on; `text` is what the filter matches.
  rows(view) {
    const q = view === this.filterView ? this.filterText.toLowerCase() : "";
    const keep = (r) => !q || r.text.toLowerCase().includes(q);
    if (view === "status") return this.repo ? [{ id: "status", text: "" }] : [];
    if (view === "worktrees") return this.worktrees.map((w) => ({ id: w.path, worktree: w, text: `${w.branch} ${w.path}` })).filter(keep);
    if (view === "submodules") return this.submodules.map((s) => ({ id: s.path, sub: s, text: s.path })).filter(keep);
    if (view === "branches") return this.branches.map((b) => ({ id: b.name, branch: b, text: b.name })).filter(keep);
    if (view === "remotes") return this.remotes.map((r) => ({ id: r.name, remote: r, text: `${r.name} ${r.url}` })).filter(keep);
    if (view === "remote-branches") return this.remoteBranches.filter((b) => b.name.startsWith(this.inRemote + "/")).map((b) => ({ id: b.name, rbranch: b, text: b.name })).filter(keep);
    if (view === "tags") return this.tags.map((t) => ({ id: t.name, tag: t, text: `${t.name} ${t.subject}` })).filter(keep);
    if (view === "reflog") return this.reflog.map((r) => ({ id: r.ref, reflog: r, text: `${r.short} ${r.subject}` })).filter(keep);
    if (view === "stash") return this.stash.map((s) => ({ id: s.ref, stash: s, text: s.subject })).filter(keep);
    if (view === "commits") {
      // A rebase's todo comes first, the last to be applied on top, as lazygit shows it.
      const todo = this.todo.map((t, n) => ({ id: `todo-${n}`, todo: t, n, text: t.rest })).reverse();
      return [...todo, ...this.commits.map((c, n) => ({ id: c.hash, commit: c, ahead: n < this.head.ahead, text: `${c.short} ${c.subject}` }))].filter(keep);
    }
    // Built once per change of what it's made of, not on every key and draw.
    const made = [this.files, q, this.tree, [...this.collapsed].join("\0")];
    if (this.made?.every((v, n) => v === made[n])) return this.fileRows;
    this.made = made;
    return (this.fileRows = this.fileTree(q));
  }

  fileTree(q) {
    // A path can be both deleted in the index and untracked (two entries): ids must stay unique or the list draws nothing.
    const files = this.files.filter((f) => !q || f.path.toLowerCase().includes(q));
    if (!this.tree) return files.map((f) => ({ id: f.untracked ? f.path + "?" : f.path, file: f, depth: 0, name: f.path, text: f.path }));
    // The tree: a folder row before its files, folders with a single child folder joined.
    const root = { dirs: new Map(), files: [] };
    for (const f of files) {
      const parts = f.path.split("/"); let node = root;
      for (const p of parts.slice(0, -1)) { if (!node.dirs.has(p)) node.dirs.set(p, { dirs: new Map(), files: [] }); node = node.dirs.get(p); }
      node.files.push(f);
    }
    const out = [];
    const walk = (node, prefix, depth) => {
      for (const [name, sub] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
        let label = name, path = prefix + name, n = sub;
        while (n.dirs.size === 1 && !n.files.length) { const [[k, v]] = n.dirs; label += "/" + k; path += "/" + k; n = v; }
        const inside = files.filter((f) => f.path.startsWith(path + "/"));
        out.push({ id: path + "/", dir: path, depth, name: label, files: inside, text: path });
        if (!this.collapsed.has(path)) walk(n, path + "/", depth + 1);
      }
      for (const f of node.files.sort((a, b) => a.path.localeCompare(b.path))) out.push({ id: f.untracked ? f.path + "?" : f.path, file: f, depth, name: f.path.slice(prefix.length), text: f.path });
    };
    walk(root, "", 0);
    return out;
  }

  current(view = this.view) {
    const rows = this.rows(view), i = Math.min(this.sel[view] ?? 0, rows.length - 1);
    return i < 0 ? null : rows[i];
  }

  // The commit or ref a row stands for, if any.
  refOf(row) {
    if (!row) return null;
    const todoHash = row.todo && /^[0-9a-f]{7,40}$/.test(row.todo.rest.split(" ")[0]) ? row.todo.rest.split(" ")[0] : null;
    return row.commit?.hash ?? row.reflog?.hash ?? row.branch?.name ?? row.rbranch?.name ?? row.tag?.name ?? todoHash;
  }

  // Tells the diff pane what's selected.
  show(cx) {
    // An empty list still tells the diff: committing everything mustn't leave the old file shown.
    const row = this.current() ?? {}, repo = this.repo;
    if (!repo) return;
    const files = row.file ? [row.file] : row.files, ref = this.refOf(row);
    const short = (r) => /^[0-9a-f]{40}$/.test(r) ? r.slice(0, 7) : r;
    let s;
    if (row.file?.conflict) s = { kind: "conflict", path: row.file.path, title: `Conflicts in ${row.file.path}` };
    else if (files) s = { kind: "file", path: row.file?.path ?? row.dir, untracked: row.file?.untracked, staged: files.some((f) => f.staged), unstaged: files.some((f) => f.unstaged), title: row.file?.path ?? row.dir + "/" };
    else if (this.diffBase && ref) s = { kind: "range", from: this.diffBase, to: ref, title: `${short(this.diffBase)} → ${short(ref)}` };
    else if (row.commit || row.reflog || (row.todo && ref)) {
      const c = row.commit ?? row.reflog ?? { short: short(ref), subject: row.todo.rest.split(" ").slice(1).join(" ") };
      s = { kind: "commit", hash: ref, title: `${c.short} ${c.subject}` };
    }
    else if (row.stash) s = { kind: "stash", ref: row.stash.ref, title: `${row.stash.ref}: ${row.stash.subject}` };
    else if (ref) s = { kind: "branch", name: ref, title: `Log of ${ref}` };
    else if (row.worktree) s = { kind: "branch", name: row.worktree.head, title: `${row.worktree.branch || "(detached)"} at ${row.worktree.path}` };
    else if (row.remote) s = { kind: "remote", name: row.remote.name, title: `Branches of ${row.remote.name}` };
    else if (row.sub && row.sub.state !== "-") s = { kind: "status", title: `${row.sub.path}: all branches`, repo: { root: `${repo.root}/${row.sub.path}`, on: repo.on } };
    else s = { kind: "status", title: "All branches" };
    // A folder's untracked files can't share one `diff --no-index`: the diff runs one per file (50 at most).
    if (row.dir) { const news = files.filter((f) => f.untracked).map((f) => f.path); if (news.length) s = { ...s, news: news.slice(0, 50) }; }
    // Sent once the selection rests 60 ms: every setShared redraws every mod and the diff runs git,
    // so a held arrow key sends only where it stops. `edits` reloads a file edited again.
    // A graph reloads when a ref or HEAD moves (an action picked in it included).
    const stamp = s.kind === "file" || s.kind === "conflict" ? [this.stamp, this.edits ?? 0]
      : ["branch", "remote", "status"].includes(s.kind) && !s.repo ? JSON.stringify([this.head.oid, this.branches, this.remoteBranches, this.tags]) : undefined;
    this.next = { repo, ...s, stamp };
    const gen = this.sendGen = (this.sendGen ?? 0) + 1;
    cx.timer.after(60, () => {
      if (gen !== this.sendGen) return;
      const t0 = Date.now(); // PERF
      if (JSON.stringify(this.next) !== JSON.stringify(shared("smart-git:show"))) setShared("smart-git:show", this.next);
      perf("setShared show", t0); // PERF
    });
  }

  // The diff pane beside the focused tab's panes, opened once.
  ensureDiff(cx) {
    const tab = focused()?.tab;
    if (!tab || panes().some((p) => p.tab === tab && p.mod === "smart-git")) return;
    run("pane.split", { direction: "right", mod: "smart-git", props: { view: "diff" } });
    cx.spawn(async (cx) => { await cx.sleep(150); this.handle.focus(); cx.notify(); });
  }

  // Enter: the diff pane zoomed to the whole tab (its Esc brings the layout back).
  focusDiff() {
    const tab = focused()?.tab, pane = panes().find((p) => p.tab === tab && p.mod === "smart-git");
    if (pane) run(pane.zoomed ? "pane.focus" : "pane.zoom", { pane: pane.pane });
  }

  select(panel, index, cx) {
    this.panel = panel;
    const view = this.view, rows = this.rows(view);
    this.sel[view] = Math.max(0, Math.min(index, rows.length - 1));
    if (this.folded.delete(panel)) setShared("smart-git:folded", [...this.folded]);
    this.scrolls[panel].scroll_to_item(this.sel[view]);
    this.show(cx); this.ensureDiff(cx); cx.notify();
  }

  setTab(panel, tab, cx) {
    if (tab !== "remotes") this.inRemote = null;
    this.tabs[panel] = tab; setShared("smart-git:tabs", this.tabs);
    if (tab === "submodules") this.refresh(cx);
    this.select(panel, this.sel[this.viewOf(panel)] ?? 0, cx);
  }

  // Runs one change, shows what failed, and reloads.
  // An action that is only waiting on a dialog doesn't block: the new one cancels that dialog.
  act(label, work, cx) {
    // A hot reload can stop the running action before it unlocks: pressing again runs anyway.
    if (this.busy && !asking() && this.refused !== label) { this.refused = label; this.note = `Still ${this.busy} Press again to run anyway.`; cx.notify(); return; }
    this.refused = null;
    cancelAsks();
    const n = this.acts = (this.acts ?? 0) + 1;
    this.busy = label; this.note = null; this.info = null; cx.notify();
    cx.spawn(async (cx) => {
      askFrom(cx, this.handle);
      try { await work(cx); }
      catch (e) { this.note = String(e.message ?? e); }
      finally { if (this.acts === n) this.busy = null; this.refresh(cx); cx.notify(); }
    });
  }

  w(args, opts) { return git(this.repo, args, { write: true, ...opts }); }

  // A command that needs a person (an editor, a password) in a terminal under the focused pane.
  // The editor picked with E (if any) is the one git opens there.
  inTerminal(argv, folder = this.repo.root) {
    const ed = shared("smart-git:editor");
    run("terminal.open", { argv: argv && ed ? ["env", `GIT_EDITOR=${ed}`, ...argv] : argv, folder, place: "down" });
  }

  edit(path, cx, line) { return openEditor(this.repo, path, line, cx); }

  // E: which editor e, C and R open; only the ones installed are offered.
  async pickEditor() {
    const r = await exec("sh", ["-c", "for e in micro nano nvim vim vi hx emacs; do command -v $e >/dev/null && echo $e; done"], { on: this.repo.on });
    const cur = shared("smart-git:editor");
    const items = r.stdout.split("\n").filter(Boolean).map((e, n) => ({ key: String(n + 1), label: e === cur ? `${e} ✓` : e, value: e }));
    const pick = await ask({ title: "Editor", items: [...items,
      { key: "c", label: "Custom command…", value: "custom" },
      { key: "d", label: cur ? "Default ($VISUAL / $EDITOR)" : "Default ($VISUAL / $EDITOR) ✓", value: "default" }] });
    if (!pick) return;
    if (pick === "default") return setShared("smart-git:editor", null);
    if (pick !== "custom") return setShared("smart-git:editor", pick);
    const c = await ask({ title: "Editor command", input: { value: cur ?? "", placeholder: "e.g. code --wait" } });
    if (c?.text.trim()) setShared("smart-git:editor", c.text.trim());
  }

  // Opens a page of the repo's forge (GitHub, GitLab, …) in the browser.
  async browse(path) {
    const remote = this.head.upstream?.split("/")[0] || this.remotes.find((r) => r.name === "origin")?.name || this.remotes[0]?.name;
    if (!remote) throw new Error("No remote to open");
    const url = (await git(this.repo, ["remote", "get-url", remote])).trim()
      .replace(/^git@([^:]+):/, "https://$1/").replace(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\//, "https://$1/").replace(/\.git$/, "");
    if (!url.startsWith("http")) throw new Error(`Can't open ${url} in a browser`);
    await exec("xdg-open", [`${url}/${path}`]);
  }

  // --- Files ---
  async toggleStage(row) {
    const files = row.file ? [row.file] : row.files, paths = files.map((f) => f.path);
    if (files.some((f) => f.unstaged)) return this.w(["add", "--", ...paths]);
    if (this.commits.length) return this.w(["restore", "--staged", "--", ...paths]);
    return this.w(["rm", "--cached", "-r", "-q", "--", ...paths]);
  }

  async discard(row, unstagedOnly) {
    const files = row.file ? [row.file] : row.files;
    const untracked = files.filter((f) => f.untracked).map((f) => f.path);
    const added = files.filter((f) => !f.untracked && f.x === "A").map((f) => f.path);
    const tracked = files.filter((f) => !f.untracked && f.x !== "A").map((f) => f.path);
    if (untracked.length) await this.w(["clean", "-f", "--", ...untracked]);
    if (unstagedOnly) { if (tracked.length || added.length) await this.w(["restore", "--worktree", "--", ...tracked, ...added]); return; }
    if (added.length) await this.w(["rm", "-f", "-q", "--", ...added]);
    if (tracked.length) await this.w(["restore", "--source=HEAD", "--staged", "--worktree", "--", ...tracked]);
  }

  // Commits with the commit box's subject and description; with nothing staged, everything (after asking).
  async commit({ noVerify = false } = {}) {
    const subject = this.subject.value().trim(), body = this.body.value().trim();
    if (!subject) return this.subject.focus();
    if (!this.files.some((f) => f.staged)) {
      if (!this.files.length) throw new Error("Nothing to commit");
      if (!await confirm("No files staged", "Stage all files and commit?", "Stage all and commit", false)) return;
      await this.w(["add", "-A"]);
    }
    await this.w(["commit", "-m", subject, ...(body ? ["-m", body] : []), ...(noVerify ? ["--no-verify"] : [])], { timeout: 120000 });
    this.subject.set_value(""); this.body.set_value(""); this.handle.focus();
  }

  // I: an agent CLI writes the commit box's subject and description from the staged changes
  // (everything, when nothing is staged).
  async generate(cx) {
    if (!this.files.length) throw new Error("Nothing to commit");
    const a = await this.chosenAgent();
    if (!a) { throw new Error("No installed agent can write commit messages yet: ctrl-i sets one up"); }
    this.busy = `Writing message with ${a.name}…`; cx.notify();
    const staged = this.files.some((f) => f.staged);
    let [diff, log] = await Promise.all([
      git(this.repo, ["diff", "--no-color", "--no-ext-diff", staged ? "--cached" : "HEAD"]).catch(() => ""),
      git(this.repo, ["log", "-10", "--format=%s"]).catch(() => ""),
    ]);
    if (diff.length > 10000) diff = diff.slice(0, 10000) + "\n\n[... diff truncated ...]";
    const files = this.files.filter((f) => !staged || f.staged).map((f) => `${f.x}${f.y} ${f.path}`).join("\n");
    // The branch name and recent subjects let it follow the repo's own style (scopes, ticket ids).
    const prompt = `${PROMPT}Branch: ${this.head.branch}\n\nRecent commit subjects (follow their style):\n${log}\nFiles:\n${files}\n\nDiff:\n${diff}`;
    const opts = { cwd: this.repo.root, on: this.repo.on, timeout: 180000 };
    const model = a.model ?? a.recipe?.fast;
    // No stdin: some agents (codex) wait to read it when it isn't a terminal.
    const r = a.custom ? await exec("sh", ["-c", `${a.custom} "$1" </dev/null`, "sh", prompt], opts)
      : await exec("sh", ["-c", 'exec "$@" </dev/null', "sh", a.bin, ...a.recipe.args.map((x) => x === "{prompt}" ? prompt : x), ...(model && a.recipe.model ? [a.recipe.model, model] : [])], opts);
    let m = null;
    try { m = JSON.parse(/\{[\s\S]*\}/.exec(r.stdout)?.[0]); } catch {}
    if (!m?.subject) throw new Error(`${a.name} wrote no commit message: ${(r.stderr.trim() || r.stdout.trim()).slice(-300)}`);
    this.subject.set_value(m.subject.trim()); this.body.set_value(String(m.body ?? "").trim());
    this.subject.focus();
  }

  // The agents installed on the repo's machine, from Herdr's table (most picked first), each with
  // how it answers one prompt (null: not set up).
  async usableAgents() {
    const setups = shared("smart-git:recipes") ?? {};
    return (await knownAgents({ on: this.repo.on })).filter((a) => a.installed)
      .map((a) => ({ key: a.key, name: a.name, bin: a.run[0], recipe: setups[a.key] ?? RECIPES[a.key] ?? null }));
  }

  // Auto: the agent most recently busy in this space (signed in, and likely the one that made the
  // changes), else the most picked one; with its fast model.
  autoAgent(list) {
    const space = focused()?.space, ready = list.filter((a) => a.recipe);
    const here = agents().filter((x) => x.space === space).sort((x, y) => y.seq - x.seq)
      .map((x) => ready.find((a) => a.key === x.program.key)).find(Boolean);
    const a = here ?? ready[0];
    return a ? { ...a, model: null, why: here ? "running in this space" : "you use most" } : null;
  }

  // The saved choice (smart-git:agent): null for Auto, { key, model }, or { custom } (a plain string: custom).
  savedAgent() { const s = shared("smart-git:agent"); return typeof s === "string" ? { custom: s } : s ?? null; }

  // What writes the message: the saved choice, else Auto.
  async chosenAgent() {
    const pick = this.savedAgent();
    if (pick?.custom) return { name: pick.custom, custom: pick.custom };
    const list = await this.usableAgents(), a = pick && list.find((x) => x.key === pick.key && x.recipe);
    return a ? { ...a, model: pick.model ?? null } : this.autoAgent(list);
  }

  // ctrl-i, or right-click ✨: the agent and model that write commit messages. Every installed agent
  // is offered; one without a known recipe is set up once. `save` false: for one message only.
  async pickAgent(save = true) {
    const list = await this.usableAgents(), cur = save ? this.savedAgent() : undefined, auto = this.autoAgent(list);
    const mark = (on) => on ? " ✓" : "";
    const pick = await ask({ title: save ? "Agent for commit messages" : "Write this message with…", items: [
      { key: "0", label: `Auto · ${auto ? auto.name + (auto.recipe.fast ? ` · ${auto.recipe.fast}` : "") : "none ready"}${mark(cur === null)}`, value: "auto",
        hint: auto ? `The agent ${auto.why}, with its fast model.` : "Set up one of the agents below first." },
      ...list.map((a, n) => ({ key: KEYS[n] ?? "", value: a.key,
        label: `${a.name}${a.recipe ? "" : " · set up…"}${mark(cur?.key === a.key)}${cur?.key === a.key && cur.model ? ` (${cur.model})` : ""}`,
        hint: a.recipe ? `${a.bin} ${a.recipe.args.join(" ")}` : `Tell Smart Git how ${a.bin} answers one prompt and exits.` })),
      { key: "!", label: `Custom command…${mark(Boolean(cur?.custom))}`, value: "custom", hint: "Any CLI that prints its answer, the prompt as its last argument." },
    ] });
    if (!pick) return null;
    if (pick === "auto") { if (save) setShared("smart-git:agent", null); return auto; }
    if (pick === "custom") {
      const c = (await ask({ title: "Agent command", detail: "The prompt is added as its last argument.", input: { value: cur?.custom ?? "", placeholder: "e.g. llm -m gpt-4o-mini" } }))?.text.trim();
      if (!c) return null;
      if (save) setShared("smart-git:agent", { custom: c });
      return { name: c, custom: c };
    }
    let a = list.find((x) => x.key === pick);
    if (!a.recipe) {
      const r = await ask({ title: `Set up ${a.name}`, detail: `The arguments that make ${a.bin} answer one prompt and exit; {prompt} marks where the prompt goes.`, input: { placeholder: "e.g. -p {prompt}" } });
      const args = r?.text.trim().split(/\s+/).filter(Boolean);
      if (!args?.length) return null;
      if (!args.includes("{prompt}")) args.push("{prompt}");
      a = { ...a, recipe: { args } };
      setShared("smart-git:recipes", { ...(shared("smart-git:recipes") ?? {}), [a.key]: a.recipe });
    }
    const model = await this.pickModel(a, cur?.key === a.key ? cur.model : undefined);
    if (model === undefined) return null;
    if (save) setShared("smart-git:agent", { key: a.key, model });
    return { ...a, model };
  }

  // An agent's model: its list (asked of the CLI when it can print one; by provider first when long),
  // its default, or one typed in. null: the default; undefined: cancelled.
  async pickModel(a, current) {
    const r = a.recipe;
    if (!r.model) return null;
    let models = r.models ?? [], prefix = "";
    if (!models.length && r.list) models = modelIds((await exec(a.bin, r.list, { on: this.repo.on, timeout: 30000 }).catch(() => ({ stdout: "" }))).stdout);
    const providers = [...new Set(models.filter((m) => m.includes("/")).map((m) => m.split("/")[0]))];
    if (models.length > 20 && providers.length > 1) {
      prefix = await ask({ title: `${a.name}: provider`, items: providers.map((p, n) => ({ key: KEYS[n] ?? "", label: p, value: p + "/" })) });
      if (!prefix) return undefined;
      models = models.filter((m) => m.startsWith(prefix));
    }
    const pick = await ask({ title: `${a.name}: model`, items: [
      { key: "0", label: `Default${r.fast ? ` (${r.fast}, fast)` : " (the CLI's own)"}${current === null ? " ✓" : ""}`, value: "default" },
      ...models.map((m, n) => ({ key: KEYS[n] ?? "", label: m.slice(prefix.length) + (m === current ? " ✓" : ""), value: m })),
      { key: "!", label: "Other model…", value: "other" }] });
    if (!pick) return undefined;
    if (pick === "default") return null;
    if (pick !== "other") return pick;
    return (await ask({ title: `${a.name}: model`, input: { value: current ?? "", placeholder: "model id" } }))?.text.trim() || undefined;
  }

  async ignore(row) {
    const path = "/" + (row.file?.path ?? row.dir + "/");
    const where = await ask({ title: `Ignore ${path}`, items: [{ key: "i", label: "Add to .gitignore", value: ".gitignore" }, { key: "e", label: "Add to .git/info/exclude", value: `${this.gitDir}/info/exclude` }] });
    if (!where) return;
    const r = await exec("sh", ["-c", 'printf "%s\\n" "$1" >> "$2"', "sh", path, where], { cwd: this.repo.root, on: this.repo.on });
    if (r.code !== 0) throw new Error(r.stderr.trim());
  }

  // --- Submodules ---
  // The repo a submodule is recorded in (its parent for a nested one); act on `sub.rel` there.
  subRepo(s) { return { root: s.parent ? `${this.repo.root}/${s.parent}` : this.repo.root, on: this.repo.on }; }

  // Goes into a submodule, through every submodule it's nested in.
  enter(path, cx) {
    const s = this.submodules.find((o) => o.path === path);
    if (s?.state === "-") { this.note = `${path} isn't checked out yet: u updates it`; return; }
    const chain = this.submodules.filter((o) => path.startsWith(o.path + "/")).sort((a, b) => a.path.length - b.path.length).map((o) => o.path);
    this.go([...this.stack, ...[...chain, path].map((p) => ({ root: `${this.repo.root}/${p}`, on: this.repo.on }))], cx);
  }

  // A changed submodule back to the commit its parent records, its own changes stashed.
  async resetSub(path) {
    if (!await confirm(`Reset submodule ${path}?`, "Its uncommitted changes are stashed (in the submodule), and it goes back to the commit this repo records.", "Reset submodule")) return;
    await git({ root: `${this.repo.root}/${path}`, on: this.repo.on }, ["stash", "push", "--include-untracked", "-m", "smart-git: submodule reset"], { write: true });
    await this.w(["submodule", "update", "--init", "--force", "--recursive", "--", path], { timeout: 300000 });
  }

  // --- Remote ---
  async push(force = false) {
    const h = this.head;
    let args = ["push", ...(force ? ["--force-with-lease"] : [])];
    if (!h.upstream) {
      const r = await ask({ title: "Push to (remote branch)", input: { value: `${this.remotes[0]?.name ?? "origin"} ${h.branch}` } });
      if (!r?.text.trim()) return;
      args = ["push", "--set-upstream", ...r.text.trim().split(/\s+/)];
    }
    try { await this.w(args, { timeout: 300000 }); }
    catch (e) { await this.remoteFailed(e, args, () => this.push(true)); }
  }

  // Runs a command that talks to a remote, handing it to a terminal when it needs a person.
  remote(args, timeout = 300000) { return this.w(args, { timeout }).catch((e) => this.remoteFailed(e, args)); }

  async remoteFailed(e, args, forced) {
    const text = String(e.message ?? e);
    if (forced && /rejected|non-fast-forward|fetch first/.test(text)) {
      if (await confirm("Push rejected", "The remote has commits you don't. Force push with lease?", "Force push (--force-with-lease)")) return forced();
      return;
    }
    if (/could not read|terminal prompts disabled|Permission denied|passphrase|Authentication failed|Host key/i.test(text)) {
      if (await confirm("git needs you", text, `Run git ${args[0]} in a terminal`, false)) this.inTerminal(["git", ...args]);
      return;
    }
    throw e;
  }

  // --- History ---
  newBranch(from, cx, label = from) {
    this.act("Creating branch…", async () => {
      const r = await ask({ title: `New branch from ${label}`, input: { placeholder: "Branch name" } });
      if (r?.text.trim()) await this.w(["checkout", "-b", r.text.trim().replace(/\s+/g, "-"), from]);
    }, cx);
  }

  async resetTo(hash, short, subject) {
    const r = await ask({ title: `Reset ${this.head.branch || "HEAD"} to ${short}`, detail: subject, items: [
      { key: "s", label: "Soft: keep changes staged", value: "--soft", hint: "The changes of the commits left behind stay, staged, ready to commit again. Your working files don't change." },
      { key: "m", label: "Mixed: keep changes unstaged", value: "--mixed", hint: "The changes of the commits left behind stay in your files, unstaged. Nothing is lost." },
      { key: "h", label: "Hard: discard all changes", value: "--hard", danger: true, hint: "Your files become exactly this commit: the commits' changes and any uncommitted work are thrown away. Uncommitted work can't be recovered." },
    ] });
    if (r) await this.w(["reset", r, "-q", hash]);
  }

  // History rewriting starts only from a quiet repo, on commits of the checked out branch.
  async rewrite(hash, change, opts) {
    const op = this.ops.find((o) => o !== "BISECT_LOG");
    if (op) throw new Error(`Finish the ${OPS[op].toLowerCase()} first (m)`);
    await rebaseWith(this.repo, hash, change, opts);
  }
  // The todo entry of a commit (by its full hash).
  static at(todo, hash) { const t = todo.find((x) => x.rest.startsWith(hash)); if (!t) throw new Error("That commit isn't on the checked out branch"); return t; }

  // Rewrites the todo of the rebase in progress.
  async editTodo(change) {
    const todo = this.todo.map((t) => ({ ...t }));
    change(todo);
    const r = await writeThere(this.repo, `${this.gitDir}/rebase-merge/git-rebase-todo`, todo.map((t) => `${t.action} ${t.rest}`.trim()).join("\n") + "\n");
    if (r.code !== 0) throw new Error(r.stderr.trim());
  }

  async undo() {
    const log = parseReflog(await git(this.repo, ["reflog", `--format=${REFLOG_FORMAT}`, "-n", "2"]));
    if (log.length < 2) throw new Error("Nothing to undo");
    const m = /^checkout: moving from (\S+) to (\S+)$/.exec(log[0].subject);
    if (m) { if (await confirm(`Undo: check out ${m[1]} again?`, log[0].subject, "Check out", false)) await this.w(["checkout", m[1]]); return; }
    // --keep keeps uncommitted changes, and refuses if they'd be lost.
    if (await confirm(`Undo "${log[0].subject}"?`, `Moves ${this.head.branch || "HEAD"} back to ${log[1].short} (reset --keep HEAD@{1}). z again redoes it.`, "Undo"))
      await this.w(["reset", "--keep", "-q", "HEAD@{1}"]);
  }

  // Every key, list first (lazygit's defaults). A labelled one is also in the right-click
  // menu, the ? menu and the hints.
  actions(cx) {
    const view = this.picked?.view ?? this.view, row = this.picked?.row ?? this.current(), rows = this.rows(view), i = this.sel[view] ?? 0;
    const index = PANELS.findIndex((p) => p.id === this.panel);
    const move = (n) => this.select(this.panel, i + n, cx);
    const act = (label, work) => this.act(label, work, cx);
    const changed = row?.file ? [row.file] : row?.files ?? [];
    const stages = changed.some((f) => f.unstaged), stagesAll = this.files.some((f) => f.unstaged);
    const ref = this.refOf(row), short = row?.commit?.short ?? row?.reflog?.short ?? ref;
    const remoteOf = (name) => [name.slice(0, name.indexOf("/")), name.slice(name.indexOf("/") + 1)];
    const copy = ["Copy name", () => ref && cx.write_to_clipboard(ref)];
    const diffAgainst = ["Diff against this (W again to stop)", () => { if (ref) { this.diffBase = this.diffBase === ref ? null : ref; this.show(cx); } }];
    const mergeRebase = {
      M: ["Merge into the current branch", () => ref && act(`Merging ${ref}…`, async () => {
        if (await confirm(`Merge ${ref} into ${this.head.branch}?`, null, "Merge", false)) await this.w(["merge", "--no-edit", ref], { timeout: 120000 });
      })],
      r: ["Rebase the current branch onto this", () => ref && act(`Rebasing onto ${ref}…`, async () => {
        if (await confirm(`Rebase ${this.head.branch} onto ${ref}?`, null, "Rebase", false)) await this.w(["rebase", "--autostash", ref], { timeout: 120000 });
      })],
    };
    const panelKeys = {
      files: {
        space: [stages ? "Stage" : "Unstage", () => row && act(stages ? "Staging…" : "Unstaging…", () => this.toggleStage(row))],
        enter: [row?.file?.sub ? "Open submodule" : row?.dir ? "Fold folder" : "View diff (stage lines)", () => {
          if (row?.dir) { this.collapsed.has(row.dir) ? this.collapsed.delete(row.dir) : this.collapsed.add(row.dir); }
          else if (row?.file?.sub) this.enter(row.file.path, cx);
          else this.focusDiff();
        }],
        a: [stagesAll ? "Stage all" : "Unstage all", () => act(stagesAll ? "Staging all…" : "Unstaging all…", () => stagesAll ? this.w(["add", "-A"]) : this.w(["reset", "-q"]))],
        "|1": null,
        c: ["Write commit message", () => this.subject.focus()],
        I: ["Write it with AI", () => act("Writing message…", (cx) => this.generate(cx))],
        w: ["Commit without hooks", () => act("Committing…", () => this.commit({ noVerify: true }))],
        C: ["Commit in your editor", () => this.inTerminal(["git", "commit"])],
        "|2": null,
        d: [row?.file?.sub ? "Reset submodule" : "Discard…", () => row && act("Discarding…", async () => {
          if (row.file?.sub) return this.resetSub(row.file.path);
          const files = row.file ? [row.file] : row.files, items = [{ key: "x", label: "Discard all changes", value: "all", danger: true }];
          if (files.some((f) => f.staged) && files.some((f) => f.unstaged && !f.untracked)) items.push({ key: "u", label: "Discard unstaged changes", value: "unstaged", danger: true });
          const r = await ask({ title: `Discard ${row.file?.path ?? row.dir + "/"}`, items });
          if (r) await this.discard(row, r === "unstaged");
        })],
        D: ["Reset…", () => act("Resetting…", async () => {
          const up = this.head.upstream;
          const r = await ask({ title: "Reset", items: [
            { key: "x", label: "Nuke working tree (reset --hard, clean -fd)", value: "nuke", danger: true },
            { key: "u", label: "Discard unstaged changes", value: "unstaged", danger: true },
            { key: "c", label: "Discard untracked files", value: "untracked", danger: true },
            { key: "S", label: "Unstage everything", value: "unstage" },
            ...(up ? [
              { key: "s", label: `Soft reset to ${up}`, value: "--soft" },
              { key: "m", label: `Mixed reset to ${up}`, value: "--mixed" },
              { key: "h", label: `Hard reset to ${up}`, value: "--hard", danger: true },
            ] : []),
          ] });
          if (r === "nuke") { await this.w(["reset", "--hard", "-q"]); await this.w(["clean", "-fd"]); }
          else if (r === "unstaged") await this.w(["checkout", "--", "."]);
          else if (r === "untracked") await this.w(["clean", "-fd"]);
          else if (r === "unstage") await this.w(["reset", "-q"]);
          else if (r) await this.w(["reset", r, "-q", up]);
        })],
        ...(row?.file?.conflict ? { M: ["Resolve conflict…", () => act("Resolving…", async () => {
          const p = row.file.path;
          const r = await ask({ title: `Resolve ${p}`, detail: "enter on the file picks conflict by conflict in the diff pane.", items: [
            { key: "o", label: "Keep ours (the checked out side)", value: "--ours" },
            { key: "t", label: "Keep theirs (the incoming side)", value: "--theirs" },
            { key: "m", label: "Open git mergetool in a terminal", value: "tool" },
          ] });
          if (r === "tool") return this.inTerminal(["git", "mergetool", "--", p]);
          if (r) { await this.w(["checkout", r, "--", p]); await this.w(["add", "--", p]); }
        })] } : {}),
        "|3": null,
        s: ["Stash all changes…", () => act("Stashing…", async () => {
          const r = await ask({ title: "Stash all changes", input: { placeholder: "Stash message (optional)" } });
          if (r) await this.w(["stash", "push", "--include-untracked", ...(r.text.trim() ? ["-m", r.text.trim()] : [])]);
        })],
        S: ["Stash some…", () => act("Stashing…", async () => {
          const r = await ask({ title: "Stash", items: [
            { key: "i", label: "Stash all changes and keep index", value: ["--include-untracked", "--keep-index"] },
            { key: "s", label: "Stash staged changes", value: ["--staged"] },
            { key: "u", label: "Stash unstaged changes", value: ["--keep-index"] },
          ] });
          if (!r) return;
          const m = await ask({ title: "Stash message", input: { placeholder: "Optional" } });
          if (m) await this.w(["stash", "push", ...r, ...(m.text.trim() ? ["-m", m.text.trim()] : [])]);
        })],
        "|4": null,
        ...(row?.file ? {
          e: ["Open in your editor", () => act("Opening editor…", (cx) => this.edit(row.file.path, cx))],
          ...(this.repo.on ? {} : { o: ["Open with the default app", () => exec("xdg-open", [`${this.repo.root}/${row.file.path}`])] }),
        } : {}),
        i: ["Add to .gitignore", () => row && act("Ignoring…", () => this.ignore(row))],
        "|5": null,
        "`": [this.tree ? "Show as a flat list" : "Show as a tree", () => { this.tree = !this.tree; setShared("smart-git:tree", this.tree); this.select("files", 0, cx); }],
        // Collapsing all needs every folder, nested ones too: list them with nothing collapsed.
        ...(this.tree ? { "-": ["Collapse all folders", () => {
          const id = row?.id;
          this.collapsed = new Set();
          this.collapsed = new Set(this.rows("files").filter((r) => r.dir).map((r) => r.dir));
          this.select("files", Math.max(0, this.rows("files").findIndex((r) => r.id === id)), cx);
        }],
        "=": ["Expand all folders", () => {
          const id = row?.id;
          this.collapsed = new Set();
          this.select("files", Math.max(0, this.rows("files").findIndex((r) => r.id === id)), cx);
        }] } : {}),
      },
      worktrees: {
        enter: ["Switch to this worktree", () => row && this.go([{ root: row.id, on: this.repo.on }], cx)],
        space: () => row && this.go([{ root: row.id, on: this.repo.on }], cx),
        o: ["Open a terminal there", () => row && this.inTerminal(undefined, row.id)],
        "|11": null,
        n: ["New worktree", () => act("Creating worktree…", async () => {
          const r = await ask({ title: "New worktree", detail: "A branch to check out, or a new one (from HEAD).", input: { placeholder: "Branch" } });
          const b = r?.text.trim();
          if (!b) return;
          const main = this.worktrees[0]?.path ?? this.repo.root;
          const p = await ask({ title: "Worktree folder", input: { value: `${main.slice(0, main.lastIndexOf("/"))}/${main.split("/").pop()}-${b.replace(/\//g, "-")}` } });
          if (!p?.text.trim()) return;
          const exists = this.branches.some((x) => x.name === b);
          await this.w(["worktree", "add", ...(exists ? [p.text.trim(), b] : ["-b", b, p.text.trim()])]);
        })],
        d: ["Remove worktree", () => row && act("Removing worktree…", async () => {
          if (row.id === this.worktrees[0]?.path) throw new Error("That's the main worktree");
          if (!await confirm(`Remove worktree ${row.id}?`, row.worktree.branch, "Remove")) return;
          try { await this.w(["worktree", "remove", row.id]); }
          catch (e) {
            if (!/modified or untracked|locked/.test(String(e.message))) throw e;
            if (await confirm("It has uncommitted changes", String(e.message), "Remove anyway (--force)")) await this.w(["worktree", "remove", "--force", row.id]);
          }
        })],
      },
      submodules: {
        enter: ["Open submodule", () => row && this.enter(row.id, cx)],
        u: ["Update (check out the recorded commit)", () => row && act("Updating…", () => {
          const repo = this.subRepo(row.sub), args = ["submodule", "update", "--init", "--recursive", "--", row.sub.rel];
          return git(repo, args, { write: true, timeout: 300000 }).catch((e) => this.remoteFailed(e, ["-C", repo.root, ...args]));
        })],
        i: ["Init", () => row && act("Initializing…", () => git(this.subRepo(row.sub), ["submodule", "init", "--", row.sub.rel], { write: true }))],
        b: ["All submodules…", () => act("Updating submodules…", async () => {
          const r = await ask({ title: "All submodules", items: [
            { key: "i", label: "Init all", value: ["submodule", "init"] },
            { key: "u", label: "Update all (recursively)", value: ["submodule", "update", "--init", "--recursive"] },
            { key: "s", label: "Sync URLs (recursively)", value: ["submodule", "sync", "--recursive"] },
            { key: "d", label: "Deinit all", value: ["submodule", "deinit", "--all", "-f"], danger: true },
          ] });
          if (r) await this.remote(r);
        })],
        "|13": null,
        n: ["Add submodule", () => act("Adding submodule…", async () => {
          const u = await ask({ title: "Add submodule", input: { placeholder: "Repository URL" } });
          if (!u?.text.trim()) return;
          const p = await ask({ title: "Submodule path", input: { value: u.text.trim().replace(/\/$/, "").split(/[/:]/).pop().replace(/\.git$/, "") } });
          if (p?.text.trim()) await this.remote(["submodule", "add", "--", u.text.trim(), p.text.trim()]);
        })],
        e: ["Edit URL", () => row && act("Updating URL…", async () => {
          const r = await ask({ title: `URL of ${row.sub.rel}`, input: { value: row.sub.url } });
          if (!r?.text.trim() || r.text.trim() === row.sub.url) return;
          const repo = this.subRepo(row.sub);
          await git(repo, ["config", "--file", ".gitmodules", `submodule.${row.sub.name}.url`, r.text.trim()], { write: true });
          await git(repo, ["submodule", "sync", "--", row.sub.rel], { write: true });
        })],
        d: ["Remove submodule", () => row && act("Removing submodule…", async () => {
          const what = "Deinitializes it, removes it from .gitmodules and the index, and deletes its folder and its copy under .git/modules.";
          if (!await confirm(`Remove submodule ${row.id}?`, what, "Remove")) return;
          const repo = this.subRepo(row.sub);
          await git(repo, ["submodule", "deinit", "-f", "--", row.sub.rel], { write: true });
          await git(repo, ["rm", "-f", "-q", "--", row.sub.rel], { write: true });
          const dir = (await git(repo, ["rev-parse", "--git-path", `modules/${row.sub.name}`])).trim();
          await exec("rm", ["-rf", "--", dir], { cwd: repo.root, on: repo.on });
        })],
        "|15": null,
        y: ["Copy path", () => row && cx.write_to_clipboard(row.id)],
        o: ["Open a terminal in it", () => row && this.inTerminal(undefined, `${this.repo.root}/${row.id}`)],
        s: ["Open as a new space", () => row && run("space.new", { folder: `${this.repo.root}/${row.id}`, machine: this.repo.on ?? "" })],
      },
      branches: {
        space: ["Check out", () => row && !row.branch.current && act(`Checking out ${row.id}…`, () => this.w(["checkout", row.id]))],
        enter: ["View log", () => this.focusDiff()],
        c: ["Check out by name", () => act("Checking out…", async () => {
          const r = await ask({ title: "Check out", input: { placeholder: "Branch, tag or commit" } });
          if (r?.text.trim()) await this.w(["checkout", r.text.trim()]);
        })],
        "-": ["Check out previous", () => act("Checking out previous…", () => this.w(["checkout", "-"]))],
        "|16": null,
        n: ["New branch from here", () => this.newBranch(row?.branch.name ?? "HEAD", cx)],
        d: ["Delete", () => row && !row.branch.current && act(`Deleting ${row.id}…`, async () => {
          if (!await confirm(`Delete branch ${row.id}?`, row.branch.subject, "Delete")) return;
          try { await this.w(["branch", "-d", row.id]); }
          catch (e) {
            if (!/not fully merged/.test(String(e.message))) throw e;
            if (await confirm(`${row.id} is not fully merged`, "Its commits are on no other branch. Delete anyway?", "Force delete (-D)")) await this.w(["branch", "-D", row.id]);
          }
        })],
        R: ["Rename", () => row && act("Renaming…", async () => {
          const r = await ask({ title: `Rename ${row.id}`, input: { value: row.id } });
          if (r?.text.trim() && r.text.trim() !== row.id) await this.w(["branch", "-m", row.id, r.text.trim().replace(/\s+/g, "-")]);
        })],
        "|17": null,
        ...(row?.branch?.current ? {} : mergeRebase),
        "|18": null,
        u: ["Upstream…", () => row && act("Setting upstream…", async () => {
          const b = row.branch;
          const r = await ask({ title: `Upstream of ${b.name}`, detail: b.upstream || "None", items: [
            { key: "s", label: "Set upstream…", value: "set" },
            ...(b.upstream ? [{ key: "u", label: "Unset upstream", value: "unset" }] : []),
          ] });
          if (r === "unset") await this.w(["branch", "--unset-upstream", b.name]);
          if (r !== "set") return;
          const t = await ask({ title: `Upstream of ${b.name}`, input: { value: b.upstream || `${this.remotes[0]?.name ?? "origin"}/${b.name}` } });
          if (t?.text.trim()) await this.w(["branch", "--set-upstream-to", t.text.trim(), b.name]);
        })],
        f: ["Fast-forward from upstream", () => row && act(`Fast-forwarding ${row.id}…`, async () => {
          const up = row.branch.upstream;
          if (!up) throw new Error(`${row.id} has no upstream (u sets one)`);
          if (row.branch.current) return this.remote(["pull", "--ff-only"]);
          const [remote, branch] = remoteOf(up);
          await this.remote(["fetch", remote, `${branch}:${row.id}`]);
        })],
        "|19": null,
        y: copy,
        o: ["Open in the browser", () => row && act("Opening…", () => this.browse(`tree/${row.branch.upstream ? remoteOf(row.branch.upstream)[1] : row.id}`))],
        W: diffAgainst,
      },
      remotes: {
        enter: ["Show its branches", () => { if (row) { this.inRemote = row.id; this.select("branches", 0, cx); } }],
        f: ["Fetch", () => row && act(`Fetching ${row.id}…`, () => this.remote(["fetch", row.id]))],
        "|20": null,
        n: ["Add remote", () => act("Adding remote…", async () => {
          const n = await ask({ title: "New remote", input: { placeholder: "Name", value: this.remotes.length ? "" : "origin" } });
          if (!n?.text.trim()) return;
          const u = await ask({ title: `URL of ${n.text.trim()}`, input: { placeholder: "URL" } });
          if (!u?.text.trim()) return;
          await this.w(["remote", "add", n.text.trim(), u.text.trim()]);
          await this.remote(["fetch", n.text.trim()]);
        })],
        e: ["Edit URL", () => row && act("Updating URL…", async () => {
          const r = await ask({ title: `URL of ${row.id}`, input: { value: row.remote.url } });
          if (r?.text.trim() && r.text.trim() !== row.remote.url) await this.w(["remote", "set-url", row.id, r.text.trim()]);
        })],
        R: ["Rename", () => row && act("Renaming…", async () => {
          const r = await ask({ title: `Rename ${row.id}`, input: { value: row.id } });
          if (r?.text.trim() && r.text.trim() !== row.id) await this.w(["remote", "rename", row.id, r.text.trim()]);
        })],
        d: ["Remove", () => row && act("Removing remote…", async () => {
          if (await confirm(`Remove remote ${row.id}?`, row.remote.url, "Remove")) await this.w(["remote", "remove", row.id]);
        })],
      },
      "remote-branches": {
        space: ["Check out", () => row && act(`Checking out ${row.id}…`, async () => {
          const local = remoteOf(row.id)[1];
          await this.w(this.branches.some((b) => b.name === local) ? ["checkout", local] : ["checkout", "-b", local, "--track", row.id]);
        })],
        enter: ["View log", () => this.focusDiff()],
        "|21": null,
        n: ["New branch from here", () => this.newBranch(row?.id ?? "HEAD", cx)],
        ...mergeRebase,
        u: ["Set as upstream of the current branch", () => row && act("Setting upstream…", () => this.w(["branch", "--set-upstream-to", row.id]))],
        d: ["Delete on the remote", () => row && act(`Deleting ${row.id}…`, async () => {
          const [remote, branch] = remoteOf(row.id);
          if (await confirm(`Delete ${branch} on ${remote}?`, row.rbranch.subject, "Delete remote branch")) await this.remote(["push", remote, "--delete", branch]);
        })],
        "|24": null,
        y: copy,
        o: ["Open in the browser", () => row && act("Opening…", () => this.browse(`tree/${remoteOf(row.id)[1]}`))],
        W: diffAgainst,
      },
      tags: {
        space: ["Check out", () => row && act(`Checking out ${row.id}…`, async () => {
          if (await confirm(`Check out ${row.id}?`, "You'll be on a detached HEAD.", "Check out", false)) await this.w(["checkout", "--detach", row.id]);
        })],
        enter: ["View log", () => this.focusDiff()],
        "|25": null,
        n: ["New tag at HEAD", () => this.tagAt("HEAD", "HEAD", cx)],
        d: ["Delete", () => row && act(`Deleting ${row.id}…`, async () => {
          const r = await ask({ title: `Delete tag ${row.id}`, items: [
            { key: "l", label: "Delete locally", value: "local", danger: true },
            ...this.remotes.map((rm, n) => ({ key: String(n + 1), label: `Delete locally and on ${rm.name}`, value: rm.name, danger: true })),
          ] });
          if (!r) return;
          if (r !== "local") await this.remote(["push", r, "--delete", `refs/tags/${row.id}`]);
          await this.w(["tag", "-d", row.id]);
        })],
        P: ["Push tag", () => row && act(`Pushing ${row.id}…`, async () => {
          const r = this.remotes.length < 2 ? this.remotes[0]?.name
            : await ask({ title: `Push ${row.id} to`, items: this.remotes.map((rm, n) => ({ key: String(n + 1), label: rm.name, value: rm.name })) });
          if (r) await this.remote(["push", r, `refs/tags/${row.id}`]);
        })],
        "|26": null,
        y: copy,
        W: diffAgainst,
      },
      commits: row?.todo ? {
        // A rebase in progress: change what's still to come.
        enter: ["View commit", () => this.focusDiff()],
        "|29": null,
        p: ["Pick", () => this.setTodo(row, "pick", cx)],
        s: ["Squash into the one below", () => this.setTodo(row, "squash", cx)],
        f: ["Fixup into the one below", () => this.setTodo(row, "fixup", cx)],
        e: ["Edit (stop there)", () => this.setTodo(row, "edit", cx)],
        d: ["Drop", () => act("Dropping…", () => this.editTodo((t) => t.splice(row.n, 1)))],
        // The list shows the todo upside down: down is earlier in it.
        "|28": null,
        "ctrl-j": ["Move down", () => row.n > 0 && act("Moving…", async () => {
          await this.editTodo((t) => { [t[row.n - 1], t[row.n]] = [t[row.n], t[row.n - 1]]; });
          this.sel.commits = i + 1;
        })],
        "ctrl-k": ["Move up", () => row.n < this.todo.length - 1 && act("Moving…", async () => {
          await this.editTodo((t) => { [t[row.n + 1], t[row.n]] = [t[row.n], t[row.n + 1]]; });
          this.sel.commits = i - 1;
        })],
      } : {
        enter: ["View commit (select lines to move)", () => this.focusDiff()],
        space: ["Check out", () => row && act(`Checking out ${short}…`, async () => {
          if (await confirm(`Check out ${short}?`, "You'll be on a detached HEAD.", "Check out", false, EXPLAIN.commits.space)) await this.w(["checkout", "--detach", row.id]);
        })],
        g: ["Reset to this commit…", () => row && act("Resetting…", () => this.resetTo(row.id, short, row.commit.subject))],
        "|30": null,
        r: ["Reword", () => row && act("Rewording…", async () => {
          const body = (await git(this.repo, ["log", "-1", "--format=%b", row.id])).trim();
          const m = await ask({ title: `Reword ${short}`, detail: EXPLAIN.commits.r, input: { value: row.commit.subject }, description: true, descriptionValue: body });
          if (!m?.text.trim()) return;
          const msg = [m.text.trim(), ...(m.description.trim() ? ["-m", m.description.trim()] : [])];
          if (row.id === this.head.oid) return this.w(["commit", "--amend", "--only", "--no-verify", "-m", ...msg]);
          const file = `${this.gitDir}/smart-git-msg`, w = await writeThere(this.repo, file, m.text.trim() + (m.description.trim() ? "\n\n" + m.description.trim() : "") + "\n");
          if (w.code !== 0) throw new Error(w.stderr.trim());
          await this.rewrite(row.id, (t) => t.splice(1, 0, { action: "exec", rest: `git commit --amend --only --no-verify -F '${file.replace(/'/g, "'\\''")}'` }));
        })],
        R: ["Reword in your editor", () => row && this.inTerminal(row.id === this.head.oid
          ? ["git", "commit", "--amend", "--only"]
          : ["git", "rebase", "-i", "--autostash", `${row.id}^`])],
        s: ["Squash into the one below", () => row?.commit && act("Squashing…", async () => {
          if (await confirm(`Squash ${short} into the commit below?`, row.commit.subject, "Squash", true, EXPLAIN.commits.s)) await this.rewrite(`${row.id}^`, (t) => { Sidebar.at(t, row.id).action = "squash"; });
        })],
        f: ["Fixup into the one below", () => row?.commit && act("Fixing up…", async () => {
          if (await confirm(`Fixup ${short} into the commit below?`, row.commit.subject, "Fixup", true, EXPLAIN.commits.f)) await this.rewrite(`${row.id}^`, (t) => { Sidebar.at(t, row.id).action = "fixup"; });
        })],
        d: ["Drop", () => row?.commit && act("Dropping…", async () => {
          if (await confirm(`Drop ${short}?`, row?.commit.subject, "Drop commit", true, EXPLAIN.commits.d)) await this.rewrite(row.id, (t) => { t[0].action = "drop"; });
        })],
        e: ["Edit (stop at it)", () => row?.commit && act("Starting rebase…", () => this.rewrite(row.id, (t) => { t[0].action = "edit"; }))],
        i: ["Interactive rebase from here", () => row?.commit && act("Starting rebase…", () => this.rewrite(row.id, (t) => t.unshift({ action: "break", rest: "" })))],
        "|32": null,
        "ctrl-j": ["Move down", () => row?.commit && act("Moving…", async () => {
          await this.rewrite(`${row.id}^`, (t) => { if (t.length < 2) throw new Error("Nothing below to move past"); [t[0], t[1]] = [t[1], t[0]]; });
          this.sel.commits = i + 1;
        })],
        "ctrl-k": ["Move up", () => row?.commit && act("Moving…", async () => {
          await this.rewrite(row.id, (t) => { if (t.length < 2) throw new Error("Already the newest"); [t[0], t[1]] = [t[1], t[0]]; });
          this.sel.commits = Math.max(0, i - 1);
        })],
        "|33": null,
        A: ["Amend with staged changes", () => row?.commit && act("Amending…", async () => {
          if (!this.files.some((f) => f.staged)) throw new Error("Stage the changes to amend with first");
          if (row?.id === this.head.oid) return this.w(["commit", "--amend", "--no-edit", "--no-verify"]);
          if (!await confirm(`Amend ${short} with the staged changes?`, row?.commit.subject, "Amend", false, EXPLAIN.commits.A)) return;
          await this.w(["commit", "--no-verify", `--fixup=${row.id}`]);
          await this.rewrite(row.id, null, { autosquash: true });
        })],
        F: ["Create fixup commit", () => row && act("Committing…", () => this.w(["commit", "--no-verify", `--fixup=${row.id}`]))],
        S: ["Squash fixups onto this", () => row?.commit && act("Squashing…", () => this.rewrite(row.id, null, { autosquash: true }))],
        t: ["Revert", () => row && act("Reverting…", async () => {
          if (await confirm(`Revert ${short}?`, row.commit.subject, "Revert", false, EXPLAIN.commits.t)) await this.w(["revert", "--no-edit", row.id], { timeout: 120000 });
        })],
        "|35": null,
        C: ["Copy for cherry-pick", () => row && this.toggleCopy(row.id, short)],
        V: ["Paste (cherry-pick) copied commits", () => this.paste(cx)],
        "|36": null,
        n: ["New branch from here", () => row && this.newBranch(row.id, cx, short)],
        T: ["Tag", () => row && this.tagAt(row.id, short, cx)],
        b: ["Bisect…", () => row && act("Bisecting…", async () => {
          const on = this.ops.includes("BISECT_LOG");
          const r = await ask({ title: on ? "Bisect" : "Start bisecting", detail: `${short} ${row.commit.subject}`, items: [
            { key: "b", label: `Mark ${short} as bad`, value: "bad" }, { key: "g", label: `Mark ${short} as good`, value: "good" },
            ...(on ? [{ key: "s", label: `Skip ${short}`, value: "skip" }, { key: "r", label: "Stop bisecting (reset)", value: "reset", danger: true }] : []),
          ] });
          if (!r) return;
          if (!on) await this.w(["bisect", "start"]);
          const out = await this.w(r === "reset" ? ["bisect", "reset"] : ["bisect", r, row.id]);
          this.info = out.split("\n").find((l) => /first bad commit|^Bisecting:/.test(l)) ?? null;
        })],
        "ctrl-s": ["Filter by path", () => act("Filtering…", async () => {
          if (this.pathFilter) { this.pathFilter = null; return; }
          const f = this.current("files");
          const r = await ask({ title: "Show the commits touching", input: { placeholder: "path/to/file-or-folder", value: f?.file?.path ?? f?.dir ?? "" } });
          if (r?.text.trim()) this.pathFilter = r.text.trim();
        })],
        "|38": null,
        y: ["Copy…", () => row && act("Copying…", async (cx) => {
          const r = await ask({ menu: true, title: "Copy", items: [
            { key: "h", label: "Hash", value: "%H" }, { key: "s", label: "Short hash", value: "%h" }, { key: "m", label: "Subject", value: "%s" },
            { key: "M", label: "Message", value: "%B" }, { key: "a", label: "Author", value: "%an <%ae>" }, { key: "d", label: "Diff", value: "diff" },
          ] });
          if (!r) return;
          const args = r === "diff" ? ["show", "--no-color", "--format=", row.id] : ["log", "-1", `--format=${r}`, row.id];
          cx.write_to_clipboard((await git(this.repo, args)).trim());
        })],
        o: ["Open in the browser", () => row && act("Opening…", () => this.browse(`commit/${row.id}`))],
        W: diffAgainst,
      },
      reflog: {
        enter: ["View commit", () => this.focusDiff()],
        space: ["Check out", () => row && act(`Checking out ${short}…`, async () => {
          if (await confirm(`Check out ${short}?`, "You'll be on a detached HEAD.", "Check out", false, EXPLAIN.reflog.space)) await this.w(["checkout", "--detach", row.reflog.hash]);
        })],
        g: ["Reset to this…", () => row && act("Resetting…", () => this.resetTo(row.reflog.hash, short, row.reflog.subject))],
        "|39": null,
        C: ["Copy for cherry-pick", () => row && this.toggleCopy(row.reflog.hash, short)],
        V: ["Paste (cherry-pick) copied commits", () => this.paste(cx)],
        "|40": null,
        n: ["New branch from here", () => row && this.newBranch(row.reflog.hash, cx, short)],
        y: ["Copy hash", () => row && cx.write_to_clipboard(row.reflog.hash)],
        W: diffAgainst,
      },
      stash: {
        enter: ["View", () => this.focusDiff()],
        space: ["Apply", () => row && act("Applying stash…", () => this.w(["stash", "apply", row.id]))],
        g: ["Pop", () => row && act("Popping stash…", () => this.w(["stash", "pop", row.id]))],
        d: ["Drop", () => row && act("Dropping stash…", async () => {
          if (await confirm(`Drop ${row.id}?`, row.stash.subject, "Drop", true, "Deletes this stash and the changes saved in it.")) await this.w(["stash", "drop", row.id]);
        })],
        "|42": null,
        n: ["New branch from this stash", () => row && act("Creating branch…", async () => {
          const r = await ask({ title: `Branch from ${row.id}`, input: { placeholder: "Branch name" } });
          if (r?.text.trim()) await this.w(["stash", "branch", r.text.trim().replace(/\s+/g, "-"), row.id]);
        })],
        r: ["Rename", () => row && act("Renaming stash…", async () => {
          const r = await ask({ title: `Rename ${row.id}`, input: { value: row.stash.subject } });
          if (!r?.text.trim()) return;
          const hash = (await git(this.repo, ["rev-parse", row.id])).trim();
          await this.w(["stash", "drop", row.id]);
          await this.w(["stash", "store", "-m", r.text.trim(), hash]);
        })],
      },
      status: { enter: ["View all branches", () => this.focusDiff()] },
    };
    const busy = this.ops.find((o) => o !== "BISECT_LOG");
    const global = {
      j: () => move(1), down: () => move(1), k: () => move(-1), up: () => move(-1),
      "ctrl-d": () => move(10), pagedown: () => move(10), "ctrl-u": () => move(-10), pageup: () => move(-10),
      // Not g/G: g is reset (commits, reflog) and pop (stash), as in lazygit.
      home: () => move(-rows.length), end: () => move(rows.length),
      h: () => this.select(PANELS[(index + PANELS.length - 1) % PANELS.length].id, this.sel[this.viewOf(PANELS[(index + PANELS.length - 1) % PANELS.length].id)] ?? 0, cx),
      l: () => this.select(PANELS[(index + 1) % PANELS.length].id, this.sel[this.viewOf(PANELS[(index + 1) % PANELS.length].id)] ?? 0, cx),
      left: () => global.h(), right: () => global.l(), tab: () => global.l(), "shift-tab": () => global.h(),
      "[": () => { const tabs = PANELS[index].tabs, n = tabs.findIndex(([id]) => id === this.tabs[this.panel]); this.setTab(this.panel, tabs[(n + tabs.length - 1) % tabs.length][0], cx); },
      "]": () => { const tabs = PANELS[index].tabs, n = tabs.findIndex(([id]) => id === this.tabs[this.panel]); this.setTab(this.panel, tabs[(n + 1) % tabs.length][0], cx); },
      ...Object.fromEntries(PANELS.map((p, n) => [String(n + 1), () => this.select(p.id, this.sel[this.viewOf(p.id)] ?? 0, cx)])),
      ...(busy ? { m: [`${OPS[busy]}: continue / abort…`, () => act("…", async () => {
        const cmd = busy.startsWith("rebase") ? "rebase" : busy === "MERGE_HEAD" ? "merge" : busy === "CHERRY_PICK_HEAD" ? "cherry-pick" : "revert";
        const r = await ask({ title: OPS[busy], detail: this.files.some((f) => f.conflict) ? "There are still conflicts." : null, items: [
          { key: "c", label: "Continue", value: "--continue" }, { key: "a", label: "Abort", value: "--abort", danger: true },
          ...(cmd !== "merge" ? [{ key: "s", label: "Skip this commit", value: "--skip", danger: true }] : []),
        ] });
        if (!r) return;
        // Staged resolutions are what continuing commits; offer to stage the rest.
        const unstaged = this.files.some((f) => f.unstaged && !f.untracked && !f.conflict);
        if (r === "--continue" && unstaged && await confirm("Stage all changes first?", "Unstaged changes aren't part of what continuing commits.", "Stage all and continue", false))
          await this.w(["add", "-u"]);
        this.busy = `${OPS[busy]}…`;
        await this.w([cmd, r], { timeout: 120000 });
      })] } : {}),
      "|44": null,
      "/": ["Filter this list", () => {
        if (this.filterView !== view) { this.filter.set_value(""); this.filterText = ""; this.filterView = view; }
        this.filtering = true; this.filter.focus();
      }],
      "|45": null,
      p: ["Pull", () => act("Pulling…", () => this.remote(["pull"]))],
      P: ["Push", () => act("Pushing…", () => this.push())],
      f: ["Fetch all remotes", () => act("Fetching…", () => this.remote(["fetch", "--all", "--prune"]))],
      "|46": null,
      z: ["Undo (reflog)", () => act("Undoing…", () => this.undo())],
      R: ["Refresh", () => this.refresh(cx)],
      "|47": null,
      E: ["Choose editor…", () => act("…", () => this.pickEditor())],
      "ctrl-i": ["Choose AI commit agent…", () => act("…", () => this.pickAgent())],
      // lazygit's "menu of what I can do here": the right-click menu, from the keyboard.
      x: () => this.menu(cx),
      "?": () => this.menu(cx, true),
      escape: () => {
        if (this.filterText) { this.filter.set_value(""); this.filterText = ""; }
        else if (this.diffBase) { this.diffBase = null; this.show(cx); }
        else if (this.pathFilter) { this.pathFilter = null; this.refresh(cx); }
        else if (this.copied.length) this.copied = [];
        else if (view === "remote-branches") { this.inRemote = null; this.select("branches", this.remotes.findIndex((r) => r.name === row?.id.split("/")[0]), cx); }
        else if (this.stack.length > 1) this.go(this.stack.slice(0, -1), cx);
      },
    };
    return { panel: panelKeys[view] ?? {}, global };
  }

  setTodo(row, action, cx) {
    if (!/^[0-9a-f]{7,40}$/.test(row.todo.rest.split(" ")[0])) { this.note = `Only commits can be ${action}ed`; return; }
    this.act(`Marking ${action}…`, () => this.editTodo((t) => { t[row.n].action = action; }), cx);
  }

  tagAt(target, label, cx) {
    this.act("Tagging…", async () => {
      const r = await ask({ title: `Tag ${label}`, input: { placeholder: "Tag name" }, description: true, descriptionHint: "A message makes it an annotated tag" });
      if (!r?.text.trim()) return;
      await this.w(["tag", ...(r.description.trim() ? ["-a", "-m", r.description.trim()] : []), r.text.trim(), target]);
    }, cx);
  }

  toggleCopy(hash, short) {
    const n = this.copied.findIndex((c) => c.hash === hash);
    if (n < 0) this.copied.push({ hash, short }); else this.copied.splice(n, 1);
  }

  paste(cx) {
    if (!this.copied.length) { this.note = "Nothing copied: C on a commit copies it"; return; }
    // Oldest first: by place in the log when it's there, else in the order copied.
    const at = (c) => { const n = this.commits.findIndex((x) => x.hash === c.hash); return n < 0 ? -1 : n; };
    const order = [...this.copied].sort((a, b) => at(b) - at(a));
    this.act("Cherry-picking…", async () => {
      if (!await confirm(`Cherry-pick ${order.length} commit${order.length > 1 ? "s" : ""} onto ${this.head.branch || "HEAD"}?`, order.map((c) => c.short).join(" "), "Cherry-pick", false)) return;
      await this.w(["cherry-pick", ...order.map((c) => c.hash)], { timeout: 120000 });
      this.copied = [];
    }, cx);
  }

  // The labelled keys as a menu: the list's (right-click), or with the global ones (?).
  menu(cx, all = false) {
    const { panel, global } = this.actions(cx);
    const picked = this.picked, row = picked?.row ?? this.current(), explain = EXPLAIN[row?.todo ? "todo" : picked?.view ?? this.view] ?? {};
    // A null entry ("|1", "|2"…) is a line between groups; one is dropped where a group came out empty.
    const items = [];
    for (const [key, a] of Object.entries(all ? { ...panel, "|panel": null, ...global } : panel)) {
      if (Array.isArray(a)) items.push({ key, label: a[0], value: key, hint: panel[key] ? explain[key] : undefined });
      else if (a === null && items.length && !items.at(-1).sep) items.push({ sep: true });
    }
    if (items.at(-1)?.sep) items.pop();
    if (!items.length) return;
    cx.spawn(async (cx) => {
      askFrom(cx, this.handle);
      const k = await ask({ menu: !all, title: all ? "Keys" : row?.name ?? row?.text ?? null, items });
      if (k) { this.picked = picked; try { this.key(k, cx); } finally { this.picked = null; } cx.notify(); }
    });
  }

  // A commit or label the diff pane's graph picked, acted on with this list's keys as if selected
  // here ("menu": the list's right-click menu). Only the list's own keys: the global ones move this panel.
  pick({ root, view, id, key, commit }, cx) {
    if (!this.repo || root !== this.repo.root) { this.note = "That graph is another repository's (a submodule): open it here to act on it"; return; }
    const found = { commits: this.commits, branches: this.branches, "remote-branches": this.remoteBranches, tags: this.tags }[view]
      ?.find((x) => (x.hash ?? x.name) === id);
    const field = { commits: "commit", branches: "branch", "remote-branches": "rbranch", tags: "tag" }[view];
    if (!field || !(found ?? commit)) return;
    this.picked = { view, row: { id, [field]: found ?? commit, text: id } };
    try { if (key === "menu") this.menu(cx); else if (this.actions(cx).panel[key]) this.key(key, cx); }
    finally { this.picked = null; }
  }

  key(k, cx) {
    const t0 = Date.now(); // PERF
    const { panel, global } = this.actions(cx);
    perf(`key ${k} actions()`, t0); // PERF
    const a = panel[k] ?? global[k];
    if (!a) return false;
    const t1 = Date.now(); // PERF
    (Array.isArray(a) ? a[1] : a)();
    perf(`key ${k} handler`, t1); this.keyAt = Date.now(); // PERF
    cx.notify();
    return true;
  }

  // --- Drawing ---
  line(row, selected, t, focused) {
    const base = h_flex().h(ROW).flex_none().px(8).gap(8).items_center().rounded(7).when(selected, (e) => e.bg(focused ? t.selected : t.hover));
    const dim = (s) => div().text_color(t.dim).flex_none().child(s);
    const name = (s, color = t.foreground) => div().flex_1().min_w(0).truncate().text_color(color).child(s);
    if (row.file || row.dir) {
      const f = row.file, files = row.file ? [row.file] : row.files;
      const staged = files.every((x) => x.staged && !x.unstaged), some = files.some((x) => x.staged);
      // A folder shows what space would do to it: green all staged, amber some, plain none.
      const label = name(row.dir ? row.name + "/" : row.name, f ? (f.conflict ? t.ansi1 : staged ? t.ansi2 : f.untracked ? t.ansi1 : t.foreground) : staged ? t.ansi2 : some ? t.blocked : t.muted);
      const xy = f ? h_flex().flex_none().w(18).text_size(11).child(div().text_color(t.ansi2).child(f.x === "." ? " " : f.x === "?" ? "?" : f.x)).child(div().text_color(t.ansi1).child(f.y === "." ? " " : f.y))
        : h_flex().flex_none().w(18).text_color(staged ? t.ansi2 : some ? t.blocked : t.dim).child(icon(this.collapsed.has(row.dir) ? "chevron-right" : "chevron-down").size(12));
      // A submodule only says when its commit moved: that's what space stages here. Changed files inside
      // can't be staged from the parent (enter it); the diff says which.
      const sub = f?.sub?.[1] === "C" ? "new commit" : "";
      const done = row.dir ? files.filter((x) => x.staged && !x.unstaged).length : 0;
      return base.pl(8 + row.depth * 12).child(xy).child(label)
        .when(Boolean(row.dir) && done > 0 && !staged, (e) => e.child(dim(`${done}/${files.length} staged`)))
        .when(Boolean(f?.sub), (e) => e.child(dim(`submodule${sub ? ": " + sub : ""}`)));
    }
    if (row.branch) {
      const b = row.branch;
      return base.child(div().flex_none().w(10).text_color(t.accent).child(b.current ? "*" : ""))
        .child(name(b.name, b.current ? t.accent : t.foreground))
        .when(Boolean(b.track), (e) => e.child(dim(b.track.replace("ahead ", "↑").replace("behind ", "↓").replace(", ", " "))))
        .child(dim(b.when.replace(/ ago$/, "")));
    }
    if (row.commit) {
      const c = row.commit, copied = this.copied.some((x) => x.hash === c.hash);
      return base.child(div().flex_none().text_color(copied ? t.accent : row.ahead ? t.ansi1 : t.ansi3).child(c.short))
        .when(copied, (e) => e.child(div().flex_none().text_color(t.accent).child("◆")))
        .child(name(c.subject))
        .when(Boolean(c.refs), (e) => e.child(div().flex_none().max_w(110).truncate().text_size(11).text_color(t.accent).child(c.refs.replace("HEAD -> ", ""))));
    }
    if (row.todo) {
      const [hash, ...subject] = row.todo.rest.split(" "), isHash = /^[0-9a-f]{7,40}$/.test(hash);
      return base.child(div().flex_none().w(44).text_size(11).font_semibold().text_color(row.todo.action === "drop" ? t.ansi1 : row.todo.action === "pick" ? t.ansi2 : t.blocked).child(row.todo.action))
        .child(dim(isHash ? hash.slice(0, 7) : "")).child(name(isHash ? subject.join(" ") : row.todo.rest, t.muted));
    }
    if (row.reflog) {
      const r = row.reflog, copied = this.copied.some((x) => x.hash === r.hash);
      return base.child(div().flex_none().text_color(copied ? t.accent : t.ansi3).child(r.short)).child(name(r.subject)).child(dim(r.when.replace(/ ago$/, "")));
    }
    if (row.sub) {
      const s = row.sub;
      return base.pl(8 + s.depth * 12).child(div().flex_none().w(10).text_color(s.state === "+" ? t.blocked : s.state === "U" ? t.ansi1 : t.dim).child(s.state.trim()))
        .child(name(s.depth ? s.rel : s.path, s.state === "-" ? t.dim : t.foreground)).when(s.state === "-", (e) => e.child(dim("not checked out")));
    }
    if (row.worktree) {
      const w = row.worktree, here = w.path === this.repo?.root;
      return base.child(div().flex_none().w(10).text_color(t.accent).child(here ? "*" : ""))
        .child(div().flex_none().max_w(140).truncate().text_color(here ? t.accent : t.foreground).child(w.branch || "(detached)"))
        .child(name(w.path.replace(/^\/home\/[^/]+/, "~"), t.dim));
    }
    if (row.remote) return base.child(div().flex_none().text_color(t.foreground).child(row.remote.name)).child(name(row.remote.url, t.dim));
    if (row.rbranch || row.tag) {
      const r = row.rbranch ?? row.tag;
      return base.child(name(row.rbranch ? r.name.slice(this.inRemote.length + 1) : r.name)).when(Boolean(row.tag), (e) => e.child(dim(r.subject).max_w(120).truncate())).child(dim(r.when.replace(/ ago$/, "")));
    }
    return base.child(dim(row.stash.ref.replace("stash@", ""))).child(name(row.stash.subject));
  }

  render(cx) { const t0 = Date.now(), r = this.render2(cx); perf(`sidebar render${this.keyAt ? ` (${t0 - this.keyAt}ms after key)` : ""}`, t0); this.keyAt = 0; return r; } // PERF
  render2(cx) { // PERF
    this.follow(cx);
    // The diff pane changed something (a line staged, a conflict resolved).
    if (shared("smart-git:bump") !== this.bump) { this.bump = shared("smart-git:bump"); this.refresh(cx); }
    const t = theme(), focused = this.handle.is_focused(), h = this.head;
    const toggle = (id, cx) => {
      this.folded.has(id) ? this.folded.delete(id) : this.folded.add(id);
      setShared("smart-git:folded", [...this.folded]); cx.notify();
    };
    // What's running shows in the bottom strip, and as a spinner on what started it (✨, ✓, the branch chip).
    const spin = () => div().flex_none().text_color(t.working).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90);
    const running = Boolean(this.busy) && !asking(), syncing = running && ["Pulling…", "Pushing…", "Fetching…"].includes(this.busy);
    // The title bar: where you are (submodules as a breadcrumb) and the branch.
    const title = h_flex().h(42).flex_none().px(14).gap(4).items_center().border_b(1).border_color(t.border)
      .when(!this.repo, (e) => e.child(div().font_semibold().child("Git")))
      // The last crumb (a long submodule path) shrinks, so the branch stays in view.
      // Long submodule paths are cut at the start with "…", so the tail stays.
      .children(this.stack.flatMap((r, n) => {
        const last = n === this.stack.length - 1, x = n ? r.root.slice(this.stack[n - 1].root.length + 1) : r.root.split("/").pop();
        return [
          ...(n ? [div().flex_none().text_color(t.muted).child("›")] : []),
          div().id(`crumb-${n}`).when(!last, (e) => e.flex_none()).when(last, (e) => e.min_w(0).overflow_hidden().whitespace_nowrap().text_ellipsis_start()).px(2).rounded(4).font_semibold().cursor_pointer()
            .text_color(last ? t.foreground : t.muted).hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { if (!last) this.go(this.stack.slice(0, n + 1), cx); })
            .child(x),
        ];
      }))
      .child(div().flex_1())
      .when(Boolean(this.repo), (e) => e.child(h_flex().id("branch").flex_none().max_w(200).h(22).px(6).gap(5).items_center().rounded(6).cursor_pointer()
        .text_size(11.5).text_color(this.panel === "status" ? t.foreground : t.muted)
        .when(this.panel === "status", (e) => e.bg(focused ? t.selected : t.hover)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.handle.focus(); this.select("status", 0, cx); })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.handle.focus(); this.select("status", 0, cx); this.menu(cx, true); })
        .child(icon("git-branch").size(12).flex_none())
        .child(div().min_w(0).truncate().text_size(12.5).child(h.branch === "(detached)" ? h.oid?.slice(0, 7) ?? "(detached)" : h.branch || (this.loading ? "…" : "(no branch)")))
        .when(syncing, (e) => e.child(spin()))
        .when(!syncing && h.ahead > 0, (e) => e.child(div().flex_none().text_color(t.ansi2).child(`↑${h.ahead}`)))
        .when(!syncing && h.behind > 0, (e) => e.child(div().flex_none().text_color(t.ansi1).child(`↓${h.behind}`)))));
    // What the repo is in the middle of, and the modes that change what lists show.
    const conflicts = this.files.filter((f) => f.conflict).length;
    const banners = [
      ...[...new Set(this.ops.map((o) => OPS[o]).filter(Boolean))].map((op) => [op + (conflicts && op !== "Bisecting" ? ` · ${conflicts} conflicted` : ""), op === "Bisecting" ? "b on a commit" : "m continue / abort", t.blocked]),
      ...(this.copied.length ? [[`${this.copied.length} copied for cherry-pick`, "V paste · esc clear", t.accent]] : []),
      ...(this.diffBase ? [[`Diffing against ${/^[0-9a-f]{40}$/.test(this.diffBase) ? this.diffBase.slice(0, 7) : this.diffBase}`, "W or esc to stop", t.accent]] : []),
      ...(this.pathFilter ? [[`Commits touching ${this.pathFilter}`, "ctrl-s or esc to clear", t.accent]] : []),
      ...(this.info ? [[this.info, "", t.muted]] : []),
    ];
    const banner = ([text, hint, color], n) => h_flex().id(`banner-${n}`).flex_none().px(14).py(5).gap(8).items_center().border_b(1).border_color(t.border).text_size(11.5)
      .child(div().flex_1().min_w(0).truncate().text_color(color).font_medium().child(text)).child(div().flex_none().text_color(t.dim).text_size(11).child(hint));
    // A section: tabs on a header that folds it, then its rows, sized to fit them and sharing what's left.
    const section = (p, n) => {
      const view = this.viewOf(p.id), rows = this.rows(view), sel = this.sel[view] ?? 0, active = p.id === this.panel, open = !this.folded.has(p.id);
      const filter = view === this.filterView && (this.filtering || this.filterText) ? 34 : 0;
      const header = h_flex().h(HEAD).flex_none().px(14).gap(10).items_center().text_size(11.5).font_medium()
        .children(p.tabs.map(([id, label]) => {
          const on = this.tabs[p.id] === id;
          return h_flex().id(`tab-${id}`).flex_none().gap(5).items_center().cursor_pointer().text_color(on && active ? t.foreground : on ? t.muted : t.dim).hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { this.handle.focus(); this.setTab(p.id, id, cx); })
            .child(on && view === "remote-branches" ? `${label} › ${this.inRemote}` : label)
            .when(on, (e) => e.child(div().text_size(11).text_color(t.dim).child(String(view === "files" ? this.files.length : rows.length))));
        }))
        .child(div().id(`fold-${p.id}`).flex_1().min_w(0).h_full().flex().items_center().gap(6).cursor_pointer().on_click((_e, cx) => toggle(p.id, cx))
          .child(div().flex_1().min_w(0).truncate().font_normal().text_size(11).text_color(t.dim).child(open ? "" : this.summary(view)))
          .child(div().flex_none().text_size(10.5).text_color(active && focused ? t.accent : t.dim).child(String(n)))
          .child(icon(open ? "chevron-down" : "chevron-right").size(11).flex_none().text_color(t.dim)));
      const el = v_flex().when(n > 2, (e) => e.border_t(1).border_color(t.border)).child(header);
      if (!open) return el.flex_none();
      const filterBox = div().mx(10).mb(4).h(30).flex_none().px(10).flex().items_center().rounded(8).border_1().border_color(this.filtering ? t.accent : t.border)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.filter).h_full().text_size(12));
      if (!rows.length) return el.flex_none().when(filter > 0, (e) => e.child(filterBox)).child(div().px(14).pb(8).text_size(12).text_color(t.dim).child(this.empty(view)));
      return el.flex_1().min_h(HEAD + Math.min(rows.length, 3) * ROW + 8 + filter).max_h(HEAD + rows.length * ROW + 8 + filter)
        .when(filter > 0, (e) => e.child(filterBox))
        // A virtual list placed absolutely, its size from the section: only the rows on screen are built.
        // The list reports a click's row, not its click count: the press before it says (`clicks`).
        .child(div().flex_1().min_h(0).relative()
          .child(div().absolute().inset_0().px(6).pb(6).on_mouse_down("left", (e) => { this.clicks = e.click_count; })
            .child(v_virtual_list(`list-${p.id}`, rows.length, ROW, (j) => rows[j].id,
              (range) => rows.slice(range.start, range.end).map((row, k) => this.line(row, active && range.start + k === sel, t, focused).cursor_pointer()))
              .track_scroll(this.scrolls[p.id]).size_full()
              .on_item_click((key, cx) => {
                const j = rows.findIndex((r) => r.id === key), row = rows[j];
                if (!row) return;
                this.handle.focus(); this.select(p.id, j, cx);
                // A folder opens or closes on one click (a double click's second click does nothing more).
                if (row.dir) { if (this.clicks === 1) this.key("enter", cx); }
                else if (this.clicks === 2) this.key(["files", "branches", "worktrees"].includes(view) ? "space" : "enter", cx);
              })
              .on_item_secondary_click((key, _e, cx) => {
                const j = rows.findIndex((r) => r.id === key);
                if (j < 0) return;
                cx.stop_propagation(); this.handle.focus(); this.select(p.id, j, cx); this.menu(cx);
              })))
          .child(Scrollbar.vertical(`list-${p.id}`).viewport_from_layout().absolute().inset_0()));
    };
    // The commit box, as VS Code's: one card, the subject with ✨ (an agent writes it, right-click picks
    // the agent) and ✓ (commit), and the description under it once there's a subject (or one already).
    const writingAi = Boolean(this.busy?.startsWith("Writing message")), hasSubject = Boolean(this.subject.value().trim());
    const tool = (id, tip, on, enabled = true) => div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(5)
      .text_color(enabled ? t.muted : t.dim).tooltip(tip)
      .when(enabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((e, cx) => { on(cx, e); cx.notify(); }));
    const agent = this.savedAgent();
    const named = agent?.custom ?? (agent?.key ? agent.key + (agent.model ? ` · ${agent.model}` : "") : "Auto (the agent in this space)");
    const box = v_flex().id("commit-box").mx(10).mt(8).mb(6).flex_none().rounded(8).border_1().overflow_hidden().text_size(12.5)
      .border_color(this.typing ? t.accent : t.border).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(h_flex().h(32).pl(10).pr(3).gap(1).items_center()
        .child(div().flex_1().min_w(0).h_full().child(Input.new(this.subject).h_full().text_size(12.5)))
        .child(tool("ai", writingAi ? "Writing the message…" : `Write the message with ${named} (I) · right-click: choose`,
          (cx) => this.act("Writing message…", (cx) => this.generate(cx), cx), !this.busy)
          .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.act("…", () => this.pickAgent(), cx); })
          .child(writingAi ? spin() : svg("mods/smart-git/sparkles.svg").size(13)))
        .child(tool("commit", "Commit (enter, ctrl-enter from the description)", (cx) => this.act("Committing…", () => this.commit(), cx), hasSubject && !this.busy)
          .child(this.busy === "Committing…" ? spin() : svg("mods/workspace-chrome/check.svg").size(14))))
      .when(hasSubject || this.typing === "body" || Boolean(this.body.value()), (e) => e.child(div().border_t(1).border_color(t.border).pl(10).pr(8).py(6)
        .child(Textarea.new(this.body).w_full().text_size(12.5))));
    return v_flex().id("smart-git").size_full().min_h(0).overflow_hidden().rounded(10).border_1().border_color(t.border)
      .bg(t.background).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        // In the commit box: ctrl-enter commits, tab goes to the description, esc back to the list.
        if (this.typing) {
          const k = keyOf(e);
          if (k === "ctrl-enter" || k === "cmd-enter") this.act("Committing…", () => this.commit(), cx);
          else if (k === "tab" && this.typing === "subject") this.body.focus();
          else if (k === "shift-tab" && this.typing === "body") this.subject.focus();
          else if (k === "escape") this.handle.focus();
          else return;
          cx.stop_propagation(); cx.notify(); return;
        }
        if (this.filtering && e.key === "escape") { this.filtering = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); return; }
        if (this.filtering && !this.handle.is_focused()) return;
        if (this.key(keyOf(e), cx)) cx.stop_propagation();
      })
      .on_mouse_down("left", (_e, cx) => { this.handle.focus(); cx.notify(); })
      .child(title)
      .when(!this.error && Boolean(this.repo), (e) => e.child(box))
      .children(banners.map(banner))
      .when(Boolean(this.error) || !this.repo, (e) => e.child(div().flex_1().px(14).py(12).text_size(12).text_color(t.dim).child(this.error ?? "")))
      .when(!this.error && Boolean(this.repo), (e) => e.child(v_flex().flex_1().min_h(0).children(PANELS.slice(1).map((p, n) => section(p, n + 2)))))
      // One strip for the whole life of an action: the keys when idle, the spinner while it runs, then
      // what went wrong (click to dismiss). The note wins: "Still … press again" comes while running.
      .when(Boolean(this.note), (e) => e.child(h_flex().id("note").flex_none().px(14).py(6).gap(6).items_start().border_t(1).border_color(t.border).text_size(11.5).text_color(t.ansi1).cursor_pointer()
        .on_click((_e, cx) => { this.note = null; cx.notify(); })
        .child(div().flex_1().min_w(0).child(this.note)).child(div().flex_none().text_size(10.5).text_color(t.dim).child("dismiss"))))
      .when(!this.note && running, (e) => e.child(h_flex().flex_none().px(14).py(6).gap(6).items_center().border_t(1).border_color(t.border).text_size(11.5).text_color(t.working)
        .child(spin()).child(div().min_w(0).truncate().child(this.busy === "…" ? "Working…" : this.busy))))
      .when(!this.note && !running && Boolean(this.repo) && !this.error, (e) => e.child(div().flex_none().px(14).py(6).border_t(1).border_color(t.border).text_size(10.5).text_color(t.dim).truncate().child(this.hints())));
  }

  summary(view) {
    const row = this.current(view);
    return row?.name ?? row?.text ?? "";
  }

  empty(view) {
    if (this.loading && (!this.head.branch || view === "submodules")) return "Loading…";
    if (view === this.filterView && this.filterText) return "Nothing matches";
    return { files: "No changes", worktrees: "No worktrees", submodules: "No submodules", branches: "No branches", remotes: "No remotes", "remote-branches": "No branches", tags: "No tags", commits: "No commits yet", reflog: "No reflog", stash: "No stashes", status: "" }[view];
  }

  // A short, per-section line of the keys you reach for most; ? lists the rest.
  hints() {
    const keys = {
      files: "space stage · a stage all · c message · I AI message · d discard",
      worktrees: "space switch · n new · o terminal · d remove",
      submodules: "enter open · s new space · u update · n add · d remove",
      branches: "space check out · n new · M merge · r rebase · d delete",
      remotes: "enter branches · f fetch · n add · d remove",
      "remote-branches": "space check out · n new · M merge · d delete",
      tags: "space check out · n new · P push · d delete",
      commits: "enter view · space check out · r reword · s squash · d drop",
      reflog: "enter view · space check out · g reset · n branch",
      stash: "space apply · g pop · d drop · n branch",
      status: "enter view all branches",
    }[this.view];
    return `${keys ?? ""} · ? all keys`;
  }
}
