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

One node, any number of LoRAs, laid out left-to-right as cards:

- Click **+** to add another LoRA "slot"; click **×** on a card to
  remove it.
- Each card: cover image, gallery picker button, a single strength value
  (applied to both model and clip, or just model for the model-only
  variant), and an editable **trigger prompt** box — auto-filled when
  you pick a *different* LoRA, edits preserved otherwise (including
  across save/reload).
- Click **Select LoRA...** (or the card's cover image) to open the
  gallery: equal-size 1x1 tiles in a grid, each with the cover image
  (same letterboxed preview style as the cards) and the file name.
  Filter as you type, narrow to a subfolder via the folder dropdown
  (top level only; saved per-node with the workflow), sort by
  **Name** or **Modified** (the LoRA file's last-modified time) with
  the **↑/↓** toggle for direction — the choice
  is remembered. Click a tile to pick it. Close via **×**,
  `Esc`, or clicking outside the panel; **↻** refreshes the list.
- LoRAs apply in left-to-right order. Trigger prompts from all cards are
  joined with `", "` into the node's **trigger_prompts** output, skipping
  any empty ones. This separator is fixed, not a node input — change
  `TRIGGER_PROMPT_JOIN_DELIMITER` near the top of `lora_metadata_loader.py`
  if you want a different one.
- The node widens as you add cards, up to a cap (~860px), then the card
  row scrolls horizontally instead of growing further. Change
  `MAX_NODE_WIDTH` in `web/js/lora_metadata_loader.js` for a different
  cap.
- Empty/unfilled slots (no LoRA picked) are skipped silently when the
  graph runs — you can leave a spare card around without it causing an
  error.

Internally, the stack node has no fixed number of Python inputs — the
whole card list plus gallery prefs are stored as JSON in a `stack_data`
widget that the on-node UI keeps in sync, and the node just reads it
back when it runs. The value is an envelope
`{"slots": [...], "gallery": {"folder": ...}}` (a bare slot list is
also accepted, for older workflows and hand-written values).
That widget renders as a plain textbox at the bottom of the node showing
its raw JSON — it has to stay a real widget for its value to reach
Python, and an attempt to visually hide it fought the frontend's own
layout system more than they helped, so it's left alone (and pushed below the
card UI, out of the way). The cards and gallery above it are the intended
way to edit it; hand-editing the JSON directly works too (it's re-parsed on
load), but isn't necessary. Because the folder filter lives in
`stack_data`, it's saved per-node with the workflow.

Restoring the card UI from a saved workflow relies on one timing detail:
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
