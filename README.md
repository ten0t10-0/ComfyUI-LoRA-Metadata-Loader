# LoRA Loader w/ Metadata (ComfyUI custom node)

Four nodes, all under the **loaders** category, that load LoRAs and
surface two *optional* sidecar files matched by filename next to each
LoRA — a JSON file for the trigger prompt and an image for a cover preview:

- **Load LoRA (w/ Metadata)** — single LoRA, model + clip (mirrors the
  built-in `LoraLoader`)
- **Load LoRA Model Only (w/ Metadata)** — single LoRA, model only
  (mirrors `LoraLoaderModelOnly`)
- **Load LoRA Stack (w/ Metadata)** — any number of LoRAs in one node,
  model + clip
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
  my_lora.json     <- optional, trigger prompt
  my_lora.png       <- optional, cover image
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
JPG/PNG plus WEBP/BMP/GIF/TIFF all work out of the box.

Metadata is looked up (and anything missing logged) the instant you pick
a LoRA in a dropdown — not at graph execution — via small local HTTP
routes this node registers under `/lora_metadata_loader/`.

## Load LoRA (w/ Metadata) / Model Only

- **Cover image**: fixed-size preview box under the widgets (aspect ratio
  kept, letterboxed to fit). Hidden when there's no image.
- **Trigger prompt**: editable text box. Your edits are kept — including
  across saving/reloading the workflow — and only get **overwritten**
  when you pick a *different* LoRA from the dropdown.

## Load LoRA Stack (w/ Metadata) / Model Only

One node, any number of LoRAs, laid out left-to-right as cards:

- Click **+** to add another LoRA "slot"; click **×** on a card to
  remove it.
- Each card: cover image, LoRA dropdown, a single strength value
  (applied to both model and clip, or just model for the model-only
  variant), and an editable **trigger prompt** box — same
  auto-fill-on-select / edits-preserved-on-reload behavior as the
  single-LoRA node's trigger prompt box, just per-card.
- LoRAs apply in left-to-right order. Trigger prompts from all cards are
  joined with **delimiter** (a widget at the top of the node, default
  `,`) into the node's **trigger_prompts** output, skipping any empty
  ones.
- The node widens as you add cards, up to a cap (~860px), then the card
  row scrolls horizontally instead of growing further. Change
  `MAX_NODE_WIDTH` in `web/js/lora_metadata_loader.js` for a different
  cap.
- Empty/unfilled slots (no LoRA picked) are skipped silently when the
  graph runs — you can leave a spare card around without it causing an
  error.

Internally, the stack node has no fixed number of Python inputs — the
whole card list is stored as JSON in a `stack_data` widget that the
on-node UI keeps in sync, and the node just reads it back when it runs.
That widget renders as a plain textbox on the node showing its raw JSON
— it has to stay a real widget for its value to reach Python, and an
attempt to visually hide it fought the frontend's own layout more than
it helped, so it's left alone. The cards above it are the intended way
to edit it; hand-editing the JSON directly works too (it's re-parsed on
load), but isn't necessary.

Restoring the card UI from a saved workflow relies on one timing detail:
ComfyUI restores saved widget values (`configure()`) *after* the node's
own setup code (`onNodeCreated`) runs, so this node's JS deliberately
waits a frame before reading `stack_data` — reading it immediately would
only ever see the just-created default, even on a node loaded from a
saved workflow.

## Console logging

Anything missing or broken is logged as a single short line prefixed
with `[LoRA-Meta]`:

```
[LoRA-Meta] my_lora.safetensors: missing trigger prompt (bad json), cover image
[LoRA-Meta] my_lora.safetensors: missing trigger prompt (no matching key)
[LoRA-Meta] my_lora.safetensors: missing cover image (unreadable)
[LoRA-Meta] my_lora.safetensors: missing cover image
[LoRA-Meta] skipping slot: LoRA file not found: some_lora.safetensors
```

## Notes / limitations

- Lookups and logging happen client-side (triggered by the dropdowns), so
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
