"""
LoRA loader that also surfaces optional sidecar metadata living next to
the LoRA file: a JSON file with trigger prompts, and a cover-image file.
Both are matched purely by filename (same directory, same base name as
the LoRA, different extension). Everything is optional -- with no
sidecar files present the node behaves exactly like the built-in
LoraLoader.

The cover image and trigger prompts are shown directly on the node (via
the companion JS extension in web/js/) instead of as graph outputs:
- trigger_prompts is an editable text widget, auto-filled from the JSON
  whenever a *different* LoRA is picked (manual edits are left alone
  otherwise, including across saving/reloading the workflow).
- the cover image is shown as a small fixed-size preview under the
  widgets. There's no separate "thumbnail" -- the preview box itself
  serves that purpose, so nothing extra is generated or output.

Metadata is looked up (and anything missing is logged) the moment a
LoRA is selected in the UI, via two small HTTP routes below -- not at
graph execution time.

Sidecar layout, for "my_lora.safetensors":
    my_lora.json    -> trigger prompts
    my_lora.png      (or .jpg/.jpeg/.webp/.bmp/.gif/.tif/.tiff) -> cover image

JSON format (first matching key wins, checked in this order):
    {"activation text": "..."}   (Civitai's own field name)
    {"trigger": "..."}
    {"prompt": "..."}
The value can be a string, or a list of strings (joined with ", ").
Any missing/broken piece is logged as a single short line prefixed with
"[LoRA-Meta]" -- nothing is logged when everything is present.
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


def _sibling_path(lora_path, ext):
    base, _ = os.path.splitext(lora_path)
    return base + ext


def _find_cover_image_path(lora_path):
    for ext in IMAGE_EXTENSIONS:
        candidate = _sibling_path(lora_path, ext)
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


def _read_trigger_prompts(lora_path):
    """Returns (trigger_prompts: str, missing_reason: str | None)."""
    json_path = _sibling_path(lora_path, ".json")
    if not os.path.isfile(json_path):
        return "", "trigger prompts"

    try:
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError, UnicodeDecodeError):
        return "", "trigger prompts (bad json)"

    if not isinstance(data, dict):
        return "", "trigger prompts (unexpected structure)"

    for key in TRIGGER_KEYS:
        if key in data and data[key] is not None:
            value = data[key]
            if isinstance(value, str):
                return value, None
            if isinstance(value, list):
                return ", ".join(str(v) for v in value), None
            return str(value), None

    return "", "trigger prompts (no matching key)"


def _metadata_for(lora_name):
    """Looks up sidecar metadata for a LoRA, logs anything missing/broken
    as a single short line, and returns (trigger_prompts, has_cover_image)."""
    lora_path = folder_paths.get_full_path("loras", lora_name) if lora_name else None
    if lora_path is None:
        return "", False

    missing = []

    trigger_prompts, reason = _read_trigger_prompts(lora_path)
    if reason:
        missing.append(reason)

    image_path = _find_cover_image_path(lora_path)
    has_image = False
    if image_path is None:
        missing.append("cover image")
    elif not _cover_image_is_readable(image_path):
        missing.append("cover image (unreadable)")
    else:
        has_image = True

    if missing:
        print(f"{LOG_PREFIX} {lora_name}: missing {', '.join(missing)}")

    return trigger_prompts, has_image


# --- HTTP routes for the JS extension: these run the lookup/logging above
# the instant a LoRA is picked in the UI, and serve the cover image for
# the on-node preview. Registering onto PromptServer.instance.routes at
# import time is the standard way custom nodes add endpoints in ComfyUI. ---
try:
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.get("/lora_metadata_loader/info")
    async def _lora_metadata_info(request):
        lora_name = request.rel_url.query.get("lora_name", "")
        trigger_prompts, has_image = _metadata_for(lora_name)
        return web.json_response({"trigger_prompts": trigger_prompts, "has_image": has_image})

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
        # Used by the stack node's per-slot <select> dropdowns, which are
        # plain HTML rather than a native combo widget. Computed fresh each
        # call, so it's actually more current than a native combo list
        # (those only refresh when the node defs are reloaded).
        return web.json_response({"loras": folder_paths.get_filename_list("loras")})

except Exception as e:  # pragma: no cover - only hit outside a real ComfyUI server
    print(f"{LOG_PREFIX} could not register HTTP routes ({e}); on-node preview will be unavailable")


class _LoraMetadataBase:
    """Shared LoRA-file loading, with the same caching as the built-in loader."""

    def __init__(self):
        self.loaded_lora = None

    def _load_lora_file(self, lora_name):
        lora_path = folder_paths.get_full_path("loras", lora_name)
        if lora_path is None:
            raise FileNotFoundError(f"LoRA not found: {lora_name}")

        if self.loaded_lora is not None and self.loaded_lora[0] == lora_path:
            lora = self.loaded_lora[1]
        else:
            lora = comfy.utils.load_torch_file(lora_path, safe_load=True)
            self.loaded_lora = (lora_path, lora)

        return lora_path, lora


class LoraLoaderWithMetadata(_LoraMetadataBase):
    """
    Like the built-in LoraLoader, but also shows the LoRA's cover image
    and lets you view/edit its trigger prompts directly on the node.
    trigger_prompts is a normal editable widget -- whatever text is in it
    when the graph runs is what gets output, no magic at execution time.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "clip": ("CLIP",),
                "lora_name": (folder_paths.get_filename_list("loras"),),
                "strength_model": ("FLOAT", {"default": 1.0, "min": -100.0, "max": 100.0, "step": 0.01}),
                "strength_clip": ("FLOAT", {"default": 1.0, "min": -100.0, "max": 100.0, "step": 0.01}),
                "trigger_prompts": ("STRING", {"default": "", "multiline": True}),
            }
        }

    RETURN_TYPES = ("MODEL", "CLIP", "STRING")
    RETURN_NAMES = ("MODEL", "CLIP", "trigger_prompts")
    FUNCTION = "load_lora"
    CATEGORY = "loaders"

    def load_lora(self, model, clip, lora_name, strength_model, strength_clip, trigger_prompts):
        _, lora = self._load_lora_file(lora_name)

        if strength_model == 0 and strength_clip == 0:
            return (model, clip, trigger_prompts)

        model_lora, clip_lora = comfy.sd.load_lora_for_models(model, clip, lora, strength_model, strength_clip)
        return (model_lora, clip_lora, trigger_prompts)


class LoraLoaderModelOnlyWithMetadata(_LoraMetadataBase):
    """Model-only variant (no CLIP in/out) for UNet-only workflows."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "lora_name": (folder_paths.get_filename_list("loras"),),
                "strength_model": ("FLOAT", {"default": 1.0, "min": -100.0, "max": 100.0, "step": 0.01}),
                "trigger_prompts": ("STRING", {"default": "", "multiline": True}),
            }
        }

    RETURN_TYPES = ("MODEL", "STRING")
    RETURN_NAMES = ("MODEL", "trigger_prompts")
    FUNCTION = "load_lora_model_only"
    CATEGORY = "loaders"

    def load_lora_model_only(self, model, lora_name, strength_model, trigger_prompts):
        _, lora = self._load_lora_file(lora_name)

        if strength_model == 0:
            return (model, trigger_prompts)

        model_lora = comfy.sd.load_lora_for_models(model, None, lora, strength_model, 0)[0]
        return (model_lora, trigger_prompts)


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
    clip_strength=0, same as the single-LoRA model-only node. Returns
    (model, clip, trigger_prompt_parts) -- clip is unchanged (None) if it was
    None going in.
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

        prompts = str(slot.get("trigger_prompts") or "").strip()
        if prompts:
            trigger_parts.append(prompts)

    return model, clip, trigger_parts


class LoraStackLoaderWithMetadata:
    """
    Applies a variable-length stack of LoRAs to a model/clip. The number of
    LoRAs is controlled entirely from the node's UI (an "Add LoRA" button
    that adds another slot/card, each with its own dropdown, strength, and
    editable trigger prompt) -- there's no fixed set of Python inputs for
    this, so all of that lives as JSON in the `stack_data` widget, which
    the JS extension keeps in sync. This node just reads it back.

    LoRAs are applied in the slots' left-to-right order, each with its own
    strength (applied to both model and clip). Trigger prompts from all
    slots are joined with `delimiter` (default ","), skipping empty ones.
    """

    def __init__(self):
        self._file_cache = {}

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "clip": ("CLIP",),
                "delimiter": ("STRING", {"default": ","}),
                # Kept in sync by the JS extension's card UI; holds a JSON
                # list of {"lora_name", "strength", "trigger_prompts"} dicts,
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

    def load_stack(self, model, clip, delimiter, stack_data):
        model, clip, trigger_parts = _apply_lora_stack(model, clip, stack_data, self._file_cache)
        return (model, clip, delimiter.join(trigger_parts))


class LoraStackLoaderModelOnlyWithMetadata:
    """Model-only variant of the stack loader (no CLIP in/out), for
    UNet-only workflows -- mirrors LoraLoaderModelOnlyWithMetadata the same
    way the built-in LoraLoaderModelOnly mirrors LoraLoader. Kept as a
    separate node rather than an optional CLIP input on the node above so
    there's never a CLIP output socket that's silently None."""

    def __init__(self):
        self._file_cache = {}

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "delimiter": ("STRING", {"default": ","}),
                "stack_data": ("STRING", {"default": "[]"}),
            }
        }

    RETURN_TYPES = ("MODEL", "STRING")
    RETURN_NAMES = ("MODEL", "trigger_prompts")
    FUNCTION = "load_stack"
    CATEGORY = "loaders"

    def load_stack(self, model, delimiter, stack_data):
        model, _clip, trigger_parts = _apply_lora_stack(model, None, stack_data, self._file_cache)
        return (model, delimiter.join(trigger_parts))


NODE_CLASS_MAPPINGS = {
    "LoraLoaderWithMetadata": LoraLoaderWithMetadata,
    "LoraLoaderModelOnlyWithMetadata": LoraLoaderModelOnlyWithMetadata,
    "LoraStackLoaderWithMetadata": LoraStackLoaderWithMetadata,
    "LoraStackLoaderModelOnlyWithMetadata": LoraStackLoaderModelOnlyWithMetadata,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LoraLoaderWithMetadata": "Load LoRA (w/ Metadata)",
    "LoraLoaderModelOnlyWithMetadata": "Load LoRA Model Only (w/ Metadata)",
    "LoraStackLoaderWithMetadata": "Load LoRA Stack (w/ Metadata)",
    "LoraStackLoaderModelOnlyWithMetadata": "Load LoRA Stack Model Only (w/ Metadata)",
}
