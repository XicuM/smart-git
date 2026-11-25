// Smart Git's agent-written commit messages: which agent CLI writes them (Auto, a picked agent and
// model, or a custom command) and the call that asks it.
import { focused, shared, setShared, exec, agents, knownAgents } from "herdr";
import { ask } from "./ask.js";
import { git } from "./git.js";

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

// An agent CLI writes a commit's { subject, body } from the staged changes (everything, when
// nothing is staged). `files` are the status rows, `branch` the current one.
export async function writeMessage(repo, files, branch, a) {
  const staged = files.some((f) => f.staged);
  let [diff, log] = await Promise.all([
    git(repo, ["diff", "--no-color", "--no-ext-diff", staged ? "--cached" : "HEAD"]).catch(() => ""),
    git(repo, ["log", "-10", "--format=%s"]).catch(() => ""),
  ]);
  if (diff.length > 10000) diff = diff.slice(0, 10000) + "\n\n[... diff truncated ...]";
  const list = files.filter((f) => !staged || f.staged).map((f) => `${f.x}${f.y} ${f.path}`).join("\n");
  // The branch name and recent subjects let it follow the repo's own style (scopes, ticket ids).
  const prompt = `${PROMPT}Branch: ${branch}\n\nRecent commit subjects (follow their style):\n${log}\nFiles:\n${list}\n\nDiff:\n${diff}`;
  const opts = { cwd: repo.root, on: repo.on, timeout: 180000 };
  const model = a.model ?? a.recipe?.fast;
  // No stdin: some agents (codex) wait to read it when it isn't a terminal.
  const r = a.custom ? await exec("sh", ["-c", `${a.custom} "$1" </dev/null`, "sh", prompt], opts)
    : await exec("sh", ["-c", 'exec "$@" </dev/null', "sh", a.bin, ...a.recipe.args.map((x) => x === "{prompt}" ? prompt : x), ...(model && a.recipe.model ? [a.recipe.model, model] : [])], opts);
  let m = null;
  try { m = JSON.parse(/\{[\s\S]*\}/.exec(r.stdout)?.[0]); } catch {}
  if (!m?.subject) throw new Error(`${a.name} wrote no commit message: ${(r.stderr.trim() || r.stdout.trim()).slice(-300)}`);
  return { subject: m.subject.trim(), body: String(m.body ?? "").trim() };
}

// The agents installed on the repo's machine, from Herdr's table (most picked first), each with
// how it answers one prompt (null: not set up).
async function usableAgents(on) {
  const setups = shared("smart-git:recipes") ?? {};
  return (await knownAgents({ on })).filter((a) => a.installed)
    .map((a) => ({ key: a.key, name: a.name, bin: a.run[0], recipe: setups[a.key] ?? RECIPES[a.key] ?? null }));
}

// Auto: the agent most recently busy in this space (signed in, and likely the one that made the
// changes), else the most picked one; with its fast model.
function autoAgent(list) {
  const space = focused()?.space, ready = list.filter((a) => a.recipe);
  const here = agents().filter((x) => x.space === space).sort((x, y) => y.seq - x.seq)
    .map((x) => ready.find((a) => a.key === x.program.key)).find(Boolean);
  const a = here ?? ready[0];
  return a ? { ...a, model: null, why: here ? "running in this space" : "you use most" } : null;
}

// The saved choice (smart-git:agent): null for Auto, { key, model }, or { custom } (a plain string: custom).
export function savedAgent() { const s = shared("smart-git:agent"); return typeof s === "string" ? { custom: s } : s ?? null; }

// What writes the message: the saved choice, else Auto.
export async function chosenAgent(on) {
  const pick = savedAgent();
  if (pick?.custom) return { name: pick.custom, custom: pick.custom };
  const list = await usableAgents(on), a = pick && list.find((x) => x.key === pick.key && x.recipe);
  return a ? { ...a, model: pick.model ?? null } : autoAgent(list);
}

// ctrl-i, or right-click ✨: the agent and model that write commit messages. Every installed agent
// is offered; one without a known recipe is set up once.
export async function pickAgent(on) {
  const list = await usableAgents(on), cur = savedAgent(), auto = autoAgent(list);
  const mark = (on) => on ? " ✓" : "";
  const pick = await ask({ title: "Agent for commit messages", items: [
    { key: "0", label: `Auto · ${auto ? auto.name + (auto.recipe.fast ? ` · ${auto.recipe.fast}` : "") : "none ready"}${mark(cur === null)}`, value: "auto",
      hint: auto ? `The agent ${auto.why}, with its fast model.` : "Set up one of the agents below first." },
    ...list.map((a, n) => ({ key: KEYS[n] ?? "", value: a.key,
      label: `${a.name}${a.recipe ? "" : " · set up…"}${mark(cur?.key === a.key)}${cur?.key === a.key && cur.model ? ` (${cur.model})` : ""}`,
      hint: a.recipe ? `${a.bin} ${a.recipe.args.join(" ")}` : `Tell Smart Git how ${a.bin} answers one prompt and exits.` })),
    { key: "!", label: `Custom command…${mark(Boolean(cur?.custom))}`, value: "custom", hint: "Any CLI that prints its answer, the prompt as its last argument." },
  ] });
  if (!pick) return null;
  if (pick === "auto") { setShared("smart-git:agent", null); return auto; }
  if (pick === "custom") {
    const c = (await ask({ title: "Agent command", detail: "The prompt is added as its last argument.", input: { value: cur?.custom ?? "", placeholder: "e.g. llm -m gpt-4o-mini" } }))?.text.trim();
    if (!c) return null;
    setShared("smart-git:agent", { custom: c });
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
  const model = await pickModel(a, cur?.key === a.key ? cur.model : undefined, on);
  if (model === undefined) return null;
  setShared("smart-git:agent", { key: a.key, model });
  return { ...a, model };
}

// An agent's model: its list (asked of the CLI when it can print one; by provider first when long),
// its default, or one typed in. null: the default; undefined: cancelled.
async function pickModel(a, current, on) {
  const r = a.recipe;
  if (!r.model) return null;
  let models = r.models ?? [], prefix = "";
  if (!models.length && r.list) models = modelIds((await exec(a.bin, r.list, { on, timeout: 30000 }).catch(() => ({ stdout: "" }))).stdout);
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
