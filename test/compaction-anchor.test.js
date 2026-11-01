// node --test: the plugin's two hooks against a fake opencode client and a hand-built compacted session.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CompactionAnchor } from "../compaction-anchor.js";

const TASK = "Fix these:\n1. the badge stays green during the grace period\n2. unknown start dates sort first";
const STOP_ASK = "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.";
const SID = "ses_test";

function session({ withSummary = true, summaryText = "## Task checklist\n1. [done] badge -- color fixed\n2. [not started] sort\n\n## Objective\n- x" } = {}) {
  const m = [
    { info: { role: "user", id: "m1", sessionID: SID }, parts: [{ type: "text", text: TASK }] },
    { info: { role: "assistant", id: "m2", sessionID: SID }, parts: [{ type: "text", text: "Looking at the badge first." }] },
  ];
  if (withSummary) {
    m.push({ info: { role: "user", id: "c1", sessionID: SID }, parts: [{ type: "compaction" }] });
    m.push({ info: { role: "assistant", id: "s1", sessionID: SID, summary: true }, parts: [{ type: "text", text: summaryText }] });
    m.push({ info: { role: "user", id: "u2", sessionID: SID }, parts: [{ type: "text", synthetic: true, text: STOP_ASK }] });
  }
  return m;
}

function fakeClient(msgs, todos = []) {
  return { session: { messages: async () => ({ data: msgs }), todo: async () => ({ data: todos }) } };
}

async function load(options, msgs, todos) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anchor-"));
  const hooks = await CompactionAnchor({ client: fakeClient(msgs, todos), directory: "/w" }, { dir, ...options });
  return { hooks, dir };
}

const texts = (m) => m.parts.filter((p) => p.type === "text").map((p) => p.text);

test("before any summary nothing changes", async () => {
  const msgs = session({ withSummary: false });
  const { hooks } = await load({}, msgs);
  const out = { messages: structuredClone(msgs) };
  await hooks["experimental.chat.messages.transform"]({}, out);
  assert.deepEqual(out.messages, msgs);
});

test("default parts: the summarizer gets the checklist ask with the original request, and the view re-inserts the request", async () => {
  const msgs = session();
  const todos = [{ content: "badge", status: "completed", priority: "high" }, { content: "sort", status: "pending", priority: "high" }];
  const { hooks, dir } = await load({}, msgs, todos);
  const ctx = { context: [] };
  await hooks["experimental.session.compacting"]({ sessionID: SID }, ctx);
  assert.equal(ctx.context.length, 1);
  assert.match(ctx.context[0], /## Task checklist/);
  assert.ok(ctx.context[0].includes(`<original-request>\n${TASK}\n</original-request>`));
  assert.ok(ctx.context[0].includes("- [completed] badge\n- [pending] sort"));
  const out = { messages: structuredClone(msgs) };
  await hooks["experimental.chat.messages.transform"]({}, out);
  const [, , comp, summ, cont] = out.messages;
  assert.ok(comp.parts[0].text.startsWith("My original request, repeated word for word"));
  assert.ok(comp.parts[0].text.includes(TASK));
  const st = texts(summ);
  assert.equal(st[0], msgs[3].parts[0].text);                                     // the summary itself is untouched
  assert.ok(st[1].includes("Todo list when this summary was written:\n- [completed] badge\n- [pending] sort"));
  assert.ok(st[2].trim().startsWith("Next: use the todowrite tool to make the todo list match the task checklist above"));
  assert.deepEqual(cont, msgs[4]);                                                 // no-stop-and-ask is off by default
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith(".md")));                   // no history file without "pointer"
});

test("a summary without a checklist still gets the todo-list ask, worded for the original request", async () => {
  const msgs = session({ summaryText: "## Objective\n- fix things" });
  const { hooks } = await load({}, msgs);
  const out = { messages: structuredClone(msgs) };
  await hooks["experimental.chat.messages.transform"]({}, out);
  const st = texts(out.messages[3]);
  assert.ok(st[st.length - 1].includes("cover every task in the original request"));
});

test("pointer: the full conversation is written and the summary points at it", async () => {
  const msgs = session();
  const { hooks, dir } = await load({ parts: ["pointer"] }, msgs);
  await hooks["experimental.session.compacting"]({ sessionID: SID }, { context: [] });
  const file = path.join(dir, `${SID}.md`);
  assert.ok(fs.readFileSync(file, "utf8").includes(TASK));
  const out = { messages: structuredClone(msgs) };
  await hooks["experimental.chat.messages.transform"]({}, out);
  assert.ok(texts(out.messages[3]).some((t) => t.includes(file)));
  assert.equal(out.messages[2].parts.length, 1);                                    // reinsert is off here
});

test("no-stop-and-ask replaces the automatic turn after a summary", async () => {
  const msgs = session();
  const { hooks } = await load({ parts: ["no-stop-and-ask"] }, msgs);
  const out = { messages: structuredClone(msgs) };
  await hooks["experimental.chat.messages.transform"]({}, out);
  assert.equal(out.messages[4].parts[0].text, "Continue with the task.");
});

test("the request is not re-inserted when opencode already re-sent it after the summary", async () => {
  const msgs = session();
  msgs.push({ info: { role: "user", id: "u3", sessionID: SID }, parts: [{ type: "text", text: TASK }] });
  const { hooks } = await load({ parts: ["reinsert"] }, msgs);
  const out = { messages: structuredClone(msgs) };
  await hooks["experimental.chat.messages.transform"]({}, out);
  assert.equal(out.messages[2].parts.length, 1);
});
