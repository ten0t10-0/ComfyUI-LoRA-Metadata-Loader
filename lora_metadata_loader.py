"""
LoRA stack loader that also surfaces optional sidecar metadata living next to
the LoRA file: a JSON file with trigger prompts, and a cover-image file.
Both are matched purely by filename (same directory, same base name as
the LoRA, different extension). Everything is optional -- with no
sidecar files present the node just loads LoRAs with an empty trigger
prompt and no cover image.

The cover image and trigger prompts are shown directly on the node (via
the companion JS extension in web/js/) instead of as graph outputs:
- trigger_prompt is an editable text widget, auto-filled from the JSON
  whenever a *different* LoRA is picked (manual edits are left alone
  otherwise, including across saving/reloading the workflow).
- the cover image is shown as a small fixed-size preview on each card.
  There's no separate "thumbnail" -- the preview box itself
  serves that purpose, so nothing extra is generated or output.

Metadata is looked up the moment a LoRA is selected in the UI, via
small HTTP routes below -- not at graph execution time.

Sidecar layout, for "my_lora.safetensors":
    my_lora.json    -> trigger prompt
    my_lora.txt     -> trigger prompt (plain text, used if there's no
                       usable value in the JSON -- see below)
    my_lora.png      (or .jpg/.jpeg/.webp/.bmp/.gif/.tif/.tiff) -> cover image
    my_lora.preview.png  (same extensions) -> cover image, used only if
                       "my_lora.<ext>" isn't found

JSON format (first matching key wins, checked in this order):
    {"activation text": "..."}   (Civitai's own field name)
    {"trigger": "..."}
    {"prompt": "..."}
The value can be a string, or a list of strings (joined with ", ").

Trigger prompts resolve JSON-first: if my_lora.json exists and has a
usable value under one of the keys above, that's used and my_lora.txt
is ignored. Otherwise (no JSON file, or the JSON is empty/malformed/
missing all three keys) my_lora.txt is used instead, if present -- its
whole (stripped) contents become the trigger prompt verbatim.

Missing sidecars are not logged at all -- that's the normal case and
it's already visible in the UI (empty trigger box, no preview tile).
Only genuine execution problems are logged, as single short lines
prefixed with "[LoRA-Meta]" (unparseable stack_data, LoRA file not
found for a filled slot).
"""

import json
import os

from PIL import Image

import comfy.sd
import comfy.utils
import folder_paths

LOG_PREFIX = "[LoRA-Meta]"

# Pillow (a core ComfyUI dependency, used by the built-in LoadImage node
# too) decodes far more than this -- these are just the extensions we
# probe for by filename. JPG/PNG are always covered.
IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff")

TRIGGER_KEYS = ("activation text", "trigger", "prompt")

# Separator used to join trigger prompts from multiple stack slots into one
# string (see _apply_lora_stack below). Not exposed as a node input -- ", "
# reads cleanly when the result is dropped straight into a positive-prompt
# text box. Change this constant if you want a different separator.
TRIGGER_PROMPT_JOIN_DELIMITER = ", "


def _sibling_path(lora_path, ext):
    base, _ = os.path.splitext(lora_path)
    return base + ext


def _find_cover_image_path(lora_path):
    # Plain "name.ext" first -- the common case.
    for ext in IMAGE_EXTENSIONS:
        candidate = _sibling_path(lora_path, ext)
        if os.path.isfile(candidate):
            return candidate
    # Fall back to "name.preview.ext" -- how some LoRA managers/downloaders
    # name preview images when they also keep other images (sample grids,
    # etc.) alongside the LoRA.
    for ext in IMAGE_EXTENSIONS:
        candidate = _sibling_path(lora_path, f".preview{ext}")
        if os.path.isfile(candidate):
            return candidate
    return None


def _cover_image_is_readable(image_path):
    try:
        with Image.open(image_path) as img:
            img.verify()
        return True
    except Exception:
        return False


def _read_trigger_prompt_from_json(json_path):
    """Returns (value, error). value is a non-empty string on success, else
    None. error is None unless the file exists but is actually broken
    (bad json / wrong structure / none of the recognized keys have a
    non-empty value) -- a simply-absent file is *not* an error, it's the
    common case of a LoRA with no JSON sidecar."""
    if not os.path.isfile(json_path):
        return None, None

    try:
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError, UnicodeDecodeError):
        return None, "trigger prompt (bad json)"

    if not isinstance(data, dict):
        return None, "trigger prompt (unexpected structure)"

    for key in TRIGGER_KEYS:
        if key in data and data[key] is not None:
            value = data[key]
            if isinstance(value, list):
                value = ", ".join(str(v) for v in value)
            elif not isinstance(value, str):
                value = str(value)
            if value.strip():
                return value, None
            break  # matched a key, but its value was blank -- no usable match

    return None, "trigger prompt (no matching key)"


def _read_trigger_prompt_from_txt(txt_path):
    """Returns (value, error), same contract as the JSON reader above."""
    if not os.path.isfile(txt_path):
        return None, None

    try:
        with open(txt_path, "r", encoding="utf-8") as f:
            content = f.read().strip()
    except (OSError, UnicodeDecodeError):
        return None, "trigger prompt (bad txt)"

    if not content:
        return None, "trigger prompt (empty txt)"

    return content, None


def _read_trigger_prompt(lora_path):
    """Resolves the trigger prompt JSON-first, falling back to a .txt
    sidecar if the JSON doesn't provide anything usable. Returns (trigger_prompt,
    missing_reason). missing_reason is only set for a genuine problem with
    a sidecar file that's actually present -- neither sidecar existing at
    all is the normal/expected case and isn't reported."""
    json_value, json_error = _read_trigger_prompt_from_json(_sibling_path(lora_path, ".json"))
    if json_value is not None:
        return json_value, None

    txt_value, txt_error = _read_trigger_prompt_from_txt(_sibling_path(lora_path, ".txt"))
    if txt_value is not None:
        # .txt covered it, but still surface a broken JSON sidecar if there
        # was one -- that's worth knowing about even though the end result
        # is fine.
        return txt_value, json_error

    return "", (json_error or txt_error)


def _metadata_for(lora_name):
    """Looks up sidecar metadata for a LoRA and returns
    (trigger_prompt, has_cover_image). Missing/broken sidecars are
    deliberately *not* logged -- they're already visible in the UI
    (empty trigger box, no preview tile), so logging them would just
    spam the terminal once per LoRA picked."""
    lora_path = folder_paths.get_full_path("loras", lora_name) if lora_name else None
    if lora_path is None:
        return "", False

    trigger_prompt, _reason = _read_trigger_prompt(lora_path)

    image_path = _find_cover_image_path(lora_path)
    has_image = image_path is not None and _cover_image_is_readable(image_path)

    return trigger_prompt, has_image


# --- HTTP routes for the JS extension: these run the lookup above
# the instant a LoRA is picked in the UI, and serve the cover image for
# the on-node preview. Registering onto PromptServer.instance.routes at
# import time is the standard way custom nodes add endpoints in ComfyUI. ---
try:
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.get("/lora_metadata_loader/info")
    async def _lora_metadata_info(request):
        lora_name = request.rel_url.query.get("lora_name", "")
        trigger_prompt, has_image = _metadata_for(lora_name)
        return web.json_response({"trigger_prompt": trigger_prompt, "has_image": has_image})

    @PromptServer.instance.routes.get("/lora_metadata_loader/cover_image")
    async def _lora_metadata_cover_image(request):
        lora_name = request.rel_url.query.get("lora_name", "")
        lora_path = folder_paths.get_full_path("loras", lora_name) if lora_name else None
        if lora_path is None:
            return web.Response(status=404)
        image_path = _find_cover_image_path(lora_path)
        if image_path is None or not _cover_image_is_readable(image_path):
            return web.Response(status=404)
        return web.FileResponse(image_path)

    @PromptServer.instance.routes.get("/lora_metadata_loader/list_loras")
    async def _lora_metadata_list_loras(request):
        # Used by the stack node's gallery picker. Computed fresh each
        # call, so it's actually more current than a native combo list
        # (those only refresh when the node defs are reloaded). mtimes
        # powers last-modified sorting; a file that can't be stated gets
        # None and sorts as oldest.
        names = folder_paths.get_filename_list("loras")
        mtimes = {}
        for name in names:
            try:
                path = folder_paths.get_full_path("loras", name)
                mtimes[name] = os.path.getmtime(path) if path else None
            except OSError:
                mtimes[name] = None
        return web.json_response({"loras": names, "mtimes": mtimes})

except Exception as e:  # pragma: no cover - only hit outside a real ComfyUI server
    print(f"{LOG_PREFIX} could not register HTTP routes ({e}); on-node preview will be unavailable")


def _parse_stack_slots(stack_data):
    """Parses the stack_data JSON widget into a list of slot dicts, logging
    (and falling back to an empty stack) if it's not valid JSON."""
    try:
        slots = json.loads(stack_data) if stack_data else []
        if not isinstance(slots, list):
            raise ValueError("stack_data was not a JSON list")
        return slots
    except (json.JSONDecodeError, ValueError, TypeError):
        print(f"{LOG_PREFIX} stack_data was not valid JSON; treating the stack as empty")
        return []


def _apply_lora_stack(model, clip, stack_data, file_cache):
    """
    Applies each slot's LoRA to model (and clip, if not None) in order.
    Pass clip=None for a model-only stack -- each LoRA is then applied with
    clip_strength=0. Returns
    (model, clip, trigger_prompt) -- clip is unchanged (None) if it was None
    going in, and trigger_prompt is every slot's non-empty trigger prompt
    joined with TRIGGER_PROMPT_JOIN_DELIMITER.
    """
    trigger_parts = []
    for slot in _parse_stack_slots(stack_data):
        if not isinstance(slot, dict):
            continue

        lora_name = (slot.get("lora_name") or "").strip()
        if not lora_name:
            continue  # empty/unfilled slot -- skip quietly, not an error

        lora_path = folder_paths.get_full_path("loras", lora_name)
        if lora_path is None:
            print(f"{LOG_PREFIX} skipping slot: LoRA file not found: {lora_name}")
            continue
        if lora_path not in file_cache:
            file_cache[lora_path] = comfy.utils.load_torch_file(lora_path, safe_load=True)
        lora = file_cache[lora_path]

        try:
            strength = float(slot.get("strength", 1.0))
        except (TypeError, ValueError):
            strength = 1.0

        if strength != 0:
            if clip is not None:
                model, clip = comfy.sd.load_lora_for_models(model, clip, lora, strength, strength)
            else:
                model = comfy.sd.load_lora_for_models(model, None, lora, strength, 0)[0]

        prompt_text = str(slot.get("trigger_prompt") or "").strip()
        if prompt_text:
            trigger_parts.append(prompt_text)

    return model, clip, TRIGGER_PROMPT_JOIN_DELIMITER.join(trigger_parts)


class LoraStackLoaderWithMetadata:
    """
    Applies a variable-length stack of LoRAs to a model/clip. The number of
    LoRAs is controlled entirely from the node's UI (an "Add LoRA" button
    that adds another slot/card, each with its own gallery picker, strength, and
    editable trigger prompt) -- there's no fixed set of Python inputs for
    this, so all of that lives as JSON in the `stack_data` widget, which
    the JS extension keeps in sync. This node just reads it back.

    LoRAs are applied in the slots' left-to-right order, each with its own
    strength (applied to both model and clip). Trigger prompts from all
    slots are joined with TRIGGER_PROMPT_JOIN_DELIMITER (see top of file),
    skipping empty ones.
    """

    def __init__(self):
        self._file_cache = {}

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "clip": ("CLIP",),
                # Kept in sync by the JS extension's card UI; holds a JSON
                # list of {"lora_name", "strength", "trigger_prompt"} dicts,
                # one per slot/card the user has added on the node. Shows
                # up as a raw-JSON textbox on the node -- edit via the
                # cards above it rather than by hand.
                "stack_data": ("STRING", {"default": "[]"}),
            }
        }

    RETURN_TYPES = ("MODEL", "CLIP", "STRING")
    RETURN_NAMES = ("MODEL", "CLIP", "trigger_prompts")
    FUNCTION = "load_stack"
    CATEGORY = "loaders"

    def load_stack(self, model, clip, stack_data):
        model, clip, trigger_prompt = _apply_lora_stack(model, clip, stack_data, self._file_cache)
        return (model, clip, trigger_prompt)


class LoraStackLoaderModelOnlyWithMetadata:
    """Model-only variant of the stack loader (no CLIP in/out), for
    UNet-only workflows. Kept as a
    separate node rather than an optional CLIP input on the node above so
    there's never a CLIP output socket that's silently None."""

    def __init__(self):
        self._file_cache = {}

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "stack_data": ("STRING", {"default": "[]"}),
            }
        }

    RETURN_TYPES = ("MODEL", "STRING")
    RETURN_NAMES = ("MODEL", "trigger_prompts")
    FUNCTION = "load_stack"
    CATEGORY = "loaders"

    def load_stack(self, model, stack_data):
        model, _clip, trigger_prompt = _apply_lora_stack(model, None, stack_data, self._file_cache)
        return (model, trigger_prompt)


NODE_CLASS_MAPPINGS = {
    "LoraStackLoaderWithMetadata": LoraStackLoaderWithMetadata,
    "LoraStackLoaderModelOnlyWithMetadata": LoraStackLoaderModelOnlyWithMetadata,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LoraStackLoaderWithMetadata": "Load LoRA Stack (w/ Metadata)",
    "LoraStackLoaderModelOnlyWithMetadata": "Load LoRA Stack Model Only (w/ Metadata)",
}
