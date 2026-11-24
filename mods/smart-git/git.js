// Git for every view: where the repo is, running git there, and reading its output.
import { spaces, panes, focused, exec, hc, shared, terminals, openOverlay } from "herdr";
let perfFlush = false; // PERF
const PERF_LOG = [], PERF_ID = Math.random().toString(36).slice(2, 6); // PERF
export const perf = (label, t0) => { PERF_LOG.push(`${Date.now() % 100000} ${label} ${Date.now() - t0}ms`); if (perfFlush) return; perfFlush = true; Promise.resolve().then(async () => { await new Promise((r) => r()); perfFlush = false; exec("sh", ["-c", 'printf %s "$1" > "$2"', "sh", PERF_LOG.slice(-400).join("\n") + "\n", "/tmp/claude-1000/-home-xicu-Projects-herdr/ce091be5-dee9-4fa3-ad26-0ba984492e9b/scratchpad/perf-" + PERF_ID + ".log"], {}).catch(() => {}); }); }; // PERF

// The focused pane's folder and machine (as the shipped Changes panel finds them).
// A focused mod pane (the diff) stands for a terminal of its tab; in a tab with none,
// the space's folder is only a `guess` (the sidebar keeps the repo it has).
export function location() {
  const space = spaces().find((s) => s.active), f = focused();
  let pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  // Nothing with a folder focused (an empty tab) is a guess too.
  const guess = Boolean(pane && !pane.terminal && !panes().some((p) => p.tab === pane.tab && p.terminal)) || (!pane && !f?.cwd);
  if (pane && !pane.terminal) pane = panes().find((p) => p.tab === pane.tab && p.terminal) ?? null;
  // A layout or overlay terminal names its machine; anything else is on the space's.
  const on = f?.pane === null && f.terminal ? (f.terminal.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id, guess };
}

// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
// Diffs always say a/ and b/ (a personal diff.mnemonicPrefix or noprefix would break patches).
// Paths come unquoted (core.quotePath), so "año.txt" stays readable and gaps can `git show` it.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotePath=false", "-c", "diff.autoRefreshIndex=false", "-c", "diff.mnemonicPrefix=false", "-c", "diff.noprefix=false"];

// `repo` is { root, on }. Reads by default; `write: true` for commands that change things.
// Never prompts: a password or passphrase it would need is an error, and the caller
// offers to run the command in a terminal instead.
// `env` adds variables ("GIT_SEQUENCE_EDITOR=…").
export async function git(repo, args, { write = false, timeout = 30000, env = [] } = {}) {
  const t0 = Date.now(); // PERF
  const r = await exec("env", ["GIT_TERMINAL_PROMPT=0", "GIT_EDITOR=true", ...env, "git", ...(write ? [] : READ), ...args], { cwd: repo.root, on: repo.on, timeout });
  perf(`git ${args.slice(0, 2).join(" ")}`, t0); // PERF
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

// The editor in a popup over the window: a terminal overlay closes itself when its
// terminal ends, so quitting the editor is all it takes to be back. Both the sidebar and
// the diff pane open it, so neither needs the other shown.
// `line`: open there (the line selected in the diff); helix takes file:line, the rest +line.
export async function openEditor(repo, path, line, cx) {
  const ed = shared("smart-git:editor") ?? "${VISUAL:-${EDITOR:-micro}}";
  const at = !line ? [path] : /(^|\/)hx\b/.test(ed) ? [`${path}:${line}`] : [`+${line}`, path];
  // An editor that can't start (126/127) would close the popup at once: say so and wait instead.
  const script = `${ed} "$@"; s=$?; [ $s -lt 126 ] || { printf '%s\\n' "Couldn't start the editor (exit $s). E in smart-git picks another. Enter closes this."; read -r _; }`;
  const r = await hc(["run", "--bg", "--json", "--no-parent", "--rm", "--cwd", repo.root, ...(repo.on ? ["--on", repo.on] : []),
    "--", "sh", "-c", script, "sh", ...at]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim());
  // The app hears of a new terminal a moment after hc starts it; an overlay opened before would close at once.
  const t = JSON.parse(r.stdout).address;
  for (let n = 0; n < 30 && !terminals().some((x) => x.address === t); n++) await cx.sleep(100);
  // A click beside it doesn't close it (that would leave the editor running unseen); Esc goes to the editor.
  openOverlay({ kind: "dialog", modal: true, width: 0.85, height: 0.85, layout: { type: "column", children: [
    { type: "block", size: { px: 34 }, content: { mod: "smart-git", props: { view: "editbar", title: line ? `${path}:${line}` : path, editor: ed.startsWith("$") ? "" : ed, terminal: t } } },
    { type: "block", content: { terminal: t } }] } });
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
      // A conflict's versions in the index: ours (stage 2) and theirs (stage 3), null where that side deleted it.
      if (file.conflict) { file.ours = /^0+$/.test(f[8]) ? null : f[8]; file.theirs = /^0+$/.test(f[9]) ? null : f[9]; }
      // No markers to pick from (a submodule, a side deleted it): resolved by keeping one side whole.
      if (file.conflict) file.whole = Boolean(file.sub) || !file.ours || !file.theirs;
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
    const file = `${(await git(repo, ["rev-parse", "--absolute-git-dir"])).trim()}/smart-git-todo`;
    const r = await writeThere(repo, file, todo.map((t) => `${t.action} ${t.rest}`.trim()).join("\n") + "\n");
    if (r.code !== 0) throw new Error(r.stderr.trim());
    editor = `cp '${file.replace(/'/g, "'\\''")}'`;
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
      if (c.side !== "theirs" && l.replace(/\r$/, "") === "=======") { c.side = "theirs"; continue; }
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
export const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// Unified diff text (possibly several files, possibly after a commit header) into rows:
// kind "h" (header text), "f" (file: `path` its new side, null when deleted; `notes`, like
// "renamed from x"), "@" (hunk: `text` its function, `line` where it starts), "g" (the unchanged
// lines before a hunk: `from`..`to` on the new side, `old` the first one's number on the old),
// "+", "-", " ". A +/- row keeps `raw`, its line in `text`, for building patches, and when it
// pairs with a line of the other kind `hl`, the [start, end) of what changed in it.
// `rows.truncated` is set when the diff was too long to show whole.
export function diffRows(text) {
  const all = text.replace(/\n$/, "").split("\n"), lines = all.slice(0, 20000), rows = [];
  let old = 0, next = 0, inHunk = false, file = null, mode = null;
  for (let raw = 0; raw < lines.length; raw++) {
    const line = lines[raw];
    const cut = line.length > 4000 ? line.slice(0, 4000) + "…" : line;
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)/.exec(cut);
    if (m) {
      // A side with no lines in the hunk names the line before it.
      const at = +m[3] + (m[4] === "0" ? 1 : 0), n = at - next;
      if (file?.path && n > 0) rows.push({ kind: "g", from: next, to: at - 1, old, path: file.path, text: `⋯ ${n} unchanged line${n > 1 ? "s" : ""}` });
      old = +m[1] + (m[2] === "0" ? 1 : 0); next = at; inHunk = true; rows.push({ kind: "@", text: untab(m[5]), line: at }); continue;
    }
    if (cut.startsWith("diff --git ")) {
      inHunk = false; old = next = 1; mode = null;
      const path = cut.replace(/^diff --git a\/(.*) b\/.*$/, "$1");
      rows.push(file = { kind: "f", text: path, path, notes: [] }); continue;
    }
    // `--submodule=log`: "Submodule <path> <a>..<b>:" then "  > added" / "  < removed" commits.
    if (cut.startsWith("Submodule ")) { inHunk = false; file = null; rows.push({ kind: "f", text: cut }); continue; }
    if (!inHunk && /^\s+[<>] /.test(cut)) { rows.push({ kind: "h", text: cut, tone: cut.trim()[0] === ">" ? "+" : "-" }); continue; }
    if (!inHunk) {
      let n;
      if (file && cut.startsWith("+++ ")) { file.path = cut === "+++ /dev/null" ? null : cut.replace(/^\+\+\+ b\//, ""); file.text = file.path ?? file.text; }
      else if (file && (n = /^(rename|copy) to (.*)/.exec(cut))) file.path = file.text = n[2];
      else if (file && (n = /^(rename|copy) from (.*)/.exec(cut))) file.notes.push(`${n[1] === "rename" ? "renamed" : "copied"} from ${n[2]}`);
      else if (file && /^new file mode/.test(cut)) file.notes.push("new file");
      else if (file && /^deleted file mode/.test(cut)) file.notes.push("deleted");
      else if (file && (n = /^old mode (\d+)/.exec(cut))) mode = n[1];
      else if (file && (n = /^new mode (\d+)/.exec(cut))) file.notes.push(`mode ${mode} → ${n[1]}`);
      else if (file && /^Binary files /.test(cut)) file.notes.push("binary");
      else if (!/^(index |--- |similarity|dissimilarity)/.test(cut)) rows.push({ kind: "h", text: untab(cut) });
      continue;
    }
    const k = cut[0], body = untab(cut.slice(1)) || " ";
    if (k === "-") rows.push({ kind: "-", old: old++, text: body, raw });
    else if (k === "+") rows.push({ kind: "+", new: next++, text: body, raw });
    else if (k === " ") rows.push({ kind: " ", old: old++, new: next++, text: body });
    else rows.push({ kind: "h", text: cut });
  }
  // A run of removals and the additions after it pair up, line by line, like side by side.
  for (let i = 0; i < rows.length;) {
    if (rows[i].kind !== "-") { i++; continue; }
    const a = i; while (rows[i]?.kind === "-") i++;
    const b = i; while (rows[i]?.kind === "+") i++;
    for (let j = 0; j < Math.min(b - a, i - b); j++) markChange(rows[a + j], rows[b + j]);
  }
  if (all.length > lines.length) rows.truncated = all.length;
  return rows;
}

// Marks the part of two paired lines between what they share at the start and the end,
// widened to whole words. A pair that shares nothing stays unmarked: the whole line changed.
function markChange(x, y) {
  const a = x.text, b = y.text, w = (c) => /\w/.test(c ?? "");
  let p = 0, s = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  while (p > 0 && w(a[p - 1]) && (w(a[p]) || w(b[p]))) p--;
  while (s > 0 && w(a[a.length - s]) && (w(a[a.length - s - 1]) || w(b[b.length - s - 1]))) s--;
  if (p + s === 0) return;
  x.hl = [p, a.length - s]; y.hl = [p, b.length - s];
}

// `git log --date-order --decorate=full --format=LOG_GRAPH` into rows of kind "L", laid out on lanes.
// Refs become labels: the checked out branch (tone "head"), a local branch with the remotes that
// have it on the same commit (`main | origin`), remote branches, tags. `view` is the sidebar list
// that acts on a label.
export const LOG_GRAPH = "%H%x1f%h%x1f%P%x1f%D%x1f%s%x1f%an%x1f%ar";
export const logRows = (text) => {
  const rows = text.split("\n").filter(Boolean).slice(0, 20000).map((l) => {
    const [hash, short, parents, decor, subject, author, when] = l.split("\x1f");
    const refs = decor ? decor.split(", ") : [];
    const remotes = refs.filter((d) => d.startsWith("refs/remotes/") && !d.endsWith("/HEAD")).map((d) => d.slice(13)), paired = new Set();
    const labels = [];
    for (const d of refs) {
      const head = d.startsWith("HEAD -> "), ref = head ? d.slice(8) : d;
      if (d === "HEAD") labels.push({ tone: "head", name: "HEAD" });
      else if (ref.startsWith("refs/heads/")) {
        const name = ref.slice(11), mates = remotes.filter((r) => r.slice(r.indexOf("/") + 1) === name);
        mates.forEach((r) => paired.add(r));
        labels.push({ tone: head ? "head" : "local", name, view: "branches", remotes: mates.map((r) => r.slice(0, r.indexOf("/"))) });
      }
    }
    for (const r of remotes) if (!paired.has(r)) labels.push({ tone: "remote", name: r, view: "remote-branches" });
    for (const d of refs) if (d.startsWith("tag: ")) labels.push({ tone: "tag", name: d.slice(5).replace(/^refs\/tags\//, ""), view: "tags" });
    labels.sort((a, b) => Number(b.tone === "head") - Number(a.tone === "head"));
    return { kind: "L", hash, short, parents: parents ? parents.split(" ") : [], head: labels[0]?.tone === "head", refs: labels, subject, author, when,
      text: [short, ...labels.map((r) => r.name), subject, author, when].join("  ") };
  });
  // Lanes, after herdr-git-graph's lanes.js (MIT, github.com/rabeeh-ta/herdr-git-graph). A lane is a
  // column waiting for one commit and keeps its column until that commit comes, so lines bend only
  // where branches fork or merge. Each row gets its lane and segments [fromLane, fromY, toLane, toY,
  // colorLane], y 0 the row's top, 0.5 its dot, 1 its bottom. Needs every child before its parents.
  const lanes = [], free = () => { const i = lanes.indexOf(null); return i < 0 ? lanes.length : i; };
  let width = 1;
  for (const r of rows) {
    const before = lanes.slice();
    r.segments = [];
    r.lane = before.indexOf(r.hash);
    if (r.lane < 0) { r.lane = free(); lanes[r.lane] = r.hash; } // a branch tip: nothing above it
    before.forEach((hash, j) => {
      if (hash == null) return;
      if (hash !== r.hash) return r.segments.push([j, 0, j, 1, j]);
      r.segments.push([j, 0, r.lane, 0.5, j]);
      if (j !== r.lane) lanes[j] = null; // branches that end here
    });
    const [first, ...rest] = r.parents;
    lanes[r.lane] = first ?? null;
    if (first) r.segments.push([r.lane, 0.5, r.lane, 1, r.lane]);
    for (const p of rest) {
      let k = lanes.indexOf(p);
      if (k < 0) { k = free(); lanes[k] = p; }
      r.segments.push([r.lane, 0.5, k, 1, k]);
    }
    width = Math.max(width, before.length, lanes.length);
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
  }
  for (const r of rows) r.lanes = width;
  return rows;
};

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
