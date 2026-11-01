# opencode-compaction-anchor

An [opencode](https://github.com/anomalyco/opencode) plugin that keeps the task in view when a long session is compacted.

## The problem

When a session fills its context window, opencode replaces the conversation with a model-written summary. On long, multi-part tasks this loses work:

- **The original request is gone.** After compaction the model only sees the summary.
- **Items that weren't started drop out.** The first summary usually lists every item. Later summaries are summaries of summaries, and tend to keep only what is done or in progress.
- **The agent stops.** After the summary, opencode adds "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed." The agent reports what it did and stops, with items it no longer knows about left undone.

This shows up most with smaller context windows, where compaction happens often, and with models whose summaries lose detail.

## What the plugin does

It has four parts, each switchable:

| Part | Default | What it does |
|---|---|---|
| `reinsert` | on | After each summary, the next message starts with the original request, word for word. |
| `checklist` | on | Tells the summarizer to start the summary with a **Task checklist**: every item of the original request, marked `[done]` / `[in progress]` / `[not started]`, never dropped. The summarizer gets the original request and the session's todo list to build it from. After the summary, the agent is asked to bring its todo list in line with the checklist (`todowrite`), work from it, and check it before finishing. |
| `pointer` | off | At each summary, writes the full conversation so far to `<dir>/<session>.md` and adds one line to the summary saying where it is. |
| `no-stop-and-ask` | off | Replaces the automatic "…or stop and ask for clarification…" turn with "Continue with the task." |

- **Before the first compaction, nothing changes.**
- **Nothing stored changes.** Except for the extra summarizer instruction, the plugin only changes the context sent to the model, not what is stored in the session.
- **It uses opencode's experimental plugin hooks:** `experimental.session.compacting` and `experimental.chat.messages.transform`.

## Results

All numbers come from one setup:
- **Model:** Qwen3.8-Flash-Next (IQ3_XXS) on two RX 7900 XTX.
- **Harness:** opencode 1.18.34 with a 128k context window.
- **Tasks:** four tasks that each bundle 6–12 independent bugs in one request, from a real web-app codebase.
- **Grading:** hidden tests, 79 checks in total.

| Setup | Checks passed |
|---|---|
| Stock opencode | 57% |
| `checklist` only | 82% |
| `reinsert` only | 90% |
| `reinsert` + `checklist` | **94%** |
| Same model, no plugin, 262k window (rarely compacts) | 91% |
| Claude Opus 5.5 on the same tasks (19 runs) | 94% |

Caveats:
- **Sample size:** one run per setup on the local side, and only four tasks. An earlier pilot pointed the same way.
- **Single-bug tasks didn't change.** They rarely compact.
- **Cost:** the re-inserted request and the checklist add prompt tokens after every compaction.

## Install

Add it to your opencode config (`~/.config/opencode/opencode.json` or a project's `opencode.json`) with an absolute path:

```json
{
  "plugin": [
    ["file:///absolute/path/to/compaction-anchor.js", { "parts": ["reinsert", "checklist"] }]
  ]
}
```

This config form was tested with opencode 1.18.34.

opencode also loads plugin files placed in `~/.config/opencode/plugin/` or a project's `.opencode/plugin/`. Loaded that way, the plugin runs with its defaults. OpenCode 2.x has not been tested.

### Options

| Option | Default | Meaning |
|---|---|---|
| `parts` | `["reinsert", "checklist"]` | Which parts to enable (see above). |
| `dir` | `~/.local/share/opencode/history` | Where history files (`pointer`) and todo-list snapshots go. |
| `debug` | `false` | Append what the plugin did to `<dir>/.events.jsonl`. |

## Limitations

- **Todos are written by the model, not the plugin.** opencode's plugin API can read a session's todo list but not write it, so the plugin asks the model to update it with `todowrite`.
- **Very long requests are cut.** Only the first 32,000 characters of the original request are repeated.
- **opencode can change these hooks.** The hooks are experimental and may change between versions.

## Related opencode issues

- [#5934](https://github.com/anomalyco/opencode/issues/5934): todo lists cleared after auto-compaction.
- [#25982](https://github.com/anomalyco/opencode/pull/25982): PR to preserve todo progress through compaction.
- [#28063](https://github.com/anomalyco/opencode/issues/28063): completed work reappears as next steps after compaction.

## Tests

```
node --test test/
```

## License

MIT
