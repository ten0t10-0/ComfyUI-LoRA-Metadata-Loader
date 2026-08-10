// NOTE on the import: newer ComfyUI (Vue-based) frontends don't reliably
// serve/resolve a relative "../../scripts/app.js" import from custom-node
// JS -- the internal modules are bundled/hashed. The supported way to get
// at them from a custom node is the window.comfyAPI global namespace.
const { app } = window.comfyAPI.app;

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

let loraListPromise = null;
function fetchLoraList() {
    if (!loraListPromise) {
        loraListPromise = fetch("/lora_metadata_loader/list_loras")
            .then((r) => (r.ok ? r.json() : { loras: [] }))
            .then((d) => d.loras || [])
            .catch(() => []);
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
// Single-LoRA nodes: cover-image preview + editable, auto-filled
// trigger_prompts widget.
// ---------------------------------------------------------------------

const SINGLE_LORA_NODES = new Set(["LoraLoaderWithMetadata", "LoraLoaderModelOnlyWithMetadata"]);
const PREVIEW_HEIGHT = 220;

function setupSingleLoraNode(node) {
    const loraWidget = node.widgets?.find((w) => w.name === "lora_name");
    const triggerWidget = node.widgets?.find((w) => w.name === "trigger_prompts");
    if (!loraWidget) return;

    const img = document.createElement("img");
    img.style.width = "100%";
    img.style.height = `${PREVIEW_HEIGHT}px`;
    img.style.objectFit = "contain";
    img.style.borderRadius = "6px";
    img.style.background = "rgba(0,0,0,0.2)";
    img.style.display = "none";

    let showingImage = false;

    const previewWidget = node.addDOMWidget("cover_image_preview", "preview", img, {
        serialize: false,
    });
    previewWidget.computeSize = (width) => [width, showingImage ? PREVIEW_HEIGHT + 8 : 0];

    const refresh = async (loraName, { overwriteTrigger }) => {
        if (!loraName) return;
        try {
            const data = await fetchLoraInfo(loraName);
            if (!data) return;

            if (overwriteTrigger && triggerWidget) {
                triggerWidget.value = data.trigger_prompts || "";
            }

            if (data.has_image) {
                img.src = coverImageUrl(loraName);
                img.style.display = "block";
                showingImage = true;
            } else {
                img.removeAttribute("src");
                img.style.display = "none";
                showingImage = false;
            }

            node.setSize(node.computeSize());
            node.setDirtyCanvas(true, true);
        } catch (err) {
            console.warn("[LoRA-Meta] metadata lookup failed", err);
        }
    };

    const origCallback = loraWidget.callback;
    loraWidget.callback = function (value, ...rest) {
        const r = origCallback ? origCallback.apply(this, [value, ...rest]) : undefined;
        refresh(value, { overwriteTrigger: true });
        return r;
    };

    // Fires for both brand-new nodes and ones restored from a saved
    // workflow. By next frame, configure() has already restored any saved
    // widget values, so only overwrite trigger_prompts if it's still empty
    // (a genuinely new node) -- otherwise we'd stomp a saved edit.
    requestAnimationFrame(() => {
        refresh(loraWidget.value, { overwriteTrigger: !triggerWidget?.value });
    });
}

// ---------------------------------------------------------------------
// Stack node: horizontal row of LoRA "cards", add/remove, all slot data
// synced into one JSON widget (stack_data). stack_data is a normal,
// visible widget -- it has to stay a real widget so its value serializes
// and reaches Python, and attempts to visually hide it fought the
// frontend's own layout system more than they helped, so it's just left
// alone. The card UI below it is the intended way to edit it.
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
    return { lora_name: "", strength: 1.0, trigger_prompts: "" };
}

function setupStackNode(node) {
    const stackWidget = node.widgets?.find((w) => w.name === "stack_data");
    if (!stackWidget) return;

    // Placeholder until the deferred init below reads the real value --
    // see the requestAnimationFrame block at the bottom of this function
    // for why that read can't happen synchronously here.
    let slots = [emptySlot()];
    let loraOptions = [];

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
                slot.trigger_prompts = data.trigger_prompts || "";
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
        if (slot._hasImage && slot.lora_name) {
            img.src = coverImageUrl(slot.lora_name);
            img.style.display = "block";
        } else {
            img.style.display = "none";
        }

        const select = document.createElement("select");
        select.style.width = "100%";
        const blankOpt = document.createElement("option");
        blankOpt.value = "";
        blankOpt.textContent = "Select LoRA...";
        select.appendChild(blankOpt);
        for (const name of loraOptions) {
            const opt = document.createElement("option");
            opt.value = name;
            opt.textContent = name;
            if (name === slot.lora_name) opt.selected = true;
            select.appendChild(opt);
        }
        select.onclick = (e) => e.stopPropagation();
        select.onchange = () => {
            slot.lora_name = select.value;
            syncWidget();
            refreshSlotMetadata(index, { overwriteTrigger: true });
        };

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
        trigger.value = slot.trigger_prompts || "";
        trigger.placeholder = "trigger prompt";
        trigger.style.width = "100%";
        trigger.style.flex = "1";
        trigger.style.resize = "none";
        trigger.style.boxSizing = "border-box";
        trigger.onclick = (e) => e.stopPropagation();
        trigger.oninput = () => {
            slot.trigger_prompts = trigger.value;
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

        // Populate dropdown options, then look up metadata for any slots
        // that already have a LoRA picked (e.g. restored from a saved
        // workflow) -- without overwriting their (already-restored)
        // trigger prompts.
        fetchLoraList().then((names) => {
            loraOptions = names;
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
        const isSingle = SINGLE_LORA_NODES.has(nodeData.name);
        const isStack = STACK_NODES.has(nodeData.name);
        if (!isSingle && !isStack) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
            if (isSingle) setupSingleLoraNode(this);
            if (isStack) setupStackNode(this);
            return result;
        };
    },
});
