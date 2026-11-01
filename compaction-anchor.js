// opencode-compaction-anchor: keep the task in view when opencode compacts a long session.
//
// When a session fills its context window, opencode replaces the conversation with a model-written summary. The
// original request is no longer shown to the model; later summaries (summaries of summaries) tend to keep only the
// items already done or in progress, so items not started yet drop out; and the automatic turn after a summary invites
// the agent to "stop and ask". On long multi-part tasks the agent then reports and stops with work left undone.
//
// Parts (options.parts; default ["reinsert", "checklist"]):
//   - "reinsert":  after a summary, the next message starts with the original request, word for word.
//   - "checklist": the summarizer is asked to start the summary with a "Task checklist" -- every item of the original
//                  request (given to it word for word, with the session's todo list) marked [done] / [in progress] /
//                  [not started], never dropped. After the summary the agent is asked to bring its todo list in line
//                  with the checklist (todowrite), work from it, and check it before finishing. The todo list as it
//                  stood at the summary is shown too.
//   - "pointer":   each time the session is summarized, its full conversation so far is written to <dir>/<session>.md,
//                  and the summary ends with one line saying where that file is.
//   - "no-stop-and-ask": the automatic turn after a summary reads "Continue with the task." instead of
//                  "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
// Before the first summary nothing is changed. Everything except the summarizer's instructions is a view of the context
// sent to the model; nothing stored in the session changes.
//
// Options (plugin entry ["file:///path/compaction-anchor.js", {parts, dir, debug}]):
//   parts  the list above; dir: where history files / todo snapshots go (default ~/.local/share/opencode/history);
//   debug  true: append what the plugin did to <dir>/.events.jsonl.
// Uses opencode's experimental plugin hooks experimental.session.compacting and experimental.chat.messages.transform
// (tested with opencode 1.18.34).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TASK_MAX = 32000;      // characters of the original request repeated after a summary
const PARTS = ["checklist", "reinsert", "pointer", "no-stop-and-ask"];
const STOP_ASK = "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.";
const CONTINUE = "Continue with the task.";

export const CompactionAnchor = async ({ client, directory }, options = {}) => {
  const dir = String((options && options.dir) || path.join(os.homedir(), ".local", "share", "opencode", "history"));
  const parts = new Set(Array.isArray(options && options.parts) ? options.parts.filter((x) => PARTS.includes(x)) : ["reinsert", "checklist"]);
  const debug = !!(options && options.debug);
  const history = parts.has("pointer");   // the full-conversation file is written only when the pointer part is on
  const todoSnap = new Map();   // session id -> the todo list as it stood at the latest summary (also <dir>/<id>.todos.json)
  const known = new Map();   // session id -> { task, file } (cached per process)
  const shown = new Set();   // "<session>:<summary message id>": the first view after each summary is logged once
  const event = (o) => {
    if (!debug) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, ".events.jsonl"), JSON.stringify({ t: Date.now(), ...o }) + "\n");
    } catch {}
  };
  const fileOf = (sid) => path.join(dir, `${sid}.md`);
  event({ event: "loaded", directory, parts: [...parts] });

  async function messages(sid) {
    const r = await client.session.messages({ path: { id: sid } });
    const data = Array.isArray(r) ? r : r && r.data;
    if (!Array.isArray(data)) throw new Error("could not read the session: " + JSON.stringify((r && r.error) || r).slice(0, 300));
    return data;
  }

  // the first request of the session: the text the user typed (parts opencode added itself, such as an attached file's
  // contents, are marked synthetic and left out)
  function taskOf(msgs) {
    for (const m of msgs) {
      if (m.info.role !== "user" || m.parts.some((p) => p.type === "compaction")) continue;
      const text = m.parts.filter((p) => p.type === "text" && !p.synthetic && !p.ignored && p.text).map((p) => p.text).join("\n").trim();
      if (text) return text;
    }
    return null;
  }

  function render(msgs, sid) {
    const out = [];
    out.push("# Conversation history", "");
    out.push(`Session ${sid}. Everything said and done in this conversation up to its most recent summary, oldest first:`);
    out.push("every message, every tool call with its arguments, and every tool result in full. Rewritten at each summary.", "");
    let n = 0, calls = 0, summaries = 0;
    for (const m of msgs) {
      const role = m.info.role;
      if (role === "user" && m.parts.some((p) => p.type === "compaction")) continue;   // the summary request itself
      if (role === "assistant" && m.info.summary === true) {
        summaries += 1;
        out.push(`======== conversation summarized here (summary ${summaries}) ========`, "");
        for (const p of m.parts) if (p.type === "text" && p.text) out.push(p.text.trim(), "");
        continue;
      }
      n += 1;
      out.push(`======== [${n}] ${role} ========`, "");
      for (const p of m.parts) {
        if (p.type === "text" && p.text) {
          out.push(p.synthetic ? `(added automatically)\n${p.text}` : p.text, "");
        } else if (p.type === "reasoning" && p.text) {
          out.push("(thinking)", p.text, "");
        } else if (p.type === "file") {
          out.push(`(attached file: ${p.filename || p.url || "file"}${p.mime ? ", " + p.mime : ""})`, "");
        } else if (p.type === "tool") {
          calls += 1;
          const st = p.state || {};
          out.push(`--- tool call ${calls}: ${p.tool} ---`);
          for (const [k, v] of Object.entries(st.input || {})) {
            if (typeof v === "string") out.push(v.includes("\n") ? `${k}:\n${v}` : `${k}: ${v}`);
            else out.push(`${k}: ${JSON.stringify(v)}`);
          }
          if (st.status === "completed") out.push(`--- result of tool call ${calls} ---`, String(st.output ?? ""));
          else if (st.status === "error") out.push(`--- error from tool call ${calls} ---`, String(st.error ?? ""));
          else out.push(`--- tool call ${calls} has no result (${st.status || "unknown"}) ---`);
          out.push("");
        } else if (p.type === "subtask") {
          out.push(`(sub-task: ${p.description || p.agent || ""})`, p.prompt || "", "");
        }
      }
    }
    return { text: out.join("\n") + "\n", messages: n, calls, summaries };
  }

  async function write(sid, why) {
    const msgs = await messages(sid);
    const task = taskOf(msgs);
    let file = null;
    if (history) {
      const r = render(msgs, sid);
      fs.mkdirSync(dir, { recursive: true });
      file = fileOf(sid); const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, r.text);
      fs.renameSync(tmp, file);
      event({ event: "wrote", why, session: sid, file, bytes: Buffer.byteLength(r.text), messages: r.messages, tool_calls: r.calls,
              summaries: r.summaries, task_chars: task ? task.length : 0 });
    }
    known.set(sid, { task, file });
    return known.get(sid);
  }

  // what a session needs after a summary; a new process (a later turn of the same session) reads it from the store
  async function stateOf(sid) {
    if (known.has(sid)) return known.get(sid);
    if (history && fs.existsSync(fileOf(sid))) {
      const task = taskOf(await messages(sid));
      known.set(sid, { task, file: fileOf(sid) });
      return known.get(sid);
    }
    return await write(sid, "late");
  }

  // the session's todo list (opencode's todowrite store). The plugin API can READ it (GET /session/{id}/todo); nothing
  // in it writes todos -- only the model's own todowrite tool does -- so the list is shown, never changed.
  async function todosOf(sid) {
    const r = await client.session.todo({ path: { id: sid } });
    const data = Array.isArray(r) ? r : r && r.data;
    return Array.isArray(data) ? data.map((t) => ({ content: String(t.content || ""), status: String(t.status || ""), priority: String(t.priority || "") })) : [];
  }
  const todoLines = (todos) => todos.map((t) => `- [${t.status}] ${t.content}`).join("\n");
  function snapOf(sid) {
    if (todoSnap.has(sid)) return todoSnap.get(sid);
    let todos = [];
    try { todos = JSON.parse(fs.readFileSync(path.join(dir, `${sid}.todos.json`), "utf8")).todos || []; } catch {}
    todoSnap.set(sid, todos);
    return todos;
  }
  function checklistAsk(task, todos) {
    const out = [
      "Additional requirement for this summary, which takes precedence over the template above: start the summary with a section \"## Task checklist\", placed before \"## Objective\"; every other section follows as the template says.",
      "- One line for every distinct task, issue or requirement in the original request below, in the request's order, using the request's own numbering when it has one. A request that asks for a single thing gets a one-line checklist.",
      "- Begin each line with its status: [done], [in progress] or [not started]. Never leave an item out: an item with no recorded work is [not started], whether or not the conversation or an earlier summary mentions it.",
      "- For a [done] item, add one short piece of evidence on the same line (the change made, or the check that passed).",
    ];
    if (todos.length) out.push("- The session's todo list is below. Use it as evidence of progress; the checklist still follows the original request.");
    out.push("", "<original-request>", task.length > TASK_MAX ? task.slice(0, TASK_MAX) + "\n[...]" : task, "</original-request>");
    if (todos.length) out.push("", "<todo-list>", todoLines(todos), "</todo-list>");
    return out.join("\n");
  }

  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const textOf = (m) => m.parts.filter((p) => p.type === "text" && !p.synthetic && p.text).map((p) => p.text).join("\n");

  return {
    "experimental.session.compacting": async (input, output) => {
      const sid = input.sessionID;
      let st = null;
      try { st = await write(sid, "summary"); }
      catch (e) { event({ event: "error", where: "write", session: sid, error: String((e && e.stack) || e).slice(0, 600) }); }
      if (!parts.has("checklist")) return;
      try {
        let todos = [];
        try { todos = await todosOf(sid); }
        catch (e) { event({ event: "error", where: "todos", session: sid, error: String((e && e.stack) || e).slice(0, 300) }); }
        todoSnap.set(sid, todos);
        try {   // a later process (the next turn of the same session) reads it back
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, `${sid}.todos.json`), JSON.stringify({ t: Date.now(), todos }));
        } catch {}
        const task = st ? st.task : (await stateOf(sid)).task;
        if (task) output.context.push(checklistAsk(task, todos));
        event({ event: "asked", session: sid, task_chars: task ? task.length : 0, todos: todos.length });
      } catch (e) { event({ event: "error", where: "checklist", session: sid, error: String((e && e.stack) || e).slice(0, 600) }); }
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      const msgs = output.messages;
      for (let i = 0; i + 1 < msgs.length; i++) {
        const u = msgs[i], a = msgs[i + 1];
        if (u.info.role !== "user" || !u.parts.some((p) => p.type === "compaction")) continue;
        if (a.info.role !== "assistant" || a.info.summary !== true) continue;
        const sid = u.info.sessionID;
        let st;
        try { st = await stateOf(sid); }
        catch (e) { event({ event: "error", where: "state", session: sid, error: String((e && e.stack) || e).slice(0, 600) }); continue; }
        const added = {};
        // the original request at the top, unless opencode already put it back after the summary (it re-sends the last
        // request when a provider rejected it as too large)
        const replayed = st.task && msgs.slice(i + 2).some((m) => m.info.role === "user" && norm(textOf(m)) === norm(st.task));
        if (parts.has("reinsert") && st.task && !replayed) {
          const task = st.task.length > TASK_MAX
            ? st.task.slice(0, TASK_MAX) + `\n\n[... the rest of this request is the first message of this conversation${st.file ? ` and in ${st.file}` : ""}]`
            : st.task;
          const part = { id: `${u.info.id}-request`, sessionID: sid, messageID: u.info.id, type: "text", synthetic: true,
                         text: `My original request, repeated word for word from the start of this conversation:\n\n${task}\n\n` };
          msgs[i] = { ...u, parts: [part, ...u.parts] };
          added.task_chars = task.length;
        }
        const extra = [];
        let todoAsk = null;   // last, after the pointer: the line right before the turn that continues the work
        if (parts.has("checklist")) {
          const summary = a.parts.filter((p) => p.type === "text").map((p) => p.text || "").join("\n");
          added.checklist = /^\s*#+\s*Task checklist/im.test(summary);
          added.not_started = (summary.match(/\[not started\]/gi) || []).length;
          const todos = snapOf(sid);
          if (todos.length) {
            extra.push({ id: `${a.info.id}-todos`, sessionID: sid, messageID: a.info.id, type: "text", synthetic: true,
                         text: `\n\nTodo list when this summary was written:\n${todoLines(todos)}` });
            added.todos = todos.length;
          }
          // the model keeps the checklist in its own todo list (only its todowrite tool can write it) and checks it before
          // it finishes
          const what = added.checklist ? "match the task checklist above, one item per line" : "cover every task in the original request";
          todoAsk = { id: `${a.info.id}-todoask`, sessionID: sid, messageID: a.info.id, type: "text", synthetic: true,
                       text: `\n\nNext: use the todowrite tool to make the todo list ${what}, each with its current status ` +
                             `(completed, in_progress or pending). Then continue with the items that are not completed, keep the ` +
                             `todo list up to date as you go, and check it before you finish.` };
          added.todo_ask = true;
        }
        if (parts.has("pointer") && st.file) {
          const line = `The full conversation before this summary (every message, tool call and complete tool output) is saved in ${st.file}. ` +
                       `Search it (for example with grep -n) or read the part you need whenever a detail you need is missing from this summary.`;
          extra.push({ id: `${a.info.id}-history`, sessionID: sid, messageID: a.info.id, type: "text", synthetic: true, text: `\n\n${line}` });
          added.pointer = st.file;
        }
        if (todoAsk) extra.push(todoAsk);
        if (extra.length) {
          const ps = [...a.parts];
          let at = ps.length;
          for (let k = ps.length - 1; k >= 0; k--) if (ps[k].type === "text") { at = k + 1; break; }
          ps.splice(at, 0, ...extra);
          msgs[i + 1] = { ...a, parts: ps };
        }
        const key = `${sid}:${a.info.id}`;
        if (!shown.has(key)) { shown.add(key); event({ event: "shown", session: sid, summary: a.info.id, replayed: !!replayed, ...added }); }
        i += 1;
      }
      if (parts.has("no-stop-and-ask")) {
        for (let i = 0; i < msgs.length; i++) {
          const m = msgs[i];
          if (m.info.role !== "user") continue;
          const k = m.parts.findIndex((p) => p.type === "text" && p.synthetic && typeof p.text === "string" && p.text.endsWith(STOP_ASK));
          if (k < 0) continue;
          const ps = [...m.parts];
          ps[k] = { ...ps[k], text: ps[k].text.slice(0, -STOP_ASK.length) + CONTINUE };
          msgs[i] = { ...m, parts: ps };
          const key = `${m.info.sessionID}:${m.info.id}:continue`;
          if (!shown.has(key)) { shown.add(key); event({ event: "continue-replaced", session: m.info.sessionID, message: m.info.id }); }
        }
      }
    },
  };
};
