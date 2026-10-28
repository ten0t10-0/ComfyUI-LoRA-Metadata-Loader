// NOTE on the import: newer ComfyUI (Vue-based) frontends don't reliably
// serve/resolve a relative "../../scripts/app.js" import from custom-node
// JS -- the internal modules are bundled/hashed. The supported way to get
// at them from a custom node is the window.comfyAPI global namespace.
const { app } = window.comfyAPI.app;

// ---------------------------------------------------------------------
// Stylesheet
// ---------------------------------------------------------------------

// All node UI styling lives in web/lora_metadata_loader.css, next to this
// file. Injected once via a <link>; the href is resolved from this module's
// own URL so a renamed custom-node folder keeps working.
//
// Every class name in the node UI carries the "lml-" (LoRA Metadata Loader)
// prefix, including state classes, so nothing can collide with other custom
// nodes' styles. Keep new classes inside that namespace.
const CSS_ID = "lml-metadata-loader-css";

function ensureCss() {
    if (document.getElementById(CSS_ID)) return;
    const link = document.createElement("link");
    link.id = CSS_ID;
    link.rel = "stylesheet";
    link.type = "text/css";
    link.href = new URL("./lora_metadata_loader.css", import.meta.url).href;
    document.head.appendChild(link);
}

ensureCss();

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

// Always fetched fresh: LoRAs added while ComfyUI is running show up on
// the next gallery open with no refresh step. Cheap (a directory
// listing) and only called from user-triggered opens, so no caching.
function fetchLoraList() {
    return fetch("/lora_metadata_loader/list_loras")
        .then((r) => (r.ok ? r.json() : { loras: [], mtimes: {} }))
        .then((d) => ({ names: d.loras || [], mtimes: d.mtimes || {} }))
        .catch(() => ({ names: [], mtimes: {} }));
}

async function fetchLoraInfo(loraName) {
    const res = await fetch(`/lora_metadata_loader/info?lora_name=${encodeURIComponent(loraName)}`);
    if (!res.ok) return null;
    return res.json();
}

// bust defeats stale browser caching when a sidecar image is replaced;
// callers pass a value stable across their re-renders so e.g. each
// gallery filter keystroke doesn't refetch every visible thumbnail.
function coverImageUrl(loraName, bust = Date.now()) {
    return `/lora_metadata_loader/cover_image?lora_name=${encodeURIComponent(loraName)}&t=${bust}`;
}

// The node UI is made of DOM widgets layered over the canvas, so LiteGraph
// never sees the middle-button pointerdown that starts a canvas pan. Feed
// the middle button to the canvas exactly like ComfyUI's own DOM widgets
// do (forwardMiddleButtonToCanvas in the frontend): the canvas starts the
// pan and takes pointer capture, so the rest of the drag is handled by it.
//
// Listening in the capture phase is deliberate: several controls in the
// node call stopPropagation() on pointerdown so LiteGraph doesn't drag the
// node, which would otherwise hide the event from a bubble listener.
function enableMiddleButtonPan(el) {
    if (!el || el.dataset.loraPanBound === "1") return;
    el.dataset.loraPanBound = "1";

    const canvas = () => (app && app.canvas) || null;
    const isMiddleDown = (e) => e.button === 1 || e.buttons === 4;
    const isMiddleHeld = (e) => (e.buttons & 4) === 4;

    let panning = false;
    let canvasEl = null;

    const stop = () => {
        panning = false;
        canvasEl = null;
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onUp, true);
        window.removeEventListener("pointercancel", onUp, true);
    };

    // Fallback path for frontends where the canvas doesn't end up owning
    // pointer capture. Once it does, events are retargeted to the canvas
    // and must not be forwarded a second time.
    function onMove(e) {
        const c = canvas();
        if (!panning || !c) return;
        if (!isMiddleHeld(e)) {
            stop();
            return;
        }
        if (e.target === canvasEl) return;
        e.preventDefault();
        c.processMouseMove(e);
    }

    function onUp(e) {
        const c = canvas();
        const target = e.target;
        stop();
        if (!c || target === canvasEl) return;
        c.processMouseUp(e);
    }

    el.addEventListener(
        "pointerdown",
        (e) => {
            const c = canvas();
            if (!c || !c.allow_dragcanvas || !isMiddleDown(e)) return;
            // Suppress text selection and the browser's middle-click
            // autoscroll/paste defaults; the canvas handles the gesture.
            e.preventDefault();
            e.stopPropagation();
            canvasEl = c.canvas;
            try {
                c.processMouseDown(e);
            } catch (err) {
                console.warn("[LoRA-Meta] canvas pan forwarding failed", err);
                stop();
                return;
            }
            panning = true;
            window.addEventListener("pointermove", onMove, true);
            window.addEventListener("pointerup", onUp, true);
            window.addEventListener("pointercancel", onUp, true);
        },
        true
    );

    el.addEventListener("auxclick", (e) => {
        if (e.button === 1) e.preventDefault();
    });
}

// ---------------------------------------------------------------------
// Gallery picker: modal overlay with equal-size 1x1 tiles, one per LoRA.
// Each tile shows the cover image (same "contain" preview style as the
// on-card preview -- letterboxed on a dark background, never cropped)
// plus the file name. Click a tile to pick that LoRA for the slot that
// opened the gallery. Closes on outside-click, Escape, or the close
// button -- same dismiss behavior as the old dropdown panel.
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// Gallery prefs -- add future filters here:
// - Per-node prefs (e.g. subfolder filter) live in the stack_data
//   envelope, so they persist in the workflow. See syncWidget.
// - galleryStored: persisted to localStorage. For global sticky prefs
//   like sort.
// ---------------------------------------------------------------------
const galleryStored = {
    key: "name",
    dir: 1,
};
try {
    const savedSort = JSON.parse(localStorage.getItem("lora-gallery-sort") || "{}");
    if (savedSort.key === "name" || savedSort.key === "modified") galleryStored.key = savedSort.key;
    if (savedSort.dir === 1 || savedSort.dir === -1) galleryStored.dir = savedSort.dir;
} catch {
    // storage unavailable (e.g. private mode) -- defaults stand
}
function saveGalleryStored() {
    try {
        localStorage.setItem("lora-gallery-sort", JSON.stringify({ key: galleryStored.key, dir: galleryStored.dir }));
    } catch {
        // ignore -- prefs still apply for this session
    }
}

function openLoraGallery({ options, mtimes, folder, value, onChange, onFolderChange }) {
    if (document.querySelector(".lml-gallery-overlay")) return;

    const overlay = document.createElement("div");
    overlay.className = "lml-gallery-overlay";

    const panel = document.createElement("div");
    panel.className = "lml-gallery-panel";
    panel.onpointerdown = (e) => e.stopPropagation();
    panel.onclick = (e) => e.stopPropagation();

    const header = document.createElement("div");
    header.className = "lml-gallery-header";

    const search = document.createElement("input");
    search.type = "text";
    search.placeholder = "Filter...";
    search.className = "lml-gallery-search";
    search.onpointerdown = (e) => e.stopPropagation();
    search.onkeydown = (e) => {
        e.stopPropagation(); // don't let ComfyUI/canvas keybinds eat keystrokes
    };

    const count = document.createElement("span");
    count.className = "lml-gallery-count";

    const refreshBtn = document.createElement("button");
    refreshBtn.textContent = "\u21BB";
    refreshBtn.title = "Refresh LoRA list";
    refreshBtn.className = "lml-gallery-btn";

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "\u00D7";
    closeBtn.title = "Close";
    closeBtn.className = "lml-gallery-btn lml-gallery-close";

    const sortSelect = document.createElement("select");
    sortSelect.title = "Sort by";
    sortSelect.className = "lml-gallery-select";
    for (const [sortValue, label] of [["name", "Name"], ["modified", "Modified"]]) {
        const opt = document.createElement("option");
        opt.value = sortValue;
        opt.textContent = label;
        sortSelect.appendChild(opt);
    }
    sortSelect.onpointerdown = (e) => e.stopPropagation();

    const dirBtn = document.createElement("button");
    dirBtn.title = "Sort direction: ascending / descending";
    dirBtn.className = "lml-gallery-btn";

    // Optional single-level subfolder filter ("anime" in
    // "anime/my_lora.safetensors"). Flat list of top-level folders only --
    // no recursive tree. Per-node value, persisted in the stack_data
    // envelope (see syncWidget).
    const folderSelect = document.createElement("select");
    folderSelect.title = "Filter by subfolder";
    folderSelect.className = "lml-gallery-select lml-gallery-folder-select";
    folderSelect.onpointerdown = (e) => e.stopPropagation();

    function buildFolderOptions() {
        // Seed from this node's saved folder on first build; on refresh
        // (options already present) keep the live UI value instead.
        const prev = folderSelect.options.length ? folderSelect.value : folderFilter;
        folderSelect.innerHTML = "";
        const allOpt = document.createElement("option");
        allOpt.value = "";
        allOpt.textContent = "All folders";
        folderSelect.appendChild(allOpt);
        const folders = [...new Set(liveOptions.map(topFolder).filter(Boolean))].sort((a, b) =>
            a.toLowerCase().localeCompare(b.toLowerCase())
        );
        for (const f of folders) {
            const opt = document.createElement("option");
            opt.value = f;
            opt.textContent = f;
            folderSelect.appendChild(opt);
        }
        if (liveOptions.some((n) => topFolder(n) === null)) {
            const rootOpt = document.createElement("option");
            rootOpt.value = ROOT_FILTER;
            rootOpt.textContent = "(top level)";
            folderSelect.appendChild(rootOpt);
        }
        const stillThere = [...folderSelect.options].some((o) => o.value === prev);
        folderSelect.value = stillThere ? prev : "";
        folderFilter = folderSelect.value;
        if (onFolderChange) onFolderChange(folderFilter);
    }
    folderSelect.onchange = () => {
        folderFilter = folderSelect.value;
        if (onFolderChange) onFolderChange(folderFilter);
        renderTiles(search.value);
    };

    header.append(search, folderSelect, sortSelect, dirBtn, count, refreshBtn, closeBtn);

    const gridWrap = document.createElement("div");
    gridWrap.className = "lml-gallery-grid-wrap";
    gridWrap.onpointerdown = (e) => e.stopPropagation();

    const grid = document.createElement("div");
    grid.className = "lml-gallery-grid";
    gridWrap.appendChild(grid);
    panel.append(header, gridWrap);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    let liveOptions = [...(options || [])];
    let liveMtimes = { ...(mtimes || {}) };

    // One cache-buster for the whole open: tiles re-render on every filter
    // keystroke, and a fresh timestamp per tile would refetch all visible
    // previews each time.
    const galleryBust = Date.now();

    const ROOT_FILTER = "__root__";
    function topFolder(name) {
        const parts = String(name).split(/[\\/]/);
        return parts.length > 1 ? parts[0] : null;
    }
    // Per-node folder filter, passed in from the stack_data envelope --
    // writing it back via onFolderChange is what persists it in the
    // workflow.
    let folderFilter = folder || "";

    // Persisted prefs: initialized from the module-level cache.
    let sortKey = galleryStored.key;
    let sortDir = galleryStored.dir;
    sortSelect.value = sortKey;
    const renderDirBtn = () => {
        dirBtn.textContent = sortDir === 1 ? "\u2191" : "\u2193";
    };
    renderDirBtn();
    sortSelect.onchange = () => {
        sortKey = sortSelect.value;
        galleryStored.key = sortKey;
        saveGalleryStored();
        renderTiles(search.value);
    };
    dirBtn.onclick = (e) => {
        e.stopPropagation();
        sortDir = -sortDir;
        galleryStored.dir = sortDir;
        renderDirBtn();
        saveGalleryStored();
        renderTiles(search.value);
    };

    function sortNames(list) {
        const sorted = [...list];
        if (sortKey === "modified") {
            // mtime is the LoRA file's last-modified stamp (epoch seconds);
            // unknown/missing sorts as oldest.
            sorted.sort((a, b) => ((liveMtimes[a] || 0) - (liveMtimes[b] || 0)) * sortDir);
        } else {
            sorted.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) * sortDir);
        }
        return sorted;
    }

    function close() {
        document.removeEventListener("keydown", onKeyDown, true);
        overlay.remove();
    }

    function onKeyDown(e) {
        if (e.key === "Escape") {
            e.stopPropagation();
            close();
        }
    }
    document.addEventListener("keydown", onKeyDown, true);

    overlay.addEventListener("pointerdown", (e) => {
        if (e.target === overlay) close();
    });
    closeBtn.onclick = (e) => {
        e.stopPropagation();
        close();
    };

    function makeTile(name) {
        const isSelected = name === value;
        const tile = document.createElement("div");
        tile.title = name;
        tile.className = isSelected ? "lml-gallery-tile lml-selected" : "lml-gallery-tile";

        // 1x1 preview box -- same style as the on-card preview: dark
        // letterbox background, image fitted with contain (never cropped).
        // The img stays in layout (visibility, not display:none) so
        // loading="lazy" actually fetches it -- display:none removes the
        // layout box, so the browser never considers it near the viewport,
        // onload never fires, and every tile is stuck on "No preview".
        const thumb = document.createElement("div");
        thumb.className = "lml-gallery-thumb";

        const placeholder = document.createElement("span");
        placeholder.textContent = "No preview";
        placeholder.className = "lml-gallery-placeholder";
        thumb.appendChild(placeholder);

        const img = document.createElement("img");
        img.loading = "lazy";
        img.alt = "";
        img.className = "lml-gallery-img";
        img.onload = () => {
            placeholder.remove();
            img.classList.add("lml-loaded");
        };
        img.onerror = () => {
            img.remove();
        };
        img.src = coverImageUrl(name, galleryBust);
        thumb.appendChild(img);

        const label = document.createElement("div");
        label.textContent = name;
        label.title = name;
        label.className = "lml-gallery-label";

        tile.append(thumb, label);
        tile.onclick = (e) => {
            e.stopPropagation();
            onChange(name);
            close();
        };
        return tile;
    }

    function renderTiles(filterText) {
        grid.innerHTML = "";
        const q = (filterText || "").trim().toLowerCase();
        const inFolder = folderFilter
            ? liveOptions.filter((name) =>
                  folderFilter === ROOT_FILTER ? topFolder(name) === null : topFolder(name) === folderFilter
              )
            : liveOptions;
        const filtered = q
            ? inFolder.filter((name) => name.toLowerCase().includes(q))
            : inFolder;
        const sorted = sortNames(filtered);
        count.textContent = `${filtered.length}/${liveOptions.length}`;

        if (sorted.length === 0) {
            const empty = document.createElement("div");
            empty.textContent = liveOptions.length === 0 ? "No LoRAs found" : "No matches";
            empty.className = "lml-gallery-empty";
            grid.appendChild(empty);
            return;
        }

        for (const name of sorted) {
            grid.appendChild(makeTile(name));
        }
    }

    search.oninput = () => renderTiles(search.value);
    refreshBtn.onclick = async (e) => {
        e.stopPropagation();
        refreshBtn.disabled = true;
        try {
            ({ names: liveOptions, mtimes: liveMtimes } = await fetchLoraList());
        } finally {
            refreshBtn.disabled = false;
        }
        buildFolderOptions();
        renderTiles(search.value);
    };

    buildFolderOptions();
    renderTiles("");
    requestAnimationFrame(() => search.focus());
}

function createLoraGalleryTrigger({ getValue, getFolder, onPick, onFolderChange }) {
    const trigger = document.createElement("div");
    trigger.tabIndex = 0;
    trigger.title = "Browse LoRAs...";
    trigger.className = "lml-gallery-trigger";

    const renderLabel = () => {
        const v = getValue();
        trigger.textContent = v ? `\uD83D\uDDBC ${v}` : "Select LoRA...";
        trigger.classList.toggle("lml-empty", !v);
    };
    renderLabel();

    const open = () => {
        // Always fetch fresh on open: LoRAs added while ComfyUI is running
        // show up immediately, with no need for the in-modal refresh or
        // ComfyUI's own node-definition refresh (R) first.
        fetchLoraList().then(({ names, mtimes }) => {
            openLoraGallery({
                options: names,
                mtimes,
                folder: typeof getFolder === "function" ? getFolder() : "",
                value: getValue(),
                onChange: (name) => {
                    onPick(name);
                    renderLabel();
                },
                onFolderChange,
            });
        });
    };

    trigger.onpointerdown = (e) => e.stopPropagation();
    trigger.onclick = (e) => {
        e.stopPropagation();
        open();
    };
    trigger.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open();
        }
    };

    return trigger;
}

// ---------------------------------------------------------------------
// Presets: named snapshots of a node's slot list (selections + strengths
// + trigger prompts, exactly as set -- never defaults), stored in a
// single lora_presets.json in this node's folder. This section is the
// data layer (fetch/save/delete/sanitize); the per-node preset bar in
// setupStackNode and applyPresetSlots are the UI side.
// ---------------------------------------------------------------------

function sanitizePresetSlot(slot) {
    if (!slot || typeof slot !== "object" || Array.isArray(slot)) return null;
    const raw = slot.strength == null || slot.strength === "" ? 1.0 : Number(slot.strength);
    return {
        lora_name: String(slot.lora_name || "").trim(),
        strength: Number.isFinite(raw) ? raw : 1.0,
        trigger_prompt: String(slot.trigger_prompt || ""),
    };
}

async function readPresetResponse(res) {
    try {
        return await res.json();
    } catch {
        return {};
    }
}

async function fetchPresets() {
    const res = await fetch("/lora_metadata_loader/presets");
    const data = await readPresetResponse(res);
    if (!res.ok) throw new Error((data && data.error) || `presets request failed (${res.status})`);
    return (data && data.presets) || {};
}

async function savePreset(name, slots) {
    const clean = (slots || []).map(sanitizePresetSlot).filter((s) => s && s.lora_name);
    const res = await fetch("/lora_metadata_loader/presets/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, slots: clean }),
    });
    const data = await readPresetResponse(res);
    if (!res.ok) throw new Error((data && data.error) || `preset save failed (${res.status})`);
    return data;
}

async function deletePreset(name) {
    const res = await fetch("/lora_metadata_loader/presets/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
    });
    const data = await readPresetResponse(res);
    if (!res.ok) throw new Error((data && data.error) || `preset delete failed (${res.status})`);
    return data;
}

// ---------------------------------------------------------------------
// Stack node: horizontal row of LoRA "cards", add/remove, all slot data
// synced into one JSON widget (stack_data). stack_data stays a real
// widget so its value serializes into the workflow and reaches Python,
// but it's hidden on the node (see hideWidget) -- the card UI and the
// gallery are the intended way to edit it.
// ---------------------------------------------------------------------

const STACK_NODES = new Set(["LoraStackLoaderWithMetadata", "LoraStackLoaderModelOnlyWithMetadata"]);

// Marshalling sizes only -- the matching CSS values live in
// lora_metadata_loader.css (card gap, slot body height, bar height).
const PRESET_BAR_HEIGHT = 30;
const DEFAULT_NODE_HEIGHT = 360;

function emptySlot() {
    return { lora_name: "", strength: 1.0, trigger_prompt: "" };
}

// Hides a widget without losing its state. Serialization (and hence the
// workflow file and Python) is unaffected by any of these flags -- they
// only control rendering. Several layers because frontends differ:
// - options.hidden: what the current Vue-based frontend actually checks
// - type "hidden" + hidden flag + zero computeSize: older canvas paths
// - DOM collapse: frontends that render a widget type as a real element
//   (the known leak case is multiline STRING textareas; our single-line
//   stack_data has no such element, but this costs nothing).
function hideWidget(widget) {
    if (!widget.options) widget.options = {};
    widget.options.hidden = true;
    widget.hidden = true;
    widget.type = "hidden";
    widget.computeSize = () => [0, -4];
    const el = widget.element;
    if (el) {
        el.style.display = "none";
        const wrapper = el.closest?.(".dom-widget");
        if (wrapper) wrapper.style.display = "none";
    }
}

// Re-finds stack_data by name and hides it. Used on configure as well as
// creation, in case a frontend rebuilds or resets widgets afterwards.
function hideStackWidget(node) {
    const stackWidget = node.widgets?.find((w) => w.name === "stack_data");
    if (stackWidget) hideWidget(stackWidget);
}

function setupStackNode(node) {
    const stackWidget = node.widgets?.find((w) => w.name === "stack_data");
    if (!stackWidget) return;

    hideWidget(stackWidget);

    // Placeholder until the deferred init below reads the real value --
    // see the requestAnimationFrame block at the bottom of this function
    // for why that read can't happen synchronously here.
    let slots = [emptySlot()];
    // Gallery folder filter for this node. Restored from the stack_data
    // envelope on init, written back via syncWidget -- per-node, and part
    // of the saved workflow.
    let galleryFolder = "";
    // Per-slot expanded state, parallel to `slots`. Transient UI state --
    // not persisted in stack_data.
    let slotExpanded = [];
    let slotBodies = [];
    let slotHeaders = [];

    // ---- Preset bar: one-way load/save, no loaded-preset tracking ----
    // Built (and its DOM widget added) before the card row so it renders
    // above the cards. Handlers reference applyPresetSlots and friends
    // defined below -- they only run on user interaction or the deferred
    // init, both after setup completes.
    let presetData = {};
    // Delete works arm-then-pick: the dropdown resets after every load, so
    // there is never a lingering selection to delete. Arming re-purposes
    // the next dropdown pick as a delete target instead of a load.
    let deleteArmed = false;

    const presetBar = document.createElement("div");
    presetBar.className = "lml-preset-bar";
    enableMiddleButtonPan(presetBar);

    const presetWidget = node.addDOMWidget("lora_preset_ui", "presets", presetBar, {
        serialize: false,
    });
    presetWidget.computeSize = (width) => [width, PRESET_BAR_HEIGHT];

    const presetSelect = document.createElement("select");
    presetSelect.title = "Load a preset (replaces current slots)";
    presetSelect.className = "lml-preset-control lml-preset-select";

    const presetSaveBtn = document.createElement("button");
    presetSaveBtn.textContent = "Save";
    presetSaveBtn.title = "Save current slots as a preset";
    presetSaveBtn.className = "lml-preset-control lml-preset-action";

    const presetDelBtn = document.createElement("button");
    presetDelBtn.textContent = "Delete";
    presetDelBtn.title = "Delete a preset (arms, then pick it from the dropdown)";
    presetDelBtn.className = "lml-preset-control lml-preset-action";

    const presetRefreshBtn = document.createElement("button");
    presetRefreshBtn.textContent = "\u21BB";
    presetRefreshBtn.title = "Refresh preset list";
    presetRefreshBtn.className = "lml-preset-control lml-preset-action";

    const presetClearBtn = document.createElement("button");
    presetClearBtn.textContent = "Clear";
    presetClearBtn.title = "Remove all LoRAs from this node";
    presetClearBtn.className = "lml-preset-control lml-preset-action";

    const presetNameInput = document.createElement("input");
    presetNameInput.type = "text";
    presetNameInput.placeholder = "Preset name...";
    presetNameInput.className = "lml-preset-control lml-preset-input";
    presetNameInput.hidden = true;

    const presetOkBtn = document.createElement("button");
    presetOkBtn.textContent = "OK";
    presetOkBtn.title = "Save preset";
    presetOkBtn.className = "lml-preset-control lml-preset-action";
    presetOkBtn.hidden = true;

    const presetCancelBtn = document.createElement("button");
    presetCancelBtn.textContent = "Cancel";
    presetCancelBtn.className = "lml-preset-control lml-preset-action";
    presetCancelBtn.hidden = true;

    // Status toasts float up from the cursor and fade: no layout shift, no
    // extra height (they live on document.body, outside the node). Tracks
    // the last cursor position over the bar, falling back to the bar itself
    // for keyboard-driven actions.
    let lastBarPointer = null;
    presetBar.onpointermove = (e) => {
        lastBarPointer = { x: e.clientX, y: e.clientY };
    };

    const spawnStatusToast = (msg, isError = false) => {
        const rect = presetBar.getBoundingClientRect();
        const x = (lastBarPointer ? lastBarPointer.x : rect.right - 12) + 12;
        const y = (lastBarPointer ? lastBarPointer.y : rect.top + rect.height / 2) - 10;
        const toast = document.createElement("div");
        toast.className = isError ? "lml-preset-toast lml-error" : "lml-preset-toast";
        toast.textContent = msg;
        // Position is per-toast data (cursor location), not styling.
        toast.style.left = `${x}px`;
        toast.style.top = `${y}px`;
        const existing = document.querySelectorAll(".lml-preset-toast");
        if (existing.length >= 3) existing[0].remove();
        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add("lml-fading"));
        setTimeout(() => toast.remove(), 1300);
    };

    const presetConfirmMsg = document.createElement("span");
    presetConfirmMsg.className = "lml-preset-confirm-msg";
    presetConfirmMsg.hidden = true;

    const presetYesBtn = document.createElement("button");
    presetYesBtn.textContent = "Yes";
    presetYesBtn.title = "Confirm";
    presetYesBtn.className = "lml-preset-control lml-preset-action";
    presetYesBtn.hidden = true;

    const presetNoBtn = document.createElement("button");
    presetNoBtn.textContent = "No";
    presetNoBtn.title = "Cancel";
    presetNoBtn.className = "lml-preset-control lml-preset-action";
    presetNoBtn.hidden = true;

    // Control groups: every show/hide switch below works off these, so a
    // new bar control can't be missed in one of the lists.
    const presetMainControls = [presetSelect, presetSaveBtn, presetDelBtn, presetClearBtn, presetRefreshBtn];
    const presetSaveControls = [presetNameInput, presetOkBtn, presetCancelBtn];
    const presetConfirmControls = [presetConfirmMsg, presetYesBtn, presetNoBtn];

    presetBar.append(
        ...presetMainControls,
        ...presetSaveControls,
        ...presetConfirmControls
    );

    const setVisible = (els, visible) => {
        for (const el of els) el.hidden = !visible;
    };

    for (const el of [...presetMainControls, ...presetSaveControls, ...presetConfirmControls]) {
        el.onpointerdown = (e) => e.stopPropagation();
        el.onkeydown = (e) => e.stopPropagation();
        el.onclick = (e) => e.stopPropagation();
    }

    // Transient feedback only -- toasts expire on their own, so clearing
    // is a no-op and every existing call site keeps working unchanged.
    const setPresetStatus = (msg, isError = false) => {
        if (msg) spawnStatusToast(msg, isError);
    };

    const rebuildPresetOptions = (preserve) => {
        const prev = preserve ? presetSelect.value : "";
        presetSelect.innerHTML = "";
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "Load preset...";
        presetSelect.appendChild(placeholder);
        const names = Object.keys(presetData).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        for (const n of names) {
            const opt = document.createElement("option");
            opt.value = n;
            opt.textContent = `${n} (${(presetData[n] || []).length})`;
            presetSelect.appendChild(opt);
        }
        presetSelect.value = [...presetSelect.options].some((o) => o.value === prev) ? prev : "";
    };

    const refreshPresetList = async (preserve = false) => {
        try {
            presetData = await fetchPresets();
        } catch (err) {
            console.warn("[LoRA-Meta] presets lookup failed", err);
            presetData = {};
        }
        rebuildPresetOptions(preserve);
    };

    const showPresetMain = () => {
        pendingConfirm = null;
        setVisible(presetMainControls, true);
        setVisible([...presetSaveControls, ...presetConfirmControls], false);
    };

    // Inline confirmation row ([message] [Yes] [No]) -- retained for the
    // armed-delete confirmation flow. danger tints Yes red for destructive
    // actions.
    let pendingConfirm = null;

    const showPresetConfirm = (message, onYes, danger = false) => {
        disarmDelete();
        setPresetStatus("");
        pendingConfirm = onYes;
        setVisible([...presetMainControls, ...presetSaveControls], false);
        presetConfirmMsg.textContent = message;
        presetYesBtn.classList.toggle("lml-preset-danger", danger);
        setVisible(presetConfirmControls, true);
        requestAnimationFrame(() => presetYesBtn.focus());
    };

    const answerPresetConfirm = (yes) => {
        const action = pendingConfirm;
        pendingConfirm = null;
        showPresetMain();
        if (yes && action) action();
    };

    presetYesBtn.onclick = (e) => {
        e.stopPropagation();
        answerPresetConfirm(true);
    };

    presetNoBtn.onclick = (e) => {
        e.stopPropagation();
        answerPresetConfirm(false);
    };

    for (const el of [presetYesBtn, presetNoBtn]) {
        el.onkeydown = (e) => {
            e.stopPropagation();
            if (e.key === "Escape") answerPresetConfirm(false);
        };
    }

    const disarmDelete = () => {
        deleteArmed = false;
        presetDelBtn.textContent = "Delete";
        presetDelBtn.classList.remove("lml-preset-danger");
    };

    const deletePresetByName = async (name) => {
        try {
            await deletePreset(name);
            presetData = await fetchPresets();
            rebuildPresetOptions(false);
            setPresetStatus(`Deleted "${name}"`);
        } catch (err) {
            console.warn("[LoRA-Meta] preset delete failed", err);
            setPresetStatus(err.message || "Delete failed", true);
        }
    };

    const showPresetSaveForm = () => {
        disarmDelete();
        setPresetStatus("");
        setVisible(presetMainControls, false);
        setVisible(presetSaveControls, true);
        presetNameInput.value = "";
        requestAnimationFrame(() => presetNameInput.focus());
    };

    presetSelect.onchange = () => {
        const name = presetSelect.value;
        if (!name || !presetData[name]) {
            presetSelect.value = "";
            return;
        }
        if (deleteArmed) {
            disarmDelete();
            presetSelect.value = "";
            deletePresetByName(name);
            return;
        }
        // Capture up front: the confirm row resets the dropdown, and the
        // stored preset could change before the user answers.
        const slotsToLoad = presetData[name];
        applyPresetSlots(slotsToLoad);
        presetSelect.value = ""; // one-way: no loaded-preset tracking
        setPresetStatus(`Loaded "${name}"`);
    };

    presetSaveBtn.onclick = (e) => {
        e.stopPropagation();
        showPresetSaveForm();
    };

    presetCancelBtn.onclick = (e) => {
        e.stopPropagation();
        showPresetMain();
    };

    const persistPreset = async (name) => {
        try {
            const result = await savePreset(name, slots);
            presetData = await fetchPresets();
            rebuildPresetOptions(false);
            showPresetMain();
            setPresetStatus(`Saved "${result.name || name}"`);
        } catch (err) {
            console.warn("[LoRA-Meta] preset save failed", err);
            setPresetStatus(err.message || "Save failed", true);
        }
    };

    const doSavePreset = () => {
        const name = presetNameInput.value.trim();
        if (!name) {
            setPresetStatus("Enter a preset name", true);
            return;
        }
        if (!slots.some((s) => s && s.lora_name)) {
            setPresetStatus("Nothing to save", true);
            return;
        }
        persistPreset(name);
    };

    presetOkBtn.onclick = (e) => {
        e.stopPropagation();
        doSavePreset();
    };

    presetNameInput.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === "Enter") doSavePreset();
        else if (e.key === "Escape") showPresetMain();
    };

    presetDelBtn.onclick = (e) => {
        e.stopPropagation();
        if (deleteArmed) {
            // Armed + clicked again = cancel.
            disarmDelete();
            setPresetStatus("");
            return;
        }
        if (!Object.keys(presetData).length) {
            setPresetStatus("No presets saved", true);
            return;
        }
        deleteArmed = true;
        presetDelBtn.textContent = "Delete?";
        presetDelBtn.classList.add("lml-preset-danger");
        setPresetStatus("Select a preset to delete");
    };

    presetClearBtn.onclick = (e) => {
        e.stopPropagation();
        if (slots.length === 0) {
            setPresetStatus("Nothing to clear");
            return;
        }
        slots = [];
        slotExpanded = [];
        syncWidget();
        render();
        setPresetStatus("Cleared");
    };

    presetRefreshBtn.onclick = async (e) => {
        e.stopPropagation();
        await refreshPresetList(true);
    };

    const container = document.createElement("div");
    container.className = "lml-stack";
    enableMiddleButtonPan(container);

    const domWidget = node.addDOMWidget("lora_stack_ui", "stack", container, {
        serialize: false,
    });
    domWidget.computeSize = (width) => [width, DEFAULT_NODE_HEIGHT];

    // Envelope carries gallery prefs alongside the slots, so the folder
    // filter persists in the workflow. _parse_stack_slots accepts a bare
    // list too, so legacy/hand-written values keep working.
    const syncWidget = () => {
        // _hasImage is transient UI state (re-looked-up on load) -- keep
        // it out of the saved JSON. Non-object entries (hand-edited
        // garbage) pass through untouched for the server to skip.
        const cleanSlots = slots.map((s) => {
            if (!s || typeof s !== "object" || Array.isArray(s)) return s;
            const { _hasImage, ...rest } = s;
            return rest;
        });
        stackWidget.value = JSON.stringify({ slots: cleanSlots, gallery: { folder: galleryFolder } });
    };

    // Replaces the card list with preset slots. Prompts come from the
    // preset itself, so metadata is only re-looked-up for cover images
    // (overwriteTrigger: false) -- strengths/prompts are never reset to
    // defaults. Gallery folder is untouched (presets hold slots only).
    const applyPresetSlots = (presetSlots) => {
        const clean = (presetSlots || []).map(sanitizePresetSlot).filter((s) => s && s.lora_name);
        slots = clean;
        slotExpanded = slots.map(() => false);
        syncWidget();
        render();
        slots.forEach((slot, i) => {
            if (slot.lora_name) refreshSlotMetadata(i, { overwriteTrigger: false });
        });
    };

    const refreshSlotMetadata = async (index, { overwriteTrigger }) => {
        const slot = slots[index];
        if (!slot || !slot.lora_name) return;
        try {
            const data = await fetchLoraInfo(slot.lora_name);
            if (!data) return;
            if (overwriteTrigger) {
                slot.trigger_prompt = data.trigger_prompt || "";
            }
            slot._hasImage = !!data.has_image;
            syncWidget();
            render();
        } catch (err) {
            console.warn("[LoRA-Meta] metadata lookup failed", err);
        }
    };

    function toggleExpanded(index) {
        slotExpanded[index] = !slotExpanded[index];
        const expanded = slotExpanded[index];
        const body = slotBodies[index];
        const header = slotHeaders[index];
        const chevron = header.querySelector(".lml-slot-chevron");
        body.classList.toggle("lml-expanded", expanded);
        header.classList.toggle("lml-expanded", expanded);
        if (chevron) chevron.classList.toggle("lml-expanded", expanded);
    }

    function makeAccordionSlot(slot, index) {
        const wrapper = document.createElement("div");
        wrapper.className = "lml-slot";

        // ---- header (always visible): slot #, name, editable strength, chevron, remove ----
        const header = document.createElement("div");
        header.className = slotExpanded[index] ? "lml-slot-header lml-expanded" : "lml-slot-header";

        const chevron = document.createElement("span");
        chevron.className = slotExpanded[index] ? "lml-slot-chevron lml-expanded" : "lml-slot-chevron";
        chevron.textContent = "\u25B8";

        const name = document.createElement("span");
        name.textContent = slot.lora_name || "Empty slot";
        name.className = slot.lora_name ? "lml-slot-name" : "lml-slot-name lml-empty";
        name.title = slot.lora_name || "No LoRA selected";

        const strengthRow = document.createElement("div");
        strengthRow.className = "lml-slot-strength";
        const strengthLabel = document.createElement("span");
        strengthLabel.textContent = "strength";
        strengthLabel.className = "lml-slot-strength-label";
        const strengthInput = document.createElement("input");
        strengthInput.type = "number";
        strengthInput.step = "0.1";
        strengthInput.value = slot.strength ?? 1.0;
        strengthInput.className = "lml-slot-strength-input";
        strengthInput.onclick = (e) => e.stopPropagation();
        strengthInput.onchange = () => {
            const v = parseFloat(strengthInput.value);
            slot.strength = Number.isFinite(v) ? v : 1.0;
            syncWidget();
        };
        strengthRow.appendChild(strengthLabel);
        strengthRow.appendChild(strengthInput);

        const removeBtn = document.createElement("button");
        removeBtn.textContent = "\u00D7";
        removeBtn.title = "Remove this LoRA";
        removeBtn.className = "lml-slot-remove";
        removeBtn.onclick = (e) => {
            e.stopPropagation();
            slots.splice(index, 1);
            slotExpanded.splice(index, 1);
            syncWidget();
            render();
        };

        header.append(chevron, name, strengthRow, removeBtn);
        slotHeaders[index] = header;

        header.onclick = (e) => {
            if (e.target === removeBtn || removeBtn.contains(e.target)) return;
            if (e.target === strengthInput || strengthInput.contains(e.target)) return;
            toggleExpanded(index);
        };

        // ---- body (collapsible): cover image, gallery trigger, trigger prompt ----
        const body = document.createElement("div");
        body.className = slotExpanded[index] ? "lml-slot-body lml-expanded" : "lml-slot-body";
        slotBodies[index] = body;

        const pickLora = (chosenName) => {
            slot.lora_name = chosenName;
            syncWidget();
            refreshSlotMetadata(index, { overwriteTrigger: true });
        };
        const setGalleryFolder = (f) => {
            galleryFolder = f;
            syncWidget();
        };

        const openGallery = () => {
            fetchLoraList().then(({ names, mtimes }) => {
                openLoraGallery({
                    options: names,
                    mtimes,
                    folder: galleryFolder,
                    value: slot.lora_name,
                    onChange: pickLora,
                    onFolderChange: setGalleryFolder,
                });
            });
        };

        // Left column: fixed 100x100 preview box. The box (and its
        // placeholder) is always rendered at full size so the right-hand
        // column keeps the same width and offset whether or not the LoRA
        // ships a cover image.
        const imageCol = document.createElement("div");
        imageCol.className = "lml-slot-image-col";

        const imageBox = document.createElement("div");
        imageBox.className = slot.lora_name
            ? "lml-slot-image-box lml-clickable"
            : "lml-slot-image-box";
        imageBox.title = slot.lora_name ? "Browse LoRAs..." : "";

        const placeholder = document.createElement("span");
        placeholder.className = "lml-slot-image-placeholder";
        placeholder.textContent = slot.lora_name ? "No preview" : "";
        // Clicks must not fall through to the accordion header (which would
        // collapse the slot). Placeholder text is not selectable and never
        // the click target, so the whole box behaves like the image.
        placeholder.setAttribute("aria-hidden", "true");

        const img = document.createElement("img");
        img.className = "lml-slot-image";
        img.alt = "";
        const showImage = (on) => {
            img.hidden = !on;
            imageBox.classList.toggle("lml-has-image", on);
        };
        showImage(!!(slot._hasImage && slot.lora_name));
        if (slot._hasImage && slot.lora_name) {
            img.src = coverImageUrl(slot.lora_name);
        }
        // A stale has_image (sidecar deleted since lookup) leaves a broken
        // image -- fall back to the placeholder instead of a blank box.
        img.onerror = () => showImage(false);
        imageBox.onclick = (e) => {
            e.stopPropagation();
            if (slot.lora_name) openGallery();
        };

        // Right column: gallery picker + trigger prompt, stacked.
        const rightCol = document.createElement("div");
        rightCol.className = "lml-slot-right";

        const select = createLoraGalleryTrigger({
            getValue: () => slot.lora_name,
            getFolder: () => galleryFolder,
            onPick: pickLora,
            onFolderChange: setGalleryFolder,
        });

        const trigger = document.createElement("textarea");
        trigger.value = slot.trigger_prompt || "";
        trigger.placeholder = "trigger prompt";
        trigger.className = "lml-slot-trigger";
        trigger.onclick = (e) => e.stopPropagation();
        trigger.oninput = () => {
            slot.trigger_prompt = trigger.value;
            syncWidget();
        };

        imageBox.append(placeholder, img);
        imageCol.appendChild(imageBox);
        rightCol.append(select, trigger);
        body.append(imageCol, rightCol);
        wrapper.append(header, body);
        return wrapper;
    }

    function makeAddButton() {
        const btn = document.createElement("button");
        btn.textContent = "+";
        btn.title = "Add another LoRA";
        btn.className = "lml-add-btn";
        btn.onclick = (e) => {
            e.stopPropagation();
            slots.push(emptySlot());
            // New slots start expanded so the user can pick a LoRA right away.
            slotExpanded.push(true);
            syncWidget();
            render();
            requestAnimationFrame(() => {
                container.scrollTop = container.scrollHeight;
            });
        };
        return btn;
    }

    function render() {
        container.innerHTML = "";
        slotBodies = [];
        slotHeaders = [];
        slots.forEach((slot, i) => container.appendChild(makeAccordionSlot(slot, i)));
        container.appendChild(makeAddButton());
    }

    // Defer the initial read of stack_data (and the first render) to the
    // next frame. onNodeCreated fires *before* configure() restores saved
    // widget values, so a synchronous read/write here would clobber a
    // restored value with the just-constructed default ("[]") -- which is
    // exactly why the card UI wasn't restoring. By next frame, configure()
    // has already run, so it's safe to read stack_data for real.
    requestAnimationFrame(() => {
        try {
            const parsed = JSON.parse(stackWidget.value || "[]");
            const data =
                parsed && typeof parsed === "object" && !Array.isArray(parsed)
                    ? parsed
                    : { slots: parsed, gallery: {} };
            const rawSlots = Array.isArray(data.slots) ? data.slots : [];
            // Ignore slots with no LoRA picked — they're no-ops at execution
            // time anyway, and a genuinely empty stack is now valid UI state.
            slots = rawSlots.filter((s) => s && s.lora_name);
            slotExpanded = slots.map(() => false);
            galleryFolder = (data.gallery && data.gallery.folder) || "";
        } catch {
            slots = [];
            slotExpanded = [];
            galleryFolder = "";
        }

        // Safe to write here (unlike synchronously in onNodeCreated,
        // before configure() has had its chance to run) -- normalizes a
        // brand-new node's "[]" default into an empty stack (just the add
        // button, no starter slot).
        slotExpanded = slots.map(() => false);
        syncWidget();
        render();
        // Height is deliberately left alone so a manually set node size
        // survives reloads; the slot list scrolls inside the node.

        // Look up metadata for any slots that already have a LoRA picked
        // (e.g. restored from a saved workflow) -- without overwriting
        // their (already-restored) trigger prompts. The gallery fetches a
        // fresh LoRA list on every open, so nothing list-related is needed
        // here.
        slots.forEach((slot, i) => {
            if (slot.lora_name) refreshSlotMetadata(i, { overwriteTrigger: false });
        });

        // Populate the preset dropdown (fire-and-forget; failures warn to
        // the console and the bar's own refresh retries).
        refreshPresetList(false);
    });
}

// ---------------------------------------------------------------------

app.registerExtension({
    name: "Comfy.LoraMetadataLoader",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!STACK_NODES.has(nodeData.name)) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
            setupStackNode(this);
            return result;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = onConfigure ? onConfigure.apply(this, arguments) : undefined;
            hideStackWidget(this);
            return result;
        };
    },
});
