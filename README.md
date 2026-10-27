# LoRA Loader w/ Metadata (ComfyUI custom node)

Two nodes, both under the **loaders** category, that load LoRAs and
surface two *optional* sidecar files matched by filename next to each
LoRA — a JSON file for the trigger prompt and an image for a cover preview:

- **Load LoRA Stack (w/ Metadata)** — any number of LoRAs in one node,
  model + clip (use a single slot for just one LoRA)
- **Load LoRA Stack Model Only (w/ Metadata)** — same, model only

Nothing is required — with no sidecar files present these behave like
the native loaders, just with an empty trigger-prompt box and no preview.

Model-only is a separate node rather than an optional CLIP input on the
same node, matching how ComfyUI's own `LoraLoader`/`LoraLoaderModelOnly`
are split — RETURN_TYPES is fixed per node, so an "optional CLIP" node
would always expose a CLIP output socket, just silently `None` when
unused. Two explicit nodes avoid that footgun.

## Install

Copy this whole folder into `ComfyUI/custom_nodes/`, then restart
ComfyUI and hard-refresh your browser.

## Sidecar files

For `my_lora.safetensors` in your `loras/` folder:

```
loras/
  my_lora.safetensors
  my_lora.json         <- optional, trigger prompt
  my_lora.png           <- optional, cover image
  my_lora.preview.png   <- optional, cover image -- only used if
                           my_lora.png (etc.) isn't present
```

**JSON** — a single object; the first of these keys present wins:

```json
{ "activation text": "..." }   // Civitai's own field name
{ "trigger": "..." }
{ "prompt": "..." }
```

Value can be a string, or a list of strings (joined with `, `). This
matches what Civitai's downloader writes, so those files "just work."

**Image** — decoded with Pillow (already a core ComfyUI dependency), so
JPG/PNG plus WEBP/BMP/GIF/TIFF all work out of the box. Checked as
`my_lora.<ext>` first, then `my_lora.preview.<ext>` as a fallback.

Metadata is looked up (and anything missing logged) the instant you pick
a LoRA in the gallery — not at graph execution — via small local HTTP
routes this node registers under `/lora_metadata_loader/`.

## Load LoRA Stack (w/ Metadata) / Model Only

One node, any number of LoRAs, laid out top-to-bottom as accordion slots:

- Click the **+** button on the "Add LoRA" row at the bottom to add
  another slot; click **×** on a slot header to remove it.
- Each slot header is always visible and shows the slot number, the LoRA
  name (or "Empty slot"), an editable **strength** value (applied to both
  model and clip, or just model for the model-only variant), and a
  chevron to expand/collapse the slot.
- Expanding a slot reveals its cover image, a gallery picker button, and
  an editable **trigger prompt** box — auto-filled when you pick a
  *different* LoRA, edits preserved otherwise (including across
  save/reload).
- Click **Select LoRA...** (or the slot's cover image) to open the
  gallery: equal-size 1x1 tiles in a grid, each with the cover image
  (same letterboxed preview style as the slots) and the file name.
  Filter as you type, narrow to a subfolder via the folder dropdown
  (top level only; saved per-node with the workflow), sort by
  **Name** or **Modified** (the LoRA file's last-modified time) with
  the **↑/↓** toggle for direction — the choice
  is remembered. Click a tile to pick it. Close via **×**,
  `Esc`, or clicking outside the panel. The list is always fresh on
  open (LoRAs added mid-session appear immediately); **↻** is only
  for changes while the panel is already open.
- LoRAs apply in top-to-bottom order. Trigger prompts from all slots are
  joined with `", "` into the node's **trigger_prompts** output, skipping
  any empty ones. This separator is fixed, not a node input — change
  `TRIGGER_PROMPT_JOIN_DELIMITER` near the top of `lora_metadata_loader.py`
  if you want a different one.
- The node no longer resizes itself as you add or remove slots — set the
  node size manually if you want more room; the slot list scrolls inside
  the node.
- Empty/unfilled slots (no LoRA picked) are skipped silently when the
  graph runs — you can leave a spare slot around without it causing an
  error.

Internally, the stack node has no fixed number of Python inputs — the
whole slot list plus gallery prefs are stored as JSON in a `stack_data`
widget that the on-node UI keeps in sync, and the node just reads it
back when it runs. The value is an envelope
`{"slots": [...], "gallery": {"folder": ...}}` (a bare slot list is
also accepted, for older workflows and hand-written values).
That widget is hidden on the node (it has to stay a real widget for its
value to reach Python) — the slots and gallery are the intended way to
edit it. Because the folder filter lives in
`stack_data`, it's saved per-node with the workflow.

Restoring the slot UI from a saved workflow relies on one timing detail:
ComfyUI restores saved widget values (`configure()`) *after* the node's
own setup code (`onNodeCreated`) runs, so this node's JS deliberately
waits a frame before reading `stack_data` — reading it immediately would
only ever see the just-created default, even on a node loaded from a
saved workflow.

## Console logging

Missing sidecars are not logged — that's the normal case and it's
already visible in the UI (empty trigger box, `No preview` tile). Only
genuine execution problems log a single short line prefixed with
`[LoRA-Meta]`:

```
[LoRA-Meta] skipping slot: LoRA file not found: some_lora.safetensors
```

## Presets

Named snapshots of a node's slot list — LoRA selections with their set
strengths and trigger prompts, exactly as configured (never defaults).
Stored in a single `lora_presets.json` in this node's folder:

```json
{ "my look": [{ "lora_name": "sub/a.safetensors", "strength": 0.7, "trigger_prompt": "cat" }] }
```

- `GET /lora_metadata_loader/presets` → `{"presets": {...}}`
  (full slot lists included, so loading needs no second call).
- `POST /lora_metadata_loader/presets/save` with
  `{"name": ..., "slots": [...]}` — empty slots are dropped, at least
  one filled slot required; saving under an existing name overwrites it
  (reported via `"overwrote"`).
- `POST /lora_metadata_loader/presets/delete` with `{"name": ...}`.
- Writes are atomic (temp file + replace); a corrupt file logs one line
  and is treated as empty until the next save rewrites it.
- Loading a preset replaces the node's slots and refreshes cover images
  only — saved strengths/prompts are kept as-is. The gallery folder
  filter is per-node workflow state, not part of presets.

Each node has a preset bar above its slots: a dropdown to load
(replaces filled slots after confirming), **Save** (names the current
slots; overwriting confirms too), **Delete** (arms it, then pick the
preset from the dropdown; click again to cancel), **Clear** (empties
the stack after confirming), and **↻** to re-read the file. Loads are
one-way — the bar never shows a "current preset".

## Notes / limitations

- Lookups happen client-side (triggered by the gallery picker), so
  they won't fire for workflows built and run purely through the API
  without ever touching the UI — `trigger_prompt`/`stack_data` are then
  just whatever's stored in the workflow JSON.
- The on-node UI needs ComfyUI to serve this node's `web/` folder, which
  happens automatically via `WEB_DIRECTORY` in `__init__.py`. It imports
  ComfyUI's frontend `app` via `window.comfyAPI.app` (the supported hook
  for custom-node JS on current, Vue-based ComfyUI frontends) rather than
  a relative `import` of `scripts/app.js`, which doesn't reliably resolve
  on newer frontends. If you're on a much older ComfyUI frontend where
  `window.comfyAPI` doesn't exist, you'd need to switch that one line
  back to `import { app } from "../../scripts/app.js";`.
