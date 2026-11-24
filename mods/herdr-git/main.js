// herdr-git: lazygit's side panels as a herdr sidebar. The same mod draws the diff pane
// (props.view "diff") and its own dialogs (props.view "ask").
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, ScrollHandle, InputState, Input } from "gpui-base";
import { props, panes, focused, theme, run, shared, setShared, watchFolder, nextCommand, exec, checking } from "herdr";
import {
  location, git, findRoot, writeThere, rebaseWith, parseStatus, parseLog, parseBranches, parseStash, parseSubmodules, parseWorktrees,
  parseRemotes, parseRefs, parseReflog, LOG_FORMAT, BRANCH_FORMAT, REF_FORMAT, REFLOG_FORMAT,
} from "./git.js";
import { Diff } from "./diff.js";
import { ask, confirm, keyOf, Ask } from "./ask.js";

const ROW = 26, HEAD = 30;
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

export default class HerdrGit extends View {
  init(_props, cx) {
    const view = props()?.view;
    this.part = view === "diff" ? new Diff(this, cx) : view === "ask" ? new Ask(cx) : new Sidebar(cx);
    if (view !== "ask" && !checking()) cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.part.handle.focus();
        // `herdr-git.key:<k>` presses a key, for scripts and tests.
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
    this.scrolls = Object.fromEntries(PANELS.map((p) => [p.id, ScrollHandle.new()]));
    this.folded = new Set(shared("herdr-git:folded") ?? []);
    this.tabs = { status: "status", files: "files", branches: "branches", commits: "commits", stash: "stash", ...(shared("herdr-git:tabs") ?? {}) };
    this.stack = []; this.panel = "files"; this.collapsed = new Set(); this.copied = [];
    this.tree = shared("herdr-git:tree") ?? true;
    this.clear();
    this.filter = InputState.new({ placeholder: "Filter" });
    this.filter.on("change", (_e, cx) => { this.filterText = this.filter.value(); this.sel[this.filterView] = 0; cx.notify(); });
    this.filter.on("submit", (_e, cx) => { this.filtering = false; this.handle.focus(); cx.notify(); });
    this.filterText = "";
    this.bump = shared("herdr-git:bump");
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  clear() {
    this.head = {}; this.files = []; this.branches = []; this.commits = []; this.stash = []; this.submodules = []; this.worktrees = [];
    this.remotes = []; this.remoteBranches = []; this.tags = []; this.reflog = []; this.ops = []; this.todo = []; this.gitDir = "";
    this.sel = {}; this.inRemote = null; this.diffBase = null; this.pathFilter = null; this.info = null;
  }

  get repo() { return this.stack[this.stack.length - 1] ?? null; }
  // The list a section shows: its tab, or a remote's branches inside Remotes.
  viewOf(panel) { const v = this.tabs[panel] ?? panel; return v === "remotes" && this.inRemote ? "remote-branches" : v; }
  get view() { return this.viewOf(this.panel); }

  // Follows the focused terminal's repo, with the repos it's a submodule of before it.
  follow(cx) {
    const loc = location(), key = JSON.stringify(loc);
    // A tab with no terminal (only mods) says nothing about the repo: stay on this one.
    if (loc.guess && this.stack.length && loc.space === this.space) return;
    if (key === this.where || !loc.cwd) return;
    this.where = key; this.space = loc.space;
    cx.spawn(async (cx) => {
      const stack = [];
      for (let root = await findRoot(loc.cwd, loc.on); root;) {
        stack.unshift({ root, on: loc.on });
        const r = await exec("git", ["rev-parse", "--show-superproject-working-tree"], { cwd: root, on: loc.on });
        root = r.code === 0 ? r.stdout.trim() : "";
      }
      if (this.where !== key) return;
      // The same repo, or one entered from it: stay where the person is.
      if (stack.length && stack.every((r, n) => r.root === this.stack[n]?.root && r.on === this.stack[n]?.on)) return;
      this.go(stack, cx);
    });
  }

  go(stack, cx) {
    this.stack = stack;
    this.error = stack.length ? null : "Not a git repository";
    this.clear(); this.refresh(cx); this.watch(cx); cx.notify();
  }

  watch(cx) {
    const repo = this.repo;
    if (this.watching === repo?.root) return;
    this.watchCall?.cancel(); this.watching = null;
    if (!repo || repo.on) return;
    this.watching = repo.root;
    cx.spawn(async (cx) => {
      try {
        while (this.watching === repo.root) {
          this.watchCall = watchFolder(repo.root);
          const changed = await this.watchCall;
          if (this.watching === repo.root && changed.length) this.refresh(cx);
        }
      } catch { if (this.watching === repo.root) this.watching = null; }
    });
  }

  refresh(cx) {
    const repo = this.repo;
    if (!repo) return;
    if (this.loading) { this.again = true; return; }
    this.loading = true; this.again = false;
    const soft = (p) => p.catch(() => "");
    cx.spawn(async (cx) => {
      try {
        const [status, branches, log, stash, subs, subConfig, worktrees, remotes, remoteBranches, tags, reflog, state] = await Promise.all([
          git(repo, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"]),
          git(repo, ["for-each-ref", "--sort=-committerdate", `--format=${BRANCH_FORMAT}`, "refs/heads"]),
          soft(git(repo, ["log", `--format=${LOG_FORMAT}`, "-n", "300", "HEAD", "--", ...(this.pathFilter ? [this.pathFilter] : [])])),
          git(repo, ["stash", "list", "--format=%gd%x1f%cr%x1f%gs"]),
          soft(git(repo, ["submodule", "status", "--recursive"])),
          soft(git(repo, ["config", "-z", "--file", ".gitmodules", "--get-regexp", "^submodule\\."])),
          soft(git(repo, ["worktree", "list", "--porcelain"])),
          git(repo, ["remote", "-v"]),
          git(repo, ["for-each-ref", "--sort=-committerdate", `--format=${REF_FORMAT}`, "refs/remotes"]),
          git(repo, ["for-each-ref", "--sort=-creatordate", `--format=${REF_FORMAT}`, "refs/tags"]),
          soft(git(repo, ["reflog", `--format=${REFLOG_FORMAT}`, "-n", "300"])),
          exec("sh", ["-c", STATE], { cwd: repo.root, on: repo.on }).then((r) => r.stdout),
        ]);
        if (repo !== this.repo) return;
        const s = parseStatus(status);
        this.head = s.head; this.files = s.files; this.branches = parseBranches(branches);
        this.commits = parseLog(log); this.stash = parseStash(stash); this.submodules = parseSubmodules(subs, subConfig);
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
      finally { this.loading = false; if (this.again) this.refresh(cx); this.show(cx); cx.notify(); }
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
      return [...todo, ...this.commits.map((c) => ({ id: c.hash, commit: c, text: `${c.short} ${c.subject}` }))].filter(keep);
    }
    // Built once per change of what it's made of, not on every key and draw.
    const made = [this.files, q, this.tree, [...this.collapsed].join("\0")];
    if (this.made?.every((v, n) => v === made[n])) return this.fileRows;
    this.made = made;
    return (this.fileRows = this.fileTree(q));
  }

  fileTree(q) {
    const files = this.files.filter((f) => !q || f.path.toLowerCase().includes(q));
    if (!this.tree) return files.map((f) => ({ id: f.path, file: f, depth: 0, name: f.path, text: f.path }));
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
      for (const f of node.files.sort((a, b) => a.path.localeCompare(b.path))) out.push({ id: f.path, file: f, depth, name: f.path.slice(prefix.length), text: f.path });
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
    const row = this.current(), repo = this.repo;
    if (!row || !repo) return;
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
    // A folder's untracked files can't share one `diff --no-index`: show the tracked changes.
    if (row.dir && files.every((f) => f.untracked)) s = { ...s, unstaged: true, untracked: false };
    // Sent once the selection rests: every setShared redraws every mod and the diff runs git,
    // so a held arrow key sends only where it stops.
    this.next = { repo, ...s, stamp: s.kind === "file" || s.kind === "conflict" ? this.stamp : undefined };
    if (this.sending) return;
    this.sending = true;
    cx.timer.after(60, () => {
      this.sending = false;
      if (JSON.stringify(this.next) !== JSON.stringify(shared("herdr-git:show"))) setShared("herdr-git:show", this.next);
    });
  }

  // The diff pane beside the focused tab's panes, opened once.
  ensureDiff(cx) {
    const tab = focused()?.tab;
    if (!tab || panes().some((p) => p.tab === tab && p.mod === "herdr-git")) return;
    run("pane.split", { direction: "right", mod: "herdr-git", props: { view: "diff" } });
    cx.spawn(async (cx) => { await cx.sleep(150); this.handle.focus(); cx.notify(); });
  }

  // Enter: the diff pane zoomed to the whole tab (its Esc brings the layout back).
  focusDiff() {
    const tab = focused()?.tab, pane = panes().find((p) => p.tab === tab && p.mod === "herdr-git");
    if (pane) run(pane.zoomed ? "pane.focus" : "pane.zoom", { pane: pane.pane });
  }

  select(panel, index, cx) {
    this.panel = panel;
    const view = this.view, rows = this.rows(view);
    this.sel[view] = Math.max(0, Math.min(index, rows.length - 1));
    if (this.folded.delete(panel)) setShared("herdr-git:folded", [...this.folded]);
    this.scrolls[panel].scroll_to_item(this.sel[view]);
    this.show(cx); this.ensureDiff(cx); cx.notify();
  }

  setTab(panel, tab, cx) {
    if (tab !== "remotes") this.inRemote = null;
    this.tabs[panel] = tab; setShared("herdr-git:tabs", this.tabs);
    this.select(panel, this.sel[this.viewOf(panel)] ?? 0, cx);
  }

  // Runs one change, shows what failed, and reloads.
  act(label, work, cx) {
    if (this.busy) return;
    this.busy = label; this.note = null; this.info = null; cx.notify();
    cx.spawn(async (cx) => {
      try { await work(cx); }
      catch (e) { this.note = String(e.message ?? e); }
      finally { this.busy = null; this.refresh(cx); cx.notify(); }
    });
  }

  w(args, opts) { return git(this.repo, args, { write: true, ...opts }); }

  // A command that needs a person (an editor, a password) in a terminal under the focused pane.
  inTerminal(argv, folder = this.repo.root) { run("terminal.open", { argv, folder, place: "down" }); }

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

  async commit({ noVerify = false } = {}) {
    if (!this.files.some((f) => f.staged)) {
      if (!this.files.length) throw new Error("Nothing to commit");
      if (!await confirm("No files staged", "Stage all files and commit?", "Stage all and commit", false)) return;
      await this.w(["add", "-A"]);
    }
    const r = await ask({ title: noVerify ? "Commit (skip hooks)" : "Commit", input: { placeholder: "Summary" }, description: true });
    if (!r?.text.trim()) return;
    await this.w(["commit", "-m", r.text.trim(), ...(r.description.trim() ? ["-m", r.description.trim()] : []), ...(noVerify ? ["--no-verify"] : [])], { timeout: 120000 });
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
    await git({ root: `${this.repo.root}/${path}`, on: this.repo.on }, ["stash", "push", "--include-untracked", "-m", "herdr-git: submodule reset"], { write: true });
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
    const view = this.view, row = this.current(), rows = this.rows(view), i = this.sel[view] ?? 0;
    const index = PANELS.findIndex((p) => p.id === this.panel);
    const move = (n) => this.select(this.panel, i + n, cx);
    const act = (label, work) => this.act(label, work, cx);
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
        space: ["Stage / unstage", () => row && act(row.file?.staged && !row.file?.unstaged ? "Unstaging…" : "Staging…", () => this.toggleStage(row))],
        enter: [row?.file?.sub ? "Open submodule" : row?.dir ? "Fold folder" : "View diff (stage lines)", () => {
          if (row?.dir) { this.collapsed.has(row.dir) ? this.collapsed.delete(row.dir) : this.collapsed.add(row.dir); }
          else if (row?.file?.sub) this.enter(row.file.path, cx);
          else this.focusDiff();
        }],
        a: ["Stage / unstage all", () => act("Staging all…", () => this.files.some((f) => f.unstaged) ? this.w(["add", "-A"]) : this.w(["reset", "-q"]))],
        c: ["Commit", () => act("Committing…", () => this.commit())],
        w: ["Commit without hooks", () => act("Committing…", () => this.commit({ noVerify: true }))],
        C: ["Commit in your editor", () => this.inTerminal(["git", "commit"])],
        A: ["Amend last commit", () => act("Amending…", async () => {
          const r = await ask({ title: "Amend last commit", detail: this.commits[0]?.subject, items: [
            { key: "enter", label: "Amend with staged changes", value: "noedit" },
            { key: "r", label: "Amend and reword…", value: "reword" },
          ] });
          if (r === "noedit") await this.w(["commit", "--amend", "--no-edit"]);
          if (r === "reword") {
            const m = await ask({ title: "Reword last commit", input: { value: this.commits[0]?.subject ?? "" }, description: true });
            if (m?.text.trim()) await this.w(["commit", "--amend", "-m", m.text.trim(), ...(m.description.trim() ? ["-m", m.description.trim()] : [])]);
          }
        })],
        d: [row?.file?.sub ? "Reset submodule" : "Discard changes", () => row && act("Discarding…", async () => {
          if (row.file?.sub) return this.resetSub(row.file.path);
          const files = row.file ? [row.file] : row.files, items = [{ key: "x", label: "Discard all changes", value: "all", danger: true }];
          if (files.some((f) => f.staged) && files.some((f) => f.unstaged && !f.untracked)) items.push({ key: "u", label: "Discard unstaged changes", value: "unstaged", danger: true });
          const r = await ask({ title: `Discard ${row.file?.path ?? row.dir + "/"}`, items });
          if (r) await this.discard(row, r === "unstaged");
        })],
        D: ["Reset options", () => act("Resetting…", async () => {
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
        M: ["Resolve conflict…", () => row?.file?.conflict && act("Resolving…", async () => {
          const p = row.file.path;
          const r = await ask({ title: `Resolve ${p}`, detail: "enter on the file picks conflict by conflict in the diff pane.", items: [
            { key: "o", label: "Keep ours (the checked out side)", value: "--ours" },
            { key: "t", label: "Keep theirs (the incoming side)", value: "--theirs" },
            { key: "m", label: "Open git mergetool in a terminal", value: "tool" },
          ] });
          if (r === "tool") return this.inTerminal(["git", "mergetool", "--", p]);
          if (r) { await this.w(["checkout", r, "--", p]); await this.w(["add", "--", p]); }
        })],
        s: ["Stash all changes", () => act("Stashing…", async () => {
          const r = await ask({ title: "Stash all changes", input: { placeholder: "Stash message (optional)" } });
          if (r) await this.w(["stash", "push", "--include-untracked", ...(r.text.trim() ? ["-m", r.text.trim()] : [])]);
        })],
        S: ["Stash options", () => act("Stashing…", async () => {
          const r = await ask({ title: "Stash", items: [
            { key: "a", label: "Stash all changes", value: ["--include-untracked"] },
            { key: "i", label: "Stash all changes and keep index", value: ["--include-untracked", "--keep-index"] },
            { key: "s", label: "Stash staged changes", value: ["--staged"] },
            { key: "u", label: "Stash unstaged changes", value: ["--keep-index"] },
          ] });
          if (!r) return;
          const m = await ask({ title: "Stash message", input: { placeholder: "Optional" } });
          if (m) await this.w(["stash", "push", ...r, ...(m.text.trim() ? ["-m", m.text.trim()] : [])]);
        })],
        i: ["Ignore", () => row && act("Ignoring…", () => this.ignore(row))],
        e: ["Edit in your editor", () => row?.file && this.inTerminal(["sh", "-c", 'exec ${VISUAL:-${EDITOR:-micro}} "$1"', "sh", row.file.path])],
        o: ["Open with the default app", () => row?.file && !this.repo.on && exec("xdg-open", [`${this.repo.root}/${row.file.path}`])],
        "`": ["Tree / flat list", () => { this.tree = !this.tree; setShared("herdr-git:tree", this.tree); this.select("files", 0, cx); }],
        // Collapsing all needs every folder, nested ones too: list them with nothing collapsed.
        "-": ["Collapse all folders", () => {
          const id = row?.id;
          this.collapsed = new Set();
          this.collapsed = new Set(this.rows("files").filter((r) => r.dir).map((r) => r.dir));
          this.select("files", Math.max(0, this.rows("files").findIndex((r) => r.id === id)), cx);
        }],
        "=": ["Expand all folders", () => {
          const id = row?.id;
          this.collapsed = new Set();
          this.select("files", Math.max(0, this.rows("files").findIndex((r) => r.id === id)), cx);
        }],
      },
      worktrees: {
        enter: ["Switch to this worktree", () => row && this.go([{ root: row.id, on: this.repo.on }], cx)],
        space: ["Switch to this worktree", () => row && this.go([{ root: row.id, on: this.repo.on }], cx)],
        o: ["Open a terminal there", () => row && this.inTerminal(undefined, row.id)],
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
        b: ["All submodules…", () => act("Updating submodules…", async () => {
          const r = await ask({ title: "All submodules", items: [
            { key: "i", label: "Init all", value: ["submodule", "init"] },
            { key: "u", label: "Update all (recursively)", value: ["submodule", "update", "--init", "--recursive"] },
            { key: "s", label: "Sync URLs (recursively)", value: ["submodule", "sync", "--recursive"] },
            { key: "d", label: "Deinit all", value: ["submodule", "deinit", "--all", "-f"], danger: true },
          ] });
          if (r) await this.remote(r);
        })],
        y: ["Copy path", () => row && cx.write_to_clipboard(row.id)],
        o: ["Open a terminal in it", () => row && this.inTerminal(undefined, `${this.repo.root}/${row.id}`)],
      },
      branches: {
        space: ["Check out", () => row && !row.branch.current && act(`Checking out ${row.id}…`, () => this.w(["checkout", row.id]))],
        enter: ["View log", () => this.focusDiff()],
        c: ["Check out by name", () => act("Checking out…", async () => {
          const r = await ask({ title: "Check out", input: { placeholder: "Branch, tag or commit" } });
          if (r?.text.trim()) await this.w(["checkout", r.text.trim()]);
        })],
        "-": ["Check out previous", () => act("Checking out previous…", () => this.w(["checkout", "-"]))],
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
        ...(row?.branch?.current ? {} : mergeRebase),
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
        y: copy,
        o: ["Open in the browser", () => row && act("Opening…", () => this.browse(`tree/${row.branch.upstream ? remoteOf(row.branch.upstream)[1] : row.id}`))],
        W: diffAgainst,
      },
      remotes: {
        enter: ["Show its branches", () => { if (row) { this.inRemote = row.id; this.select("branches", 0, cx); } }],
        f: ["Fetch", () => row && act(`Fetching ${row.id}…`, () => this.remote(["fetch", row.id]))],
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
        n: ["New branch from here", () => this.newBranch(row?.id ?? "HEAD", cx)],
        ...mergeRebase,
        u: ["Set as upstream of the current branch", () => row && act("Setting upstream…", () => this.w(["branch", "--set-upstream-to", row.id]))],
        d: ["Delete on the remote", () => row && act(`Deleting ${row.id}…`, async () => {
          const [remote, branch] = remoteOf(row.id);
          if (await confirm(`Delete ${branch} on ${remote}?`, row.rbranch.subject, "Delete remote branch")) await this.remote(["push", remote, "--delete", branch]);
        })],
        y: copy,
        o: ["Open in the browser", () => row && act("Opening…", () => this.browse(`tree/${remoteOf(row.id)[1]}`))],
        W: diffAgainst,
      },
      tags: {
        space: ["Check out", () => row && act(`Checking out ${row.id}…`, async () => {
          if (await confirm(`Check out ${row.id}?`, "You'll be on a detached HEAD.", "Check out", false)) await this.w(["checkout", "--detach", row.id]);
        })],
        enter: ["View log", () => this.focusDiff()],
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
        y: copy,
        W: diffAgainst,
      },
      commits: row?.todo ? {
        // A rebase in progress: change what's still to come.
        p: ["Pick", () => this.setTodo(row, "pick", cx)],
        s: ["Squash into the one below", () => this.setTodo(row, "squash", cx)],
        f: ["Fixup into the one below", () => this.setTodo(row, "fixup", cx)],
        e: ["Edit (stop there)", () => this.setTodo(row, "edit", cx)],
        d: ["Drop", () => act("Dropping…", () => this.editTodo((t) => t.splice(row.n, 1)))],
        // The list shows the todo upside down: down is earlier in it.
        "ctrl-j": ["Move down", () => row.n > 0 && act("Moving…", async () => {
          await this.editTodo((t) => { [t[row.n - 1], t[row.n]] = [t[row.n], t[row.n - 1]]; });
          this.sel.commits = i + 1;
        })],
        "ctrl-k": ["Move up", () => row.n < this.todo.length - 1 && act("Moving…", async () => {
          await this.editTodo((t) => { [t[row.n + 1], t[row.n]] = [t[row.n], t[row.n + 1]]; });
          this.sel.commits = i - 1;
        })],
        enter: ["View commit", () => this.focusDiff()],
      } : {
        enter: ["View commit (select lines to move)", () => this.focusDiff()],
        space: ["Check out", () => row && act(`Checking out ${short}…`, async () => {
          if (await confirm(`Check out ${short}?`, "You'll be on a detached HEAD.", "Check out", false, EXPLAIN.commits.space)) await this.w(["checkout", "--detach", row.id]);
        })],
        g: ["Reset to this commit…", () => row && act("Resetting…", () => this.resetTo(row.id, short, row.commit.subject))],
        r: ["Reword", () => row && act("Rewording…", async () => {
          const body = (await git(this.repo, ["log", "-1", "--format=%b", row.id])).trim();
          const m = await ask({ title: `Reword ${short}`, detail: EXPLAIN.commits.r, input: { value: row.commit.subject }, description: true, descriptionValue: body });
          if (!m?.text.trim()) return;
          const msg = [m.text.trim(), ...(m.description.trim() ? ["-m", m.description.trim()] : [])];
          if (row.id === this.head.oid) return this.w(["commit", "--amend", "--only", "--no-verify", "-m", ...msg]);
          const file = `${this.gitDir}/herdr-git-msg`, w = await writeThere(this.repo, file, m.text.trim() + (m.description.trim() ? "\n\n" + m.description.trim() : "") + "\n");
          if (w.code !== 0) throw new Error(w.stderr.trim());
          await this.rewrite(row.id, (t) => t.splice(1, 0, { action: "exec", rest: `git commit --amend --only --no-verify -F '${file}'` }));
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
        "ctrl-j": ["Move down", () => row?.commit && act("Moving…", async () => {
          await this.rewrite(`${row.id}^`, (t) => { if (t.length < 2) throw new Error("Nothing below to move past"); [t[0], t[1]] = [t[1], t[0]]; });
          this.sel.commits = i + 1;
        })],
        "ctrl-k": ["Move up", () => row?.commit && act("Moving…", async () => {
          await this.rewrite(row.id, (t) => { if (t.length < 2) throw new Error("Already the newest"); [t[0], t[1]] = [t[1], t[0]]; });
          this.sel.commits = Math.max(0, i - 1);
        })],
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
        C: ["Copy for cherry-pick", () => row && this.toggleCopy(row.id, short)],
        V: ["Paste (cherry-pick) copied commits", () => this.paste(cx)],
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
        C: ["Copy for cherry-pick", () => row && this.toggleCopy(row.reflog.hash, short)],
        V: ["Paste (cherry-pick) copied commits", () => this.paste(cx)],
        n: ["New branch from here", () => row && this.newBranch(row.reflog.hash, cx, short)],
        y: ["Copy hash", () => row && cx.write_to_clipboard(row.reflog.hash)],
        W: diffAgainst,
      },
      stash: {
        space: ["Apply", () => row && act("Applying stash…", () => this.w(["stash", "apply", row.id]))],
        g: ["Pop", () => row && act("Popping stash…", () => this.w(["stash", "pop", row.id]))],
        d: ["Drop", () => row && act("Dropping stash…", async () => {
          if (await confirm(`Drop ${row.id}?`, row.stash.subject, "Drop", true, "Deletes this stash and the changes saved in it.")) await this.w(["stash", "drop", row.id]);
        })],
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
        enter: ["View", () => this.focusDiff()],
      },
      status: { enter: ["View all branches", () => this.focusDiff()] },
    };
    const busy = this.ops.find((o) => o !== "BISECT_LOG");
    const global = {
      j: () => move(1), down: () => move(1), k: () => move(-1), up: () => move(-1),
      "ctrl-d": () => move(10), pagedown: () => move(10), "ctrl-u": () => move(-10), pageup: () => move(-10),
      g: () => move(-rows.length), home: () => move(-rows.length), G: () => move(rows.length), end: () => move(rows.length),
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
      "/": ["Filter this list", () => {
        if (this.filterView !== view) { this.filter.set_value(""); this.filterText = ""; this.filterView = view; }
        this.filtering = true; this.filter.focus();
      }],
      p: ["Pull", () => act("Pulling…", () => this.remote(["pull"]))],
      P: ["Push", () => act("Pushing…", () => this.push())],
      f: ["Fetch all remotes", () => act("Fetching…", () => this.remote(["fetch", "--all", "--prune"]))],
      z: ["Undo (reflog)", () => act("Undoing…", () => this.undo())],
      R: ["Refresh", () => this.refresh(cx)],
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
    const row = this.current(), explain = EXPLAIN[row?.todo ? "todo" : this.view] ?? {};
    const items = Object.entries(all ? { ...panel, ...global } : panel).filter(([, a]) => Array.isArray(a)).map(([key, [label]]) => ({ key, label, value: key, hint: panel[key] ? explain[key] : undefined }));
    if (!items.length) return;
    cx.spawn(async (cx) => {
      const k = await ask({ menu: !all, title: all ? "Keys" : row?.name ?? row?.text ?? null, items });
      if (k) { this.key(k, cx); cx.notify(); }
    });
  }

  key(k, cx) {
    const { panel, global } = this.actions(cx);
    const a = panel[k] ?? global[k];
    if (!a) return false;
    (Array.isArray(a) ? a[1] : a)();
    cx.notify();
    return true;
  }

  // --- Drawing ---
  line(row, selected, t) {
    const base = h_flex().h(ROW).flex_none().px(8).gap(8).items_center().rounded(7).when(selected, (e) => e.bg(this.handle.is_focused() ? t.selected : t.hover));
    const dim = (s) => div().text_color(t.dim).flex_none().child(s);
    const name = (s, color = t.foreground) => div().flex_1().min_w(0).truncate().text_color(color).child(s);
    if (row.file || row.dir) {
      const f = row.file, files = row.file ? [row.file] : row.files;
      const staged = files.every((x) => x.staged && !x.unstaged), some = files.some((x) => x.staged);
      const label = name(row.dir ? row.name + "/" : row.name, f ? (f.conflict ? t.ansi1 : staged ? t.ansi2 : f.untracked ? t.ansi1 : t.foreground) : t.muted);
      const xy = f ? h_flex().flex_none().w(18).text_size(11).child(div().text_color(t.ansi2).child(f.x === "." ? " " : f.x === "?" ? "?" : f.x)).child(div().text_color(t.ansi1).child(f.y === "." ? " " : f.y))
        : h_flex().flex_none().w(18).text_color(staged ? t.ansi2 : some ? t.blocked : t.dim).child(icon(this.collapsed.has(row.dir) ? "chevron-right" : "chevron-down").size(12));
      // A submodule says what changed in it: its commit, its files, or new files.
      const sub = f?.sub ? [f.sub[1] === "C" && "commit", f.sub[2] === "M" && "modified", f.sub[3] === "U" && "untracked"].filter(Boolean).join(", ") : "";
      return base.pl(8 + row.depth * 12).child(xy).child(label).when(Boolean(f?.sub), (e) => e.child(dim(`submodule${sub ? ": " + sub : ""}`)));
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
      return base.child(div().flex_none().text_color(copied ? t.accent : this.commits.indexOf(c) < this.head.ahead ? t.ansi1 : t.ansi3).child(c.short))
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

  render(cx) {
    this.follow(cx);
    // The diff pane changed something (a line staged, a conflict resolved).
    if (shared("herdr-git:bump") !== this.bump) { this.bump = shared("herdr-git:bump"); this.refresh(cx); }
    const t = theme(), focused = this.handle.is_focused(), h = this.head;
    const toggle = (id, cx) => {
      this.folded.has(id) ? this.folded.delete(id) : this.folded.add(id);
      setShared("herdr-git:folded", [...this.folded]); cx.notify();
    };
    // The title bar: where you are (submodules as a breadcrumb), the branch, and what's running.
    const title = h_flex().h(42).flex_none().px(14).gap(4).items_center().border_b(1).border_color(t.border)
      .when(!this.repo, (e) => e.child(div().font_semibold().child("Git")))
      .children(this.stack.map((r, n) => div().id(`crumb-${n}`).flex_none().px(2).rounded(4).font_semibold().cursor_pointer()
        .text_color(n === this.stack.length - 1 ? t.foreground : t.muted).hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { if (n < this.stack.length - 1) this.go(this.stack.slice(0, n + 1), cx); })
        .child((n ? "› " : "") + (n ? r.root.slice(this.stack[n - 1].root.length + 1) : r.root.split("/").pop()))))
      .when(Boolean(this.repo), (e) => e.child(h_flex().id("branch").ml(4).min_w(0).h(22).px(6).gap(5).items_center().rounded(6).cursor_pointer()
        .text_size(11.5).text_color(this.panel === "status" ? t.foreground : t.muted)
        .when(this.panel === "status", (e) => e.bg(focused ? t.selected : t.hover)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.handle.focus(); this.select("status", 0, cx); })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.handle.focus(); this.select("status", 0, cx); this.menu(cx, true); })
        .child(icon("git-branch").size(12).flex_none())
        .child(div().min_w(0).truncate().child(h.branch === "(detached)" ? h.oid?.slice(0, 7) ?? "(detached)" : h.branch || (this.loading ? "…" : "(no branch)")))
        .when(h.ahead > 0, (e) => e.child(div().flex_none().text_color(t.ansi2).child(`↑${h.ahead}`)))
        .when(h.behind > 0, (e) => e.child(div().flex_none().text_color(t.ansi1).child(`↓${h.behind}`)))))
      .child(div().flex_1())
      .when(Boolean(this.busy), (e) => e.child(div().flex_none().text_color(t.working).text_size(11).child(this.busy)).child(div().text_color(t.working).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)));
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
          .child(div().flex_none().text_size(10.5).text_color(active ? t.accent : t.dim).child(String(n)))
          .child(icon(open ? "chevron-down" : "chevron-right").size(11).flex_none().text_color(t.dim)));
      const el = v_flex().when(n > 2, (e) => e.border_t(1).border_color(t.border)).child(header);
      if (!open) return el.flex_none();
      const filterBox = div().mx(10).mb(4).h(30).flex_none().px(10).flex().items_center().rounded(8).border_1().border_color(this.filtering ? t.accent : t.border)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.filter).h_full().text_size(12));
      if (!rows.length) return el.flex_none().when(filter > 0, (e) => e.child(filterBox)).child(div().px(14).pb(8).text_size(12).text_color(t.dim).child(this.empty(view)));
      return el.flex_1().min_h(HEAD + Math.min(rows.length, 3) * ROW + 8 + filter).max_h(HEAD + rows.length * ROW + 8 + filter)
        .when(filter > 0, (e) => e.child(filterBox))
        // A plain scroll area placed absolutely, as the shipped Changes list does: its size comes from the section.
        .child(div().flex_1().min_h(0).relative()
          .child(v_flex().id(`list-${p.id}`).absolute().inset_0().px(6).pb(6).overflow_y_scroll().track_scroll(this.scrolls[p.id]).children(rows.slice(0, 2000).map((row, j) =>
            div().id(`row-${row.id}`).flex_none().cursor_pointer().on_click((e, cx) => {
              this.handle.focus(); this.select(p.id, j, cx);
              // A folder opens or closes on one click (a double click's second click does nothing more).
              if (row.dir) { if (e.click_count === 1) this.key("enter", cx); }
              else if (e.click_count === 2) this.key(["files", "branches", "worktrees"].includes(view) ? "space" : "enter", cx);
            }).on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.handle.focus(); this.select(p.id, j, cx); this.menu(cx); })
              .child(this.line(row, active && j === sel, t)))))
          .child(Scrollbar.vertical(`list-${p.id}`).absolute().inset_0()));
    };
    return v_flex().id("herdr-git").size_full().min_h(0).overflow_hidden().rounded(10).border_1().border_color(t.border)
      .bg(t.background).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (this.filtering && e.key === "escape") { this.filtering = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); return; }
        if (this.filtering && !this.handle.is_focused()) return;
        if (this.key(keyOf(e), cx)) cx.stop_propagation();
      })
      .on_mouse_down("left", (_e, cx) => { this.handle.focus(); cx.notify(); })
      .child(title)
      .children(banners.map(banner))
      .when(Boolean(this.error) || !this.repo, (e) => e.child(div().flex_1().px(14).py(12).text_size(12).text_color(t.dim).child(this.error ?? "")))
      .when(!this.error && Boolean(this.repo), (e) => e.child(v_flex().flex_1().min_h(0).children(PANELS.slice(1).map((p, n) => section(p, n + 2)))))
      .when(Boolean(this.note), (e) => e.child(div().id("note").flex_none().px(14).py(8).border_t(1).border_color(t.border).text_size(11.5).text_color(t.ansi1).cursor_pointer()
        .on_click((_e, cx) => { this.note = null; cx.notify(); }).child(this.note)))
      .when(Boolean(this.repo) && !this.error, (e) => e.child(div().flex_none().px(14).py(6).border_t(1).border_color(t.border).text_size(10.5).text_color(t.dim).truncate().child(this.hints())));
  }

  summary(view) {
    const row = this.current(view);
    return row?.name ?? row?.text ?? "";
  }

  empty(view) {
    if (this.loading && !this.head.branch) return "Loading…";
    if (view === this.filterView && this.filterText) return "Nothing matches";
    return { files: "No changes", worktrees: "No worktrees", submodules: "No submodules", branches: "No branches", remotes: "No remotes", "remote-branches": "No branches", tags: "No tags", commits: "No commits yet", reflog: "No reflog", stash: "No stashes", status: "" }[view];
  }

  // A short, per-section line of the keys you reach for most; ? lists the rest.
  hints() {
    const keys = {
      files: "space stage · a stage all · c commit · d discard · s stash",
      worktrees: "space switch · n new · o terminal · d remove",
      submodules: "enter open · u update · n add · d remove",
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
