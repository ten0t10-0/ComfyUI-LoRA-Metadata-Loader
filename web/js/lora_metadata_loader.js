// NOTE on the import: newer ComfyUI (Vue-based) frontends don't reliably
// serve/resolve a relative "../../scripts/app.js" import from custom-node
// JS -- the internal modules are bundled/hashed. The supported way to get
// at them from a custom node is the window.comfyAPI global namespace.
const { app } = window.comfyAPI.app;

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
    if (document.querySelector(".lora-gallery-overlay")) return;

    const overlay = document.createElement("div");
    overlay.className = "lora-gallery-overlay";
    Object.assign(overlay.style, {
        position: "fixed",
        inset: "0",
        background: "rgba(0,0,0,0.65)",
        zIndex: "10000",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
        boxSizing: "border-box",
    });

    const panel = document.createElement("div");
    Object.assign(panel.style, {
        width: "min(920px, 94vw)",
        maxHeight: "84vh",
        display: "flex",
        flexDirection: "column",
        background: "#2b2b2b",
        border: "1px solid rgba(255,255,255,0.2)",
        borderRadius: "8px",
        boxShadow: "0 8px 30px rgba(0,0,0,0.6)",
        overflow: "hidden",
    });
    panel.onpointerdown = (e) => e.stopPropagation();
    panel.onclick = (e) => e.stopPropagation();

    const header = document.createElement("div");
    Object.assign(header.style, {
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: "8px",
        padding: "10px 12px",
        borderBottom: "1px solid rgba(255,255,255,0.12)",
    });

    const search = document.createElement("input");
    search.type = "text";
    search.placeholder = "Filter...";
    Object.assign(search.style, {
        boxSizing: "border-box",
        flex: "1",
        minWidth: "0",
        padding: "5px 8px",
        fontSize: "12px",
        border: "1px solid rgba(255,255,255,0.15)",
        borderRadius: "4px",
        background: "rgba(255,255,255,0.05)",
        color: "inherit",
        outline: "none",
    });
    search.onpointerdown = (e) => e.stopPropagation();
    search.onkeydown = (e) => {
        e.stopPropagation(); // don't let ComfyUI/canvas keybinds eat keystrokes
    };

    const count = document.createElement("span");
    count.style.fontSize = "12px";
    count.style.opacity = "0.6";
    count.style.whiteSpace = "nowrap";

    const refreshBtn = document.createElement("button");
    refreshBtn.textContent = "\u21BB";
    refreshBtn.title = "Refresh LoRA list";
    Object.assign(refreshBtn.style, { cursor: "pointer", padding: "2px 8px" });

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "\u00D7";
    closeBtn.title = "Close";
    Object.assign(closeBtn.style, { cursor: "pointer", padding: "2px 10px", fontSize: "14px" });

    const sortSelect = document.createElement("select");
    sortSelect.title = "Sort by";
    for (const [sortValue, label] of [["name", "Name"], ["modified", "Modified"]]) {
        const opt = document.createElement("option");
        opt.value = sortValue;
        opt.textContent = label;
        sortSelect.appendChild(opt);
    }
    Object.assign(sortSelect.style, {
        fontSize: "12px",
        padding: "4px",
        cursor: "pointer",
        background: "rgba(255,255,255,0.05)",
        color: "inherit",
        border: "1px solid rgba(255,255,255,0.15)",
        borderRadius: "4px",
    });
    sortSelect.onpointerdown = (e) => e.stopPropagation();

    const dirBtn = document.createElement("button");
    dirBtn.title = "Sort direction: ascending / descending";
    Object.assign(dirBtn.style, { cursor: "pointer", padding: "2px 8px" });

    // Optional single-level subfolder filter ("anime" in
    // "anime/my_lora.safetensors"). Flat list of top-level folders only --
    // no recursive tree. Per-node value, persisted in the stack_data
    // envelope (see syncWidget).
    const folderSelect = document.createElement("select");
    folderSelect.title = "Filter by subfolder";
    Object.assign(folderSelect.style, {
        fontSize: "12px",
        padding: "4px",
        maxWidth: "160px",
        cursor: "pointer",
        background: "rgba(255,255,255,0.05)",
        color: "inherit",
        border: "1px solid rgba(255,255,255,0.15)",
        borderRadius: "4px",
    });
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
    Object.assign(gridWrap.style, {
        overflowY: "auto",
        padding: "12px",
        flex: "1",
        minHeight: "0",
    });
    gridWrap.onpointerdown = (e) => e.stopPropagation();

    const grid = document.createElement("div");
    Object.assign(grid.style, {
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(132px, 1fr))",
        gap: "10px",
    });
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
        Object.assign(tile.style, {
            cursor: "pointer",
            background: isSelected ? "rgba(140,190,255,0.12)" : "rgba(255,255,255,0.03)",
            border: isSelected
                ? "1px solid rgba(140,190,255,0.7)"
                : "1px solid rgba(255,255,255,0.12)",
            borderRadius: "6px",
            padding: "6px",
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            boxSizing: "border-box",
        });
        tile.onmouseenter = () => {
            if (!isSelected) tile.style.background = "rgba(255,255,255,0.08)";
        };
        tile.onmouseleave = () => {
            if (!isSelected) tile.style.background = "rgba(255,255,255,0.03)";
        };

        // 1x1 preview box -- same style as the on-card preview: dark
        // letterbox background, image fitted with contain (never cropped).
        // The img stays in layout (visibility, not display:none) so
        // loading="lazy" actually fetches it -- display:none removes the
        // layout box, so the browser never considers it near the viewport,
        // onload never fires, and every tile is stuck on "No preview".
        const thumb = document.createElement("div");
        Object.assign(thumb.style, {
            width: "100%",
            aspectRatio: "1 / 1",
            background: "rgba(0,0,0,0.2)",
            borderRadius: "4px",
            overflow: "hidden",
            position: "relative",
        });

        const placeholder = document.createElement("span");
        placeholder.textContent = "No preview";
        Object.assign(placeholder.style, {
            position: "absolute",
            inset: "0",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "11px",
            opacity: "0.45",
            pointerEvents: "none",
        });
        thumb.appendChild(placeholder);

        const img = document.createElement("img");
        img.loading = "lazy";
        img.alt = "";
        Object.assign(img.style, {
            position: "absolute",
            inset: "0",
            width: "100%",
            height: "100%",
            objectFit: "contain",
            display: "block",
            visibility: "hidden",
        });
        img.onload = () => {
            placeholder.remove();
            img.style.visibility = "visible";
        };
        img.onerror = () => {
            img.remove();
        };
        img.src = coverImageUrl(name, galleryBust);
        thumb.appendChild(img);

        const label = document.createElement("div");
        label.textContent = name;
        label.title = name;
        Object.assign(label.style, {
            fontSize: "11px",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            textAlign: "center",
            opacity: "0.9",
        });

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
            Object.assign(empty.style, { padding: "12px", fontSize: "12px", opacity: "0.6" });
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
    Object.assign(trigger.style, {
        width: "100%",
        boxSizing: "border-box",
        padding: "3px 6px",
        fontSize: "12px",
        background: "rgba(255,255,255,0.05)",
        border: "1px solid rgba(255,255,255,0.15)",
        borderRadius: "4px",
        cursor: "pointer",
        userSelect: "none",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
    });

    const renderLabel = () => {
        const v = getValue();
        trigger.textContent = v ? `\uD83D\uDDBC ${v}` : "Select LoRA...";
        trigger.style.opacity = v ? "1" : "0.6";
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

const CARD_WIDTH = 220;
const CARD_GAP = 10;
// Card children are fixed-height except the trigger box (flex:1), so this
// is what sizes it: ~67px here vs ~134px at 330. Preview image untouched.
const CARD_HEIGHT = 262;
const CARD_IMAGE_HEIGHT = 130;
const ADD_BTN_WIDTH = 70;
const PRESET_BAR_HEIGHT = 30;
const MIN_NODE_WIDTH = 260;
const MAX_NODE_WIDTH = 860;

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
    Object.assign(presetBar.style, {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        width: "100%",
        height: `${PRESET_BAR_HEIGHT}px`,
        boxSizing: "border-box",
        padding: "2px 0",
    });

    const presetWidget = node.addDOMWidget("lora_preset_ui", "presets", presetBar, {
        serialize: false,
    });
    presetWidget.computeSize = (width) => [width, PRESET_BAR_HEIGHT];

    const presetControlStyle = {
        fontSize: "12px",
        padding: "3px 6px",
        background: "rgba(255,255,255,0.05)",
        border: "1px solid rgba(255,255,255,0.15)",
        borderRadius: "4px",
        color: "inherit",
    };

    const presetSelect = document.createElement("select");
    presetSelect.title = "Load a preset (replaces current slots)";
    Object.assign(presetSelect.style, {
        ...presetControlStyle,
        flex: "1 1 auto",
        minWidth: "0",
        cursor: "pointer",
    });

    const presetSaveBtn = document.createElement("button");
    presetSaveBtn.textContent = "Save";
    presetSaveBtn.title = "Save current slots as a preset";
    Object.assign(presetSaveBtn.style, { ...presetControlStyle, cursor: "pointer", whiteSpace: "nowrap" });

    const presetDelBtn = document.createElement("button");
    presetDelBtn.textContent = "Delete";
    presetDelBtn.title = "Delete a preset (arms, then pick it from the dropdown)";
    Object.assign(presetDelBtn.style, { ...presetControlStyle, cursor: "pointer", whiteSpace: "nowrap" });

    const presetRefreshBtn = document.createElement("button");
    presetRefreshBtn.textContent = "\u21BB";
    presetRefreshBtn.title = "Refresh preset list";
    Object.assign(presetRefreshBtn.style, { ...presetControlStyle, cursor: "pointer" });

    const presetClearBtn = document.createElement("button");
    presetClearBtn.textContent = "Clear";
    presetClearBtn.title = "Remove all LoRAs from this node";
    Object.assign(presetClearBtn.style, { ...presetControlStyle, cursor: "pointer", whiteSpace: "nowrap" });

    const presetNameInput = document.createElement("input");
    presetNameInput.type = "text";
    presetNameInput.placeholder = "Preset name...";
    Object.assign(presetNameInput.style, {
        ...presetControlStyle,
        flex: "1 1 auto",
        minWidth: "0",
        outline: "none",
        display: "none",
    });

    const presetOkBtn = document.createElement("button");
    presetOkBtn.textContent = "OK";
    presetOkBtn.title = "Save preset";
    Object.assign(presetOkBtn.style, { ...presetControlStyle, cursor: "pointer", display: "none" });

    const presetCancelBtn = document.createElement("button");
    presetCancelBtn.textContent = "Cancel";
    Object.assign(presetCancelBtn.style, { ...presetControlStyle, cursor: "pointer", display: "none" });

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
        toast.className = "lora-preset-toast";
        toast.textContent = msg;
        Object.assign(toast.style, {
            position: "fixed",
            left: `${x}px`,
            top: `${y}px`,
            zIndex: "10001",
            pointerEvents: "none",
            fontSize: "11px",
            padding: "3px 8px",
            background: "rgba(20,20,20,0.92)",
            border: `1px solid ${isError ? "rgba(255,120,120,0.7)" : "rgba(255,255,255,0.25)"}`,
            color: isError ? "#ff9a9a" : "inherit",
            borderRadius: "10px",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: "280px",
            opacity: "1",
            transform: "translateY(0)",
            transition: "transform 1.2s ease-out, opacity 1.2s ease-out",
        });
        const existing = document.querySelectorAll(".lora-preset-toast");
        if (existing.length >= 3) existing[0].remove();
        document.body.appendChild(toast);
        requestAnimationFrame(() => {
            toast.style.transform = "translateY(-28px)";
            toast.style.opacity = "0";
        });
        setTimeout(() => toast.remove(), 1300);
    };

    const presetConfirmMsg = document.createElement("span");
    Object.assign(presetConfirmMsg.style, {
        fontSize: "12px",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        flex: "1 1 auto",
        minWidth: "0",
        display: "none",
    });

    const presetYesBtn = document.createElement("button");
    presetYesBtn.textContent = "Yes";
    presetYesBtn.title = "Confirm";
    Object.assign(presetYesBtn.style, { ...presetControlStyle, cursor: "pointer", display: "none" });

    const presetNoBtn = document.createElement("button");
    presetNoBtn.textContent = "No";
    presetNoBtn.title = "Cancel";
    Object.assign(presetNoBtn.style, { ...presetControlStyle, cursor: "pointer", display: "none" });

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
        for (const el of presetMainControls) el.style.display = "";
        for (const el of [...presetSaveControls, ...presetConfirmControls]) {
            el.style.display = "none";
        }
    };

    // Inline confirmation row ([message] [Yes] [No]) replacing native
    // confirm() dialogs. danger tints Yes red for destructive actions.
    let pendingConfirm = null;

    const showPresetConfirm = (message, onYes, danger = false) => {
        disarmDelete();
        setPresetStatus("");
        pendingConfirm = onYes;
        for (const el of [...presetMainControls, ...presetSaveControls]) {
            el.style.display = "none";
        }
        presetConfirmMsg.textContent = message;
        presetYesBtn.style.borderColor = danger ? "rgba(255,120,120,0.7)" : "";
        for (const el of presetConfirmControls) el.style.display = "";
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
        presetDelBtn.style.borderColor = "";
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
        for (const el of presetMainControls) el.style.display = "none";
        for (const el of presetSaveControls) el.style.display = "";
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
            const target = name;
            showPresetConfirm(`Delete "${target}"?`, () => deletePresetByName(target), true);
            return;
        }
        // Capture up front: the confirm row resets the dropdown, and the
        // stored preset could change before the user answers.
        const slotsToLoad = presetData[name];
        if (slots.some((s) => s && s.lora_name)) {
            presetSelect.value = "";
            showPresetConfirm(`Replace current LoRAs with "${name}"?`, () => {
                applyPresetSlots(slotsToLoad);
                setPresetStatus(`Loaded "${name}"`);
            });
            return;
        }
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
        if (presetData[name]) {
            showPresetConfirm(`Overwrite "${name}"?`, () => persistPreset(name), true);
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
        presetDelBtn.style.borderColor = "rgba(255,120,120,0.7)";
        setPresetStatus("Select a preset to delete");
    };

    presetClearBtn.onclick = (e) => {
        e.stopPropagation();
        if (!slots.some((s) => s && s.lora_name)) {
            setPresetStatus("Nothing to clear");
            return;
        }
        showPresetConfirm("Clear all LoRAs?", () => {
            slots = [emptySlot()];
            syncWidget();
            render();
            resizeNode();
            setPresetStatus("Cleared");
        }, true);
    };

    presetRefreshBtn.onclick = async (e) => {
        e.stopPropagation();
        await refreshPresetList(true);
    };

    const container = document.createElement("div");
    container.style.display = "flex";
    container.style.flexDirection = "row";
    container.style.gap = `${CARD_GAP}px`;
    container.style.overflowX = "auto";
    container.style.overflowY = "hidden";
    container.style.alignItems = "flex-start";
    container.style.width = "100%";
    container.style.height = `${CARD_HEIGHT}px`;

    const domWidget = node.addDOMWidget("lora_stack_ui", "stack", container, {
        serialize: false,
    });
    domWidget.computeSize = (width) => [width, CARD_HEIGHT + 8];

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

    const resizeNode = () => {
        const desired = slots.length * (CARD_WIDTH + CARD_GAP) + ADD_BTN_WIDTH + CARD_GAP + 20;
        const width = Math.max(MIN_NODE_WIDTH, Math.min(desired, MAX_NODE_WIDTH));
        node.setSize([width, node.size[1]]);
        node.setDirtyCanvas(true, true);
    };

    // Replaces the card list with preset slots. Prompts come from the
    // preset itself, so metadata is only re-looked-up for cover images
    // (overwriteTrigger: false) -- strengths/prompts are never reset to
    // defaults. Gallery folder is untouched (presets hold slots only).
    const applyPresetSlots = (presetSlots) => {
        const clean = (presetSlots || []).map(sanitizePresetSlot).filter((s) => s && s.lora_name);
        slots = clean.length ? clean : [emptySlot()];
        syncWidget();
        render();
        resizeNode();
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

    function makeCard(slot, index) {
        const card = document.createElement("div");
        card.style.position = "relative";
        card.style.width = `${CARD_WIDTH}px`;
        card.style.minWidth = `${CARD_WIDTH}px`;
        card.style.height = `${CARD_HEIGHT}px`;
        card.style.display = "flex";
        card.style.flexDirection = "column";
        card.style.gap = "4px";
        card.style.padding = "4px";
        card.style.boxSizing = "border-box";
        card.style.background = "rgba(255,255,255,0.03)";
        card.style.border = "1px solid rgba(255,255,255,0.12)";
        card.style.borderRadius = "6px";

        const removeBtn = document.createElement("button");
        removeBtn.textContent = "\u00D7";
        removeBtn.title = "Remove this LoRA";
        Object.assign(removeBtn.style, {
            position: "absolute",
            top: "2px",
            right: "2px",
            width: "18px",
            height: "18px",
            lineHeight: "16px",
            padding: "0",
            cursor: "pointer",
            zIndex: "2",
        });
        removeBtn.onclick = (e) => {
            e.stopPropagation();
            slots.splice(index, 1);
            if (slots.length === 0) slots.push(emptySlot());
            syncWidget();
            render();
            resizeNode();
        };

        const img = document.createElement("img");
        img.style.width = "100%";
        img.style.height = `${CARD_IMAGE_HEIGHT}px`;
        img.style.objectFit = "contain";
        img.style.borderRadius = "4px";
        img.style.background = "rgba(0,0,0,0.2)";
        img.title = slot.lora_name ? "Browse LoRAs..." : "";
        if (slot._hasImage && slot.lora_name) {
            img.src = coverImageUrl(slot.lora_name);
            img.style.display = "block";
            img.style.cursor = "pointer";
        } else {
            img.style.display = "none";
        }

        const pickLora = (name) => {
            slot.lora_name = name;
            syncWidget();
            refreshSlotMetadata(index, { overwriteTrigger: true });
        };
        const setGalleryFolder = (f) => {
            galleryFolder = f;
            syncWidget();
        };

        const openGallery = () => {
            // Fresh fetch on every open (see the trigger's open()): picks
            // up LoRAs added while ComfyUI is running.
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
        img.onclick = (e) => {
            e.stopPropagation();
            if (slot.lora_name) openGallery();
        };

        const select = createLoraGalleryTrigger({
            getValue: () => slot.lora_name,
            getFolder: () => galleryFolder,
            onPick: pickLora,
            onFolderChange: setGalleryFolder,
        });

        const strengthRow = document.createElement("div");
        strengthRow.style.display = "flex";
        strengthRow.style.alignItems = "center";
        strengthRow.style.gap = "4px";
        const strengthLabel = document.createElement("span");
        strengthLabel.textContent = "strength";
        strengthLabel.style.fontSize = "11px";
        strengthLabel.style.opacity = "0.7";
        strengthLabel.style.whiteSpace = "nowrap";
        const strengthInput = document.createElement("input");
        strengthInput.type = "number";
        strengthInput.step = "0.1";
        strengthInput.value = slot.strength ?? 1.0;
        strengthInput.style.width = "100%";
        strengthInput.style.fontSize = "11px";
        // Floor (not fixed height): keeps the UA spin buttons from
        // overflowing at the smaller font size, while still allowing the
        // input to grow if fonts ever scale up. 22px restores the exact
        // pre-11px metrics. border-box keeps the height predictable.
        strengthInput.style.minHeight = "22px";
        strengthInput.style.boxSizing = "border-box";
        strengthInput.onclick = (e) => e.stopPropagation();
        strengthInput.onchange = () => {
            const v = parseFloat(strengthInput.value);
            slot.strength = Number.isFinite(v) ? v : 1.0;
            syncWidget();
        };
        strengthRow.appendChild(strengthLabel);
        strengthRow.appendChild(strengthInput);

        const trigger = document.createElement("textarea");
        trigger.value = slot.trigger_prompt || "";
        trigger.placeholder = "trigger prompt";
        trigger.style.width = "100%";
        trigger.style.fontSize = "11px";
        trigger.style.flex = "1";
        trigger.style.resize = "none";
        trigger.style.boxSizing = "border-box";
        trigger.onclick = (e) => e.stopPropagation();
        trigger.oninput = () => {
            slot.trigger_prompt = trigger.value;
            syncWidget();
        };

        card.append(removeBtn, img, select, strengthRow, trigger);
        return card;
    }

    function makeAddButton() {
        const btn = document.createElement("div");
        btn.textContent = "+";
        btn.title = "Add another LoRA";
        Object.assign(btn.style, {
            width: `${ADD_BTN_WIDTH}px`,
            minWidth: `${ADD_BTN_WIDTH}px`,
            height: `${CARD_HEIGHT}px`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "28px",
            cursor: "pointer",
            border: "1px dashed rgba(255,255,255,0.25)",
            borderRadius: "6px",
            opacity: "0.7",
        });
        btn.onclick = (e) => {
            e.stopPropagation();
            slots.push(emptySlot());
            syncWidget();
            render();
            resizeNode();
            requestAnimationFrame(() => {
                container.scrollLeft = container.scrollWidth;
            });
        };
        return btn;
    }

    function render() {
        container.innerHTML = "";
        slots.forEach((slot, i) => container.appendChild(makeCard(slot, i)));
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
            slots = rawSlots.length ? rawSlots : [emptySlot()];
            galleryFolder = (data.gallery && data.gallery.folder) || "";
        } catch {
            slots = [emptySlot()];
            galleryFolder = "";
        }

        // Safe to write here (unlike synchronously in onNodeCreated,
        // before configure() has had its chance to run) -- normalizes a
        // brand-new node's "[]" default into its one empty starter slot.
        syncWidget();
        render();
        // Nodes saved while stack_data was still visible keep their taller
        // size -- collapse the height to the visible widgets (resizeNode
        // then restores the card-driven width).
        node.setSize(node.computeSize());
        resizeNode();

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
