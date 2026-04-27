const refs = {
  fileInput: document.getElementById("file-input"),
  processBtn: document.getElementById("process-btn"),
  downloadAllBtn: document.getElementById("download-all-btn"),
  sourceCanvas: document.getElementById("source-canvas"),
  overlayCanvas: document.getElementById("overlay-canvas"),
  canvasViewport: document.getElementById("canvas-viewport"),
  canvasStack: document.getElementById("canvas-stack"),
  addBoxBtn: document.getElementById("add-box-btn"),
  addBoxHint: document.getElementById("add-box-hint"),
  zoomInBtn: document.getElementById("zoom-in-btn"),
  zoomOutBtn: document.getElementById("zoom-out-btn"),
  zoomResetBtn: document.getElementById("zoom-reset-btn"),
  zoomRange: document.getElementById("zoom-range"),
  zoomValue: document.getElementById("zoom-value"),
  status: document.getElementById("status"),
  imageMeta: document.getElementById("image-meta"),
  resultCount: document.getElementById("result-count"),
  results: document.getElementById("results"),
  template: document.getElementById("result-card-template"),
  threshold: document.getElementById("threshold"),
  thresholdValue: document.getElementById("threshold-value"),
  minArea: document.getElementById("min-area"),
  minAreaValue: document.getElementById("min-area-value"),
  padding: document.getElementById("padding"),
  paddingValue: document.getElementById("padding-value"),
  outline: document.getElementById("outline"),
  outlineValue: document.getElementById("outline-value"),
  transparentBg: document.getElementById("transparent-bg"),
  autoPreview: document.getElementById("auto-preview"),
  liveIndicator: document.getElementById("live-indicator"),
  manualStatus: document.getElementById("manual-status"),
  manualHelp: document.getElementById("manual-help"),
  undoBtn: document.getElementById("undo-btn"),
  clearSelectionBtn: document.getElementById("clear-selection-btn"),
};

const state = {
  image: null,
  imageName: "sticker-sheet",
  sourceImageData: null,
  lockedThreshold: 28,
  boxes: [],
  stickers: [],
  selectedBoxIndex: -1,
  addMode: false,
  addDraftRect: null,
  boxDragState: null,
  panDragState: null,
  activeEraseIndex: -1,
  eraseStroke: null,
  undoStack: [],
  hasManualEdits: false,
  isProcessing: false,
  autoProcessTimer: null,
  preview: {
    zoom: 1,
    minZoom: 1,
    maxZoom: 5,
    panX: 0,
    panY: 0,
    displayWidth: 0,
    displayHeight: 0,
    fitScale: 1,
  },
};

const sourceCtx = refs.sourceCanvas.getContext("2d", { willReadFrequently: true });
const overlayCtx = refs.overlayCanvas.getContext("2d");

syncRangeLabels();
syncLiveIndicator();
syncZoomUi();
syncManualUi();

refs.threshold.addEventListener("input", handleDetectionOptionInput);
refs.minArea.addEventListener("input", handleDetectionOptionInput);
refs.padding.addEventListener("input", handleRenderOptionInput);
refs.outline.addEventListener("input", handleRenderOptionInput);
refs.transparentBg.addEventListener("change", handleRenderOptionInput);
refs.autoPreview.addEventListener("change", syncLiveIndicator);
refs.undoBtn.addEventListener("click", undoLastChange);
refs.clearSelectionBtn.addEventListener("click", clearSelection);
refs.addBoxBtn.addEventListener("click", toggleAddMode);

refs.zoomRange.addEventListener("input", (event) => {
  setZoom(Number(event.target.value));
});
refs.zoomInBtn.addEventListener("click", () => {
  setZoom(roundZoom(state.preview.zoom + 0.1));
});
refs.zoomOutBtn.addEventListener("click", () => {
  setZoom(roundZoom(state.preview.zoom - 0.1));
});
refs.zoomResetBtn.addEventListener("click", resetZoomAndPan);

refs.overlayCanvas.addEventListener("pointerdown", handleOverlayPointerDown);
refs.overlayCanvas.addEventListener("pointermove", handleOverlayPointerMove);
refs.overlayCanvas.addEventListener("pointerup", handleOverlayPointerUp);
refs.overlayCanvas.addEventListener("pointerleave", handleOverlayPointerLeave);
refs.canvasViewport.addEventListener(
  "wheel",
  (event) => {
    handleViewportWheel(event);
  },
  { passive: false }
);

window.addEventListener("keydown", handleWindowKeydown);
window.addEventListener("resize", refreshViewportLayout);

refs.fileInput.addEventListener("change", async (event) => {
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }

  try {
    const image = await loadImage(file);
    state.image = image;
    state.imageName = stripExtension(file.name) || "sticker-sheet";
    state.lockedThreshold = Number(refs.threshold.value);
    renderSourceImage(image);
    clearResults();
    setStatus("이미지를 불러왔습니다. 옵션을 확인한 뒤 스티커 다시 분리하기를 눌러 주세요.");
  } catch (error) {
    console.error(error);
    setStatus("이미지를 불러오는 중 문제가 발생했습니다. 다른 파일로 다시 시도해 주세요.", true);
  }
});

refs.processBtn.addEventListener("click", () => {
  if (!state.image) {
    setStatus("먼저 이미지를 업로드해 주세요.", true);
    return;
  }

  runProcess({ explicit: true });
});

refs.downloadAllBtn.addEventListener("click", () => {
  if (!state.stickers.length) {
    return;
  }

  saveAllStickers();
});

function handleDetectionOptionInput() {
  syncRangeLabels();

  if (state.boxes.length) {
    setStatus("배경 감지 민감도와 최소 오브젝트 크기는 스티커 다시 분리하기를 눌렀을 때만 반영됩니다.");
  }
}

function handleRenderOptionInput() {
  syncRangeLabels();

  if (!state.boxes.length) {
    return;
  }

  rebuildStickersFromBoxes();
  renderResults();
  drawBoxesOverlay();
  refs.downloadAllBtn.disabled = false;
  setStatus("현재 박스를 유지한 채 여백, 테두리, 투명 저장 옵션을 즉시 반영했습니다.");
}

async function runProcess({ explicit }) {
  if (!state.image || state.isProcessing) {
    return;
  }

  state.isProcessing = true;
  refs.processBtn.disabled = true;
  setStatus(explicit ? "이미지를 다시 분석하는 중입니다..." : "옵션 변경을 반영하는 중입니다...");

  try {
    await processImage();
  } catch (error) {
    console.error(error);
    setStatus("처리 중 오류가 발생했습니다. 옵션을 조금 바꿔서 다시 시도해 주세요.", true);
  } finally {
    state.isProcessing = false;
    refs.processBtn.disabled = false;
  }
}

async function processImage() {
  const imageData = state.sourceImageData;
  const { width, height, data } = imageData;
  const threshold = Number(refs.threshold.value);
  const minArea = Number(refs.minArea.value);

  const bgColor = estimateBackgroundColor(data, width, height);
  const seedMask = buildSeedMask(data, width, height, bgColor, threshold);
  const boxes = findConnectedComponents(seedMask, width, height, minArea).sort((a, b) => a.minY - b.minY || a.minX - b.minX);

  if (!boxes.length) {
    clearResults();
    setStatus("분리 가능한 오브젝트를 찾지 못했습니다. 배경 감지 민감도나 최소 크기를 조정해 보세요.", true);
    return;
  }

  state.lockedThreshold = threshold;
  state.boxes = boxes;
  rebuildStickersFromBoxes(bgColor);
  state.selectedBoxIndex = -1;
  state.boxDragState = null;
  state.panDragState = null;
  state.activeEraseIndex = -1;
  state.eraseStroke = null;
  state.undoStack = [];
  state.hasManualEdits = false;

  renderResults();
  drawBoxesOverlay();
  syncManualUi();
  refs.downloadAllBtn.disabled = false;
  setStatus(`${state.stickers.length}개의 스티커를 분리했습니다.`);
}

function rebuildStickersFromBoxes(precomputedBgColor = null) {
  if (!state.sourceImageData || !state.boxes.length) {
    state.stickers = [];
    return;
  }

  const imageData = state.sourceImageData;
  const { width, height } = imageData;
  const bgColor = precomputedBgColor || estimateBackgroundColor(imageData.data, width, height);
  const padding = Number(refs.padding.value);
  const outline = Number(refs.outline.value);
  const threshold = state.lockedThreshold ?? Number(refs.threshold.value);

  state.stickers = state.boxes.map((box, index) =>
    createStickerFromComponent({
      component: box,
      width,
      height,
      imageData,
      threshold,
      padding,
      outline,
      bgColor,
      name: `${state.imageName}-sticker-${index + 1}`,
      transparentBg: refs.transparentBg.checked,
    })
  );
}

function renderSourceImage(image) {
  refs.sourceCanvas.width = image.naturalWidth;
  refs.sourceCanvas.height = image.naturalHeight;
  refs.overlayCanvas.width = image.naturalWidth;
  refs.overlayCanvas.height = image.naturalHeight;
  sourceCtx.clearRect(0, 0, refs.sourceCanvas.width, refs.sourceCanvas.height);
  overlayCtx.clearRect(0, 0, refs.overlayCanvas.width, refs.overlayCanvas.height);
  sourceCtx.drawImage(image, 0, 0);
  state.sourceImageData = sourceCtx.getImageData(0, 0, refs.sourceCanvas.width, refs.sourceCanvas.height);
  refs.imageMeta.textContent = `${image.naturalWidth} x ${image.naturalHeight}px`;
  resetZoomAndPan();
  refreshViewportLayout();
}

function refreshViewportLayout() {
  if (!state.image) {
    return;
  }

  const viewportWidth = refs.canvasViewport.clientWidth;
  const viewportHeight = refs.canvasViewport.clientHeight;

  if (!viewportWidth || !viewportHeight) {
    return;
  }

  const fitScale = Math.min(viewportWidth / state.image.naturalWidth, viewportHeight / state.image.naturalHeight, 1);
  state.preview.fitScale = fitScale;
  state.preview.displayWidth = Math.round(state.image.naturalWidth * fitScale);
  state.preview.displayHeight = Math.round(state.image.naturalHeight * fitScale);

  refs.canvasStack.style.width = `${state.preview.displayWidth}px`;
  refs.canvasStack.style.height = `${state.preview.displayHeight}px`;
  refs.sourceCanvas.style.width = `${state.preview.displayWidth}px`;
  refs.sourceCanvas.style.height = `${state.preview.displayHeight}px`;
  refs.overlayCanvas.style.width = `${state.preview.displayWidth}px`;
  refs.overlayCanvas.style.height = `${state.preview.displayHeight}px`;

  applyPreviewTransform();
  drawBoxesOverlay();
}

function resetZoomAndPan() {
  state.preview.zoom = 1;
  state.preview.panX = 0;
  state.preview.panY = 0;
  applyPreviewTransform();
  syncZoomUi();
}

function setZoom(nextZoom, focusClientPoint = null) {
  if (!state.image) {
    return;
  }

  const clampedZoom = clamp(roundZoom(nextZoom), state.preview.minZoom, state.preview.maxZoom);
  if (clampedZoom === state.preview.zoom) {
    syncZoomUi();
    return;
  }

  if (focusClientPoint) {
    const imagePoint = getImagePointFromClient(focusClientPoint.clientX, focusClientPoint.clientY);
    if (imagePoint) {
      const viewportRect = refs.canvasViewport.getBoundingClientRect();
      const normalizedX = imagePoint.x / refs.sourceCanvas.width - 0.5;
      const normalizedY = imagePoint.y / refs.sourceCanvas.height - 0.5;
      state.preview.panX =
        focusClientPoint.clientX -
        (viewportRect.left + viewportRect.width / 2) -
        normalizedX * state.preview.displayWidth * clampedZoom;
      state.preview.panY =
        focusClientPoint.clientY -
        (viewportRect.top + viewportRect.height / 2) -
        normalizedY * state.preview.displayHeight * clampedZoom;
    }
  } else if (clampedZoom === 1) {
    state.preview.panX = 0;
    state.preview.panY = 0;
  }

  state.preview.zoom = clampedZoom;
  applyPreviewTransform();
  syncZoomUi();
}

function applyPreviewTransform() {
  const clampedPan = clampPan(state.preview.panX, state.preview.panY, state.preview.zoom);
  state.preview.panX = clampedPan.x;
  state.preview.panY = clampedPan.y;
  refs.canvasStack.style.transform = `translate(-50%, -50%) translate(${state.preview.panX}px, ${state.preview.panY}px) scale(${state.preview.zoom})`;
  syncZoomUi();
}

function clampPan(panX, panY, zoom) {
  const viewportWidth = refs.canvasViewport.clientWidth;
  const viewportHeight = refs.canvasViewport.clientHeight;
  const slack = 80;
  const limitX = Math.max(0, (state.preview.displayWidth * zoom - viewportWidth) / 2) + slack;
  const limitY = Math.max(0, (state.preview.displayHeight * zoom - viewportHeight) / 2) + slack;

  return {
    x: clamp(panX, -limitX, limitX),
    y: clamp(panY, -limitY, limitY),
  };
}

function handleViewportWheel(event) {
  if (!state.image) {
    return;
  }

  event.preventDefault();
  const delta = event.deltaY < 0 ? 0.12 : -0.12;
  setZoom(state.preview.zoom + delta, { clientX: event.clientX, clientY: event.clientY });
}

function syncRangeLabels() {
  refs.thresholdValue.textContent = refs.threshold.value;
  refs.minAreaValue.textContent = `${refs.minArea.value} px`;
  refs.paddingValue.textContent = `${refs.padding.value} px`;
  refs.outlineValue.textContent = `${refs.outline.value} px`;
}

function syncLiveIndicator() {
  refs.liveIndicator.textContent = refs.autoPreview.checked ? "실시간 미리보기 켜짐" : "실시간 미리보기 꺼짐";
}

function syncZoomUi() {
  const percentage = `${Math.round(state.preview.zoom * 100)}%`;
  refs.zoomRange.value = state.preview.zoom.toFixed(1);
  refs.zoomValue.textContent = percentage;
  refs.zoomResetBtn.textContent = percentage;
}

function syncManualUi() {
  const hasSelection = state.selectedBoxIndex >= 0;
  const selectedLabel = hasSelection ? `선택됨: ${state.selectedBoxIndex + 1}번` : "번호 박스를 클릭해 선택";

  refs.manualStatus.textContent = selectedLabel;
  refs.manualHelp.innerHTML = hasSelection
    ? "박스 안쪽은 이동, 변과 모서리는 크기 조절입니다. <strong>Delete</strong> 키로 삭제할 수 있습니다."
    : "번호 박스를 클릭해서 선택한 뒤 바로 드래그로 수정할 수 있습니다. 여백, 테두리, 투명 저장은 즉시 반영되고 감지 옵션은 스티커 다시 분리하기를 눌렀을 때만 반영됩니다.";

  refs.undoBtn.disabled = !state.undoStack.length;
  refs.clearSelectionBtn.disabled = !hasSelection;
  refs.addBoxBtn.textContent = state.addMode ? "추가 중…" : "오브젝트 추가";
  refs.addBoxBtn.classList.toggle("mode-active", state.addMode);
  refs.addBoxHint.hidden = !state.addMode;

  refs.overlayCanvas.style.cursor = getOverlayCursor();
}

function getOverlayCursor() {
  if (state.addMode) {
    return "crosshair";
  }

  if (state.boxDragState) {
    return getCursorForHandle(state.boxDragState.handle);
  }

  if (state.panDragState) {
    return "grabbing";
  }

  return state.image ? "grab" : "default";
}

function handleOverlayPointerDown(event) {
  if (!state.image) {
    return;
  }

  const point = getCanvasPoint(event);
  if (!point) {
    return;
  }

  if (state.addMode) {
    state.addDraftRect = {
      startX: point.x,
      startY: point.y,
      endX: point.x,
      endY: point.y,
    };
    refs.overlayCanvas.setPointerCapture(event.pointerId);
    drawBoxesOverlay();
    return;
  }

  const selectedRect = getSelectedBoxRect();
  const selectedHandle = selectedRect ? getHandleAtPoint(selectedRect, point.x, point.y) : null;

  if (selectedRect && selectedHandle) {
    beginBoxDrag(event, selectedHandle, selectedRect, point);
    return;
  }

  const hitIndex = findBoxIndexAtPoint(point.x, point.y);
  if (hitIndex >= 0) {
    state.selectedBoxIndex = hitIndex;
    const rect = getSelectedBoxRect();
    const handle = getHandleAtPoint(rect, point.x, point.y) || "move";
    beginBoxDrag(event, handle, rect, point);
    syncManualUi();
    drawBoxesOverlay();
    return;
  }

  state.selectedBoxIndex = -1;
  state.boxDragState = null;
  state.panDragState = {
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startPanX: state.preview.panX,
    startPanY: state.preview.panY,
  };
  refs.overlayCanvas.setPointerCapture(event.pointerId);
  syncManualUi();
  drawBoxesOverlay();
}

function beginBoxDrag(event, handle, rect, point) {
  state.boxDragState = {
    pointerId: event.pointerId,
    handle,
    startPoint: point,
    startRect: { ...rect },
    previewRect: { ...rect },
  };
  state.panDragState = null;
  refs.overlayCanvas.setPointerCapture(event.pointerId);
  refs.overlayCanvas.style.cursor = getCursorForHandle(handle);
}

function handleOverlayPointerMove(event) {
  if (!state.image) {
    return;
  }

  if (state.addMode && state.addDraftRect) {
    const point = getCanvasPoint(event);
    if (!point) {
      return;
    }

    state.addDraftRect = {
      startX: state.addDraftRect.startX,
      startY: state.addDraftRect.startY,
      endX: point.x,
      endY: point.y,
    };
    drawBoxesOverlay();
    return;
  }

  if (state.boxDragState && state.boxDragState.pointerId === event.pointerId) {
    const point = getCanvasPoint(event);
    if (!point) {
      return;
    }

    state.boxDragState.previewRect = getDraggedRect(
      state.boxDragState,
      point,
      refs.sourceCanvas.width,
      refs.sourceCanvas.height
    );
    drawBoxesOverlay();
    return;
  }

  if (state.panDragState && state.panDragState.pointerId === event.pointerId) {
    const dx = event.clientX - state.panDragState.startClientX;
    const dy = event.clientY - state.panDragState.startClientY;
    state.preview.panX = state.panDragState.startPanX + dx;
    state.preview.panY = state.panDragState.startPanY + dy;
    applyPreviewTransform();
    return;
  }

  const point = getCanvasPoint(event);
  if (!point) {
    refs.overlayCanvas.style.cursor = getOverlayCursor();
    return;
  }

  const selectedRect = getSelectedBoxRect();
  const handle = selectedRect ? getHandleAtPoint(selectedRect, point.x, point.y) : null;
  refs.overlayCanvas.style.cursor = handle ? getCursorForHandle(handle) : "grab";
}

function handleOverlayPointerUp(event) {
  if (state.addMode && state.addDraftRect) {
    const point = getCanvasPoint(event) || {
      x: state.addDraftRect.endX,
      y: state.addDraftRect.endY,
    };

    state.addDraftRect = {
      startX: state.addDraftRect.startX,
      startY: state.addDraftRect.startY,
      endX: point.x,
      endY: point.y,
    };

    if (refs.overlayCanvas.hasPointerCapture(event.pointerId)) {
      refs.overlayCanvas.releasePointerCapture(event.pointerId);
    }

    const rect = normalizeRect(state.addDraftRect);
    state.addDraftRect = null;

    if (rect.width < 12 || rect.height < 12) {
      drawBoxesOverlay();
      setStatus("새 오브젝트 박스가 너무 작습니다. 조금 더 크게 드래그해 주세요.", true);
      return;
    }

    pushUndoState();
    state.hasManualEdits = true;
    addNewBox(rect);
    return;
  }

  if (state.boxDragState && state.boxDragState.pointerId === event.pointerId) {
    const point = getCanvasPoint(event) || state.boxDragState.startPoint;
    const finalRect = getDraggedRect(
      state.boxDragState,
      point,
      refs.sourceCanvas.width,
      refs.sourceCanvas.height
    );

    if (refs.overlayCanvas.hasPointerCapture(event.pointerId)) {
      refs.overlayCanvas.releasePointerCapture(event.pointerId);
    }

    const changed =
      finalRect.minX !== state.boxDragState.startRect.minX ||
      finalRect.minY !== state.boxDragState.startRect.minY ||
      finalRect.maxX !== state.boxDragState.startRect.maxX ||
      finalRect.maxY !== state.boxDragState.startRect.maxY;

    state.boxDragState = null;

    if (!changed) {
      drawBoxesOverlay();
      syncManualUi();
      return;
    }

    pushUndoState();
    state.hasManualEdits = true;
    applyManualReplacement(finalRect);
    return;
  }

  if (state.panDragState && state.panDragState.pointerId === event.pointerId) {
    if (refs.overlayCanvas.hasPointerCapture(event.pointerId)) {
      refs.overlayCanvas.releasePointerCapture(event.pointerId);
    }
    state.panDragState = null;
    refs.overlayCanvas.style.cursor = getOverlayCursor();
  }
}

function handleOverlayPointerLeave(event) {
  if (
    (state.boxDragState && state.boxDragState.pointerId === event.pointerId) ||
    (state.panDragState && state.panDragState.pointerId === event.pointerId)
  ) {
    return;
  }

  refs.overlayCanvas.style.cursor = getOverlayCursor();
}

function handleWindowKeydown(event) {
  const activeTag = document.activeElement?.tagName;
  const isTyping = activeTag === "INPUT" || activeTag === "TEXTAREA" || document.activeElement?.isContentEditable;
  const isUndoKey = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z";

  if (event.key === "Escape" && state.addMode) {
    event.preventDefault();
    state.addMode = false;
    state.addDraftRect = null;
    syncManualUi();
    drawBoxesOverlay();
    setStatus("오브젝트 추가 모드를 종료했습니다.");
    return;
  }

  if (isUndoKey) {
    event.preventDefault();
    undoLastChange();
    return;
  }

  if (isTyping || state.selectedBoxIndex < 0) {
    return;
  }

  if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    deleteSelectedBox();
  }
}

function getCanvasPoint(event) {
  return getImagePointFromClient(event.clientX, event.clientY);
}

function getImagePointFromClient(clientX, clientY) {
  const rect = refs.overlayCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return null;
  }

  const normalizedX = (clientX - rect.left) / rect.width;
  const normalizedY = (clientY - rect.top) / rect.height;

  return {
    x: clamp(Math.round(normalizedX * refs.overlayCanvas.width), 0, refs.overlayCanvas.width - 1),
    y: clamp(Math.round(normalizedY * refs.overlayCanvas.height), 0, refs.overlayCanvas.height - 1),
  };
}

function clearSelection() {
  state.selectedBoxIndex = -1;
  state.boxDragState = null;
  state.activeEraseIndex = -1;
  syncManualUi();
  drawBoxesOverlay();
  renderResults();
}

function toggleAddMode() {
  if (!state.image) {
    setStatus("먼저 이미지를 업로드해 주세요.", true);
    return;
  }

  state.addMode = !state.addMode;
  state.addDraftRect = null;

  if (state.addMode) {
    state.selectedBoxIndex = -1;
    state.boxDragState = null;
    state.panDragState = null;
    setStatus("드래그해서 새 오브젝트 영역을 지정하세요.");
  } else {
    setStatus("오브젝트 추가 모드를 종료했습니다.");
  }

  syncManualUi();
  drawBoxesOverlay();
}

function pushUndoState() {
  if (!state.stickers.length) {
    return;
  }

  state.undoStack.push({
    lockedThreshold: state.lockedThreshold,
    boxes: state.boxes.map(cloneBox),
    stickers: state.stickers.map(serializeSticker),
    selectedBoxIndex: state.selectedBoxIndex,
  });

  if (state.undoStack.length > 20) {
    state.undoStack.shift();
  }

  syncManualUi();
}

async function undoLastChange() {
  if (!state.undoStack.length) {
    return;
  }

  const snapshot = state.undoStack.pop();
  state.lockedThreshold = snapshot.lockedThreshold ?? state.lockedThreshold;
  state.boxes = snapshot.boxes.map(cloneBox);
  state.stickers = await Promise.all(snapshot.stickers.map(deserializeSticker));
  state.selectedBoxIndex = Math.min(snapshot.selectedBoxIndex, state.boxes.length - 1);
  state.addMode = false;
  state.addDraftRect = null;
  state.boxDragState = null;
  state.panDragState = null;
  state.activeEraseIndex = -1;
  state.eraseStroke = null;
  state.hasManualEdits = true;

  renderResults();
  drawBoxesOverlay();
  syncManualUi();
  refs.downloadAllBtn.disabled = !state.stickers.length;
  refs.resultCount.textContent = `${state.stickers.length}개`;
  setStatus("방금 작업을 되돌렸습니다.");
}

function deleteSelectedBox() {
  if (state.selectedBoxIndex < 0) {
    return;
  }

  deleteStickerByIndex(state.selectedBoxIndex);
}

function drawBoxesOverlay() {
  overlayCtx.clearRect(0, 0, refs.overlayCanvas.width, refs.overlayCanvas.height);

  overlayCtx.save();
  overlayCtx.font = `${Math.max(14, Math.round(refs.sourceCanvas.width * 0.015))}px "Segoe UI", sans-serif`;
  overlayCtx.textBaseline = "top";

  state.boxes.forEach((box, index) => {
    const rect =
      index === state.selectedBoxIndex && state.boxDragState?.previewRect
        ? state.boxDragState.previewRect
        : boxToRect(box);
    const isSelected = index === state.selectedBoxIndex;
    const fillColor = isSelected ? "rgba(160, 115, 88, 0.18)" : "rgba(183, 134, 111, 0.10)";
    const strokeColor = isSelected ? "rgba(118, 72, 46, 0.95)" : "rgba(142, 94, 71, 0.75)";

    overlayCtx.fillStyle = fillColor;
    overlayCtx.strokeStyle = strokeColor;
    overlayCtx.lineWidth = isSelected ? Math.max(3, refs.sourceCanvas.width * 0.0036) : Math.max(2, refs.sourceCanvas.width * 0.0025);
    overlayCtx.fillRect(rect.minX, rect.minY, rect.width, rect.height);
    overlayCtx.strokeRect(rect.minX, rect.minY, rect.width, rect.height);

    const label = `${index + 1}`;
    const paddingX = 10;
    const paddingY = 6;
    const textWidth = overlayCtx.measureText(label).width;
    const labelWidth = textWidth + paddingX * 2;
    const labelHeight = parseInt(overlayCtx.font, 10) + paddingY * 2;
    const labelX = rect.minX;
    const labelY = Math.max(0, rect.minY - labelHeight - 4);

    overlayCtx.fillStyle = isSelected ? "rgba(118, 72, 46, 0.96)" : "rgba(142, 94, 71, 0.92)";
    roundRect(overlayCtx, labelX, labelY, labelWidth, labelHeight, 10);
    overlayCtx.fill();

    overlayCtx.fillStyle = "#fffaf5";
    overlayCtx.fillText(label, labelX + paddingX, labelY + paddingY);

    if (isSelected) {
      drawSelectionHandles(rect);
    }
  });

  if (state.addDraftRect) {
    const rect = normalizeRect(state.addDraftRect);
    overlayCtx.setLineDash([12, 8]);
    overlayCtx.strokeStyle = "rgba(36, 127, 121, 0.98)";
    overlayCtx.fillStyle = "rgba(71, 174, 167, 0.14)";
    overlayCtx.lineWidth = Math.max(3, refs.sourceCanvas.width * 0.0032);
    overlayCtx.fillRect(rect.minX, rect.minY, rect.width, rect.height);
    overlayCtx.strokeRect(rect.minX, rect.minY, rect.width, rect.height);
    overlayCtx.setLineDash([]);
  }

  overlayCtx.restore();
}

function addNewBox(rect) {
  const newBox = buildManualBoxFromRect(rect, state.sourceImageData.width);
  state.boxes.push(newBox);
  rebuildStickersFromBoxes();
  state.selectedBoxIndex = state.boxes.length - 1;
  state.addMode = false;
  state.addDraftRect = null;
  state.activeEraseIndex = -1;
  renderResults();
  drawBoxesOverlay();
  syncManualUi();
  refs.downloadAllBtn.disabled = false;
  setStatus(`${state.selectedBoxIndex + 1}번 오브젝트 박스를 추가했습니다.`);
}

function boxToRect(box) {
  return {
    minX: box.minX,
    minY: box.minY,
    maxX: box.maxX,
    maxY: box.maxY,
    width: box.maxX - box.minX + 1,
    height: box.maxY - box.minY + 1,
  };
}

function getSelectedBoxRect() {
  if (state.selectedBoxIndex < 0) {
    return null;
  }

  const box = state.boxes[state.selectedBoxIndex];
  return box ? boxToRect(box) : null;
}

function getHandleAtPoint(rect, x, y) {
  const handleSize = getHandleSize();
  const hitPadding = Math.max(8, Math.round(handleSize * 0.75));
  const positions = getHandlePositions(rect);

  for (const [name, position] of Object.entries(positions)) {
    if (
      x >= position.x - hitPadding &&
      x <= position.x + hitPadding &&
      y >= position.y - hitPadding &&
      y <= position.y + hitPadding
    ) {
      return name;
    }
  }

  if (x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY) {
    return "move";
  }

  return null;
}

function getHandlePositions(rect) {
  const centerX = Math.round((rect.minX + rect.maxX) / 2);
  const centerY = Math.round((rect.minY + rect.maxY) / 2);

  return {
    nw: { x: rect.minX, y: rect.minY },
    n: { x: centerX, y: rect.minY },
    ne: { x: rect.maxX, y: rect.minY },
    e: { x: rect.maxX, y: centerY },
    se: { x: rect.maxX, y: rect.maxY },
    s: { x: centerX, y: rect.maxY },
    sw: { x: rect.minX, y: rect.maxY },
    w: { x: rect.minX, y: centerY },
  };
}

function getHandleSize() {
  return Math.max(10, Math.round(refs.sourceCanvas.width * 0.01));
}

function drawSelectionHandles(rect) {
  const size = getHandleSize();
  const positions = Object.values(getHandlePositions(rect));

  overlayCtx.fillStyle = "#fffaf5";
  overlayCtx.strokeStyle = "rgba(118, 72, 46, 0.95)";
  overlayCtx.lineWidth = Math.max(2, refs.sourceCanvas.width * 0.0022);

  positions.forEach((position) => {
    overlayCtx.beginPath();
    overlayCtx.rect(position.x - size / 2, position.y - size / 2, size, size);
    overlayCtx.fill();
    overlayCtx.stroke();
  });
}

function getCursorForHandle(handle) {
  const cursorMap = {
    move: "move",
    n: "ns-resize",
    s: "ns-resize",
    e: "ew-resize",
    w: "ew-resize",
    ne: "nesw-resize",
    sw: "nesw-resize",
    nw: "nwse-resize",
    se: "nwse-resize",
  };

  return cursorMap[handle] || "grab";
}

function findBoxIndexAtPoint(x, y) {
  for (let index = state.boxes.length - 1; index >= 0; index -= 1) {
    const box = state.boxes[index];
    if (x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY) {
      return index;
    }
  }

  return -1;
}

function getDraggedRect(dragState, point, maxWidth, maxHeight) {
  const dx = point.x - dragState.startPoint.x;
  const dy = point.y - dragState.startPoint.y;
  const minSize = 12;
  const nextRect = { ...dragState.startRect };

  switch (dragState.handle) {
    case "move":
      return translateRect(dragState.startRect, dx, dy, maxWidth, maxHeight);
    case "n":
      nextRect.minY = clamp(dragState.startRect.minY + dy, 0, dragState.startRect.maxY - minSize + 1);
      break;
    case "s":
      nextRect.maxY = clamp(dragState.startRect.maxY + dy, dragState.startRect.minY + minSize - 1, maxHeight - 1);
      break;
    case "e":
      nextRect.maxX = clamp(dragState.startRect.maxX + dx, dragState.startRect.minX + minSize - 1, maxWidth - 1);
      break;
    case "w":
      nextRect.minX = clamp(dragState.startRect.minX + dx, 0, dragState.startRect.maxX - minSize + 1);
      break;
    case "nw":
      nextRect.minX = clamp(dragState.startRect.minX + dx, 0, dragState.startRect.maxX - minSize + 1);
      nextRect.minY = clamp(dragState.startRect.minY + dy, 0, dragState.startRect.maxY - minSize + 1);
      break;
    case "ne":
      nextRect.maxX = clamp(dragState.startRect.maxX + dx, dragState.startRect.minX + minSize - 1, maxWidth - 1);
      nextRect.minY = clamp(dragState.startRect.minY + dy, 0, dragState.startRect.maxY - minSize + 1);
      break;
    case "sw":
      nextRect.minX = clamp(dragState.startRect.minX + dx, 0, dragState.startRect.maxX - minSize + 1);
      nextRect.maxY = clamp(dragState.startRect.maxY + dy, dragState.startRect.minY + minSize - 1, maxHeight - 1);
      break;
    case "se":
      nextRect.maxX = clamp(dragState.startRect.maxX + dx, dragState.startRect.minX + minSize - 1, maxWidth - 1);
      nextRect.maxY = clamp(dragState.startRect.maxY + dy, dragState.startRect.minY + minSize - 1, maxHeight - 1);
      break;
    default:
      break;
  }

  return {
    ...nextRect,
    width: nextRect.maxX - nextRect.minX + 1,
    height: nextRect.maxY - nextRect.minY + 1,
  };
}

function translateRect(rect, dx, dy, maxWidth, maxHeight) {
  const width = rect.width;
  const height = rect.height;
  const minX = clamp(rect.minX + dx, 0, maxWidth - width);
  const minY = clamp(rect.minY + dy, 0, maxHeight - height);

  return {
    minX,
    minY,
    maxX: minX + width - 1,
    maxY: minY + height - 1,
    width,
    height,
  };
}

function applyManualReplacement(rect) {
  if (state.selectedBoxIndex < 0 || !state.sourceImageData) {
    return;
  }

  const manualBox = buildManualBoxFromRect(rect, state.sourceImageData.width);
  const padding = Number(refs.padding.value);
  const outline = Number(refs.outline.value);
  const bgColor = estimateBackgroundColor(
    state.sourceImageData.data,
    state.sourceImageData.width,
    state.sourceImageData.height
  );

  const sticker = createStickerFromComponent({
      component: manualBox,
      width: state.sourceImageData.width,
      height: state.sourceImageData.height,
      imageData: state.sourceImageData,
      threshold: state.lockedThreshold,
      padding,
      outline,
      bgColor,
    name: `${state.imageName}-sticker-${state.selectedBoxIndex + 1}`,
    transparentBg: refs.transparentBg.checked,
  });

  state.boxes[state.selectedBoxIndex] = manualBox;
  state.stickers[state.selectedBoxIndex] = sticker;
  drawBoxesOverlay();
  renderResults();
  syncManualUi();
  setStatus(`${state.selectedBoxIndex + 1}번 스티커를 드래그 기준으로 수정했습니다.`);
}

function buildManualBoxFromRect(rect, imageWidth) {
  const pixels = [];

  for (let y = rect.minY; y <= rect.maxY; y += 1) {
    for (let x = rect.minX; x <= rect.maxX; x += 1) {
      pixels.push(y * imageWidth + x);
    }
  }

  return {
    pixels,
    minX: rect.minX,
    minY: rect.minY,
    maxX: rect.maxX,
    maxY: rect.maxY,
    area: pixels.length,
    manual: true,
  };
}

function renderResults() {
  refs.results.innerHTML = "";

  if (!state.stickers.length) {
    refs.results.classList.add("empty");
    refs.results.innerHTML = "<p>분리 결과가 여기 표시됩니다.</p>";
    refs.resultCount.textContent = "0개";
    return;
  }

  refs.results.classList.remove("empty");
  refs.resultCount.textContent = `${state.stickers.length}개`;

  state.stickers.forEach((sticker, index) => {
    const fragment = refs.template.content.cloneNode(true);
    const preview = fragment.querySelector(".result-preview");
    const label = fragment.querySelector(".result-label");
    const eraseButton = fragment.querySelector(".erase-btn");
    const deleteButton = fragment.querySelector(".delete-sticker-btn");
    const downloadButton = fragment.querySelector(".download-btn");

    sticker.canvas.classList.toggle("erase-mode", state.activeEraseIndex === index);
    sticker.canvas.onpointerdown = (event) => handleStickerErasePointerDown(event, index);
    sticker.canvas.onpointermove = (event) => handleStickerErasePointerMove(event, index);
    sticker.canvas.onpointerup = (event) => handleStickerErasePointerUp(event, index);
    sticker.canvas.onpointerleave = (event) => handleStickerErasePointerLeave(event, index);

    preview.appendChild(sticker.canvas);
    label.textContent = `스티커 ${index + 1}`;
    eraseButton.textContent = state.activeEraseIndex === index ? "브러시 종료" : "브러시 지우기";
    eraseButton.classList.toggle("erase-active", state.activeEraseIndex === index);
    eraseButton.addEventListener("click", () => toggleEraseMode(index));
    deleteButton.addEventListener("click", () => deleteStickerByIndex(index));
    downloadButton.addEventListener("click", () => {
      downloadCanvas(sticker.canvas, `${state.imageName}-sticker-${String(index + 1).padStart(2, "0")}.png`);
    });

    refs.results.appendChild(fragment);
  });
}

function toggleEraseMode(index) {
  state.activeEraseIndex = state.activeEraseIndex === index ? -1 : index;
  state.eraseStroke = null;
  renderResults();

  if (state.activeEraseIndex === index) {
    setStatus(`${index + 1}번 스티커에서 브러시 지우기 모드가 켜졌습니다. 드래그해서 지워 보세요.`);
  }
}

function handleStickerErasePointerDown(event, index) {
  if (state.activeEraseIndex !== index) {
    return;
  }

  const point = getStickerCanvasPoint(state.stickers[index].canvas, event);
  if (!point) {
    return;
  }

  pushUndoState();
  state.hasManualEdits = true;
  state.eraseStroke = {
    index,
    pointerId: event.pointerId,
    radius: getEraseRadius(state.stickers[index].canvas),
  };

  state.stickers[index].canvas.setPointerCapture(event.pointerId);
  eraseOnStickerCanvas(state.stickers[index].canvas, point, state.eraseStroke.radius);
  event.preventDefault();
}

function handleStickerErasePointerMove(event, index) {
  if (!state.eraseStroke || state.eraseStroke.index !== index || state.eraseStroke.pointerId !== event.pointerId) {
    return;
  }

  const point = getStickerCanvasPoint(state.stickers[index].canvas, event);
  if (!point) {
    return;
  }

  eraseOnStickerCanvas(state.stickers[index].canvas, point, state.eraseStroke.radius);
  event.preventDefault();
}

function handleStickerErasePointerUp(event, index) {
  if (!state.eraseStroke || state.eraseStroke.index !== index || state.eraseStroke.pointerId !== event.pointerId) {
    return;
  }

  if (state.stickers[index].canvas.hasPointerCapture(event.pointerId)) {
    state.stickers[index].canvas.releasePointerCapture(event.pointerId);
  }

  state.eraseStroke = null;
  setStatus(`${index + 1}번 스티커에서 일부를 지웠습니다. 되돌리기로 복원할 수 있습니다.`);
}

function handleStickerErasePointerLeave(event, index) {
  if (!state.eraseStroke || state.eraseStroke.index !== index || state.eraseStroke.pointerId !== event.pointerId) {
    return;
  }

  handleStickerErasePointerUp(event, index);
}

function deleteStickerByIndex(index) {
  if (index < 0 || index >= state.stickers.length) {
    return;
  }

  pushUndoState();
  state.hasManualEdits = true;
  state.stickers.splice(index, 1);
  state.boxes.splice(index, 1);

  if (!state.stickers.length) {
    clearResults(false);
    setStatus("스티커를 삭제했습니다. 남은 스티커가 없습니다.");
    return;
  }

  if (state.selectedBoxIndex === index) {
    state.selectedBoxIndex = -1;
  } else if (state.selectedBoxIndex > index) {
    state.selectedBoxIndex -= 1;
  }

  if (state.activeEraseIndex === index) {
    state.activeEraseIndex = -1;
  } else if (state.activeEraseIndex > index) {
    state.activeEraseIndex -= 1;
  }

  state.boxDragState = null;
  state.panDragState = null;
  state.eraseStroke = null;

  renderResults();
  drawBoxesOverlay();
  syncManualUi();
  refs.downloadAllBtn.disabled = !state.stickers.length;
  refs.resultCount.textContent = `${state.stickers.length}개`;
  setStatus(`${index + 1}번 스티커를 삭제했습니다.`);
}

function clearResults(resetUndo = true) {
  state.boxes = [];
  state.stickers = [];
  state.selectedBoxIndex = -1;
  state.addMode = false;
  state.addDraftRect = null;
  state.boxDragState = null;
  state.panDragState = null;
  state.activeEraseIndex = -1;
  state.eraseStroke = null;
  state.hasManualEdits = false;

  if (resetUndo) {
    state.undoStack = [];
  }

  refs.results.innerHTML = "<p>분리 결과가 여기 표시됩니다.</p>";
  refs.results.classList.add("empty");
  refs.resultCount.textContent = "0개";
  refs.downloadAllBtn.disabled = true;
  overlayCtx.clearRect(0, 0, refs.overlayCanvas.width, refs.overlayCanvas.height);
  syncManualUi();
}

async function saveAllStickers() {
  if (state.boxes.length) {
    rebuildStickersFromBoxes();
    renderResults();
  }

  const filenames = state.stickers.map((_, index) => `${state.imageName}-sticker-${String(index + 1).padStart(2, "0")}.png`);
  refs.downloadAllBtn.disabled = true;

  try {
    if (canPickDirectory()) {
      setStatus("저장할 폴더를 선택해 주세요.");
      const directoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
      await saveStickersToDirectory(directoryHandle, filenames);
      setStatus(`${state.stickers.length}개의 스티커를 선택한 폴더에 저장했습니다.`);
      return;
    }

    downloadAllStickers(filenames);
    setStatus("브라우저 제한으로 폴더 선택은 사용할 수 없어 개별 다운로드로 저장했습니다.");
  } catch (error) {
    if (error?.name === "AbortError") {
      setStatus("폴더 선택이 취소되었습니다.");
      return;
    }

    console.error(error);
    downloadAllStickers(filenames);
    setStatus("폴더 저장이 지원되지 않아 개별 다운로드로 저장했습니다.");
  } finally {
    refs.downloadAllBtn.disabled = !state.stickers.length;
  }
}

function canPickDirectory() {
  return typeof window.showDirectoryPicker === "function";
}

async function saveStickersToDirectory(directoryHandle, filenames) {
  for (const [index, sticker] of state.stickers.entries()) {
    const fileHandle = await directoryHandle.getFileHandle(filenames[index], { create: true });
    const writable = await fileHandle.createWritable();
    const blob = await canvasToBlob(sticker.canvas);
    await writable.write(blob);
    await writable.close();
  }
}

function downloadAllStickers(filenames) {
  state.stickers.forEach((sticker, index) => {
    setTimeout(() => {
      downloadCanvas(sticker.canvas, filenames[index]);
    }, index * 180);
  });
}

function getStickerCanvasPoint(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return null;
  }

  return {
    x: clamp((event.clientX - rect.left) * (canvas.width / rect.width), 0, canvas.width),
    y: clamp((event.clientY - rect.top) * (canvas.height / rect.height), 0, canvas.height),
  };
}

function getEraseRadius(canvas) {
  return Math.max(10, Math.round(Math.min(canvas.width, canvas.height) * 0.06));
}

function eraseOnStickerCanvas(canvas, point, radius) {
  const ctx = canvas.getContext("2d");
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function pushCanvasImageData(ctx, canvas) {
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function cloneBox(box) {
  return {
    ...box,
    pixels: Array.isArray(box.pixels) ? [...box.pixels] : [],
  };
}

function serializeSticker(sticker) {
  return {
    name: sticker.name,
    orderX: sticker.orderX,
    orderY: sticker.orderY,
    dataUrl: sticker.canvas.toDataURL("image/png"),
    width: sticker.canvas.width,
    height: sticker.canvas.height,
  };
}

async function deserializeSticker(serializedSticker) {
  const image = await loadImageFromUrl(serializedSticker.dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = serializedSticker.width;
  canvas.height = serializedSticker.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, serializedSticker.width, serializedSticker.height);

  return {
    name: serializedSticker.name,
    orderX: serializedSticker.orderX,
    orderY: serializedSticker.orderY,
    canvas,
  };
}

function stripExtension(filename) {
  return filename.replace(/\.[^.]+$/, "");
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Failed to create blob from canvas"));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to load image"));
    };
    image.src = url;
  });
}

function loadImageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to restore image"));
    image.src = url;
  });
}

function roundZoom(value) {
  return Math.round(value * 10) / 10;
}

function estimateBackgroundColor(data, width, height) {
  const sampleSize = Math.max(12, Math.floor(Math.min(width, height) * 0.08));
  const samples = [
    sampleRegion(data, width, 0, 0, sampleSize, sampleSize),
    sampleRegion(data, width, width - sampleSize, 0, sampleSize, sampleSize),
    sampleRegion(data, width, 0, height - sampleSize, sampleSize, sampleSize),
    sampleRegion(data, width, width - sampleSize, height - sampleSize, sampleSize, sampleSize),
  ];

  const averaged = samples.reduce(
    (acc, sample) => {
      acc.r += sample.r;
      acc.g += sample.g;
      acc.b += sample.b;
      return acc;
    },
    { r: 0, g: 0, b: 0 }
  );

  return {
    r: averaged.r / samples.length,
    g: averaged.g / samples.length,
    b: averaged.b / samples.length,
  };
}

function sampleRegion(data, width, startX, startY, regionWidth, regionHeight) {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;

  for (let y = startY; y < startY + regionHeight; y += 1) {
    for (let x = startX; x < startX + regionWidth; x += 1) {
      const index = (y * width + x) * 4;
      const alpha = data[index + 3];
      if (alpha < 12) {
        continue;
      }
      r += data[index];
      g += data[index + 1];
      b += data[index + 2];
      count += 1;
    }
  }

  if (!count) {
    return { r: 255, g: 255, b: 255 };
  }

  return {
    r: r / count,
    g: g / count,
    b: b / count,
  };
}

function buildSeedMask(data, width, height, bgColor, threshold) {
  const mask = new Uint8Array(width * height);

  for (let i = 0; i < width * height; i += 1) {
    const index = i * 4;
    const alpha = data[index + 3];
    if (alpha < 14) {
      mask[i] = 0;
      continue;
    }

    const distance = colorDistance(data[index], data[index + 1], data[index + 2], bgColor);
    const saturation = colorSaturation(data[index], data[index + 1], data[index + 2]);
    const brightness = (data[index] + data[index + 1] + data[index + 2]) / 3;

    mask[i] = distance > threshold || saturation > 18 || brightness < 235 ? 1 : 0;
  }

  return mask;
}

function findConnectedComponents(mask, width, height, minArea) {
  const visited = new Uint8Array(width * height);
  const components = [];
  const queue = new Int32Array(width * height);

  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i] || visited[i]) {
      continue;
    }

    let head = 0;
    let tail = 0;
    queue[tail++] = i;
    visited[i] = 1;

    const pixels = [];
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;

    while (head < tail) {
      const current = queue[head++];
      const x = current % width;
      const y = Math.floor(current / width);
      pixels.push(current);

      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) {
            continue;
          }

          const nextX = x + offsetX;
          const nextY = y + offsetY;
          if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) {
            continue;
          }

          const nextIndex = nextY * width + nextX;
          if (!mask[nextIndex] || visited[nextIndex]) {
            continue;
          }

          visited[nextIndex] = 1;
          queue[tail++] = nextIndex;
        }
      }
    }

    if (pixels.length >= minArea) {
      components.push({ pixels, minX, minY, maxX, maxY, area: pixels.length, manual: false });
    }
  }

  return components;
}

function createStickerFromComponent({
  component,
  width,
  height,
  imageData,
  threshold,
  padding,
  outline,
  bgColor,
  name,
  transparentBg,
}) {
  const cropMargin = padding + outline * 2 + 10;
  const left = clamp(component.minX - cropMargin, 0, width - 1);
  const top = clamp(component.minY - cropMargin, 0, height - 1);
  const right = clamp(component.maxX + cropMargin, 0, width - 1);
  const bottom = clamp(component.maxY + cropMargin, 0, height - 1);

  const localWidth = right - left + 1;
  const localHeight = bottom - top + 1;
  const localSeedMask = new Uint8Array(localWidth * localHeight);
  const localTargetSeedMask = new Uint8Array(localWidth * localHeight);
  const localBgLike = new Uint8Array(localWidth * localHeight);

  for (let y = 0; y < localHeight; y += 1) {
    for (let x = 0; x < localWidth; x += 1) {
      const globalIndex = ((top + y) * width + (left + x)) * 4;
      const localIndex = y * localWidth + x;
      const alpha = imageData.data[globalIndex + 3];

      if (alpha < 14) {
        localBgLike[localIndex] = 1;
        continue;
      }

      const r = imageData.data[globalIndex];
      const g = imageData.data[globalIndex + 1];
      const b = imageData.data[globalIndex + 2];
      const distance = colorDistance(r, g, b, bgColor);
      const saturation = colorSaturation(r, g, b);
      const brightness = (r + g + b) / 3;
      const isSeed = distance > threshold || saturation > 18 || brightness < 235;

      localSeedMask[localIndex] = isSeed ? 1 : 0;
      localBgLike[localIndex] = isSeed ? 0 : 1;
    }
  }

  component.pixels.forEach((globalPixelIndex) => {
    const globalX = globalPixelIndex % width;
    const globalY = Math.floor(globalPixelIndex / width);
    const localX = globalX - left;
    const localY = globalY - top;

    if (localX < 0 || localX >= localWidth || localY < 0 || localY >= localHeight) {
      return;
    }

    localTargetSeedMask[localY * localWidth + localX] = 1;
  });

  const outsideBackground = floodFillBackground(localBgLike, localWidth, localHeight);
  const connectedSeedMask = floodFillMask(localTargetSeedMask, localSeedMask, localWidth, localHeight, true);
  const connectableMask = new Uint8Array(localWidth * localHeight);
  const objectMask = new Uint8Array(localWidth * localHeight);

  for (let i = 0; i < connectableMask.length; i += 1) {
    if (localSeedMask[i] || !outsideBackground[i]) {
      connectableMask[i] = 1;
    }
  }

  const connectedRegionMask = floodFillMask(localTargetSeedMask, connectableMask, localWidth, localHeight, true);
  const seedFeatherMask = dilateMask(
    connectedSeedMask,
    localWidth,
    localHeight,
    Math.max(1, Math.floor(outline * 0.25))
  );

  for (let i = 0; i < objectMask.length; i += 1) {
    if (connectedRegionMask[i] || seedFeatherMask[i]) {
      objectMask[i] = 1;
    }
  }

  const maskBounds = getMaskBounds(objectMask, localWidth, localHeight);
  const exportMargin = Math.max(outline + 6, Math.floor(padding * 0.7));
  const finalLeft = clamp(maskBounds.minX - exportMargin, 0, localWidth - 1);
  const finalTop = clamp(maskBounds.minY - exportMargin, 0, localHeight - 1);
  const finalRight = clamp(maskBounds.maxX + exportMargin, 0, localWidth - 1);
  const finalBottom = clamp(maskBounds.maxY + exportMargin, 0, localHeight - 1);
  const finalWidth = finalRight - finalLeft + 1;
  const finalHeight = finalBottom - finalTop + 1;

  const stickerCanvas = document.createElement("canvas");
  stickerCanvas.width = finalWidth;
  stickerCanvas.height = finalHeight;
  const stickerCtx = stickerCanvas.getContext("2d");

  const objectCanvas = document.createElement("canvas");
  objectCanvas.width = finalWidth;
  objectCanvas.height = finalHeight;
  const objectCtx = objectCanvas.getContext("2d");
  const objectImageData = objectCtx.createImageData(finalWidth, finalHeight);
  const trimmedMask = new Uint8Array(finalWidth * finalHeight);

  for (let y = 0; y < finalHeight; y += 1) {
    for (let x = 0; x < finalWidth; x += 1) {
      const sourceLocalX = finalLeft + x;
      const sourceLocalY = finalTop + y;
      const localIndex = sourceLocalY * localWidth + sourceLocalX;
      const outputIndex = (y * finalWidth + x) * 4;
      const sourceIndex = ((top + sourceLocalY) * width + (left + sourceLocalX)) * 4;

      if (!objectMask[localIndex]) {
        continue;
      }

      trimmedMask[y * finalWidth + x] = 1;
      objectImageData.data[outputIndex] = imageData.data[sourceIndex];
      objectImageData.data[outputIndex + 1] = imageData.data[sourceIndex + 1];
      objectImageData.data[outputIndex + 2] = imageData.data[sourceIndex + 2];
      objectImageData.data[outputIndex + 3] = imageData.data[sourceIndex + 3];
    }
  }

  objectCtx.putImageData(objectImageData, 0, 0);

  const whiteMaskCanvas = createSolidMaskCanvas(trimmedMask, finalWidth, finalHeight, transparentBg);
  const offsets = getCircularOffsets(outline);

  if (!transparentBg) {
    stickerCtx.fillStyle = "#ffffff";
    stickerCtx.fillRect(0, 0, finalWidth, finalHeight);
  }

  offsets.forEach(([dx, dy]) => {
    stickerCtx.drawImage(whiteMaskCanvas, dx, dy);
  });

  stickerCtx.drawImage(objectCanvas, 0, 0);

  return {
    name,
    canvas: stickerCanvas,
    orderX: component.minX,
    orderY: component.minY,
  };
}

function floodFillBackground(bgLikeMask, width, height) {
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;

  const tryEnqueue = (x, y) => {
    const index = y * width + x;
    if (!bgLikeMask[index] || visited[index]) {
      return;
    }
    visited[index] = 1;
    queue[tail++] = index;
  };

  for (let x = 0; x < width; x += 1) {
    tryEnqueue(x, 0);
    tryEnqueue(x, height - 1);
  }

  for (let y = 1; y < height - 1; y += 1) {
    tryEnqueue(0, y);
    tryEnqueue(width - 1, y);
  }

  while (head < tail) {
    const current = queue[head++];
    const x = current % width;
    const y = Math.floor(current / width);

    const neighbors = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ];

    neighbors.forEach(([nextX, nextY]) => {
      if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) {
        return;
      }
      tryEnqueue(nextX, nextY);
    });
  }

  return visited;
}

function floodFillMask(seedMask, allowedMask, width, height, useDiagonal = false) {
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;

  for (let i = 0; i < seedMask.length; i += 1) {
    if (!seedMask[i] || !allowedMask[i]) {
      continue;
    }
    visited[i] = 1;
    queue[tail++] = i;
  }

  const neighborOffsets = useDiagonal
    ? [
        [-1, -1],
        [0, -1],
        [1, -1],
        [-1, 0],
        [1, 0],
        [-1, 1],
        [0, 1],
        [1, 1],
      ]
    : [
        [0, -1],
        [-1, 0],
        [1, 0],
        [0, 1],
      ];

  while (head < tail) {
    const current = queue[head++];
    const x = current % width;
    const y = Math.floor(current / width);

    neighborOffsets.forEach(([offsetX, offsetY]) => {
      const nextX = x + offsetX;
      const nextY = y + offsetY;
      if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) {
        return;
      }

      const nextIndex = nextY * width + nextX;
      if (!allowedMask[nextIndex] || visited[nextIndex]) {
        return;
      }

      visited[nextIndex] = 1;
      queue[tail++] = nextIndex;
    });
  }

  return visited;
}

function dilateMask(mask, width, height, radius) {
  if (radius <= 0) {
    return mask.slice();
  }

  const expanded = new Uint8Array(mask.length);
  const offsets = getCircularOffsets(radius);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!mask[index]) {
        continue;
      }

      offsets.forEach(([dx, dy]) => {
        const nextX = x + dx;
        const nextY = y + dy;
        if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) {
          return;
        }
        expanded[nextY * width + nextX] = 1;
      });
    }
  }

  return expanded;
}

const offsetCache = new Map();

function getCircularOffsets(radius) {
  if (offsetCache.has(radius)) {
    return offsetCache.get(radius);
  }

  const offsets = [];
  for (let y = -radius; y <= radius; y += 1) {
    for (let x = -radius; x <= radius; x += 1) {
      if (x * x + y * y <= radius * radius) {
        offsets.push([x, y]);
      }
    }
  }

  offsetCache.set(radius, offsets);
  return offsets;
}

function createSolidMaskCanvas(mask, width, height, transparentBg) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(width, height);

  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i]) {
      continue;
    }
    const index = i * 4;
    image.data[index] = 255;
    image.data[index + 1] = 255;
    image.data[index + 2] = 255;
    image.data[index + 3] = transparentBg ? 255 : 248;
  }

  ctx.putImageData(image, 0, 0);
  return canvas;
}

function getMaskBounds(mask, width, height) {
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let found = false;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) {
        continue;
      }

      found = true;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (!found) {
    return {
      minX: 0,
      minY: 0,
      maxX: width - 1,
      maxY: height - 1,
    };
  }

  return { minX, minY, maxX, maxY };
}

function normalizeRect(rect) {
  const minX = Math.min(rect.startX, rect.endX);
  const minY = Math.min(rect.startY, rect.endY);
  const maxX = Math.max(rect.startX, rect.endX);
  const maxY = Math.max(rect.startY, rect.endY);

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

function roundRect(ctx, x, y, width, height, radius) {
  const rounded = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + rounded, y);
  ctx.arcTo(x + width, y, x + width, y + height, rounded);
  ctx.arcTo(x + width, y + height, x, y + height, rounded);
  ctx.arcTo(x, y + height, x, y, rounded);
  ctx.arcTo(x, y, x + width, y, rounded);
  ctx.closePath();
}

function colorDistance(r, g, b, bgColor) {
  const dr = r - bgColor.r;
  const dg = g - bgColor.g;
  const db = b - bgColor.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function colorSaturation(r, g, b) {
  return Math.max(r, g, b) - Math.min(r, g, b);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function downloadCanvas(canvas, filename) {
  const link = document.createElement("a");
  link.href = canvas.toDataURL("image/png");
  link.download = filename;
  link.click();
}

function setStatus(message, isError = false) {
  refs.status.textContent = message;
  refs.status.style.color = isError ? "#9c4133" : "";
}
