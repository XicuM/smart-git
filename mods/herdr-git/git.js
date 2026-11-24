// Git for every view: where the repo is, running git there, and reading its output.
import { spaces, panes, focused, exec } from "herdr";

// The focused pane's folder and machine (as the shipped Changes panel finds them).
// A focused mod pane (the diff) stands for a terminal of its tab; in a tab with none,
// the space's folder is only a `guess` (the sidebar keeps the repo it has).
export function location() {
  const space = spaces().find((s) => s.active), f = focused();
  let pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const guess = Boolean(pane && !pane.terminal && !panes().some((p) => p.tab === pane.tab && p.terminal));
  if (pane && !pane.terminal) pane = panes().find((p) => p.tab === pane.tab && p.terminal) ?? null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id, guess };
}

// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
// Diffs always say a/ and b/ (a personal diff.mnemonicPrefix or noprefix would break patches).
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-c", "diff.mnemonicPrefix=false", "-c", "diff.noprefix=false"];

// `repo` is { root, on }. Reads by default; `write: true` for commands that change things.
// Never prompts: a password or passphrase it would need is an error, and the caller
// offers to run the command in a terminal instead.
// `env` adds variables ("GIT_SEQUENCE_EDITOR=…").
export async function git(repo, args, { write = false, timeout = 30000, env = [] } = {}) {
  const r = await exec("env", ["GIT_TERMINAL_PROMPT=0", "GIT_EDITOR=true", ...env, "git", ...(write ? [] : READ), ...args], { cwd: repo.root, on: repo.on, timeout });
  // `diff --no-index` exits 1 when the files differ, which is what it's asked for.
  if (r.code !== 0 && !(r.code === 1 && args.includes("--no-index"))) throw new Error((r.stderr || r.stdout || `git ${args[0]} failed`).trim());
  return r.stdout;
}

// A file written into the repo's machine (a patch, a todo list, a resolved conflict), through
// sh so it works remotely; in pieces, as one argument can't pass 128 KiB.
export async function writeThere(repo, path, text) {
  let r;
  for (let at = 0, first = true; first || at < text.length; at += 30000, first = false) {
    r = await exec("sh", ["-c", first ? 'printf %s "$1" > "$2"' : 'printf %s "$1" >> "$2"', "sh", text.slice(at, at + 30000), path], { cwd: repo.root, on: repo.on });
    if (r.code !== 0) break;
  }
  return r;
}

export async function findRoot(cwd, on) {
  const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
  return r.code === 0 ? r.stdout.trim() : null;
}

// `git status --porcelain=v2 -z --branch`: the branch line and every changed path.
// Submodule entries keep their `S<c><m><u>` field (commit changed, modified, untracked).
export function parseStatus(text) {
  const head = { oid: "", branch: "", upstream: "", ahead: 0, behind: 0 }, files = [];
  const parts = text.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    if (e.startsWith("# branch.oid ")) head.oid = e.slice(13);
    else if (e.startsWith("# branch.head ")) head.branch = e.slice(14);
    else if (e.startsWith("# branch.upstream ")) head.upstream = e.slice(18);
    else if (e.startsWith("# branch.ab ")) { const [a, b] = e.slice(12).split(" "); head.ahead = +a; head.behind = -b; }
    else if (e[0] === "?") files.push({ path: e.slice(2), x: "?", y: "?", untracked: true });
    else if (e[0] === "1" || e[0] === "2" || e[0] === "u") {
      const f = e.split(" "), fixed = e[0] === "1" ? 8 : e[0] === "2" ? 9 : 10;
      const file = { path: f.slice(fixed).join(" "), x: f[1][0], y: f[1][1], sub: f[2][0] === "S" ? f[2] : null, conflict: e[0] === "u" };
      if (e[0] === "2") file.from = parts[++i];
      files.push(file);
    }
  }
  for (const f of files) {
    f.staged = !f.untracked && !f.conflict && f.x !== ".";
    f.unstaged = f.untracked || f.conflict || f.y !== ".";
  }
  return { head, files };
}

// `git log` lines written with FORMAT, split back into commits.
export const LOG_FORMAT = "%H%x1f%h%x1f%an%x1f%ar%x1f%D%x1f%s";
export const parseLog = (text) => text.split("\n").filter(Boolean).map((l) => {
  const [hash, short, author, when, refs, subject] = l.split("\x1f");
  return { hash, short, author, when, refs, subject };
});

// `git for-each-ref` over local branches.
export const BRANCH_FORMAT = "%(HEAD)%1f%(refname:short)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(committerdate:relative)%1f%(subject)";
export const parseBranches = (text) => text.split("\n").filter(Boolean).map((l) => {
  const [head, name, upstream, track, when, subject] = l.split("\x1f");
  return { current: head === "*", name, upstream, track, when, subject };
});

// `git submodule status --recursive` (state: " " ok, "-" not initialized, "+" checked out
// elsewhere than recorded, "U" conflict) joined with .gitmodules' urls. `parent` is the
// submodule a nested one lives in ("" for the repo's own), and `rel` its path there.
export function parseSubmodules(status, config) {
  const url = {}, name = {};
  for (const e of config.split("\0").filter(Boolean)) {
    const [key, value] = [e.slice(0, e.indexOf("\n")), e.slice(e.indexOf("\n") + 1)];
    const m = /^submodule\.(.*)\.(path|url)$/.exec(key);
    if (m?.[2] === "path") name[value] = m[1];
    else if (m) url[m[1]] = value;
  }
  const subs = status.split("\n").filter(Boolean).map((l) => {
    const [hash, path, ...rest] = l.slice(1).split(" ");
    return { state: l[0], hash, path, describe: rest.join(" ").replace(/^\(|\)$/g, "") };
  });
  for (const s of subs) {
    const outer = subs.filter((o) => s.path.startsWith(o.path + "/"));
    s.depth = outer.length;
    s.parent = outer.map((o) => o.path).sort((a, b) => b.length - a.length)[0] ?? "";
    s.rel = s.parent ? s.path.slice(s.parent.length + 1) : s.path;
    // A nested one's name and url are in its parent's .gitmodules, not read here.
    s.name = s.parent ? s.rel : name[s.path] ?? s.path;
    s.url = s.parent ? "" : url[s.name] ?? "";
  }
  return subs;
}

// `git worktree list --porcelain`.
export const parseWorktrees = (text) => text.split("\n\n").filter((b) => b.trim()).map((b) => {
  const w = { path: "", head: "", branch: "", bare: false, detached: false, locked: false, prunable: false };
  for (const l of b.split("\n")) {
    if (l.startsWith("worktree ")) w.path = l.slice(9);
    else if (l.startsWith("HEAD ")) w.head = l.slice(5);
    else if (l.startsWith("branch ")) w.branch = l.slice(7).replace("refs/heads/", "");
    else if (l === "bare" || l === "detached") w[l] = true;
    else if (l.startsWith("locked")) w.locked = true;
    else if (l.startsWith("prunable")) w.prunable = true;
  }
  return w;
});

// `git remote -v` (fetch urls).
export const parseRemotes = (text) => text.split("\n").filter((l) => l.endsWith(" (fetch)")).map((l) => {
  const [name, url] = l.replace(/ \(fetch\)$/, "").split("\t");
  return { name, url };
});

// `git for-each-ref` over tags or remote branches: name, subject, when.
export const REF_FORMAT = "%(refname:short)%1f%(subject)%1f%(creatordate:relative)%1f%(objectname:short)";
export const parseRefs = (text) => text.split("\n").filter(Boolean).map((l) => {
  const [name, subject, when, short] = l.split("\x1f");
  return { name, subject, when, short };
}).filter((r) => !r.name.endsWith("/HEAD"));

// `git reflog --format=REFLOG_FORMAT`.
export const REFLOG_FORMAT = "%H%x1f%h%x1f%gs%x1f%cr%x1f%gd";
export const parseReflog = (text) => text.split("\n").filter(Boolean).map((l) => {
  const [hash, short, subject, when, ref] = l.split("\x1f");
  return { hash, short, subject, when, ref };
});

// `git stash list --format=%gd%x1f%cr%x1f%gs`.
export const parseStash = (text) => text.split("\n").filter(Boolean).map((l) => {
  const [ref, when, subject] = l.split("\x1f");
  return { ref, when, subject };
});

// Rewrites history from `hash` (it and every commit after it, up to HEAD). `change` edits
// git's todo list, oldest first, as { action, rest } ("pick", full hash); without it the
// list stays as git wrote it (with `autosquash`, fixups moved into place). Stops where the
// todo says (edit, break) or at a conflict, as `git rebase -i` does.
export async function rebaseWith(repo, hash, change, { autosquash = false } = {}) {
  if (!(await git(repo, ["rev-parse", "--verify", "-q", `${hash}^{commit}`]).catch(() => "")).trim()) throw new Error("No such commit");
  await git(repo, ["merge-base", "--is-ancestor", hash, "HEAD"]).catch(() => { throw new Error("That commit isn't on the checked out branch"); });
  const root = !(await git(repo, ["rev-parse", "--verify", "-q", `${hash}^`]).catch(() => "")).trim();
  const range = root ? "HEAD" : `${hash}^..HEAD`;
  if ((await git(repo, ["rev-list", "--merges", range])).trim()) throw new Error("Can't rewrite history across a merge commit");
  let editor = "true";
  if (change) {
    const todo = (await git(repo, ["log", "--reverse", "--format=%H %s", range])).split("\n").filter(Boolean).map((rest) => ({ action: "pick", rest }));
    change(todo);
    const file = `${(await git(repo, ["rev-parse", "--absolute-git-dir"])).trim()}/herdr-git-todo`;
    const r = await writeThere(repo, file, todo.map((t) => `${t.action} ${t.rest}`.trim()).join("\n") + "\n");
    if (r.code !== 0) throw new Error(r.stderr.trim());
    editor = `cp '${file}'`;
  }
  return git(repo, ["rebase", "-i", "--autostash", autosquash ? "--autosquash" : "--no-autosquash", ...(root ? ["--root"] : [`${hash}^`])],
    { write: true, timeout: 120000, env: [`GIT_SEQUENCE_EDITOR=${editor}`] });
}

// A unified diff with only the picked +/- lines (`pick(i)`: line i of `text`), for `git apply`.
// Lines left out must keep the patch true to the side it applies to: forward, a removal
// stays as context and an addition goes; `reverse` (for `apply -R`), the other way round.
export function partialPatch(text, pick, reverse) {
  const out = [];
  let header = null, hunk = null;
  const flush = () => {
    if (hunk?.some) { if (header) { out.push(...header); header = null; } out.push(hunk.head, ...hunk.body); }
    hunk = null;
  };
  const lines = text.replace(/\n$/, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("diff --git ")) { flush(); header = [l]; continue; }
    // A submodule's commit summary isn't patch text: skip it up to the next file.
    if (l.startsWith("Submodule ")) { flush(); header = null; continue; }
    if (l.startsWith("@@")) { flush(); if (header || out.length) hunk = { head: l, body: [], some: false, kept: true }; continue; }
    if (!hunk) { header?.push(l); continue; }
    const k = l[0];
    if (k === "\\") { if (hunk.kept) hunk.body.push(l); continue; }
    if (k === "+" || k === "-") {
      if (pick(i)) { hunk.body.push(l); hunk.some = hunk.kept = true; }
      else if ((k === "-") !== reverse) { hunk.body.push(" " + l.slice(1)); hunk.kept = true; }
      else hunk.kept = false;
    } else { hunk.body.push(l); hunk.kept = true; }
  }
  flush();
  return out.length ? out.join("\n") + "\n" : "";
}

// A file with conflict markers, as plain runs of lines (arrays) and conflicts
// ({ ours, base, theirs, head, tail }: the lines of each side and the marker lines).
export function parseConflicts(text) {
  const parts = [];
  let plain = [], c = null;
  for (const l of text.split("\n")) {
    if (!c && l.startsWith("<<<<<<<")) { parts.push(plain); plain = []; c = { ours: [], base: null, theirs: [], side: "ours", head: l, tail: "" }; continue; }
    if (c) {
      if (c.side === "ours" && l.startsWith("|||||||")) { c.base = []; c.mid = l; c.side = "base"; continue; }
      if (c.side !== "theirs" && l === "=======") { c.side = "theirs"; continue; }
      if (c.side === "theirs" && l.startsWith(">>>>>>>")) { c.tail = l; parts.push(c); c = null; continue; }
      c[c.side].push(l); continue;
    }
    plain.push(l);
  }
  // An unfinished conflict is just text.
  if (c) plain = [...plain, c.head, ...c.ours, ...(c.base ? [c.mid, ...c.base] : []), ...(c.side === "theirs" ? ["=======", ...c.theirs] : [])];
  parts.push(plain);
  return parts;
}

// Text draws a tab as nothing: pad each to the next 4-column stop.
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// Unified diff text (possibly several files, possibly after a commit header) into rows:
// kind "h" (header text), "f" (file name), "@" (hunk), "+", "-", " ". A +/- row keeps
// `raw`, its line in `text`, for building patches.
export function diffRows(text) {
  const rows = [], lines = text.replace(/\n$/, "").split("\n").slice(0, 20000);
  let old = 0, next = 0, inHunk = false;
  for (let raw = 0; raw < lines.length; raw++) {
    const line = lines[raw];
    const cut = line.length > 4000 ? line.slice(0, 4000) + "…" : line;
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(cut);
    if (m) { old = +m[1]; next = +m[2]; inHunk = true; rows.push({ kind: "@", text: cut }); continue; }
    if (cut.startsWith("diff --git ")) { inHunk = false; rows.push({ kind: "f", text: cut.replace(/^diff --git a\/(.*) b\/.*$/, "$1") }); continue; }
    if (!inHunk) { if (!/^(index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity|rename |dissimilarity)/.test(cut)) rows.push({ kind: "h", text: untab(cut) }); continue; }
    const k = cut[0], body = untab(cut.slice(1)) || " ";
    if (k === "-") rows.push({ kind: "-", old: old++, text: body, raw });
    else if (k === "+") rows.push({ kind: "+", new: next++, text: body, raw });
    else if (k === " ") rows.push({ kind: " ", old: old++, new: next++, text: body });
    else rows.push({ kind: "h", text: cut });
  }
  return rows;
}

// The same rows side by side: a run of removals pairs with the additions that follow it.
export function splitRows(rows) {
  const out = [];
  for (let i = 0; i < rows.length;) {
    const r = rows[i];
    if (r.kind !== "-" && r.kind !== "+") { out.push({ kind: r.kind, left: r, right: r }); i++; continue; }
    const minus = [], plus = [];
    while (i < rows.length && rows[i].kind === "-") minus.push(rows[i++]);
    while (i < rows.length && rows[i].kind === "+") plus.push(rows[i++]);
    for (let j = 0; j < Math.max(minus.length, plus.length); j++) out.push({ kind: "~", left: minus[j] ?? null, right: plus[j] ?? null });
  }
  return out;
}
