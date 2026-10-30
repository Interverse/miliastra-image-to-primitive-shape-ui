/*
 * app.js — main controller for the static Shaper port.
 *
 * Views: upload+batch queue, per-job result, GIA mode conversion.
 * Jobs run in dedicated Web Workers (one per job, pooled), so multiple
 * images are processed concurrently on separate CPU cores.
 */
"use strict";

(function () {
  const $ = (id) => document.getElementById(id);
  const t = (key, params) => I18N.t(key, params);

  /* ════════════════════ presets (from web/upload.js) ════════════════════ */

  const PRESETS = {
    circle: [
      { key: "coin", hintKey: "preset.hint.defaultCircle", type_id: 10005009, size: 1.0 },
      { key: "electro_badge", hintKey: "preset.hint.lowLoad", type_id: 20001281, size: 0.3, rot_z: 90, rot_y_add: 90 },
      { key: "pyro_badge", hintKey: "preset.hint.lowLoad", type_id: 20001282, size: 0.3, rot_z: 90, rot_y_add: 90 },
      { key: "dendro_badge", hintKey: "preset.hint.lowLoad", type_id: 20001283, size: 0.3, rot_z: 90, rot_y_add: 90 },
      { key: "cryo_badge", hintKey: "preset.hint.lowLoad", type_id: 20001284, size: 0.3, rot_z: 90, rot_y_add: 90 },
      { key: "geo_badge", hintKey: "preset.hint.lowLoad", type_id: 20001285, size: 0.3, rot_z: 90, rot_y_add: 90 },
      { key: "hydro_badge", hintKey: "preset.hint.lowLoad", type_id: 20001286, size: 0.3, rot_z: 90, rot_y_add: 90 },
      { key: "anemo_badge", hintKey: "preset.hint.lowLoad", type_id: 20001287, size: 0.3, rot_z: 90, rot_y_add: 90 },
      { key: "custom", hintKey: "preset.hint.custom" },
    ],
    rect: [
      { key: "wood_box", hintKey: "preset.hint.commonRect", type_id: 20001224, size: 1.0 },
      { key: "geo_cube", hintKey: "preset.hint.blocky", type_id: 20001034, size: 5.0 },
      { key: "wood_box_green", hintKey: "preset.hint.coloredBox", type_id: 20001237, size: 1.5 },
      { key: "wood_box_blue", hintKey: "preset.hint.coloredBox", type_id: 20001238, size: 1.5 },
      { key: "wood_box_purple", hintKey: "preset.hint.coloredBox", type_id: 20001239, size: 1.5 },
      { key: "stone_wall_yellow", hintKey: "preset.hint.wallStack", type_id: 20001869, size: 3.0 },
      { key: "stone_wall_red", hintKey: "preset.hint.wallStack", type_id: 20001870, size: 3.0 },
      { key: "stone_wall_gray", hintKey: "preset.hint.wallStack", type_id: 20001872, size: 3.0 },
      { key: "water_cube", hintKey: "preset.hint.commonCube", type_id: 20001874, size: 1.0 },
      { key: "cream_cube", hintKey: "preset.hint.commonCube", type_id: 20001875, size: 1.0 },
      { key: "solid_cube_dark_blue", hintKey: "preset.hint.commonCube", type_id: 20001876, size: 1.0 },
      { key: "ice_cube", hintKey: "preset.hint.commonCube", type_id: 20001877, size: 1.0 },
      { key: "fire_cube", hintKey: "preset.hint.commonCube", type_id: 20001878, size: 1.0 },
      { key: "electro_cube", hintKey: "preset.hint.commonCube", type_id: 20001879, size: 1.0 },
      { key: "wood_low_cabinet", hintKey: "preset.hint.longRect", type_id: 20001082, size: 1.0 },
      { key: "block_cube_wood", hintKey: "preset.hint.bigBlock", type_id: 20001096, size: 6.0 },
      { key: "block_cube_dark", hintKey: "preset.hint.bigBlock", type_id: 20001097, size: 6.0 },
      { key: "block_cube_light", hintKey: "preset.hint.bigBlock", type_id: 20001100, size: 6.0 },
      { key: "stone_ceiling_white", hintKey: "preset.hint.bigPlatform", type_id: 20002146, size: 5.0 },
      { key: "wood_ceiling_black", hintKey: "preset.hint.bigPlatform", type_id: 20002121, size: 5.0 },
      { key: "green_platform", hintKey: "preset.hint.bigPlatform", type_id: 10005014, size: 5.0 },
      { key: "custom", hintKey: "preset.hint.custom" },
    ],
  };

  function presetName(shape, key) { return t(`preset.${shape}.${key}`); }
  function getPresetList(shape) { return PRESETS[shape] || PRESETS.circle; }
  function getPreset(shape, key) {
    return getPresetList(shape).find((p) => p.key === key) || getPresetList(shape)[0];
  }

  const DEFAULT_IMAGE_ASSET_REFS = { rectangle: 100001, ellipse: 100002, triangle: 100003 };

  /* ════════════════════ language selector ════════════════════ */

  const langSelect = $("langSelect");
  I18N.LANGUAGES.forEach((lang) => {
    const opt = document.createElement("option");
    opt.value = lang.code;
    opt.textContent = lang.name;
    langSelect.appendChild(opt);
  });
  I18N.init();
  langSelect.value = I18N.lang;
  langSelect.addEventListener("change", () => I18N.setLang(langSelect.value));
  I18N.onChange((code) => { langSelect.value = code; });

  /* ════════════════════ view + mode switching ════════════════════ */

  let currentMode = "fill";     // fill | outline
  let activeView = "upload";    // upload | result | classic

  function setView(view) {
    activeView = view;
    $("viewUpload").classList.toggle("active", view === "upload");
    $("viewResult").classList.toggle("active", view === "result");
    $("viewClassic").classList.toggle("active", view === "classic");
    $("imageToolTab").classList.toggle("active", view !== "classic");
    $("classicToolTab").classList.toggle("active", view === "classic");
    $("outlineLink").hidden = view === "classic";
    updateSubtitle();
  }

  function updateSubtitle() {
    const subtitle = $("topbarSubtitle");
    if (activeView === "classic") subtitle.textContent = t("topbar.subtitle.classic");
    else subtitle.textContent = t(currentMode === "fill" ? "fitting.subtitle" : "topbar.subtitle.outline");
  }

  function setMode(mode) {
    currentMode = mode;
    $("fillParams").hidden = mode !== "fill";
    $("outlineParams").hidden = mode !== "outline";
    $("fillShapeSection").hidden = mode !== "fill";
    $("primitiveListSection").hidden = mode !== "outline";
    $("shapeSectionTitle").textContent = t(mode === "fill" ? "shapes.sectionTitle.fill" : "shapes.sectionTitle.outline");
    $("outlineLink").textContent = t(mode === "fill" ? "topbar.link.outline" : "topbar.link.fill");
    $("shapeHint").textContent = mode === "fill" ? t("fitting.shapeHint") : "";
    if (mode === "outline") ensureOutlineDefault();
    updateSubtitle();
    updatePrimitiveEmptyState();
  }

  $("homeLink").addEventListener("click", (e) => { e.preventDefault(); setView("upload"); });
  $("imageToolTab").addEventListener("click", () => setView("upload"));
  $("classicToolTab").addEventListener("click", () => setView("classic"));
  $("outlineLink").addEventListener("click", (e) => {
    e.preventDefault();
    setMode(currentMode === "fill" ? "outline" : "fill");
  });
  $("btnBackToJobs").addEventListener("click", () => setView("upload"));

  I18N.onChange(() => {
    updateSubtitle();
    $("shapeSectionTitle").textContent = t(currentMode === "fill" ? "shapes.sectionTitle.fill" : "shapes.sectionTitle.outline");
    $("outlineLink").textContent = t(currentMode === "fill" ? "topbar.link.outline" : "topbar.link.fill");
    $("shapeHint").textContent = currentMode === "fill" ? t("fitting.shapeHint") : "";
    refreshPrimitiveCardsI18n();
    syncShapeLabels();
    updatePrimitiveEmptyState();
    renderJobs();
    updateUploadReady();
    if (activeView === "result" && shownJob) showResult(shownJob, true);
  });

  /* ════════════════════ sliders ════════════════════ */

  function setSliderValue(id, formatter) {
    const input = $(id);
    const value = $(id + "Val");
    if (!input || !value) return;
    const render = () => { value.textContent = formatter ? formatter(input.value) : input.value; };
    render();
    input.addEventListener("input", render);
  }

  function updateSliderFill(input) {
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 100;
    const value = Number(input.value) || 0;
    const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
    input.style.setProperty("--slider-fill", percent + "%");
  }

  setSliderValue("numPrims");
  setSliderValue("imageScale");
  setSliderValue("outputAlpha", (v) => v + "%");
  ["olPrimSize", "olSpacing", "olPrecision"].forEach((id) => setSliderValue(id));
  document.querySelectorAll('input[type="range"]').forEach((input) => {
    updateSliderFill(input);
    input.addEventListener("input", () => updateSliderFill(input));
  });

  const numPrimsSlider = $("numPrims");
  const numPrimsManual = $("numPrimsManual");
  function validControlCount(input) {
    input.setCustomValidity("");
    const value=Number(input.value);
    if(input.value!==""&&(!Number.isSafeInteger(value)||value<Number(input.min)))input.setCustomValidity(t("compression.invalidBudget",{min:input.min}));
    return input.reportValidity();
  }
  numPrimsSlider.addEventListener("input", () => {
    numPrimsManual.value = numPrimsSlider.value;
    $("numPrimsVal").textContent = numPrimsSlider.value;
  });
  numPrimsManual.addEventListener("input", () => {
    numPrimsManual.setCustomValidity("");
    const value = Number(numPrimsManual.value);
    if (Number.isSafeInteger(value) && value >= Number(numPrimsManual.min)) {
      numPrimsSlider.max=String(Math.max(Number(numPrimsSlider.max),value));
      numPrimsSlider.value = String(value);
      updateSliderFill(numPrimsSlider);
    }
    $("numPrimsVal").textContent = numPrimsManual.value || numPrimsSlider.value;
  });

  /* origin radio */
  document.querySelectorAll('input[name="originType"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      $("originCustomRow").hidden = document.querySelector('input[name="originType"]:checked').value !== "custom";
    });
  });

  /* ════════════════════ shape checkboxes ════════════════════ */

  const shapePairs = [["Circle","circle"],["Rect","rect"],["Triangle","triangle"]];
  function selectedFitShape(prefix="") {
    return shapePairs.find(([id])=>$(prefix ? "retryShape"+id : "shape"+id).checked)?.[1] || "triangle";
  }
  const fillShapeInputs = Array.from(document.querySelectorAll("#legacyShapeChecks input"));
  function syncShapeLabels() {
    const method=$("fitMethod").value, gaussian=method==="gaussian", primeval=method==="primeval";
    fillShapeInputs.forEach(input=>input.closest(".shape-check").classList.toggle("active",input.checked));
    $("legacyShapeChecks").hidden=gaussian;
    $("primevalSettings").hidden=!primeval;
    $("gaussianHint").hidden=!gaussian;
    $("shapeHint").hidden=method!=="legacy";
    $("gaussianSettings").hidden=!gaussian;
    $("enhancedMode").disabled=method!=="legacy";
    $("enhancedSettings").hidden=method!=="legacy";
    $("pngModeSettings").hidden=false;
    syncBackgroundColor();
    $("numPrimsTitle").textContent=t("fillParams.numPrims");
    numPrimsManual.removeAttribute("max");numPrimsManual.min="1";numPrimsSlider.min="1";
  }
  $("fitMethod").addEventListener("change",()=>{syncShapeLabels();updateSubtitle();});
  fillShapeInputs.forEach(input=>input.addEventListener("change",syncShapeLabels));
  function syncBackgroundColor(){
    const active=$("fitMethod").value==="primeval"&&!$("enablePngMode").checked;
    $("backgroundColorSettings").hidden=!active;
    $("backgroundColorRow").hidden=!active||!$("useBackgroundColor").checked;
    $("backgroundColorValue").textContent=$("backgroundColor").value.toUpperCase();
  }
  $("enablePngMode").addEventListener("change",syncBackgroundColor);
  $("useBackgroundColor").addEventListener("change",syncBackgroundColor);
  $("backgroundColor").addEventListener("input",syncBackgroundColor);
  syncShapeLabels();
  /* ════════════════════ outline primitive cards ════════════════════ */

  const primitiveList = $("primitiveList");

  function updatePrimitiveEmptyState() {
    const count = primitiveList.querySelectorAll(".primitive-card").length;
    $("primitiveEmpty").hidden = count > 0;
    $("primitiveCountHint").textContent = count > 0
      ? t("outline.countHint.some", { n: count })
      : t("outline.countHint.empty");
  }

  function inferPresetKey(shape, config) {
    if (config.preset_key) return config.preset_key;
    const presets = getPresetList(shape);
    const matched = presets.find((preset) => {
      if (preset.key === "custom") return false;
      return Number(preset.type_id || 0) === Number(config.type_id || 0) &&
             Number(preset.rot_z || 0) === Number(config.rot_z || 0) &&
             Number(preset.rot_y_add || 0) === Number(config.rot_y_add || 0);
    });
    return matched ? matched.key : "custom";
  }

  function fillNumberField(input, value) {
    input.value = value === undefined || value === null || value === "" ? "" : String(value);
  }

  function updatePresetOptions(card, nextPresetKey) {
    const shape = card.querySelector('[data-field="shape"]').value;
    const presetSelect = card.querySelector('[data-field="preset"]');
    const presetOptions = getPresetList(shape);
    presetSelect.innerHTML = presetOptions
      .map((preset) => `<option value="${preset.key}">${presetName(shape, preset.key)}</option>`)
      .join("");
    presetSelect.value = nextPresetKey && presetOptions.some((p) => p.key === nextPresetKey)
      ? nextPresetKey : presetOptions[0].key;
    const badge = card.querySelector(".primitive-badge");
    badge.textContent = t(shape === "rect" ? "outline.badge.rect" : "outline.badge.circle");
    badge.dataset.shape = shape;
  }

  function updatePrimitiveMeta(card) {
    const shape = card.querySelector('[data-field="shape"]').value;
    const presetKey = card.querySelector('[data-field="preset"]').value;
    const preset = getPreset(shape, presetKey);
    const meta = card.querySelector(".primitive-meta");
    if (!preset) { meta.textContent = t("outline.meta.default"); return; }
    const parts = [];
    if (preset.hintKey) parts.push(t(preset.hintKey));
    if (preset.type_id !== undefined) parts.push(t("outline.meta.id", { id: preset.type_id }));
    if (preset.size !== undefined) parts.push(t("outline.meta.size", { size: preset.size }));
    meta.textContent = parts.length ? t("outline.meta.detail", { parts: parts.join(" · ") }) : t("outline.meta.default");
  }

  function applyPreset(card, presetKey, preserveName) {
    const shape = card.querySelector('[data-field="shape"]').value;
    const preset = getPreset(shape, presetKey);
    const nameInput = card.querySelector('[data-field="name"]');
    if (!preserveName || !nameInput.value.trim()) {
      nameInput.value = presetName(shape, preset.key);
    }
    fillNumberField(card.querySelector('[data-field="image_asset_ref"]'), preset.image_asset_ref);
    fillNumberField(card.querySelector('[data-field="type_id"]'), preset.type_id);
    fillNumberField(card.querySelector('[data-field="element_type_id"]'), preset.element_type_id);
    fillNumberField(card.querySelector('[data-field="rot_z"]'), preset.rot_z);
    fillNumberField(card.querySelector('[data-field="rot_y_add"]'), preset.rot_y_add);
    updatePrimitiveMeta(card);
  }

  function createField(labelKey, field) {
    const wrap = document.createElement("label");
    wrap.className = "primitive-field";
    const title = document.createElement("span");
    title.className = "primitive-field-label";
    title.dataset.i18n = labelKey;
    title.textContent = t(labelKey);
    wrap.appendChild(title);
    wrap.appendChild(field);
    return wrap;
  }

  function createPrimitiveRow(config) {
    const initialShape = config.shape === "rect" ? "rect" : "circle";
    const card = document.createElement("article");
    card.className = "primitive-card";

    const head = document.createElement("div");
    head.className = "primitive-card-head";
    const badge = document.createElement("span");
    badge.className = "primitive-badge";
    const presetSelect = document.createElement("select");
    presetSelect.className = "form-select";
    presetSelect.dataset.field = "preset";
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn-chip primitive-remove";
    removeBtn.dataset.i18n = "outline.remove";
    removeBtn.textContent = t("outline.remove");
    head.appendChild(badge);
    head.appendChild(presetSelect);
    head.appendChild(removeBtn);

    const grid = document.createElement("div");
    grid.className = "primitive-grid";

    const shapeSelect = document.createElement("select");
    shapeSelect.className = "form-select";
    shapeSelect.dataset.field = "shape";
    shapeSelect.innerHTML =
      `<option value="circle">${t("shapes.circle")}</option><option value="rect">${t("shapes.rect")}</option>`;
    shapeSelect.value = initialShape;

    const mkInput = (field, type, placeholderKey) => {
      const input = document.createElement("input");
      input.type = type;
      input.className = "form-input";
      input.dataset.field = field;
      if (placeholderKey) {
        input.dataset.i18nPlaceholder = placeholderKey;
        input.placeholder = t(placeholderKey);
      }
      return input;
    };
    const nameInput = mkInput("name", "text", "outline.namePlaceholder");
    const assetInput = mkInput("image_asset_ref", "number");
    assetInput.placeholder = "100002";
    const typeIdInput = mkInput("type_id", "number");
    typeIdInput.placeholder = "20001285";
    const elementTypeIdInput = mkInput("element_type_id", "number", "outline.elementTypeIdPlaceholder");
    const rotZInput = mkInput("rot_z", "number");
    rotZInput.step = "1"; rotZInput.placeholder = "0";
    const rotYInput = mkInput("rot_y_add", "number");
    rotYInput.step = "1"; rotYInput.placeholder = "0";

    [
      createField("outline.field.shape", shapeSelect),
      createField("outline.field.name", nameInput),
      createField("outline.field.assetRef", assetInput),
      createField("outline.field.typeId", typeIdInput),
      createField("outline.field.elementTypeId", elementTypeIdInput),
      createField("outline.field.rotZ", rotZInput),
      createField("outline.field.rotY", rotYInput),
    ].forEach((field) => grid.appendChild(field));

    const meta = document.createElement("p");
    meta.className = "primitive-meta";

    card.appendChild(head);
    card.appendChild(grid);
    card.appendChild(meta);

    const presetKey = inferPresetKey(initialShape, config);
    updatePresetOptions(card, presetKey);
    applyPreset(card, presetKey, false);

    if (config.name) nameInput.value = config.name;
    fillNumberField(assetInput, config.image_asset_ref);
    fillNumberField(typeIdInput, config.type_id);
    fillNumberField(elementTypeIdInput, config.element_type_id);
    fillNumberField(rotZInput, config.rot_z);
    fillNumberField(rotYInput, config.rot_y_add);
    updatePrimitiveMeta(card);

    shapeSelect.addEventListener("change", () => {
      updatePresetOptions(card);
      applyPreset(card, card.querySelector('[data-field="preset"]').value, false);
    });
    presetSelect.addEventListener("change", () => applyPreset(card, presetSelect.value, false));
    removeBtn.addEventListener("click", () => { card.remove(); updatePrimitiveEmptyState(); });

    return card;
  }

  function addPrimitiveConfig(config) {
    primitiveList.appendChild(createPrimitiveRow(config || { shape: "circle" }));
    updatePrimitiveEmptyState();
  }

  function ensureOutlineDefault() {
    if (!primitiveList.querySelector(".primitive-card")) {
      addPrimitiveConfig({ shape: "circle", preset_key: "coin" });
    }
  }

  function refreshPrimitiveCardsI18n() {
    primitiveList.querySelectorAll(".primitive-card").forEach((card) => {
      const currentPreset = card.querySelector('[data-field="preset"]').value;
      const shapeSelect = card.querySelector('[data-field="shape"]');
      const currentShape = shapeSelect.value;
      shapeSelect.innerHTML =
        `<option value="circle">${t("shapes.circle")}</option><option value="rect">${t("shapes.rect")}</option>`;
      shapeSelect.value = currentShape;
      updatePresetOptions(card, currentPreset);
      updatePrimitiveMeta(card);
      I18N.apply(card);
    });
  }

  function readOutlinePrimitives() {
    return Array.from(primitiveList.querySelectorAll(".primitive-card")).map((card) => {
      const primitive = {
        shape: card.querySelector('[data-field="shape"]').value,
        color: "#ffffff",
      };
      const get = (field) => card.querySelector(`[data-field="${field}"]`).value.trim();
      const name = get("name");
      const imageAssetRef = get("image_asset_ref");
      const typeId = get("type_id");
      const elementTypeId = get("element_type_id");
      const rotZ = get("rot_z");
      const rotYAdd = get("rot_y_add");
      if (name) primitive.name = name;
      if (imageAssetRef) primitive.image_asset_ref = Number(imageAssetRef);
      if (typeId) primitive.type_id = Number(typeId);
      if (elementTypeId) primitive.element_type_id = Number(elementTypeId);
      if (rotZ) primitive.rot_z = Number(rotZ);
      if (rotYAdd) primitive.rot_y_add = Number(rotYAdd);
      return primitive;
    });
  }

  $("addCirclePrimitiveBtn").addEventListener("click", () => addPrimitiveConfig({ shape: "circle", preset_key: "coin" }));
  $("addRectPrimitiveBtn").addEventListener("click", () => addPrimitiveConfig({ shape: "rect", preset_key: "wood_box" }));

  /* ════════════════════ file staging (multi-select) ════════════════════ */

  const dropZone = $("dropZone");
  const fileInput = $("fileInput");
  let pendingFiles = [];   // [{file, url}]

  /* Adaptive columns for the preview grid: one large preview for a single
   * image, then progressively denser grids. */
  function thumbColumns(count) {
    if (count <= 1) return 1;
    if (count <= 4) return 2;
    if (count <= 9) return 3;
    return 4;
  }

  function updateUploadReady() {
    const ready = $("uploadReady");
    const thumbs = $("fileThumbs");
    if (!pendingFiles.length) {
      thumbs.innerHTML = "";
      thumbs.removeAttribute("data-count");
      ready.hidden = true;
      dropZone.classList.remove("ready");
      $("uploadWarning").hidden = true;
      return;
    }

    // Incremental update: keep existing <img> nodes (object URLs stable) so
    // batch additions only append and re-flow — no full layout refresh.
    const existing = thumbs.children.length;
    for (let i = existing - 1; i >= pendingFiles.length; i--) {
      thumbs.children[i].remove();
    }
    pendingFiles.forEach((entry, i) => {
      let img = thumbs.children[i];
      if (!img) {
        img = document.createElement("img");
        thumbs.appendChild(img);
      }
      if (!img.src || !img.src.endsWith(entry.url)) img.src = entry.url;
      img.alt = entry.file.name;
      img.title = entry.file.name;
    });
    thumbs.dataset.count = String(pendingFiles.length);
    thumbs.style.setProperty("--thumb-cols", String(thumbColumns(pendingFiles.length)));

    ready.hidden = false;
    ready.textContent = t("upload.selected", { n: pendingFiles.length });
    dropZone.classList.add("ready");
    $("uploadWarning").hidden = !pendingFiles.some((entry) => entry.file.size > 3 * 1024 * 1024);
  }

  function addFiles(files) {
    for (const file of files) {
      if (!file || !file.type.startsWith("image/")) continue;
      pendingFiles.push({ file, url: URL.createObjectURL(file) });
    }
    updateUploadReady();
  }

  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files.length) addFiles(Array.from(fileInput.files));
    fileInput.value = "";
  });
  dropZone.addEventListener("dragover", (event) => { event.preventDefault(); dropZone.classList.add("drag-over"); });
  dropZone.addEventListener("dragleave", (event) => { event.preventDefault(); dropZone.classList.remove("drag-over"); });
  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("drag-over");
    if (event.dataTransfer.files) addFiles(Array.from(event.dataTransfer.files));
  });
  document.addEventListener("paste", (event) => {
    if (activeView !== "upload") return;
    const items = (event.clipboardData || {}).items || [];
    const files = [];
    for (const item of items) {
      if (item.type && item.type.indexOf("image") !== -1) files.push(item.getAsFile());
    }
    if (files.length) addFiles(files);
  });

  /* ════════════════════ config capture ════════════════════ */

  function readOriginConfig() {
    const type = document.querySelector('input[name="originType"]:checked').value;
    return {
      type,
      x: type === "custom" ? $("originCustomX").value : "",
      y: type === "custom" ? $("originCustomY").value : "",
    };
  }

  function captureConfig(file) {
    const ext = "." + (file.name.split(".").pop() || "").toLowerCase();
    const cfg = {
      mode: currentMode,
      source_filename: file.name,
      source_ext: ext,
      origin: readOriginConfig(),
    };
    if (currentMode === "fill") {
      const method=$("fitMethod").value;
      const shape=selectedFitShape();
      cfg.num_primitives=Number(numPrimsManual.value);
      cfg.fit_method=method;
      cfg.mask_threshold=127;cfg.detail_scale=1;
      cfg.image_scale=Number($("imageScale").value);
      cfg.output_alpha=Number($("outputAlpha").value)/100;
      cfg.enable_png_mode=$("enablePngMode").checked;
      if(method==="primeval"&&!cfg.enable_png_mode&&$("useBackgroundColor").checked){cfg.background_color=$("backgroundColor").value;}
      if(method==="legacy" && $("enhancedMode").checked){
        cfg.guided_sampling=true;cfg.search_n=150;cfg.search_age=100;cfg.search_m=4;
      }
      cfg.allowed_shapes=method==="gaussian"?["blurred_circle"]:[shape];
      if(method==="primeval"){
        cfg.primeval_resolution=Number($("primevalResolution").value)||512;
        cfg.primeval_seed=42;
      }
      if(method==="gaussian"){
        cfg.gaussian_algorithm=$("gaussianAlgorithm").value;
        cfg.gaussian_iterations=Math.max(1,Math.round(Number($("gaussianIterations").value)||600));
        cfg.gaussian_resolution=Number($("gaussianResolution").value)||512;
      }
      cfg.primitives=cfg.allowed_shapes.map(shape=>({shape,color:"#ffffff"}));
    } else {
      cfg.primitive_size = Number($("olPrimSize").value);
      cfg.spacing = Number($("olSpacing").value);
      cfg.precision = Number($("olPrecision").value);
      const primitives = readOutlinePrimitives();
      const shapes = [];
      for (const p of primitives) {
        if ((p.shape === "circle" || p.shape === "rect") && !shapes.includes(p.shape)) shapes.push(p.shape);
      }
      cfg.allowed_shapes = shapes.length ? shapes : ["circle"];
      if (primitives.length) cfg.primitives = primitives;
    }
    return cfg;
  }

  /* ════════════════════ job queue ════════════════════ */

  // One worker per job; leave a core for the UI. Higher cap benefits
  // many-core machines on batch imports (per-job output is unaffected).
  const MAX_CONCURRENT = Math.max(1, Math.min((navigator.hardwareConcurrency || 4) - 1, 8));
  const jobs = [];
  let jobCounter = 0;
  let shownJob = null;

  function derivedBaseName(fileName) {
    return (fileName || "").replace(/\.[^.]+$/, "").trim() || "shaper_result";
  }

  function createJob(file, url, cfg) {
    jobCounter++;
    return {
      id: "job" + jobCounter,
      file,
      thumbUrl: url,
      name: file.name,
      baseName: derivedBaseName(file.name),
      config: cfg,
      status: "queued",      // queued | processing | done | error | cancelled
      progress: 0,
      progressTotal: 1,
      error: null,
      result: null,
      worker: null,
      assets: null,          // {baseCanvas, maskCanvas, previewCanvas}
      origin: null,
    };
  }

  /*
   * decodeToRGBA — decode an uploaded image to raw RGBA, matching the Python
   * original's cv2.imdecode(..., IMREAD_UNCHANGED): no EXIF rotation, no alpha
   * premultiplication, exact codec output.
   *
   * PNG:  handed to PNGDecode (js/png-decode.js), which is byte-exact vs cv2 for
   *       all 8-bit PNGs. We sniff the 8-byte signature rather than trusting MIME.
   * JPEG/WebP/other: browser decode via createImageBitmap, with EXIF
   *       orientation, alpha premultiplication and colour-space conversion all
   *       disabled so pixels are not corrupted.
   *
   *       The createImageBitmap `imageOrientation:"none"` option is NOT honoured
   *       by every engine (verified: Chromium 148 applies EXIF orientation
   *       regardless of the option). So for JPEG we additionally neutralise the
   *       EXIF Orientation tag in the raw bytes (set it to 1) before decoding —
   *       an engine-independent guarantee that matches cv2.imdecode, which never
   *       applies orientation. JPEG has no alpha, so the premultiply round-trip
   *       through the canvas is a no-op. WebP with semi-transparent alpha can
   *       still lose ~1 LSB of RGB precision on the canvas round-trip
   *       (see tests/parity/decode/README.md).
   */
  async function decodeToRGBA(file) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);

    if (typeof PNGDecode !== "undefined" && PNGDecode.isPNG(bytes)) {
      const png = await PNGDecode.decode(bytes);
      const data = new ImageData(png.rgba, png.width, png.height);
      return { data, width: png.width, height: png.height };
    }

    // Rewrite a JPEG's EXIF Orientation tag to 1 so no engine rotates it.
    function neutralizeJpegOrientation(src) {
      if (src.length < 4 || src[0] !== 0xff || src[1] !== 0xd8) return null; // not JPEG
      const b = src.slice();
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      let p = 2;
      while (p + 4 <= b.length) {
        if (b[p] !== 0xff) break;
        const marker = b[p + 1];
        if (marker === 0xd9 || marker === 0xda) break; // EOI / start of scan
        const len = dv.getUint16(p + 2);
        const segStart = p + 4;
        const segEnd = p + 2 + len;
        if (marker === 0xe1 && segEnd <= b.length &&
            b[segStart] === 0x45 && b[segStart + 1] === 0x78 && b[segStart + 2] === 0x69 &&
            b[segStart + 3] === 0x66 && b[segStart + 4] === 0 && b[segStart + 5] === 0) {
          const tiff = segStart + 6;
          const le = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
          const rd16 = (o) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
          const rd32 = (o) => (le
            ? b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] * 16777216)
            : (b[o] * 16777216) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
          const wr16 = (o, v) => {
            if (le) { b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff; }
            else { b[o] = (v >> 8) & 0xff; b[o + 1] = v & 0xff; }
          };
          const ifd0 = tiff + rd32(tiff + 4);
          const n = rd16(ifd0);
          for (let i = 0; i < n && ifd0 + 2 + i * 12 + 12 <= b.length; i++) {
            const e = ifd0 + 2 + i * 12;
            if (rd16(e) === 0x0112) wr16(e + 8, 1); // Orientation SHORT -> 1
          }
          return b;
        }
        p = segEnd;
      }
      return b; // JPEG with no EXIF: nothing to change, decode as-is
    }

    let source = file;
    const fixed = neutralizeJpegOrientation(bytes);
    if (fixed) source = new Blob([fixed], { type: "image/jpeg" });

    let bitmap;
    try {
      bitmap = await createImageBitmap(source, {
        imageOrientation: "none",
        premultiplyAlpha: "none",
        colorSpaceConversion: "none",
      });
    } catch (_e) {
      // Older engines that reject the options bag: fall back to plain decode.
      bitmap = await createImageBitmap(source);
    }
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();
    return { data, width: canvas.width, height: canvas.height };
  }

  function runningCount() {
    return jobs.filter((job) => job.status === "processing").length;
  }

  function pumpQueue() {
    while (runningCount() < MAX_CONCURRENT) {
      const primevalRunning=jobs.some(job=>job.status==="processing"&&job.config.fit_method==="primeval");
      const next = jobs.find((job) => job.status === "queued" && !(primevalRunning&&job.config.fit_method==="primeval"));
      if (!next) break;
      startJob(next);
    }
    renderJobs();
  }

  /* Worker pool: reuse workers across jobs (spawn + script parse costs paid
   * once per pool slot; module-level constant caches inside the workers stay
   * warm). Workers are stateless per message, so per-job output is
   * unaffected. A cancelled job's worker is terminated, not pooled. */
  const workerPool = new Map(); // workerFile -> Worker[]

  function acquireWorker(workerFile) {
    const pool = workerPool.get(workerFile);
    if (pool && pool.length) return pool.pop();
    return new Worker(workerFile);
  }

  function releaseWorker(workerFile, worker) {
    worker.onmessage = null;
    worker.onerror = null;
    // Release the model's WASM heap after each neural job.

    let pool = workerPool.get(workerFile);
    if (!pool) { pool = []; workerPool.set(workerFile, pool); }
    pool.push(worker);
  }

  async function startJob(job) {
    job.status = "processing";
    renderJobs();
    let decoded;
    try {
      decoded = await decodeToRGBA(job.file);
    } catch (error) {
      job.status = "error";
      job.error = t("error.decode");
      pumpQueue();
      return;
    }
    if (job.status !== "processing") return; // cancelled during decode

    const workerFile = job.config.mode === "outline" ? "js/worker-outline.js" :
      job.config.fit_method === "primeval" ? "js/worker-primeval.js?v=4" :
      job.config.fit_method === "compression" ? "js/worker-compress.js?v=3" :
      (job.config.allowed_shapes || []).includes("blurred_circle") ?
        "js/worker-gaussian.js?v=34" : "js/worker-fill.js?v=2";
    const worker = acquireWorker(workerFile);
    job.worker = worker;

    worker.onmessage = (event) => {
      const msg = event.data;
      if (msg.jobId !== job.id) return;
      if (msg.type === "progress") {
        job.progress = msg.step;
        job.progressTotal = msg.total;
        const phase=msg.phase || "";
        if(job.phase!==phase){job.phase=phase;renderJobs();}
        scheduleProgressFlush();
      } else if (msg.type === "done") {
        job.result = msg.result;
        if(msg.result.primeval_png){job.primevalOriginalElements=JSON.stringify(msg.result.elements);job.primevalEdited=false;}
        job.status = "done";
        job.progress = job.progressTotal;
        releaseWorker(workerFile, worker);
        job.worker = null;
        pumpQueue();
      } else if (msg.type === "error") {
        job.status = "error";
        job.error = msg.message==="COMPRESSION_EXACT_BUDGET" ? t("compression.exactBudget") : msg.message;
        worker.terminate(); // unknown worker state — do not pool
        job.worker = null;
        pumpQueue();
      }
    };
    worker.onerror = (event) => {
      job.status = "error";
      job.error = event.message || t("error.workerFailed");
      worker.terminate();
      job.worker = null;
      pumpQueue();
    };

    const buffer = decoded.data.data.buffer;
    worker.postMessage({
      cmd: "process",
      jobId: job.id,
      rgba: buffer,
      width: decoded.width,
      height: decoded.height,
      config: job.config,
    }, [buffer]);
  }

  function cancelJob(job) {
    if (job.status === "queued") {
      job.status = "cancelled";
    } else if (job.status === "processing") {
      if (job.worker) { job.worker.terminate(); job.worker = null; }
      job.status = "cancelled";
    }
    pumpQueue();
  }

  $("btnSubmit").addEventListener("click", () => {
    if (!pendingFiles.length) {
      alert(t("submit.noFiles"));
      return;
    }
    if(currentMode==="fill"&&!validControlCount(numPrimsManual))return;
    if(currentMode==="fill"&&$("fitMethod").value==="primeval"&&!$("primevalResolution").reportValidity())return;
    for (const entry of pendingFiles) {
      jobs.push(createJob(entry.file, entry.url, captureConfig(entry.file)));
    }
    pendingFiles = [];
    updateUploadReady();
    pumpQueue();
  });

  $("btnCancelAll").addEventListener("click", () => {
    if (!confirm(t("confirm.cancelAll"))) return;
    jobs.forEach((job) => {
      if (job.status === "queued" || job.status === "processing") cancelJob(job);
    });
    renderJobs();
  });

  $("btnClearDone").addEventListener("click", () => {
    for (let i = jobs.length - 1; i >= 0; i--) {
      if (["done", "error", "cancelled"].includes(jobs[i].status)) jobs.splice(i, 1);
    }
    renderJobs();
  });

  /* ════════════════════ job list rendering ════════════════════ */

  function statusLabel(status) { return t("batch.status." + status); }

  /* Progress DOM updates: cached element refs (renderJobs fills the map)
   * and one rAF-batched flush per frame regardless of how many worker
   * messages arrive — no per-message querySelector/layout work. */
  const progressFillEls = new Map(); // jobId -> element
  let progressFlushQueued = false;

  function flushProgress() {
    progressFlushQueued = false;
    for (const job of jobs) {
      if (job.status !== "processing") continue;
      const fill = progressFillEls.get(job.id);
      if (fill) {
        const pct = job.progressTotal ? Math.round(100 * job.progress / job.progressTotal) : 0;
        fill.style.width = pct + "%";
      }
    }
    renderOverall();
  }

  function scheduleProgressFlush() {
    if (progressFlushQueued) return;
    progressFlushQueued = true;
    if (document.hidden) { flushProgress(); return; }
    requestAnimationFrame(flushProgress);
  }

  function renderOverall() {
    const active = jobs.filter((job) => job.status !== "cancelled");
    const doneCount = jobs.filter((job) => job.status === "done").length;
    const hasWork = jobs.some((job) => job.status === "queued" || job.status === "processing");
    $("overallProgress").hidden = !jobs.length;
    $("btnCancelAll").hidden = !hasWork;
    $("btnClearDone").hidden = !jobs.some((job) => ["done", "error", "cancelled"].includes(job.status));
    const hasFinished=jobs.some(job=>job.status==="done"&&job.result);
    $("btnDownloadAll").hidden = !hasFinished;
    $("batchLuaTemplateField").hidden = !hasFinished;
    $("batchLuaBudgetNote").hidden = !jobs.some(job=>job.status==="done"&&job.result&&!compressionLuaFits(job.result));
    if (!jobs.length) return;
    let totalProgress = 0;
    let denom = 0;
    for (const job of active) {
      denom++;
      if (job.status === "done") totalProgress += 1;
      else if (job.status === "processing" && job.progressTotal) totalProgress += job.progress / job.progressTotal;
    }
    const pct = denom ? Math.round(100 * totalProgress / denom) : 0;
    $("overallFill").style.width = pct + "%";
    $("overallLabel").textContent = t("batch.jobCount", { done: doneCount, total: active.length || jobs.length });
  }

  function renderJobs() {
    const list = $("jobList");
    $("batchEmpty").hidden = jobs.length > 0;
    list.innerHTML = "";
    progressFillEls.clear();
    for (const job of jobs) {
      const card = document.createElement("div");
      card.className = "job-card";

      const thumb = document.createElement("img");
      thumb.className = "job-thumb";
      thumb.src = job.thumbUrl;
      thumb.alt = "";
      card.appendChild(thumb);

      const body = document.createElement("div");
      body.className = "job-body";

      const name = document.createElement("div");
      name.className = "job-name";
      name.textContent = job.name;
      name.title = job.name;
      body.appendChild(name);

      const statusRow = document.createElement("div");
      statusRow.className = "job-status-row";
      const status = document.createElement("span");
      status.className = "job-status " + job.status;
      status.classList.toggle("quality-failed",job.result?.config?.quality?.classification === "quality-regression");
      status.textContent = job.status === "done" && job.result?.config?.quality?.classification === "quality-regression" ? t("compression.failed") :
        job.status === "processing" && ["native","lossless","partition","fit","refine"].includes(job.phase) ? t("compression.phase."+job.phase) :
        job.status==="processing"&&job.phase==="model" ? t("batch.phase.model") : statusLabel(job.status);
      statusRow.appendChild(status);
      if (job.status === "done" && job.result) {
        const info = document.createElement("span");
        info.textContent = t("batch.elements", { n: job.result.elements_count }) +
          " · " + t("batch.elapsed", { s: job.result.elapsed_seconds });
        statusRow.appendChild(info);
      }
      body.appendChild(statusRow);

      if (job.status === "processing" || job.status === "queued") {
        const progress = document.createElement("div");
        progress.className = "job-progress";
        const track = document.createElement("div");
        track.className = "progress-track";
        const fill = document.createElement("div");
        fill.className = "progress-fill";
        fill.dataset.jobProgress = job.id;
        progressFillEls.set(job.id, fill);
        const pct = job.progressTotal ? Math.round(100 * job.progress / job.progressTotal) : 0;
        fill.style.width = pct + "%";
        track.appendChild(fill);
        progress.appendChild(track);
        body.appendChild(progress);
      }

      if (job.status === "error" && job.error) {
        const err = document.createElement("div");
        err.className = "job-error";
        err.textContent = job.error;
        body.appendChild(err);
      }

      const actions = document.createElement("div");
      actions.className = "job-actions";
      if (job.status === "done") {
        const view = document.createElement("button");
        view.className = "btn-text";
        view.textContent = t("batch.viewResult");
        view.addEventListener("click", () => showResult(job));
        actions.appendChild(view);
      }
      if (job.status === "queued" || job.status === "processing") {
        const cancel = document.createElement("button");
        cancel.className = "btn-text danger";
        cancel.textContent = t("batch.cancel");
        cancel.addEventListener("click", () => { cancelJob(job); renderJobs(); });
        actions.appendChild(cancel);
      }
      if (["done", "error", "cancelled"].includes(job.status)) {
        const remove = document.createElement("button");
        remove.className = "btn-text";
        remove.textContent = t("batch.remove");
        remove.addEventListener("click", () => {
          const index = jobs.indexOf(job);
          if (index >= 0) jobs.splice(index, 1);
          renderJobs();
        });
        actions.appendChild(remove);
      }
      body.appendChild(actions);
      card.appendChild(body);
      list.appendChild(card);
    }
    renderOverall();
  }

  /* ════════════════════ pixel-buffer → canvas helpers ════════════════════ */

  function rgbaToCanvas(buffer, width, height) {
    if (!buffer) return null;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const imageData = new ImageData(new Uint8ClampedArray(buffer), width, height);
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  function grayToCanvas(buffer, width, height) {
    if (!buffer) return null;
    const gray = new Uint8Array(buffer);
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const v = gray[i];
      rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255;
    }
    return rgbaToCanvas(rgba.buffer, width, height);
  }

  function ensureJobAssets(job) {
    if (job.assets) return job.assets;
    const { width, height } = job.result.image_size;
    job.assets = {
      base: rgbaToCanvas(job.result.image_rgba, width, height),
      mask: grayToCanvas(job.result.mask_gray, width, height),
      preview: job.result.preview_rgba ? rgbaToCanvas(job.result.preview_rgba, width, height) : null,
      native: job.result.native_rgba ? rgbaToCanvas(job.result.native_rgba, width, height) : null,
      difference: job.result.difference_rgba ? rgbaToCanvas(job.result.difference_rgba, width, height) : null,
    };
    return job.assets;
  }

  /* ════════════════════ result view (port of web/app.js) ════════════════════ */

  const canvas = $("mainCanvas");
  const screenCtx = canvas.getContext("2d");
  let ctx = screenCtx; // drawing target: swapped temporarily for PNG export
  let R = null; // active render context {job, data, ppu, origin, scale, hovered, selected, outputHasTransparency}

  /* ── zoom/pan view state ──
   * Each job keeps its own view {zoom, panX, panY} so switching between
   * results preserves the inspection state until Reset view. Transform in
   * CSS pixels: total scale s = fit * zoom; image is centered plus pan. */
  const MIN_ZOOM = 0.2, MAX_ZOOM = 40;

  function currentView() {
    if (!R.job.view) R.job.view = { zoom: 1, panX: 0, panY: 0 };
    return R.job.view;
  }

  function computeFit() {
    const wrap = $("canvasWrap");
    const data = R.data;
    const fit = Math.min(
      1,
      (wrap.clientWidth - 32) / data.image_size.width,
      (wrap.clientHeight - 32) / data.image_size.height
    );
    return Number.isFinite(fit) && fit > 0 ? fit : 1;
  }

  function viewTransform() {
    const wrap = $("canvasWrap");
    const view = currentView();
    const fit = computeFit();
    const s = fit * view.zoom;
    return {
      s,
      fit,
      offX: (wrap.clientWidth - R.data.image_size.width * s) / 2 + view.panX,
      offY: (wrap.clientHeight - R.data.image_size.height * s) / 2 + view.panY,
    };
  }

  function zoomAt(cssX, cssY, factor) {
    const view = currentView();
    const before = viewTransform();
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * factor));
    if (newZoom === view.zoom) return;
    // keep the image point under the cursor fixed
    const imgX = (cssX - before.offX) / before.s;
    const imgY = (cssY - before.offY) / before.s;
    view.zoom = newZoom;
    const after = viewTransform(); // pan unchanged; recompute centering
    view.panX += cssX - (after.offX + imgX * after.s);
    view.panY += cssY - (after.offY + imgY * after.s);
    scheduleRender();
  }

  function resetView() {
    if (!R) return;
    R.job.view = { zoom: 1, panX: 0, panY: 0 };
    scheduleRender();
  }

  let renderQueued = false;
  function scheduleRender() {
    if (document.hidden) { renderCanvas(); return; } // rAF is suspended in background tabs
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderCanvas();
    });
  }

  /* screen-space checkerboard pattern (drawn under the image bounds so
   * transparency reads correctly at any zoom without scaling the checkers) */
  let checkerPattern = null;
  function getCheckerPattern() {
    if (checkerPattern) return checkerPattern;
    const pc = document.createElement("canvas");
    pc.width = 20; pc.height = 20;
    const pctx = pc.getContext("2d");
    pctx.fillStyle = "#ffffff";
    pctx.fillRect(0, 0, 20, 20);
    pctx.fillStyle = "#e8e8ee";
    pctx.fillRect(0, 0, 10, 10);
    pctx.fillRect(10, 10, 10, 10);
    checkerPattern = screenCtx.createPattern(pc, "repeat");
    return checkerPattern;
  }

  function normalizeType(type) {
    if (type === "circle") return "ellipse";
    if (type === "rect") return "rectangle";
    return type;
  }

  function shapeDisplayName(type) {
    const normalized = normalizeType(type);
    if (normalized === "ellipse") return t("result.shape.ellipse");
    if (normalized === "rectangle") return t("result.shape.rectangle");
    if (normalized === "triangle") return t("result.shape.triangle");
    return normalized || t("result.shape.unknown");
  }

  function isBackgroundElement(element) { return Boolean(element && element.is_background); }

  function visibleElements(data) {
    return data.elements.filter((el) => !isBackgroundElement(el));
  }

  function renderOrderedElements(data) {
    const background = [], foreground = [];
    data.elements.forEach((el) => (isBackgroundElement(el) ? background : foreground).push(el));
    return background.concat(foreground);
  }

  function displayElementIndex(data, index) {
    let displayIndex = -1;
    for (let i = 0; i <= index; i++) {
      if (!isBackgroundElement(data.elements[i])) displayIndex++;
    }
    return Math.max(displayIndex, 0);
  }

  function cssColor(color, alphaOverride) {
    if (typeof color === "string") {
      const value = color.trim();
      if (/^#([a-f0-9]{3}|[a-f0-9]{6})$/i.test(value)) {
        let hex = value.slice(1);
        if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        return `rgba(${r},${g},${b},${alphaOverride})`;
      }
      return value;
    }
    if (Array.isArray(color)) {
      const alpha = color.length >= 4 ? color[3] / 255 : alphaOverride;
      return `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;
    }
    return `rgba(255, 204, 0, ${alphaOverride})`;
  }

  function cssSolidColor(color) {
    if (Array.isArray(color)) return `rgb(${color[0]},${color[1]},${color[2]})`;
    if (typeof color === "string") return color.trim() || "#ffcc00";
    return "#ffcc00";
  }

  function imagePointToElementCenter(element) {
    return { x: element.center.x * R.ppu, y: -element.center.y * R.ppu };
  }

  function elementRotationRad(element) {
    const rot = element.rotation && typeof element.rotation === "object" ? Number(element.rotation.z || 0) : Number(element.rotation || 0);
    return -rot * Math.PI / 180;
  }

  function elementRotationZ(element) {
    return element.rotation && typeof element.rotation === "object" ? Number(element.rotation.z || 0) : Number(element.rotation || 0);
  }

  function drawElementPath(element) {
    const type = normalizeType(element.type);
    if (type === "ellipse") {
      const rx = (element.size.rx || (element.size.width || 0) / 2) * R.ppu;
      const ry = (element.size.ry || (element.size.height || 0) / 2) * R.ppu;
      ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      return;
    }
    if (type === "triangle") {
      const width = (element.size.width || 0) * R.ppu;
      const triHeight = (element.size.height || 0) * R.ppu || (width * Math.sqrt(3) / 2);
      const shift=element.triangle_pivot==="box"?triHeight/6:0;
      ctx.moveTo(0, -2 * triHeight / 3+shift);
      ctx.lineTo(-width / 2, triHeight / 3+shift);
      ctx.lineTo(width / 2, triHeight / 3+shift);
      ctx.closePath();
      return;
    }
    const width = (element.size.width || 0) * R.ppu;
    const height = (element.size.height || 0) * R.ppu;
    ctx.rect(-width / 2, -height / 2, width, height);
  }

  function drawElement(element, index, reference=false) {
    const center = imagePointToElementCenter(element);
    const selected = !isBackgroundElement(element) && (R.selectedSet.has(index) || index === R.selected);
    const highlighted = !isBackgroundElement(element) && !selected && index === R.hovered;
    const rawAlpha = Number(element.alpha);
    const fillAlpha = Number.isFinite(rawAlpha) ? Math.max(0, rawAlpha) : 0.5;

    ctx.save();
    ctx.translate(center.x, center.y);
    ctx.rotate(elementRotationRad(element));
    ctx.beginPath();
    drawElementPath(element);

    if ($("showFill").checked && (!reference || selected || highlighted)) {
      if (selected) ctx.fillStyle = "rgba(37, 99, 235, 0.42)";
      else if (highlighted) ctx.fillStyle = "rgba(59, 130, 246, 0.28)";
      else ctx.fillStyle = cssColor(element.color, fillAlpha);
      if (Gaussian.isGaussian(element) && !selected && !highlighted) Gaussian.draw(ctx, element, R.ppu);
      else ctx.fill();
    }
    if ($("showBorder").checked) {
      if (selected) { ctx.strokeStyle = "#1d4ed8"; ctx.lineWidth = 2 / R.scale; }
      else if (highlighted) { ctx.strokeStyle = "#3b82f6"; ctx.lineWidth = 1.5 / R.scale; }
      else { ctx.strokeStyle = cssColor(element.color, 0.95); ctx.lineWidth = 1 / R.scale; }
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawOriginCross() {
    if (!$("showOrigin").checked) return;
    const arm = 12 / R.scale;
    ctx.save();
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 1.5 / R.scale;
    ctx.beginPath();
    ctx.moveTo(R.origin.x - arm, R.origin.y);
    ctx.lineTo(R.origin.x + arm, R.origin.y);
    ctx.moveTo(R.origin.x, R.origin.y - arm);
    ctx.lineTo(R.origin.x, R.origin.y + arm);
    ctx.stroke();
    ctx.fillStyle = "#ef4444";
    ctx.font = `${11 / R.scale}px sans-serif`;
    ctx.fillText(t("result.canvas.originLabel"), R.origin.x + arm + 3, R.origin.y - 3);
    ctx.restore();
  }

  /* Draws the scene (image, mask, elements, origin) into `targetCtx` with
   * total scale `sTotal` (image px → target px) and offsets in target px.
   * Elements are vectors, so they stay crisp at any zoom. Used by both the
   * interactive viewport and the PNG export. */
  function drawScene(targetCtx, sTotal, offX, offY) {
    const data = R.data;
    const imageWidth = data.image_size.width;
    const imageHeight = data.image_size.height;
    const prevCtx = ctx;
    const prevScale = R.scale;
    ctx = targetCtx;
    R.scale = sTotal; // stroke widths in the draw helpers divide by this

    ctx.setTransform(sTotal, 0, 0, sTotal, offX, offY);
    // "Crop to image": preview-only clip — the exported PNG canvas is
    // image-sized either way, so exports are unaffected by the toggle.
    const cropEl = $("cropToImage");
    const crop = cropEl ? cropEl.checked : true;
    if (crop) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, imageWidth, imageHeight);
      ctx.clip();
    }
    if (!R.outputHasTransparency) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, imageWidth, imageHeight);
    }

    const assets = ensureJobAssets(R.job);
    if ($("showImage").checked && assets.base) ctx.drawImage(assets.base, 0, 0, imageWidth, imageHeight);
    if ($("showMask").checked && assets.mask) {
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.drawImage(assets.mask, 0, 0, imageWidth, imageHeight);
      ctx.restore();
    }

    // Client mask preview: the Client .gia clips every child to the
    // masking container's rect, so clip the same way here. Element draw
    // order already matches the Client hierarchy (renderOrderedElements is
    // painter order, and an earlier Client sibling renders first), so with
    // this clip the preview composites exactly like the exported file.
    const clientMaskEl = $("showClientMask");
    const clientMask = clientMaskEl && clientMaskEl.checked ? currentClientMaskRect() : null;
    if (clientMask) {
      ctx.save();
      ctx.beginPath();
      if (clientMask.shapeType === 2) {
        ctx.ellipse(clientMask.cx, clientMask.cy, clientMask.width / 2, clientMask.height / 2, 0, 0, Math.PI * 2);
      } else {
        ctx.rect(
          clientMask.cx - clientMask.width / 2,
          clientMask.cy - clientMask.height / 2,
          clientMask.width,
          clientMask.height
        );
      }
      ctx.clip();
    }
    const reference=primevalCurrent() && $("showFill").checked;
    if(reference&&assets.preview)ctx.drawImage(assets.preview,0,0,imageWidth,imageHeight);
    const elementIndices = new Map();
    data.elements.forEach((element,index)=>{if(!elementIndices.has(element))elementIndices.set(element,index);});
    renderOrderedElements(data).forEach((element) => {
      drawElement(element, elementIndices.get(element),reference);
    });
    if (clientMask) {
      ctx.restore();
      // Outline the mask so its position and dimensions are verifiable.
      ctx.save();
      ctx.strokeStyle = "#00b0a0";
      ctx.setLineDash([6 / sTotal, 4 / sTotal]);
      ctx.lineWidth = 1.5 / sTotal;
      ctx.beginPath();
      if (clientMask.shapeType === 2) {
        ctx.ellipse(clientMask.cx, clientMask.cy, clientMask.width / 2, clientMask.height / 2, 0, 0, Math.PI * 2);
      } else {
        ctx.rect(
          clientMask.cx - clientMask.width / 2,
          clientMask.cy - clientMask.height / 2,
          clientMask.width,
          clientMask.height
        );
      }
      ctx.stroke();
      ctx.restore();
    }
    if (crop) ctx.restore(); // origin cross stays visible outside the crop
    drawOriginCross();
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    ctx = prevCtx;
    R.scale = prevScale;
  }

  function renderCanvas() {
    if (!R) return;
    const wrap = $("canvasWrap");
    const dpr = window.devicePixelRatio || 1;
    const cssW = wrap.clientWidth;
    const cssH = wrap.clientHeight;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";

    const { s, offX, offY } = viewTransform();
    R.scale = s; // hit-testing / tooltip stroke logic reads this

    screenCtx.setTransform(1, 0, 0, 1, 0, 0);
    screenCtx.clearRect(0, 0, canvas.width, canvas.height);

    // screen-fixed checkerboard under the image bounds (transparency backdrop)
    const data = R.data;
    screenCtx.save();
    screenCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    screenCtx.fillStyle = R.outputHasTransparency ? getCheckerPattern() : "#ffffff";
    screenCtx.fillRect(offX, offY, data.image_size.width * s, data.image_size.height * s);
    screenCtx.restore();

    drawScene(screenCtx, s * dpr, offX * dpr, offY * dpr);

    const view = currentView();
    if ($("zoomLabel")) $("zoomLabel").textContent = Math.round(view.zoom * 100) + "%";
  }

  function canvasToImagePoint(event) {
    const rect = canvas.getBoundingClientRect();
    const { s, offX, offY } = viewTransform();
    return {
      x: (event.clientX - rect.left - offX) / s,
      y: (event.clientY - rect.top - offY) / s,
    };
  }

  function pointInElement(element, x, y) {
    const type = normalizeType(element.type);
    const center = imagePointToElementCenter(element);
    const angle = -elementRotationRad(element);
    const dx0 = x - center.x;
    const dy0 = y - center.y;
    const dx = dx0 * Math.cos(angle) - dy0 * Math.sin(angle);
    const dy = dx0 * Math.sin(angle) + dy0 * Math.cos(angle);

    if (type === "ellipse") {
      const rx = (element.size.rx || (element.size.width || 0) / 2) * R.ppu;
      const ry = (element.size.ry || (element.size.height || 0) / 2) * R.ppu;
      if (rx <= 0 || ry <= 0) return false;
      return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;
    }
    if (type === "triangle") {
      const width = (element.size.width || 0) * R.ppu;
      const triHeight = (element.size.height || 0) * R.ppu || (width * Math.sqrt(3) / 2);
      const vertices = [
        { x: 0, y: element.triangle_pivot==="box"?-triHeight/2:-2*triHeight/3 },
        { x: -width / 2, y: element.triangle_pivot==="box"?triHeight/2:triHeight/3 },
        { x: width / 2, y: element.triangle_pivot==="box"?triHeight/2:triHeight/3 },
      ];
      const crosses = [];
      for (let i = 0; i < 3; i++) {
        const a = vertices[i], b = vertices[(i + 1) % 3];
        crosses.push((dx - a.x) * (b.y - a.y) - (dy - a.y) * (b.x - a.x));
      }
      return crosses.every((v) => v >= 0) || crosses.every((v) => v <= 0);
    }
    const width = (element.size.width || 0) * R.ppu;
    const height = (element.size.height || 0) * R.ppu;
    return Math.abs(dx) <= width / 2 && Math.abs(dy) <= height / 2;
  }

  function hitTest(x, y) {
    const data = R.data;
    for (let i = data.elements.length - 1; i >= 0; i--) {
      if (isBackgroundElement(data.elements[i])) continue;
      if (pointInElement(data.elements[i], x, y)) return i;
    }
    return null;
  }

  function relativePosition(element) {
    return {
      x: element.center.x - R.origin.x / R.ppu,
      y: element.center.y + R.origin.y / R.ppu,
    };
  }

  function clearDetail() {
    $("infoEmpty").hidden = false;
    $("infoPanel").hidden = true;
  }

  function elementSizeText(element) {
    const type = normalizeType(element.type);
    if (type === "ellipse") {
      return `rx=${Number(element.size.rx || 0).toFixed(2)} ry=${Number(element.size.ry || 0).toFixed(2)}`;
    }
    if (type === "triangle") {
      return `base=${Number(element.size.width || 0).toFixed(2)} height=${Number(element.size.height || 0).toFixed(2)}`;
    }
    return `${Number(element.size.width || 0).toFixed(2)} × ${Number(element.size.height || 0).toFixed(2)}`;
  }

  function showDetail(element, index) {
    $("infoEmpty").hidden = true;
    $("infoPanel").hidden = false;
    const relative = relativePosition(element);
    $("infoId").textContent = element.id != null ? element.id : displayElementIndex(R.data, index);
    $("infoType").textContent = Gaussian.isGaussian(element) ? t("shapes.blurredCircle") : shapeDisplayName(element.type);
    $("infoCenter").textContent = `(${element.center.x.toFixed(2)}, ${element.center.y.toFixed(2)})`;
    $("infoRelative").textContent = `(${relative.x.toFixed(2)}, ${relative.y.toFixed(2)})`;
    $("infoSize").textContent = elementSizeText(element);
    $("infoRotation").textContent = `${elementRotationZ(element).toFixed(1)}°`;
  }

  function compressionCurrent(data = R?.data, job = R?.job) {
    return !data?.config?.quality || JSON.stringify(data.elements) === JSON.stringify(job.result.elements);
  }
  function primevalCurrent(){
    return Boolean(R?.job?.result?.primeval_png&&R.data.config?.primeval_reference&&!R.job.primevalEdited);
  }
  function compressionPassed(data = R?.data, job = R?.job) {
    return !data?.config?.quality || (data.config.quality.classification !== "quality-regression" && compressionCurrent(data, job));
  }
  function compressionLuaFits(data = R?.data) {
    return !data?.config?.quality || data.elements.length + 2 <= data.config.num_primitives;
  }
  function updateCompressionReport() {
    const quality = R.data.config?.quality;
    $("compressionReport").hidden = !quality;
    const passed = compressionPassed();
    const current = compressionCurrent();
    $("topbarStatus").classList.toggle("quality-failed",!!quality&&!passed);
    if(quality) {
      $("compressionReport").dataset.valid = String(passed);
      $("compressionStatus").textContent = t(!current ? "compression.edited" : quality.classification === "pixel-perfect" ? "compression.perfect" : passed ? "compression.near" : "compression.failed");
      const cfg=R.data.config;
      $("compressionCounts").textContent=t("compression.counts",{native:cfg.native_controls+1,count:R.data.elements.length+1,budget:cfg.num_primitives});
      $("compressionMetrics").replaceChildren();
      const names={mae:"MAE",max_error:t("compression.maxError").replace(" ≤",""),ssim:"SSIM",differing_percent:t("compression.changed"),edge_mae:t("compression.edgeError").replace(" ≤",""),alpha_max:t("compression.alphaError").replace(" ≤",""),local_mae:t("compression.localError").replace(" ≤","")};
      for(const [key,label] of Object.entries(names)) {
        const tr=document.createElement("tr"),name=document.createElement("td"),value=document.createElement("td");
        name.textContent=label;value.textContent=Number(quality.metrics[key]).toFixed(key==="ssim"?4:2)+(key==="differing_percent"?"%":"");
        tr.append(name,value);$("compressionMetrics").appendChild(tr);
      }
      if(!passed)$("topbarStatus").textContent=$("compressionStatus").textContent;
    }
    for(const id of ["btnExportGIAOverlimit","btnExportGIAClassic","btnExportServerGIAOverlimit","btnExportServerGIAClassic","btnExportClientGIAOverlimit","btnExportClientGIAClassic"])$(id).disabled=false;
    refreshTemplateIndexState();
  }
  $("btnCompressionReport").addEventListener("click",()=>{
    if(!R?.data.config?.quality)return;
    downloadBlob(new Blob([JSON.stringify({image:R.job.name,controls:R.data.elements.length,...R.data.config,validation_current:compressionCurrent()},null,2)],{type:"application/json"}),`${currentExportBaseName()}_quality.json`);
  });
  function updateStats() {
    const data = R.data;
    const elements = visibleElements(data);
    const gaussianCount = elements.filter(Gaussian.isGaussian).length;
    const ellipseCount = elements.filter((el) => normalizeType(el.type) === "ellipse" && !Gaussian.isGaussian(el)).length;
    const triangleCount = elements.filter((el) => normalizeType(el.type) === "triangle").length;
    const rectCount = elements.length - ellipseCount - triangleCount - gaussianCount;
    const mode = data.mode || "fill";
    const fillVariant = (data.config && data.config.fill_variant) || "mask";
    const modeText = mode === "fill"
      ? t(fillVariant === "png" ? "result.mode.fillPng" : "result.mode.fill")
      : t("result.mode.outline");

    $("statMode").textContent = data.config?.engine === "primeval-browser" ? "Primeval" : data.config?.engine === "compression-browser" ? t("compression.name") : gaussianCount ? "GaussianImage" : modeText;
    $("statTotal").textContent = String(elements.length);
    $("statEllipse").textContent = String(ellipseCount);
    $("statGaussian").textContent = String(gaussianCount);
    $("statRect").textContent = String(rectCount);
    $("statTriangle").textContent = String(triangleCount);
    $("statImgSize").textContent = `${data.image_size.width}×${data.image_size.height}`;
    $("elemCountDisplay").textContent = t("result.canvas.elements", { n: elements.length });
    $("topbarStatus").textContent = t("result.done", { count: data.elements_count, elapsed: data.elapsed_seconds });
    updateCompressionReport();

    const hasMask = Boolean(R.job.result.mask_gray);
    if (!hasMask) $("showMask").checked = false;
    $("showMask").disabled = !hasMask;
    $("showMask").parentElement.style.opacity = hasMask ? "1" : "0.45";

    const compare = $("previewCompare");
    compare.hidden = mode !== "fill";
    if (mode === "fill") {
      const assets = ensureJobAssets(R.job);
      if (assets.preview) $("previewImg").src = assets.preview.toDataURL("image/png");
      if (assets.base) $("originalThumb").src = assets.base.toDataURL("image/png");
      $("nativePreview").hidden = !assets.native;
      $("differencePreview").hidden = !assets.difference;
      if(assets.native)$("nativeThumb").src = assets.native.toDataURL("image/png");
      if(assets.difference)$("differenceThumb").src = assets.difference.toDataURL("image/png");
    }
  }

  function fillRetryInputs(job) {
    const cfg = job.config || {};
    const isFill = (cfg.mode || "fill") === "fill";
    $("retrySectionFill").hidden = !isFill;
    $("retrySectionOutline").hidden = isFill;
    if (isFill) {
      const allowed=cfg.allowed_shapes || ["triangle"];
      $("retryFitMethod").value=allowed.includes("blurred_circle")?"gaussian":cfg.fit_method==="primeval"||cfg.fit_method==="compression"?"primeval":"legacy";
      $("retryNumPrims").removeAttribute("max");$("retryNumPrims").min="1";
      $("retryNumPrims").value=cfg.num_primitives ?? 2000;
      $("retryImageScale").value=cfg.image_scale ?? 1;
      $("retryOutputAlpha").value=Math.round((cfg.output_alpha ?? 1)*100);
      for(const [id,shape] of shapePairs)$("retryShape"+id).checked=shape===(allowed.find(s=>["circle","rect","triangle"].includes(s)) || "triangle");
      $("retryPrimevalResolution").value=cfg.primeval_resolution || 512;
      $("retryGaussianAlgorithm").value=cfg.gaussian_algorithm || "gaussianimage";
      $("retryGaussianIterations").value=cfg.gaussian_iterations || 600;
      $("retryGaussianResolution").value=cfg.gaussian_resolution || 512;
      syncRetryShapeLabels();
    } else {
      $("retryPrimSize").value = cfg.primitive_size != null ? cfg.primitive_size : 30;
      $("retrySpacing").value = cfg.spacing != null ? cfg.spacing : 0.9;
      $("retryPrecision").value = cfg.precision != null ? cfg.precision : 0.3;
    }
  }

  function retryJob(job, overrides) {
    // Mirrors the Flask /retry route: same image, old config with overrides.
    const cfg = Object.assign({}, job.config, overrides);
    const newJob = createJob(job.file, job.thumbUrl, cfg);
    jobs.push(newJob);
    setView("upload");
    pumpQueue();
  }

  const retryShapeInputs = Array.from(document.querySelectorAll("#retryShapeChecks .shape-check input"));
  function syncRetryShapeLabels() {
    const method=$("retryFitMethod").value;
    $("retryShapeChecks").hidden=method==="gaussian";
    $("retryGaussianSettings").hidden=method!=="gaussian";
    $("retryPrimevalSettings").hidden=method!=="primeval";
    retryShapeInputs.forEach(input=>input.closest(".shape-check").classList.toggle("active",input.checked));
  }
  $("retryFitMethod").addEventListener("change",syncRetryShapeLabels);
  retryShapeInputs.forEach(input=>input.addEventListener("change",syncRetryShapeLabels));
  $("btnRetryFill").addEventListener("click",()=>{
    if(!R||!validControlCount($("retryNumPrims")))return;
    const method=$("retryFitMethod").value;
    if(method==="primeval"&&!$("retryPrimevalResolution").reportValidity())return;
    const shapes=method==="gaussian"?["blurred_circle"]:[selectedFitShape("retry")];
    retryJob(R.job,{
      fit_method:method,num_primitives:Number($("retryNumPrims").value),allowed_shapes:shapes,
      image_scale:Number($("retryImageScale").value)||1,
      output_alpha:Math.max(0,Math.min(100,Number($("retryOutputAlpha").value)))/100,
      primeval_resolution:Number($("retryPrimevalResolution").value)||512,primeval_seed:42,
      gaussian_algorithm:$("retryGaussianAlgorithm").value,
      gaussian_iterations:Math.max(1,Math.round(Number($("retryGaussianIterations").value)||600)),
      gaussian_resolution:Number($("retryGaussianResolution").value)||512,
      primitives:shapes.map(shape=>({shape,color:"#ffffff"})),
    });
  });
  $("btnRetryOutline").addEventListener("click", () => {
    if (!R) return;
    retryJob(R.job, {
      primitive_size: Number($("retryPrimSize").value) || 30,
      spacing: Number($("retrySpacing").value) || 0.9,
      precision: Number($("retryPrecision").value) || 0.3,
    });
  });

  function showResult(job, keepState) {
    shownJob = job;
    const data = job.result;
    const keepOrigin = keepState && R && R.job === job ? R.origin : null;
    R = {
      job,
      data,
      ppu: (data.config && data.config.pixel_per_unit) || (data.config && data.config.primitive_size) || 1,
      origin: keepOrigin || { x: data.image_center.x, y: data.image_center.y },
      scale: 1,
      hovered: null,
      selected: keepState && R && R.job === job ? R.selected : null,
      selectedSet: keepState && R && R.job === job ? R.selectedSet : new Set(),
      outputHasTransparency: Boolean(data.config && data.config.output_has_transparency),
    };
    if (!job.editUndo) { job.editUndo = []; job.editRedo = []; }
    $("exportFileName").value = job.baseName;
    $("originX").value = R.origin.x;
    $("originY").value = R.origin.y;
    fillRetryInputs(job);
    setView("result");
    updateStats();
    refreshSelectionUI();
    // cleanup only applies to transparent outputs (PNG mode)
    $("btnCleanTransparency").disabled = !R.outputHasTransparency;
    updateClientGiaNote();
    $("cleanupStatus").textContent = "";
    $("coordsDisplay").textContent = t("result.canvas.coords", { coords: "—" });
    renderCanvas(); // setView already forced layout; render synchronously so
                    // the canvas is correct even in background tabs

  }

  ["showImage", "showMask", "showFill", "showBorder", "showOrigin", "cropToImage", "showClientMask"].forEach((id) => {
    $(id).addEventListener("change", renderCanvas);
  });

  /* ── zoom / pan / pinch interactions ── */

  $("btnResetView").addEventListener("click", resetView);

  canvas.addEventListener("wheel", (event) => {
    if (!R) return;
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    // trackpad pinch arrives as ctrlKey+wheel with fine deltas
    const k = event.ctrlKey ? 0.012 : 0.0022;
    const factor = Math.exp(-event.deltaY * k);
    zoomAt(event.clientX - rect.left, event.clientY - rect.top, factor);
  }, { passive: false });

  const pointers = new Map(); // pointerId -> {x, y}
  let dragMoved = false;
  let dragAccum = 0;
  let pinchStart = null;      // {dist, zoom}

  canvas.addEventListener("pointerdown", (event) => {
    if (!R) return;
    if (event.button !== 0) return; // left button only; right-click stays free
    try { canvas.setPointerCapture(event.pointerId); } catch (e) { /* synthetic/expired pointer */ }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    dragMoved = false;
    dragAccum = 0;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: currentView().zoom };
      elementDrag = null; // a second finger means pinch, not element move
    }
    // grabbing an element starts a move gesture instead of a pan
    if (!originArmed && pointers.size === 1) {
      const point = canvasToImagePoint(event);
      const hit = hitTest(point.x, point.y);
      if (hit !== null) {
        if (!R.selectedSet.has(hit)) {
          if (event.ctrlKey || event.metaKey || event.shiftKey) R.selectedSet.add(hit);
          else { R.selectedSet.clear(); R.selectedSet.add(hit); }
          R.selected = hit;
          suppressSelectClick = true; // selection handled here — don't let the
                                      // trailing click event toggle it back
          refreshSelectionUI();
          renderCanvas();
        }
        const indices = [...R.selectedSet];
        elementDrag = {
          startX: point.x, startY: point.y, indices,
          origCenters: indices.map((i) => ({ x: R.data.elements[i].center.x, y: R.data.elements[i].center.y })),
          undoJson: JSON.stringify(R.data.elements),
          pushed: false,
        };
      }
    }
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!R || !pointers.has(event.pointerId)) return;
    const prev = pointers.get(event.pointerId);
    const dx = event.clientX - prev.x;
    const dy = event.clientY - prev.y;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.size === 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dist > 0 && pinchStart.dist > 0) {
        const rect = canvas.getBoundingClientRect();
        const midX = (a.x + b.x) / 2 - rect.left;
        const midY = (a.y + b.y) / 2 - rect.top;
        const target = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinchStart.zoom * (dist / pinchStart.dist)));
        zoomAt(midX, midY, target / currentView().zoom);
      }
      dragMoved = true;
      return;
    }

    if (elementDrag && pointers.size === 1) {
      const point = canvasToImagePoint(event);
      const dwx = (point.x - elementDrag.startX) / R.ppu;
      const dwy = -(point.y - elementDrag.startY) / R.ppu;
      if (dwx !== 0 || dwy !== 0) {
        if (!elementDrag.pushed) { pushUndoSnapshot(elementDrag.undoJson); elementDrag.pushed = true; }
        elementDrag.indices.forEach((idx, k) => {
          const el = R.data.elements[idx];
          el.center.x = elementDrag.origCenters[k].x + dwx;
          el.center.y = elementDrag.origCenters[k].y + dwy;
        });
        elementDragged = true;
        refreshSelectionUI();
        scheduleRender();
      }
      return;
    }

    if (pointers.size === 1 && (dx !== 0 || dy !== 0)) {
      const view = currentView();
      view.panX += dx;
      view.panY += dy;
      dragAccum += Math.abs(dx) + Math.abs(dy);
      if (dragAccum > 3) dragMoved = true; // small jitter still counts as a click
      canvas.classList.add("dragging");
      scheduleRender();
    }
  });

  function endPointer(event) {
    if (pointers.has(event.pointerId)) pointers.delete(event.pointerId);
    if (pointers.size < 2) pinchStart = null;
    if (pointers.size === 0) canvas.classList.remove("dragging");
    elementDrag = null; // elementDragged persists until the click event fires
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  canvas.addEventListener("mousemove", (event) => {
    if (!R) return;
    if (pointers.size > 0) return; // panning/pinching — skip hover work
    const point = canvasToImagePoint(event);
    const worldX = point.x / R.ppu;
    const worldY = -point.y / R.ppu;
    $("coordsDisplay").textContent = t("result.canvas.coords", { coords: `(${worldX.toFixed(2)}, ${worldY.toFixed(2)})` });

    const nextHovered = hitTest(point.x, point.y);
    if (nextHovered !== R.hovered) {
      R.hovered = nextHovered;
      renderCanvas();
    }

    const tooltip = $("tooltip");
    if (R.hovered !== null && R.hovered !== R.selected) {
      const element = R.data.elements[R.hovered];
      const relative = relativePosition(element);
      tooltip.hidden = false;
      tooltip.innerHTML = [
        `<b>#${displayElementIndex(R.data, R.hovered)}</b> ${shapeDisplayName(element.type)}`,
        `${t("result.info.center")}: (${element.center.x.toFixed(2)}, ${element.center.y.toFixed(2)})`,
        `${t("result.info.relative")}: (${relative.x.toFixed(2)}, ${relative.y.toFixed(2)})`,
        `${t("result.info.size")}: ${elementSizeText(element)}`,
        `${t("result.info.rotation")}: ${elementRotationZ(element).toFixed(1)}°`,
      ].join("<br>");
      const wrapRect = $("canvasWrap").getBoundingClientRect();
      tooltip.style.left = `${event.clientX - wrapRect.left + 14}px`;
      tooltip.style.top = `${event.clientY - wrapRect.top + 14}px`;
    } else {
      tooltip.hidden = true;
    }
  });

  canvas.addEventListener("mouseleave", () => {
    if (!R) return;
    R.hovered = null;
    $("tooltip").hidden = true;
    renderCanvas();
  });

  canvas.addEventListener("click", (event) => {
    if (!R) return;
    if (dragMoved) { dragMoved = false; return; } // pan gestures don't select
    if (elementDragged) { elementDragged = false; suppressSelectClick = false; return; } // element move, not a select
    if (suppressSelectClick) { suppressSelectClick = false; return; } // pointerdown already selected
    const point = canvasToImagePoint(event);
    // origin placement: armed "Pick on canvas" tool, or Alt+click shortcut
    // (right-click no longer changes the origin — it was too easy to hit)
    if (originArmed || event.altKey) {
      setOriginPoint(point);
      disarmOriginPick();
      return;
    }
    const hit = hitTest(point.x, point.y);
    const multi = event.ctrlKey || event.metaKey || event.shiftKey;
    if (multi && hit !== null) {
      if (R.selectedSet.has(hit)) {
        R.selectedSet.delete(hit);
        if (R.selected === hit) {
          R.selected = R.selectedSet.size ? [...R.selectedSet][R.selectedSet.size - 1] : null;
        }
      } else {
        R.selectedSet.add(hit);
        R.selected = hit;
      }
    } else {
      R.selectedSet.clear();
      if (hit !== null) R.selectedSet.add(hit);
      R.selected = hit;
    }
    R.hovered = null;
    renderCanvas();
    refreshSelectionUI();
  });

  $("originX").addEventListener("change", () => {
    if (!R) return;
    R.origin.x = Number($("originX").value || 0);
    if (R.selected !== null) showDetail(R.data.elements[R.selected], R.selected);
    renderCanvas();
  });
  $("originY").addEventListener("change", () => {
    if (!R) return;
    R.origin.y = Number($("originY").value || 0);
    if (R.selected !== null) showDetail(R.data.elements[R.selected], R.selected);
    renderCanvas();
  });
  $("btnResetOrigin").addEventListener("click", () => {
    if (!R) return;
    R.origin = { x: R.data.image_center.x, y: R.data.image_center.y };
    $("originX").value = R.origin.x;
    $("originY").value = R.origin.y;
    if (R.selected !== null) showDetail(R.data.elements[R.selected], R.selected);
    renderCanvas();
  });

  window.addEventListener("resize", () => { if (activeView === "result") renderCanvas(); });

  /* ════════════════════ result editor (edit mode) ════════════════════ */

  // editing is always available — no separate edit mode
  let originArmed = false;
  let elementDrag = null;         // active move gesture (see pointer handlers)
  let elementDragged = false;     // suppresses the click that ends a move
  let suppressSelectClick = false; // pointerdown already changed the selection

  function updateEditButtons() {
    const job = R && R.job;
    $("btnUndo").disabled = !(job && job.editUndo && job.editUndo.length);
    $("btnRedo").disabled = !(job && job.editRedo && job.editRedo.length);
    $("btnDeleteSel").disabled = !(R && R.selectedSet.size);
  }

  /* Undo/redo are per-job element-array snapshots (elements are small plain
   * objects; a 400-primitive job snapshots at ~100 KB, stack capped at 30). */
  function pushUndoSnapshot(json) {
    const job = R.job;
    if(job.result.primeval_png)job.primevalEdited=true;
    if (!job.editUndo) { job.editUndo = []; job.editRedo = []; }
    job.editUndo.push(json !== undefined ? json : JSON.stringify(R.data.elements));
    if (job.editUndo.length > 30) job.editUndo.shift();
    job.editRedo.length = 0;
    updateEditButtons();
  }

  function restoreElements(json) {
    if(R.job.result.primeval_png)R.job.primevalEdited=json!==R.job.primevalOriginalElements;
    R.data.elements = JSON.parse(json);
    R.data.elements_count = R.data.elements.length;
    R.selectedSet.clear();
    R.selected = null;
    R.hovered = null;
    refreshSelectionUI();
    updateStats();
    renderCanvas();
  }

  function doUndo() {
    const job = R && R.job;
    if (!job || !job.editUndo || !job.editUndo.length) return;
    job.editRedo.push(JSON.stringify(R.data.elements));
    restoreElements(job.editUndo.pop());
    updateEditButtons();
  }

  function doRedo() {
    const job = R && R.job;
    if (!job || !job.editRedo || !job.editRedo.length) return;
    job.editUndo.push(JSON.stringify(R.data.elements));
    restoreElements(job.editRedo.pop());
    updateEditButtons();
  }

  function deleteSelection() {
    if (!R || !R.selectedSet.size) return;
    pushUndoSnapshot();
    const doomed = [...R.selectedSet].sort((a, b) => b - a);
    for (const idx of doomed) R.data.elements.splice(idx, 1);
    R.data.elements_count = R.data.elements.length;
    R.selectedSet.clear();
    R.selected = null;
    R.hovered = null;
    refreshSelectionUI();
    updateStats();
    renderCanvas();
  }

  $("btnUndo").addEventListener("click", doUndo);
  $("btnRedo").addEventListener("click", doRedo);
  $("btnDeleteSel").addEventListener("click", deleteSelection);

  function refreshSelectionUI() {
    if (!R) return;
    if (R.selected !== null && R.data.elements[R.selected]) {
      showDetail(R.data.elements[R.selected], R.selected);
    } else {
      clearDetail();
    }
    syncEditPanel();
    updateEditButtons();
  }

  /* ── edit panel (properties of the primary selection) ── */

  let editPanelSyncing = false;

  function syncEditPanel() {
    const panel = $("editPanel");
    const el = R && R.selected !== null ? R.data.elements[R.selected] : null;
    const show = Boolean(el);
    panel.hidden = !show;
    if (!show) return;
    editPanelSyncing = true;
    const type = normalizeType(el.type);
    $("editX").value = Number(el.center.x).toFixed(2);
    $("editY").value = Number(el.center.y).toFixed(2);
    if (type === "ellipse") {
      $("editSizeALabel").textContent = "rx";
      $("editSizeBLabel").textContent = "ry";
      $("editSizeA").value = Number(el.size.rx || 0).toFixed(2);
      $("editSizeB").value = Number(el.size.ry || 0).toFixed(2);
    } else {
      $("editSizeALabel").textContent = t("result.edit.width");
      $("editSizeBLabel").textContent = t("result.edit.height");
      $("editSizeA").value = Number(el.size.width || 0).toFixed(2);
      $("editSizeB").value = Number(el.size.height || 0).toFixed(2);
    }
    $("editRot").value = elementRotationZ(el).toFixed(1);
    $("editColor").value = normalizeHexColor(el.color);
    const a = Number(el.alpha);
    $("editAlpha").value = Math.round((Number.isFinite(a) ? Math.min(Math.max(a, 0), 1) : 0.5) * 100);
    editPanelSyncing = false;
  }

  function normalizeHexColor(color) {
    if (Array.isArray(color)) {
      const h = (v) => Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, "0");
      return "#" + h(color[0]) + h(color[1]) + h(color[2]);
    }
    if (typeof color === "string" && /^#([a-f0-9]{3}|[a-f0-9]{6})$/i.test(color.trim())) {
      let hex = color.trim().slice(1);
      if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
      return "#" + hex.toLowerCase();
    }
    return "#ffcc00";
  }

  // engine parity: packColor rounds alpha*255 half-to-even (ARGB uint32)
  function roundHalfEven(x) {
    const f = Math.floor(x), d = x - f;
    if (d < 0.5) return f;
    if (d > 0.5) return f + 1;
    return f % 2 === 0 ? f : f + 1;
  }

  function packColorHex(hex, alpha) {
    let v = hex.replace("#", "");
    if (v.length === 3) v = v.split("").map((c) => c + c).join("");
    const r = parseInt(v.slice(0, 2), 16);
    const g = parseInt(v.slice(2, 4), 16);
    const b = parseInt(v.slice(4, 6), 16);
    const a = Math.min(255, Math.max(0, roundHalfEven(alpha * 255)));
    return (((a << 24) >>> 0) | (r << 16) | (g << 8) | b) >>> 0;
  }

  function applyEditField(mutate) {
    if (editPanelSyncing || !R || R.selected === null) return;
    const el = R.data.elements[R.selected];
    if (!el) return;
    pushUndoSnapshot();
    mutate(el);
    refreshSelectionUI();
    updateStats();
    renderCanvas();
  }

  $("editX").addEventListener("change", () => applyEditField((el) => { el.center.x = Number($("editX").value) || 0; }));
  $("editY").addEventListener("change", () => applyEditField((el) => { el.center.y = Number($("editY").value) || 0; }));
  $("editSizeA").addEventListener("change", () => applyEditField((el) => {
    const v = Math.max(0.01, Number($("editSizeA").value) || 0.01);
    if (normalizeType(el.type) === "ellipse") el.size.rx = v; else el.size.width = v;
  }));
  $("editSizeB").addEventListener("change", () => applyEditField((el) => {
    const v = Math.max(0.01, Number($("editSizeB").value) || 0.01);
    if (normalizeType(el.type) === "ellipse") el.size.ry = v; else el.size.height = v;
  }));
  $("editRot").addEventListener("change", () => applyEditField((el) => {
    const v = Number($("editRot").value) || 0;
    if (el.rotation && typeof el.rotation === "object") el.rotation.z = v;
    else el.rotation = v;
  }));

  function applyColorAlpha() {
    applyEditField((el) => {
      const hex = $("editColor").value || "#ffcc00";
      const alphaRaw = Number($("editAlpha").value);
      const alpha = Math.min(100, Math.max(0, Number.isFinite(alphaRaw) ? alphaRaw : 100)) / 100;
      el.color = hex;
      el.alpha = alpha;
      el.packed_color = packColorHex(hex, alpha); // GIA export copies this verbatim
    });
  }
  $("editColor").addEventListener("change", applyColorAlpha);
  $("editAlpha").addEventListener("change", applyColorAlpha);

  /* ── transparency cleanup (post-generation, one undo step) ── */

  const CLEANUP_MIN_COVERAGE = 0.15; // mean source alpha under the element
  const CLEANUP_ZERO_AREA = 0.4;     // fraction of area over fully transparent source
  const CLEANUP_MIN_ALPHA = 0.01;    // effectively invisible elements

  /* Source alpha per pixel, lazily read once per job from the original
   * image canvas (only meaningful for transparent outputs). */
  function ensureJobAlpha(job) {
    if (job.srcAlpha !== undefined) return job.srcAlpha;
    const assets = ensureJobAssets(job);
    if (!assets.base) return (job.srcAlpha = null);
    const w = assets.base.width, h = assets.base.height;
    try {
      const d = assets.base.getContext("2d").getImageData(0, 0, w, h).data;
      const a = new Uint8Array(w * h);
      for (let p = 0; p < w * h; p++) a[p] = d[p * 4 + 3];
      job.srcAlpha = a;
    } catch (e) {
      job.srcAlpha = null;
    }
    return job.srcAlpha;
  }

  /* Mean source alpha + fully-transparent fraction under one element
   * (same inside tests as pointInElement, iterated over the bbox). */
  function elementAlphaStats(element, srcAlpha) {
    const w = R.data.image_size.width, h = R.data.image_size.height;
    const type = normalizeType(element.type);
    const center = imagePointToElementCenter(element);
    const rot = -elementRotationRad(element);
    const cosA = Math.cos(rot), sinA = Math.sin(rot);
    let rx, ry;
    if (type === "ellipse") {
      rx = (element.size.rx || (element.size.width || 0) / 2) * R.ppu;
      ry = (element.size.ry || (element.size.height || 0) / 2) * R.ppu;
    } else {
      rx = ((element.size.width || 0) * R.ppu) / 2;
      ry = ((element.size.height || 0) * R.ppu) / 2;
      if (type === "triangle" && !ry) ry = rx * Math.sqrt(3) / 2;
    }
    const ext = Math.max(rx, ry, 0.5) + 1;
    const x0 = Math.max(0, Math.floor(center.x - ext)), x1 = Math.min(w - 1, Math.ceil(center.x + ext));
    const y0 = Math.max(0, Math.floor(center.y - ext)), y1 = Math.min(h - 1, Math.ceil(center.y + ext));
    let count = 0, alphaSum = 0, zero = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx0 = x - center.x, dy0 = y - center.y;
        const dx = dx0 * cosA - dy0 * sinA;
        const dy = dx0 * sinA + dy0 * cosA;
        let inside = false;
        if (type === "ellipse") {
          inside = rx > 0 && ry > 0 && (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;
        } else if (type === "triangle") {
          const th = ry * 2;
          const shift=element.triangle_pivot==="box"?th/6:0;
          const vs = [[0, -2 * th / 3+shift], [-rx, th / 3+shift], [rx, th / 3+shift]];
          const cr = [];
          for (let i = 0; i < 3; i++) {
            const a = vs[i], b = vs[(i + 1) % 3];
            cr.push((dx - a[0]) * (b[1] - a[1]) - (dy - a[1]) * (b[0] - a[0]));
          }
          inside = cr.every((v) => v >= 0) || cr.every((v) => v <= 0);
        } else {
          inside = Math.abs(dx) <= rx && Math.abs(dy) <= ry;
        }
        if (!inside) continue;
        count++;
        const a = srcAlpha[y * w + x];
        alphaSum += a;
        if (a === 0) zero++;
      }
    }
    return { count, meanAlpha: count ? alphaSum / (count * 255) : 0, zeroFrac: count ? zero / count : 1 };
  }

  $("btnCleanTransparency").addEventListener("click", () => {
    if (!R || $("btnCleanTransparency").disabled) return;
    const srcAlpha = ensureJobAlpha(R.job);
    if (!srcAlpha) { $("cleanupStatus").textContent = t("result.cleanup.none"); return; }
    const elements = R.data.elements;
    const doomed = [];
    elements.forEach((el, idx) => {
      if (isBackgroundElement(el)) return;
      const alpha = Number(el.alpha) || 0;
      if (alpha <= CLEANUP_MIN_ALPHA) { doomed.push(idx); return; }
      const stats = elementAlphaStats(el, srcAlpha);
      if (!stats.count || stats.meanAlpha <= CLEANUP_MIN_COVERAGE || stats.zeroFrac >= CLEANUP_ZERO_AREA) {
        doomed.push(idx);
      }
    });
    if (!doomed.length) {
      $("cleanupStatus").textContent = t("result.cleanup.none");
      return;
    }
    pushUndoSnapshot(); // one undoable step (Ctrl+Z restores everything)
    for (let i = doomed.length - 1; i >= 0; i--) elements.splice(doomed[i], 1);
    R.data.elements_count = elements.length;
    R.selectedSet.clear();
    R.selected = null;
    R.hovered = null;
    refreshSelectionUI();
    updateStats();
    renderCanvas();
    $("cleanupStatus").textContent = t("result.cleanup.done", { n: doomed.length });
  });

  /* ── origin pick tool (replaces the old right-click gesture) ── */

  function setOriginPoint(point) {
    R.origin = { x: point.x, y: point.y };
    $("originX").value = point.x.toFixed(1);
    $("originY").value = point.y.toFixed(1);
    if (R.selected !== null && R.data.elements[R.selected]) showDetail(R.data.elements[R.selected], R.selected);
    renderCanvas();
  }

  function disarmOriginPick() {
    originArmed = false;
    $("btnPickOrigin").classList.remove("active");
    canvas.classList.remove("picking");
  }

  $("btnPickOrigin").addEventListener("click", () => {
    if (!R) return;
    originArmed = !originArmed;
    $("btnPickOrigin").classList.toggle("active", originArmed);
    canvas.classList.toggle("picking", originArmed);
  });

  /* ── keyboard: Del/Backspace delete, Ctrl+Z/Y undo/redo, Esc ── */

  document.addEventListener("keydown", (event) => {
    if (activeView !== "result" || !R) return;
    const target = event.target;
    const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" || target.isContentEditable);
    if (event.key === "Escape") {
      if (originArmed) { disarmOriginPick(); return; }
      if (!typing && R.selectedSet.size) {
        R.selectedSet.clear();
        R.selected = null;
        refreshSelectionUI();
        renderCanvas();
      }
      return;
    }
    if (typing) return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && !event.shiftKey && (event.key === "z" || event.key === "Z")) { event.preventDefault(); doUndo(); return; }
    if (mod && (event.key === "y" || event.key === "Y" || (event.shiftKey && (event.key === "z" || event.key === "Z")))) {
      event.preventDefault(); doRedo(); return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      deleteSelection();
    }
  });

  /* ════════════════════ theme toggle ════════════════════ */

  function applyThemeButton() {
    const dark = document.documentElement.dataset.theme !== "light";
    $("themeToggle").textContent = dark ? "🌙" : "☀️"; // icon shows the current theme
  }
  $("themeToggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch (e) { /* storage unavailable */ }
    applyThemeButton();
  });
  applyThemeButton();

  /* ════════════════════ exports ════════════════════ */

  function downloadBlob(blob, name) {
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 5000);
  }

  function currentExportBaseName() {
    const rawName = $("exportFileName").value;
    const safeName = String(rawName || "").trim()
      .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_")
      .replace(/\s+/g, " ");
    const baseName = safeName.replace(/\.(json|css|svg|png|gia|lua)$/i, "").trim();
    return baseName || (R ? R.job.baseName : "shaper_result");
  }

  function exportFileName(ext) { return `${currentExportBaseName()}.${ext}`; }

  function buildJsonExportPayload() {
    const data = R.data;
    const originUnits = { x: R.origin.x / R.ppu, y: -R.origin.y / R.ppu };
    const exportBaseName = currentExportBaseName();
    return {
      image_name: exportBaseName || null,
      group_name: exportBaseName || null,
      origin: originUnits,
      image_size: data.image_size,
      config: data.config?.engine==="primeval-browser"?{...R.job.config,...data.config}:R.job.config || data.config,
      mask: data.mask || null,
      elements: renderOrderedElements(data).map((element, index) => ({
        id: element.id != null ? element.id : index,
        type: normalizeType(element.type),
        shape: element.shape,
        triangle_pivot: element.triangle_pivot,
        center: element.center,
        relative: {
          x: data.config?.engine==="primeval-browser"?element.center.x-originUnits.x:+(element.center.x - originUnits.x).toFixed(4),
          y: data.config?.engine==="primeval-browser"?element.center.y-originUnits.y:+(element.center.y - originUnits.y).toFixed(4),
        },
        size: element.size,
        rotation: element.rotation,
        color: element.color,
        alpha: element.alpha,
        packed_color: element.packed_color,
        image_asset_ref: element.image_asset_ref,
        primitive_type: element.primitive_type,
        image_type: element.image_type,
        type_id: element.type_id,
        element_type_id: element.element_type_id,
        name: element.name,
      })),
    };
  }

  function buildJsonExportText() { return JSON.stringify(buildJsonExportPayload(), null, 2); }

  function buildCssExportText() {
    const data = R.data;
    const elements = renderOrderedElements(data);
    const lines = [];
    const exportBaseName = currentExportBaseName();
    const imageWidth = data.image_size.width;
    const imageHeight = data.image_size.height;

    lines.push(`/* ${exportBaseName} - CSS Export */`);
    lines.push(`/* Generated by Primitive Shaper */`);
    lines.push(`/* HTML usage:`);
    lines.push(`   <div class="shaper-container"></div>`);
    lines.push(`*/`);
    lines.push(`/* JavaScript usage:`);
    lines.push(`   const container = document.querySelector('.shaper-container');`);
    lines.push(`   for (let i = 0; i < ${elements.length}; i += 1) {`);
    lines.push(`     const node = document.createElement('div');`);
    lines.push(`     node.className = 'shaper-element shaper-e' + i;`);
    lines.push(`     container.appendChild(node);`);
    lines.push(`   }`);
    lines.push(`*/`);
    lines.push(`.shaper-container {`);
    lines.push(`  position: relative;`);
    lines.push(`  width: ${imageWidth}px;`);
    lines.push(`  height: ${imageHeight}px;`);
    lines.push(`  background: ${R.outputHasTransparency ? "transparent" : "#ffffff"};`);
    lines.push(`  overflow: hidden;`);
    lines.push(`}`);
    lines.push(`.shaper-element {`);
    lines.push(`  position: absolute;`);
    lines.push(`  box-sizing: border-box;`);
    lines.push(`}`);

    elements.forEach((element, index) => {
      const center = imagePointToElementCenter(element);
      const type = normalizeType(element.type);
      const angle = -elementRotationZ(element);
      const rawAlpha = Number(element.alpha);
      const alpha = Number.isFinite(rawAlpha) ? Math.max(0, rawAlpha) : 0.5;
      const color = cssSolidColor(element.color);

      let width, height, extraStyle = "", transformOrigin = "50% 50%";
      if (type === "ellipse") {
        width = (element.size.rx || (element.size.width || 0) / 2) * R.ppu * 2;
        height = (element.size.ry || (element.size.height || 0) / 2) * R.ppu * 2;
        extraStyle = "  border-radius: 50%;";
      } else if (type === "triangle") {
        width = (element.size.width || 0) * R.ppu;
        height = (element.size.height || 0) * R.ppu || (width * Math.sqrt(3) / 2);
        extraStyle = "  clip-path: polygon(50% 0%, 0% 100%, 100% 100%);";
        transformOrigin = element.triangle_pivot==="box"?"50% 50%":"50% 66.6667%";
      } else {
        width = (element.size.width || 0) * R.ppu;
        height = (element.size.height || 0) * R.ppu;
      }
      const txPercent = type === "triangle"&&element.triangle_pivot!=="box" ? "-50%, -66.6667%" : "-50%, -50%";

      lines.push(`.shaper-element.shaper-e${index} {`);
      lines.push(`  left: ${center.x.toFixed(2)}px;`);
      lines.push(`  top: ${center.y.toFixed(2)}px;`);
      lines.push(`  width: ${width.toFixed(2)}px;`);
      lines.push(`  height: ${height.toFixed(2)}px;`);
      if (Gaussian.isGaussian(element)) {
        const rgb = [1, 3, 5].map((i) => parseInt(element.color.slice(i, i + 2), 16));
        const stops = Gaussian.stops.map(([r, a]) => `rgba(${rgb.join(",")},${a.toFixed(6)}) ${(r * 100).toFixed(3)}%`);
        lines.push(`  background: radial-gradient(ellipse closest-side, ${stops.join(", ")});`);
      } else lines.push(`  background-color: ${color};`);
      lines.push(`  opacity: ${alpha.toFixed(4)};`);
      lines.push(`  transform: translate(${txPercent}) rotate(${angle.toFixed(2)}deg);`);
      lines.push(`  transform-origin: ${transformOrigin};`);
      lines.push(`  z-index: ${index};`);
      if (extraStyle) lines.push(extraStyle);
      lines.push(`}`);
    });

    return lines.join("\n") + "\n";
  }

  function buildSvgExportText() {
    if(primevalCurrent())return R.job.result.primeval_svg;
    const data = R.data;
    const elements = renderOrderedElements(data);
    const lines = [];
    const exportBaseName = currentExportBaseName();
    const imageWidth = data.image_size.width;
    const imageHeight = data.image_size.height;

    lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
    lines.push(`<!-- ${exportBaseName} - SVG Export -->`);
    lines.push(`<!-- Generated by Primitive Shaper -->`);
    lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidth}" height="${imageHeight}" viewBox="0 0 ${imageWidth} ${imageHeight}">`);
    if (!R.outputHasTransparency) {
      lines.push(`  <rect width="${imageWidth}" height="${imageHeight}" fill="#ffffff" />`);
    }

    elements.forEach((element, index) => {
      const center = imagePointToElementCenter(element);
      const type = normalizeType(element.type);
      const angle = -elementRotationZ(element);
      const rawAlpha = Number(element.alpha);
      const alpha = Number.isFinite(rawAlpha) ? Math.max(0, rawAlpha) : 0.5;
      const color = cssSolidColor(element.color);

      if (type === "ellipse") {
        const rx = (element.size.rx || (element.size.width || 0) / 2) * R.ppu;
        const ry = (element.size.ry || (element.size.height || 0) / 2) * R.ppu;
        if (Gaussian.isGaussian(element)) {
          const id = `gaussian-${index}`;
          lines.push(`  <defs><radialGradient id="${id}">${Gaussian.stops.map(([r, a]) => `<stop offset="${r}" stop-color="${color}" stop-opacity="${a}"/>`).join("")}</radialGradient></defs>`);
          lines.push(`  <ellipse cx="${center.x}" cy="${center.y}" rx="${rx}" ry="${ry}" fill="url(#${id})" opacity="${alpha}" transform="rotate(${angle} ${center.x} ${center.y})" />`);
          return;
        }
        lines.push(`  <ellipse cx="${center.x.toFixed(2)}" cy="${center.y.toFixed(2)}" rx="${rx.toFixed(2)}" ry="${ry.toFixed(2)}" fill="${color}" fill-opacity="${alpha.toFixed(4)}" transform="rotate(${angle.toFixed(2)} ${center.x.toFixed(2)} ${center.y.toFixed(2)})" />`);
        return;
      }
      if (type === "triangle") {
        const width = (element.size.width || 0) * R.ppu;
        const height = (element.size.height || 0) * R.ppu || (width * Math.sqrt(3) / 2);
        const shift=element.triangle_pivot==="box"?height/6:0;
        const x1 = center.x, y1 = center.y - (2 * height / 3)+shift;
        const x2 = center.x - width / 2, y2 = center.y + height / 3+shift;
        const x3 = center.x + width / 2, y3 = y2;
        lines.push(`  <polygon points="${x1.toFixed(2)},${y1.toFixed(2)} ${x2.toFixed(2)},${y2.toFixed(2)} ${x3.toFixed(2)},${y3.toFixed(2)}" fill="${color}" fill-opacity="${alpha.toFixed(4)}" transform="rotate(${angle.toFixed(2)} ${center.x.toFixed(2)} ${center.y.toFixed(2)})" />`);
        return;
      }
      const width = (element.size.width || 0) * R.ppu;
      const height = (element.size.height || 0) * R.ppu;
      const x = center.x - width / 2;
      const y = center.y - height / 2;
      lines.push(`  <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${width.toFixed(2)}" height="${height.toFixed(2)}" fill="${color}" fill-opacity="${alpha.toFixed(4)}" transform="rotate(${angle.toFixed(2)} ${center.x.toFixed(2)} ${center.y.toFixed(2)})" />`);
    });

    lines.push(`</svg>`);
    return lines.join("\n") + "\n";
  }

  /* ─────────────── GIA generation (port of server._convert_result_to_gia_bytes) ─────────────── */

  let templatePromise = null;
  function fetchTemplate(name) {
    return fetch(`assets/${name}`).then((r) => {
      if (!r.ok) throw new Error(`${name} HTTP ${r.status}`);
      return r.arrayBuffer();
    });
  }
  function loadTemplates() {
    if (!templatePromise) {
      templatePromise = Promise.all([
        fetchTemplate("image_template.gia"),
        fetchTemplate("template.gia"),
        fetchTemplate("client_mask_off_template.gia"),
        fetchTemplate("blurred_circle_server.gia"),
      ]).then(([image, decoration, clientImage, serverImage]) => ({
        image: new Uint8Array(image),
        decoration: new Uint8Array(decoration),
        // Image-parent container with the in-game mask toggle off — the
        // shape every Client export takes.
        client: new Uint8Array(clientImage),
        server: new Uint8Array(serverImage),
      })).catch((error) => {
        templatePromise = null;
        throw error;
      });
    }
    return templatePromise;
  }

  /* Exact port of server.py _convert_result_to_gia_bytes glue — lives in
   * gia-export.js so the parity suite can byte-compare it in Node. */
  function convertResultToGiaJson(resultData, cfg, imageName, originX, originY) {
    return GiaExport.convertResultToGiaJson(resultData, cfg, imageName, originX, originY);
  }

  /* Current result → the GIA writer's logical image payload. Both the
   * Server and the Client serializer consume this same object, which is
   * what guarantees identical pixel layout, colours and image IDs. */
  function currentGiaJson() {
    return convertResultToGiaJson(
      R.data, R.job.config, currentExportBaseName(), R.origin.x, R.origin.y
    );
  }

  /* Asset Group export — source-image rectangular mask enabled by default. */
  async function exportGia(classic) {
    if (!R) return;
    try {
      const templates = await loadTemplates();
      const jsonData = currentGiaJson();
      let bytes = GIA.convertJsonToGiaBytes(GiaExport.withAssetGroupMask(jsonData), templates.image, GIA.MODE_IMAGE);
      let name = exportFileName("gia");
      if (classic) {
        bytes = GIA.toClassic(bytes);
        name = `${currentExportBaseName()}_classic.gia`;
      }
      downloadBlob(new Blob([bytes], { type: "application/octet-stream" }), name);
    } catch (error) {
      alert(t("result.export.failed", { error: error && error.message ? error.message : error }));
    }
  }

  async function exportServerGia(classic) {
    if (!R) return;
    try {
      const templates = await loadTemplates();
      let bytes = GIA.convertJsonToGiaBytes(currentGiaJson(), templates.server, GIA.MODE_SERVER_IMAGE);
      if (classic) bytes = GIA.toClassic(bytes);
      downloadBlob(new Blob([bytes], { type: "application/octet-stream" }), `${currentExportBaseName()}_server${classic ? "_classic" : ""}.gia`);
    } catch (error) { alert(t("result.export.failed", { error: error.message || error })); }
  }

  /* Client Control Template export. Every file is structurally validated
   * before it is offered for download — a malformed .gia is never written
   * out silently. */
  function buildClientGiaBytes(jsonData, clientTemplates) {
    const bytes = GIA.convertJsonToGiaBytes(jsonData, clientTemplates, GIA.MODE_CLIENT_IMAGE);
    const scene = GIA.buildImageScene(jsonData);
    const report = GIA.validateClientImage(bytes, {
      groupName: scene.group_name,
      objects: scene.clientObjects,
      container: scene.clientContainer,
    });
    if (!report.ok) throw new Error(report.errors.join("; "));
    if (report.warnings.length) console.warn("[client gia]", report.warnings.join(" "));
    return bytes;
  }

  async function exportClientGia(classic) {
    if (!R) return;
    try {
      const templates = await loadTemplates();
      const jsonData = currentGiaJson();
      let bytes = buildClientGiaBytes(jsonData, templates.client);
      let name = `${currentExportBaseName()}_client.gia`;
      if (classic) {
        bytes = GIA.toClassic(bytes);
        name = `${currentExportBaseName()}_client_classic.gia`;
      }
      downloadBlob(new Blob([bytes], { type: "application/octet-stream" }), name);
    } catch (error) {
      alert(t("result.export.gia.clientFailed", {
        error: error && error.message ? error.message : error,
      }));
    }
  }

  /* ── Image Control Template index for the Lua scripts ──
   * One project-wide value: the result card field (required — the button
   * stays disabled without it) and the batch field (optional) are kept in
   * sync and remembered across sessions. */
  const TEMPLATE_INDEX_KEY = "shaper_lua_template_index";
  function templateIndexFields() { return [$("clientLuaTemplateIndex"), $("batchLuaTemplateIndex")]; }

  function refreshTemplateIndexState() {
    for (const field of templateIndexFields()) {
      const text = field.value.trim();
      field.classList.toggle("is-invalid", text !== "" && LuaExport.parseTemplateIndex(text) === null);
    }
    $("btnExportClientLua").disabled = LuaExport.parseTemplateIndex($("clientLuaTemplateIndex").value) === null;
    $("clientLuaBudgetNote").hidden = compressionLuaFits();
  }

  function syncTemplateIndex(source) {
    for (const field of templateIndexFields()) if (field !== source) field.value = source.value;
    try { localStorage.setItem(TEMPLATE_INDEX_KEY, source.value); } catch (e) { /* storage unavailable */ }
    refreshTemplateIndexState();
  }

  (function initTemplateIndex() {
    let stored = "";
    try { stored = localStorage.getItem(TEMPLATE_INDEX_KEY) || ""; } catch (e) { /* storage unavailable */ }
    for (const field of templateIndexFields()) {
      field.value = stored;
      field.addEventListener("input", () => syncTemplateIndex(field));
    }
    refreshTemplateIndexState();
  })();

  /* Client Lua export: one self-contained script — PrimitiveImage runtime
   * library + the Export JSON payload as a data table (port of the community
   * primitive_shaper_to_lua.py converter) + OnStart/OnDestroy hooks. */
  function exportClientLua() {
    if (!R) return;
    const imageTemplateIndex = LuaExport.parseTemplateIndex($("clientLuaTemplateIndex").value);
    if (imageTemplateIndex === null) { $("clientLuaTemplateIndex").focus(); return; }
    try {
      const text = LuaExport.buildStandaloneLuaScript(buildJsonExportPayload(), { imageTemplateIndex });
      downloadBlob(new Blob([text], { type: "text/x-lua" }), `${currentExportBaseName()}_client.lua`);
    } catch (error) {
      alert(t("result.export.gia.clientFailed", {
        error: error && error.message ? error.message : error,
      }));
    }
  }

  /* Every Client export has a parent image, so the mask toggle is always
   * meaningful — it previews what the player sees after switching the mask
   * on in game. */
  function updateClientGiaNote() {
    const row = $("clientMaskPreviewRow");
    if (!row) return;
    row.hidden = !R;
  }

  /* The parent image's rect exactly as the Client .gia carries it, in
   * image pixels. Derived from the same logical model the exporter uses,
   * so the preview cannot drift from the file. */
  function currentClientMaskRect() {
    if (!R) return null;
    let scene;
    try { scene = GIA.buildImageScene(currentGiaJson()); } catch (e) { return null; }
    const container = scene.clientContainer;
    if (!container || !(container.size_x > 0 && container.size_y > 0)) return null;
    const ppu = R.ppu || 1;
    // Logical units → image pixels, undoing gia-export's origin shift.
    return {
      cx: container.offset_x * ppu + R.origin.x,
      cy: R.origin.y - container.offset_y * ppu,
      width: container.size_x * ppu,
      height: container.size_y * ppu,
      shapeType: 1,
    };
  }

  /* ── structural diff / debug mode ───────────────────────────────────
   * Browser-side twin of `node tools/gia-diff.js`. From the console:
   *   await GiaDebug.compare()   → {server, client, differences, validation}
   *   await GiaDebug.bytes()     → {server, client} Uint8Arrays
   * Decodes both outputs into the same model so hierarchy, names, control
   * type, image IDs, transforms, parent IDs, GUIDs, component slot/type
   * numbers and record counts can be compared without hex diffing. */
  window.GiaDebug = {
    async bytes() {
      if (!R) throw new Error("no result open");
      const templates = await loadTemplates();
      const jsonData = currentGiaJson();
      return {
        json: jsonData,
        server: GIA.convertJsonToGiaBytes(GiaExport.withAssetGroupMask(jsonData), templates.image, GIA.MODE_IMAGE),
        client: GIA.convertJsonToGiaBytes(jsonData, templates.client, GIA.MODE_CLIENT_IMAGE),
      };
    },
    async compare() {
      const { json, server, client } = await this.bytes();
      const s = GIA.describeGia(server);
      const c = GIA.describeGia(client);
      const slots = (o) => o.components.map((x) => `${x.slot}/${x.type}`).join(" ");
      const differences = {
        templateKind: [s.templateKind, c.templateKind],
        containerClass: [s.containerClass, c.containerClass],
        containerName: [s.container.resourceName, c.container.resourceName],
        containerComponents: [slots(s.container), slots(c.container)],
        childComponents: [
          s.children[0] ? slots(s.children[0]) : null,
          c.children[0] ? slots(c.children[0]) : null,
        ],
        recordCounts: [s.children.length, c.children.length],
        editorVersion: [s.version, c.version],
        transformPlatformTag: [
          s.children[0] ? s.children[0].transform.platformDiscriminator : null,
          c.children[0] ? c.children[0].transform.platformDiscriminator : null,
        ],
        parentImage: [
          s.container.imageAssetRef !== null ? `image ${s.container.imageAssetRef}` : "none",
          c.container.imageAssetRef !== null ? `image ${c.container.imageAssetRef}` : "none",
        ],
        maskMechanism: [
          s.container.mask
            ? `mask-settings component, enabled=${s.container.mask.enabled}`
            : "none",
          c.container.isMask
            ? "parent image clips children (toggle ON)"
            : "parent image present, mask toggle OFF (player toggles in game)",
        ],
      };
      const scene = GIA.buildImageScene(json);
      const pair = (m) => {
        const byName = Object.create(null);
        for (const o of m.children) byName[o.componentName] = o;
        return byName;
      };
      const S = pair(s);
      const C = pair(c);
      // Only the *content* of the transform has to match, and it has to
      // match in ABSOLUTE terms: the platform discriminator beside it is a
      // template-format tag (server 9, client 23), and a Client mask moves
      // the container to the mask centre while compensating every child,
      // so raw child offsets differ by design. Sibling indices are
      // MIRRORED, because the two formats composite in opposite
      // directions.
      const absOffset = (model, child) => {
        const ct = model.container && model.container.transform;
        return {
          x: child.transform.offset.x + (ct ? ct.offset.x : 0),
          y: child.transform.offset.y + (ct ? ct.offset.y : 0),
        };
      };
      const shape = (t) => t && JSON.stringify([t.size, t.pivot, t.rotationZ, t.anchorMin, t.anchorMax, t.scale]);
      const n = s.children.length;
      const contentMismatches = [];
      for (const k of Object.keys(S)) {
        const a = S[k];
        const b = C[k];
        if (!b) { contentMismatches.push(`${k}: missing from client`); continue; }
        if (a.imageAssetRef !== b.imageAssetRef) contentMismatches.push(`${k}: image ID`);
        if ((a.packedColor >>> 0) !== (b.packedColor >>> 0)) contentMismatches.push(`${k}: colour`);
        if (a.index + b.index !== n + 3) contentMismatches.push(`${k}: index not mirrored`);
        const sa = absOffset(s, a);
        const ca = absOffset(c, b);
        if (Math.abs(sa.x - ca.x) > 1e-4 || Math.abs(sa.y - ca.y) > 1e-4)
          contentMismatches.push(`${k}: absolute position`);
        if (shape(a.transform) !== shape(b.transform)) contentMismatches.push(`${k}: size/rotation`);
      }
      const out = {
        server: s,
        client: c,
        differences,
        contentMismatches,
        maskRelationships: {
          server: s.maskRelationships,
          client: c.maskRelationships,
        },
        validation: GIA.validateClientImage(client, {
          groupName: scene.group_name,
          objects: scene.clientObjects,
          container: scene.clientContainer,
        }),
      };
      console.table(differences);
      for (const rel of c.maskRelationships) {
        console.log(
          `mask: "${rel.maskName}" (image ${rel.maskImageAssetRef}, graphic ` +
            `${rel.maskGraphicVisible ? "visible" : "hidden"}) clips ` +
            `${rel.content.length} child object(s) via ${rel.via}`
        );
      }
      console.log(
        contentMismatches.length
          ? `${contentMismatches.length} content mismatches`
          : `content parity: ${Object.keys(S).length}/${Object.keys(S).length} objects identical`
      );
      return out;
    },
    async download() {
      const { server, client } = await this.bytes();
      const base = currentExportBaseName();
      downloadBlob(new Blob([server], { type: "application/octet-stream" }), `${base}_debug_server.gia`);
      downloadBlob(new Blob([client], { type: "application/octet-stream" }), `${base}_debug_client.gia`);
    },
  };

  async function copyTextToClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "readonly");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      if (!document.execCommand("copy")) throw new Error("copy command failed");
      return true;
    } finally {
      textarea.remove();
    }
  }

  function setTemporaryButtonState(button, text, className) {
    const originalText = button.dataset.originalText || button.textContent;
    button.dataset.originalText = originalText;
    button.textContent = text;
    if (className) button.classList.add(className);
    window.setTimeout(() => {
      button.textContent = t("result.export.copy");
      if (className) button.classList.remove(className);
    }, 1200);
  }

  $("btnExportJSON").addEventListener("click", () => {
    if (!R) return;
    try {
      downloadBlob(new Blob([buildJsonExportText()], { type: "application/json" }), exportFileName("json"));
    } catch (error) {
      alert(t("result.export.failed", { error }));
    }
  });
  $("btnExportCSS").addEventListener("click", () => {
    if (!R) return;
    try {
      downloadBlob(new Blob([buildCssExportText()], { type: "text/css" }), exportFileName("css"));
    } catch (error) {
      alert(t("result.export.failed", { error }));
    }
  });
  $("btnExportSVG").addEventListener("click", () => {
    if (!R) return;
    try {
      downloadBlob(new Blob([buildSvgExportText()], { type: "image/svg+xml" }), exportFileName("svg"));
    } catch (error) {
      alert(t("result.export.failed", { error }));
    }
  });
  $("btnExportPNG").addEventListener("click", () => {
    if (!R) return;
    if(primevalCurrent()){
      downloadBlob(new Blob([R.job.result.primeval_png],{type:"image/png"}),exportFileName("png"));return;
    }
    // Export the full fitted render (original behavior), independent of the
    // current zoom/pan viewport.
    const fit = computeFit();
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = Math.round(R.data.image_size.width * fit);
    exportCanvas.height = Math.round(R.data.image_size.height * fit);
    const exportCtx = exportCanvas.getContext("2d");
    drawScene(exportCtx, fit, 0, 0);
    exportCanvas.toBlob((blob) => {
      if (!blob) { alert(t("result.export.failed", { error: "PNG" })); return; }
      downloadBlob(blob, exportFileName("png"));
    }, "image/png");
  });
  $("btnCopyJSON").addEventListener("click", async () => {
    if (!R) return;
    try {
      await copyTextToClipboard(buildJsonExportText());
      setTemporaryButtonState($("btnCopyJSON"), t("result.export.copied"), "is-success");
    } catch (error) {
      alert(t("result.copy.failed", { error }));
    }
  });
  $("btnCopyCSS").addEventListener("click", async () => {
    if (!R) return;
    try {
      await copyTextToClipboard(buildCssExportText());
      setTemporaryButtonState($("btnCopyCSS"), t("result.export.copied"), "is-success");
    } catch (error) {
      alert(t("result.copy.failed", { error }));
    }
  });
  $("btnExportGIAOverlimit").addEventListener("click", () => exportGia(false));
  $("btnExportGIAClassic").addEventListener("click", () => exportGia(true));
  $("btnExportServerGIAOverlimit").addEventListener("click", () => exportServerGia(false));
  $("btnExportServerGIAClassic").addEventListener("click", () => exportServerGia(true));
  $("btnExportClientGIAOverlimit").addEventListener("click", () => exportClientGia(false));
  $("btnExportClientGIAClassic").addEventListener("click", () => exportClientGia(true));
  $("btnExportClientLua").addEventListener("click", exportClientLua);

  /* ─────────────── download all (ZIP) ─────────────── */

  $("btnDownloadAll").addEventListener("click", async () => {
    const doneJobs = jobs.filter((job) => job.status === "done" && job.result);
    if (!doneJobs.length) {
      alert(t("batch.downloadAllNothing"));
      return;
    }
    try {
      const templates = await loadTemplates();
      // Optional: null keeps the TODO placeholder in every Lua script.
      const imageTemplateIndex = LuaExport.parseTemplateIndex($("batchLuaTemplateIndex").value);
      const files = [];
      const usedNames = new Set();
      const uniqueName = (base, ext) => {
        let name = `${base}.${ext}`;
        let counter = 2;
        while (usedNames.has(name)) name = `${base}_${counter++}.${ext}`;
        usedNames.add(name);
        return name;
      };
      const encoder = new TextEncoder();
      for (const job of doneJobs) {
        const data = job.result;
        const origin = { x: data.image_center.x, y: data.image_center.y };
        const jsonData = convertResultToGiaJson(data, job.config, job.baseName, origin.x, origin.y);
        const giaBytes = GIA.convertJsonToGiaBytes(GiaExport.withAssetGroupMask(jsonData), templates.image, GIA.MODE_IMAGE);
        files.push({ name: uniqueName(job.baseName, "gia"), data: giaBytes });
        files.push({ name: uniqueName(`${job.baseName}_server`, "gia"),
          data: GIA.convertJsonToGiaBytes(jsonData, templates.server, GIA.MODE_SERVER_IMAGE) });
        // Same image, same IDs, Client Control Template structure.
        files.push({
          name: uniqueName(`${job.baseName}_client`, "gia"),
          data: buildClientGiaBytes(jsonData, templates.client),
        });

        // include the JSON payload alongside
        const originUnits = {
          x: origin.x / ((data.config && data.config.pixel_per_unit) || 1),
          y: -origin.y / ((data.config && data.config.pixel_per_unit) || 1),
        };
        const payload = {
          image_name: job.baseName,
          group_name: job.baseName,
          origin: originUnits,
          image_size: data.image_size,
          config: job.config,
          mask: data.mask || null,
          elements: data.elements,
        };
        files.push({ name: uniqueName(job.baseName, "json"), data: encoder.encode(JSON.stringify(payload, null, 2)) });
        // ... and the same payload as the self-contained Client Lua script
        files.push({
          name: uniqueName(`${job.baseName}_client`, "lua"),
          data: encoder.encode(LuaExport.buildStandaloneLuaScript(payload, { imageTemplateIndex })),
        });
      }
      downloadBlob(MiniZip.build(files), "shaper_results.zip");
    } catch (error) {
      alert(t("result.export.failed", { error: error && error.message ? error.message : error }));
    }
  });

  /* ════════════════════ GIA mode conversion tool ════════════════════ */

  let classicFile = null;
  const classicDropZone = $("classicDropZone");
  const classicGiaInput = $("classicGiaInput");

  function classicDirection() {
    return $("dirClassicToOver").checked ? "classic_to_overlimit" : "overlimit_to_classic";
  }

  function updateClassicToolUi() {
    const toClassic = classicDirection() === "overlimit_to_classic";
    $("classicUploadTitle").textContent = t(toClassic ? "gia.upload.overlimit" : "gia.upload.classic");
    $("classicDropText").textContent = t(toClassic ? "gia.drop.overlimit" : "gia.drop.classic");
    $("classicHint").textContent = t(toClassic ? "gia.hint.toClassic" : "gia.hint.toOverlimit");
    $("classicToolTitle").textContent = t(toClassic ? "gia.title.toClassic" : "gia.title.toOverlimit");
    $("classicToolDesc").textContent = t(toClassic ? "gia.desc.toClassic" : "gia.desc.toOverlimit");
    $("btnConvertClassicGia").textContent = t(toClassic ? "gia.button.toClassic" : "gia.button.toOverlimit");
    const steps = $("classicSteps");
    const prefix = toClassic ? "gia.steps.toClassic." : "gia.steps.toOverlimit.";
    steps.innerHTML = "";
    for (let i = 1; i <= 3; i++) {
      const li = document.createElement("li");
      li.textContent = t(prefix + i);
      steps.appendChild(li);
    }
    if (classicFile) {
      $("classicGiaReady").textContent = t(
        toClassic ? "gia.selectedMode.overlimit" : "gia.selectedMode.classic",
        { size: (classicFile.size / 1024).toFixed(1) }
      );
    }
  }

  $("dirOverToClassic").addEventListener("change", updateClassicToolUi);
  $("dirClassicToOver").addEventListener("change", updateClassicToolUi);
  I18N.onChange(updateClassicToolUi);

  function attachClassicGia(file) {
    if (!file) return;
    if (!(file.name || "").toLowerCase().endsWith(".gia")) {
      alert(t("gia.invalidFile"));
      return;
    }
    classicFile = file;
    $("classicGiaName").textContent = file.name;
    $("classicGiaReady").hidden = false;
    classicDropZone.classList.add("ready");
    updateClassicToolUi();
  }

  classicDropZone.addEventListener("click", () => classicGiaInput.click());
  classicGiaInput.addEventListener("change", () => {
    if (classicGiaInput.files && classicGiaInput.files[0]) attachClassicGia(classicGiaInput.files[0]);
    classicGiaInput.value = "";
  });
  classicDropZone.addEventListener("dragover", (event) => { event.preventDefault(); classicDropZone.classList.add("drag-over"); });
  classicDropZone.addEventListener("dragleave", (event) => { event.preventDefault(); classicDropZone.classList.remove("drag-over"); });
  classicDropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    classicDropZone.classList.remove("drag-over");
    if (event.dataTransfer.files && event.dataTransfer.files[0]) attachClassicGia(event.dataTransfer.files[0]);
  });

  $("btnConvertClassicGia").addEventListener("click", async () => {
    const direction = classicDirection();
    if (!classicFile) {
      alert(t("gia.needFile", { mode: t(direction === "classic_to_overlimit" ? "gia.upload.classic" : "gia.upload.overlimit") }));
      return;
    }
    const button = $("btnConvertClassicGia");
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = t("gia.converting");
    try {
      const bytes = new Uint8Array(await classicFile.arrayBuffer());
      let outBytes, suffix;
      if (direction === "classic_to_overlimit") {
        outBytes = GIA.toOverlimit(bytes);
        suffix = "_overlimit";
      } else {
        outBytes = GIA.toClassic(bytes);
        suffix = "_classic";
      }
      const baseName = classicFile.name.replace(/\.gia$/i, "");
      downloadBlob(new Blob([outBytes], { type: "application/octet-stream" }), `${baseName}${suffix}.gia`);
    } catch (error) {
      alert(t("gia.convertFailed", { error: error && error.message ? error.message : error }));
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  });

  /* ════════════════════ init ════════════════════ */

  setMode("fill");
  setView("upload");
  updateClassicToolUi();
  renderJobs();
})();
