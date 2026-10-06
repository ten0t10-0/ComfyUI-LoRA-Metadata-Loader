// NOTE on the import: newer ComfyUI (Vue-based) frontends don't reliably
// serve/resolve a relative "../../scripts/app.js" import from custom-node
// JS -- the internal modules are bundled/hashed. The supported way to get
// at them from a custom node is the window.comfyAPI global namespace.
const { app } = window.comfyAPI.app;

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

let loraListPromise = null;
function fetchLoraList(forceRefresh = false) {
    if (forceRefresh) loraListPromise = null;
    if (!loraListPromise) {
        loraListPromise = fetch("/lora_metadata_loader/list_loras")
            .then((r) => (r.ok ? r.json() : { loras: [], mtimes: {} }))
            .then((d) => ({ names: d.loras || [], mtimes: d.mtimes || {} }))
            .catch(() => ({ names: [], mtimes: {} }));
    }
    return loraListPromise;
}

async function fetchLoraInfo(loraName) {
    const res = await fetch(`/lora_metadata_loader/info?lora_name=${encodeURIComponent(loraName)}`);
    if (!res.ok) return null;
    return res.json();
}

function coverImageUrl(loraName) {
    return `/lora_metadata_loader/cover_image?lora_name=${encodeURIComponent(loraName)}&t=${Date.now()}`;
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
// Gallery prefs, two tiers -- add future filters here:
// - gallerySession: memory-only, sticky across modal opens, resets on
//   page reload. For session filters like the subfolder dropdown.
// - galleryStored: persisted to localStorage. For sticky prefs like sort.
// ---------------------------------------------------------------------
const gallerySession = {
    folder: "",
};

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

function openLoraGallery({ options, mtimes, value, onChange }) {
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
    // no recursive tree.
    // Session-only: sticky across modal opens, never persisted (unlike sort).
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
        // A fresh <select> starts valueless, so seed from the session on the
        // first build; on refresh (options already present) keep the live
        // UI value instead.
        const prev = folderSelect.options.length ? folderSelect.value : gallerySession.folder;
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
        gallerySession.folder = folderFilter;
    }
    folderSelect.onchange = () => {
        folderFilter = folderSelect.value;
        gallerySession.folder = folderFilter;
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

    const ROOT_FILTER = "__root__";
    function topFolder(name) {
        const parts = String(name).split(/[\\/]/);
        return parts.length > 1 ? parts[0] : null;
    }
    // Session filter: sticky across modal opens, never persisted.
    let folderFilter = gallerySession.folder;

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
        img.src = coverImageUrl(name);
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
            ({ names: liveOptions, mtimes: liveMtimes } = await fetchLoraList(true));
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

function createLoraGalleryTrigger({ getValue, getOptions, getMtimes, onPick }) {
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
    trigger._refreshLabel = renderLabel;

    const open = () => {
        openLoraGallery({
            options: getOptions(),
            mtimes: typeof getMtimes === "function" ? getMtimes() : {},
            value: getValue(),
            onChange: (name) => {
                onPick(name);
                renderLabel();
            },
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
// Stack node: horizontal row of LoRA "cards", add/remove, all slot data
// synced into one JSON widget (stack_data). stack_data is a normal,
// visible widget -- it has to stay a real widget so its value serializes
// and reaches Python, and attempts to visually hide it fought the
// frontend's own layout system more than they helped, so it's just left
// alone, but reordered below the card UI (see setupStackNode) so the raw
// JSON textbox stays out of the way. The card UI above it is the intended
// way to edit it.
// ---------------------------------------------------------------------

const STACK_NODES = new Set(["LoraStackLoaderWithMetadata", "LoraStackLoaderModelOnlyWithMetadata"]);

const CARD_WIDTH = 200;
const CARD_GAP = 10;
const CARD_HEIGHT = 330;
const CARD_IMAGE_HEIGHT = 130;
const ADD_BTN_WIDTH = 70;
const MIN_NODE_WIDTH = 260;
const MAX_NODE_WIDTH = 860;

function emptySlot() {
    return { lora_name: "", strength: 1.0, trigger_prompt: "" };
}

function setupStackNode(node) {
    const stackWidget = node.widgets?.find((w) => w.name === "stack_data");
    if (!stackWidget) return;

    // Placeholder until the deferred init below reads the real value --
    // see the requestAnimationFrame block at the bottom of this function
    // for why that read can't happen synchronously here.
    let slots = [emptySlot()];
    let loraOptions = [];
    let loraMtimes = {};

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

    // Widgets render top-to-bottom in node.widgets' array order. stack_data
    // has to stay a real widget (see the note above), but it's just a raw
    // JSON textbox -- move it to the very end so the card UI it mirrors
    // renders first, above it, rather than sandwiched below a plain
    // STRING widget and above the DOM widget just created.
    const stackWidgetIndex = node.widgets.indexOf(stackWidget);
    if (stackWidgetIndex !== -1) {
        node.widgets.splice(stackWidgetIndex, 1);
        node.widgets.push(stackWidget);
    }

    const syncWidget = () => {
        stackWidget.value = JSON.stringify(slots);
    };

    const resizeNode = () => {
        const desired = slots.length * (CARD_WIDTH + CARD_GAP) + ADD_BTN_WIDTH + CARD_GAP + 20;
        const width = Math.max(MIN_NODE_WIDTH, Math.min(desired, MAX_NODE_WIDTH));
        node.setSize([width, node.size[1]]);
        node.setDirtyCanvas(true, true);
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

        const openGallery = () => {
            // Ensure options are loaded before opening, so a fast click on
            // a fresh node still shows the full list.
            fetchLoraList().then(({ names, mtimes }) => {
                loraOptions = names;
                loraMtimes = mtimes;
                openLoraGallery({
                    options: loraOptions,
                    mtimes: loraMtimes,
                    value: slot.lora_name,
                    onChange: (name) => {
                        slot.lora_name = name;
                        syncWidget();
                        refreshSlotMetadata(index, { overwriteTrigger: true });
                    },
                });
            });
        };
        img.onclick = (e) => {
            e.stopPropagation();
            if (slot.lora_name) openGallery();
        };

        const select = createLoraGalleryTrigger({
            getValue: () => slot.lora_name,
            getOptions: () => loraOptions,
            getMtimes: () => loraMtimes,
            onPick: (name) => {
                slot.lora_name = name;
                syncWidget();
                refreshSlotMetadata(index, { overwriteTrigger: true });
            },
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
        strengthInput.step = "0.05";
        strengthInput.value = slot.strength ?? 1.0;
        strengthInput.style.width = "100%";
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
            slots = Array.isArray(parsed) && parsed.length ? parsed : [emptySlot()];
        } catch {
            slots = [emptySlot()];
        }

        // Safe to write here (unlike synchronously in onNodeCreated,
        // before configure() has had its chance to run) -- normalizes a
        // brand-new node's "[]" default into its one empty starter slot.
        syncWidget();
        render();
        resizeNode();

        // Populate gallery options, then look up metadata for any slots
        // that already have a LoRA picked (e.g. restored from a saved
        // workflow) -- without overwriting their (already-restored)
        // trigger prompts.
        fetchLoraList().then(({ names, mtimes }) => {
            loraOptions = names;
            loraMtimes = mtimes;
            render();
            slots.forEach((slot, i) => {
                if (slot.lora_name) refreshSlotMetadata(i, { overwriteTrigger: false });
            });
        });
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
    },
});
