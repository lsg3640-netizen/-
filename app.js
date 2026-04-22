const refs = {
  fileInput: document.getElementById("file-input"),
  processBtn: document.getElementById("process-btn"),
  downloadAllBtn: document.getElementById("download-all-btn"),
  sourceCanvas: document.getElementById("source-canvas"),
  overlayCanvas: document.getElementById("overlay-canvas"),
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
  detectedComponents: [],
  stickers: [],
  isProcessing: false,
  pendingAutoProcess: false,
  autoProcessTimer: null,
  selectedComponentIndex: -1,
  dragState: null,
  activeEraseIndex: -1,
  eraseStroke: null,
  undoStack: [],
};

const sourceCtx = refs.sourceCanvas.getContext("2d", { willReadFrequently: true });
const overlayCtx = refs.overlayCanvas.getContext("2d");

const syncRangeLabels = () => {
  refs.thresholdValue.textContent = refs.threshold.value;
  refs.minAreaValue.textContent = `${refs.minArea.value} px`;
  refs.paddingValue.textContent = `${refs.padding.value} px`;
  refs.outlineValue.textContent = `${refs.outline.value} px`;
};

syncRangeLabels();
syncLiveIndicator();
syncManualUi();

[refs.threshold, refs.minArea, refs.padding, refs.outline].forEach((input) => {
  input.addEventListener("input", () => {
    syncRangeLabels();
    scheduleAutoProcess();
  });
});

refs.transparentBg.addEventListener("change", scheduleAutoProcess);
refs.autoPreview.addEventListener("change", () => {
  syncLiveIndicator();
  scheduleAutoProcess();
});
refs.undoBtn.addEventListener("click", undoLastChange);
refs.clearSelectionBtn.addEventListener("click", clearSelection);

refs.overlayCanvas.addEventListener("pointerdown", handleOverlayPointerDown);
refs.overlayCanvas.addEventListener("pointermove", handleOverlayPointerMove);
refs.overlayCanvas.addEventListener("pointerup", handleOverlayPointerUp);
refs.overlayCanvas.addEventListener("pointerleave", handleOverlayPointerLeave);
window.addEventListener("keydown", handleWindowKeydown);

refs.fileInput.addEventListener("change", async (event) => {
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }

  try {
    const image = await loadImage(file);
    state.image = image;
    state.imageName = stripExtension(file.name) || "sticker-sheet";
    renderSourceImage(image);
    clearResults();
    setStatus("이미지를 불러왔습니다. 현재 옵션으로 바로 미리보기를 준비합니다.");
    scheduleAutoProcess(true);
  } catch (error) {
    console.error(error);
    setStatus("이미지를 불러오는 중 문제가 발생했습니다. 다른 파일로 다시 시도해 주세요.", true);
  }
});

refs.processBtn.addEventListener("click", async () => {
  if (!state.image) {
    setStatus("먼저 이미지를 업로드해 주세요.", true);
    return;
  }

  runProcess(false);
});

refs.downloadAllBtn.addEventListener("click", () => {
  if (!state.stickers.length) {
    return;
  }

  saveAllStickers();
});

function setStatus(message, isError = false) {
  refs.status.textContent = message;
  refs.status.style.color = isError ? "#9c4133" : "";
}

async function saveAllStickers() {
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

function syncLiveIndicator() {
  refs.liveIndicator.textContent = refs.autoPreview.checked
    ? "실시간 미리보기 켜짐"
    : "실시간 미리보기 꺼짐";
}

function syncManualUi() {
  const hasSelection = state.selectedComponentIndex >= 0;
  const selectedLabel = hasSelection ? `선택됨: ${state.selectedComponentIndex + 1}번` : "번호 박스를 클릭해 선택";

  refs.manualStatus.textContent = selectedLabel;
  refs.manualHelp.innerHTML = hasSelection
    ? "박스 안쪽은 이동, 변과 모서리는 크기 조절입니다. <strong>Delete</strong> 키로 삭제할 수 있습니다."
    : "번호 박스를 클릭해서 선택한 뒤 바로 드래그로 수정할 수 있습니다. 자동 재분리를 다시 실행하면 수동 보정은 현재 결과 기준으로 다시 계산됩니다.";

  refs.undoBtn.disabled = !state.undoStack.length;
  refs.clearSelectionBtn.disabled = !hasSelection;
  refs.overlayCanvas.style.cursor = getCurrentCursor();
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
}

async function processImage() {
  const imageData = state.sourceImageData;
  const { width, height, data } = imageData;
  const threshold = Number(refs.threshold.value);
  const minArea = Number(refs.minArea.value);
  const padding = Number(refs.padding.value);
  const outline = Number(refs.outline.value);

  const bgColor = estimateBackgroundColor(data, width, height);
  const seedMask = buildSeedMask(data, width, height, bgColor, threshold);
  const components = findConnectedComponents(seedMask, width, height, minArea).sort(
    (a, b) => a.minY - b.minY || a.minX - b.minX
  );

  if (!components.length) {
    state.detectedComponents = [];
    state.selectedComponentIndex = -1;
    state.dragState = null;
    drawComponentOverlay([]);
    syncManualUi();
    clearResults();
    setStatus("분리 가능한 오브젝트를 찾지 못했습니다. 배경 감지 민감도나 최소 크기를 조정해 보세요.", true);
    return;
  }

  const stickers = components.map((component, index) =>
    createStickerFromComponent({
      component,
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

  state.detectedComponents = components;
  state.stickers = stickers;
  state.selectedComponentIndex = -1;
  state.dragState = null;
  state.activeEraseIndex = -1;
  state.eraseStroke = null;
  state.undoStack = [];
  drawComponentOverlay(components);
  syncManualUi();
  renderResults();
  refs.downloadAllBtn.disabled = false;
  setStatus(`${state.stickers.length}개의 스티커를 분리했습니다.`);
}

function scheduleAutoProcess(immediate = false) {
  if (!state.image || !refs.autoPreview.checked) {
    return;
  }

  if (state.autoProcessTimer) {
    clearTimeout(state.autoProcessTimer);
  }

  const delay = immediate ? 0 : 180;
  state.autoProcessTimer = window.setTimeout(() => {
    state.autoProcessTimer = null;
    runProcess(true);
  }, delay);
}

async function runProcess(isAuto = false) {
  if (!state.image) {
    return;
  }

  if (state.isProcessing) {
    state.pendingAutoProcess = true;
    return;
  }

  state.isProcessing = true;
  refs.processBtn.disabled = true;
  setStatus(isAuto ? "옵션 변경을 반영하는 중입니다..." : "이미지를 분석해서 개별 스티커를 분리하는 중입니다...");

  try {
    await processImage();
  } catch (error) {
    console.error(error);
    setStatus("처리 중 오류가 발생했습니다. 옵션을 조금 바꿔서 다시 시도해 주세요.", true);
  } finally {
    state.isProcessing = false;
    refs.processBtn.disabled = false;

    if (state.pendingAutoProcess) {
      state.pendingAutoProcess = false;
      scheduleAutoProcess(true);
    }
  }
}

function clearSelection() {
  state.selectedComponentIndex = -1;
  state.dragState = null;
  state.activeEraseIndex = -1;
  syncManualUi();
  drawComponentOverlay(state.detectedComponents);
  renderResults();
}

function pushUndoState() {
  if (!state.stickers.length) {
    return;
  }

  state.undoStack.push({
    detectedComponents: state.detectedComponents.map(cloneComponent),
    stickers: state.stickers.map(serializeSticker),
    selectedComponentIndex: state.selectedComponentIndex,
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
  state.detectedComponents = snapshot.detectedComponents.map(cloneComponent);
  state.stickers = await Promise.all(snapshot.stickers.map(deserializeSticker));
  state.selectedComponentIndex = Math.min(snapshot.selectedComponentIndex, state.detectedComponents.length - 1);
  state.dragState = null;
  state.activeEraseIndex = -1;
  state.eraseStroke = null;

  renderResults();
  drawComponentOverlay(state.detectedComponents);
  syncManualUi();
  refs.downloadAllBtn.disabled = !state.stickers.length;
  refs.resultCount.textContent = `${state.stickers.length}개`;
  setStatus("방금 작업을 되돌렸습니다.");
}

function handleOverlayPointerDown(event) {
  if (!state.image) {
    return;
  }

  const point = getCanvasPoint(event);
  if (!point) {
    return;
  }

  const selectedRect = getSelectedComponentRect();
  const selectedHandle = selectedRect ? getHandleAtPoint(selectedRect, point.x, point.y) : null;

  if (selectedRect && selectedHandle) {
    state.dragState = {
      pointerId: event.pointerId,
      handle: selectedHandle,
      startPoint: point,
      startRect: { ...selectedRect },
      previewRect: { ...selectedRect },
    };
    refs.overlayCanvas.setPointerCapture(event.pointerId);
    refs.overlayCanvas.style.cursor = getCursorForHandle(selectedHandle);
    return;
  }

  const index = findComponentIndexAtPoint(point.x, point.y);
  state.selectedComponentIndex = index;
  state.dragState = null;
  syncManualUi();
  drawComponentOverlay(state.detectedComponents);

  if (index >= 0) {
    setStatus(`${index + 1}번 박스를 선택했습니다. 드래그해서 위치나 크기를 수정할 수 있습니다.`);
  }
}

function handleOverlayPointerMove(event) {
  if (state.dragState && state.dragState.pointerId === event.pointerId) {
    const point = getCanvasPoint(event);
    if (!point) {
      return;
    }

    state.dragState.previewRect = getDraggedRect(state.dragState, point, refs.overlayCanvas.width, refs.overlayCanvas.height);
    drawComponentOverlay(state.detectedComponents);
    return;
  }

  const point = getCanvasPoint(event);
  if (!point) {
    return;
  }

  const selectedRect = getSelectedComponentRect();
  const handle = selectedRect ? getHandleAtPoint(selectedRect, point.x, point.y) : null;
  refs.overlayCanvas.style.cursor = handle ? getCursorForHandle(handle) : "pointer";
}

function handleOverlayPointerUp(event) {
  if (!state.dragState || state.dragState.pointerId !== event.pointerId) {
    return;
  }

  const point = getCanvasPoint(event) || state.dragState.startPoint;
  const finalRect = getDraggedRect(state.dragState, point, refs.overlayCanvas.width, refs.overlayCanvas.height);

  if (refs.overlayCanvas.hasPointerCapture(event.pointerId)) {
    refs.overlayCanvas.releasePointerCapture(event.pointerId);
  }

  const changed =
    finalRect.minX !== state.dragState.startRect.minX ||
    finalRect.minY !== state.dragState.startRect.minY ||
    finalRect.maxX !== state.dragState.startRect.maxX ||
    finalRect.maxY !== state.dragState.startRect.maxY;

  state.dragState = null;

  if (!changed) {
    drawComponentOverlay(state.detectedComponents);
    return;
  }

  pushUndoState();
  applyManualReplacement(finalRect);
}

function handleOverlayPointerLeave(event) {
  if (state.dragState && state.dragState.pointerId === event.pointerId) {
    return;
  }

  refs.overlayCanvas.style.cursor = getCurrentCursor();
}

function handleWindowKeydown(event) {
  const isUndoKey = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z";
  const activeTag = document.activeElement?.tagName;
  const isTyping = activeTag === "INPUT" || activeTag === "TEXTAREA" || document.activeElement?.isContentEditable;

  if (isUndoKey) {
    event.preventDefault();
    undoLastChange();
    return;
  }

  if (isTyping || state.selectedComponentIndex < 0) {
    return;
  }

  if (event.key !== "Delete" && event.key !== "Backspace") {
    return;
  }

  event.preventDefault();
  deleteSelectedComponent();
}

function toggleEraseMode(index) {
  state.activeEraseIndex = state.activeEraseIndex === index ? -1 : index;
  state.eraseStroke = null;
  renderResults();

  if (state.activeEraseIndex === index) {
    setStatus(`${index + 1}번 스티커에서 부분 지우기 모드가 켜졌습니다. 드래그해서 지워 보세요.`);
  }
}

function deleteStickerByIndex(index) {
  if (index < 0 || index >= state.stickers.length) {
    return;
  }

  pushUndoState();

  state.stickers.splice(index, 1);
  state.detectedComponents.splice(index, 1);

  if (!state.stickers.length) {
    clearResults(false);
    setStatus("스티커를 삭제했습니다. 남은 스티커가 없습니다.");
    return;
  }

  if (state.selectedComponentIndex === index) {
    state.selectedComponentIndex = -1;
  } else if (state.selectedComponentIndex > index) {
    state.selectedComponentIndex -= 1;
  }

  if (state.activeEraseIndex === index) {
    state.activeEraseIndex = -1;
  } else if (state.activeEraseIndex > index) {
    state.activeEraseIndex -= 1;
  }

  state.dragState = null;
  state.eraseStroke = null;
  renderResults();
  drawComponentOverlay(state.detectedComponents);
  syncManualUi();
  refs.downloadAllBtn.disabled = !state.stickers.length;
  refs.resultCount.textContent = `${state.stickers.length}개`;
  setStatus(`${index + 1}번 스티커를 삭제했습니다.`);
}

function clearResults(resetUndo = true) {
  state.detectedComponents = [];
  state.stickers = [];
  state.selectedComponentIndex = -1;
  state.dragState = null;
  state.activeEraseIndex = -1;
  state.eraseStroke = null;
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

function renderResults() {
  refs.results.innerHTML = "";
  refs.results.classList.remove("empty");
  refs.resultCount.textContent = `${state.stickers.length}개`;

  state.stickers.forEach((sticker, index) => {
    const fragment = refs.template.content.cloneNode(true);
    const card = fragment.querySelector(".result-card");
    const preview = fragment.querySelector(".result-preview");
    const label = fragment.querySelector(".result-label");
    const eraseButton = fragment.querySelector(".erase-btn");
    const deleteButton = fragment.querySelector(".delete-sticker-btn");
    const button = fragment.querySelector(".download-btn");

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
    button.addEventListener("click", () => {
      downloadCanvas(sticker.canvas, `${state.imageName}-sticker-${String(index + 1).padStart(2, "0")}.png`);
    });

    refs.results.appendChild(card);
  });
}

function drawComponentOverlay(components) {
  overlayCtx.clearRect(0, 0, refs.overlayCanvas.width, refs.overlayCanvas.height);

  overlayCtx.save();
  overlayCtx.font = `${Math.max(14, Math.round(refs.sourceCanvas.width * 0.015))}px "Segoe UI", sans-serif`;
  overlayCtx.textBaseline = "top";

  components.forEach((component, index) => {
    const currentRect =
      index === state.selectedComponentIndex && state.dragState?.previewRect
        ? state.dragState.previewRect
        : {
            minX: component.minX,
            minY: component.minY,
            maxX: component.maxX,
            maxY: component.maxY,
            width: component.maxX - component.minX + 1,
            height: component.maxY - component.minY + 1,
          };
    const isSelected = index === state.selectedComponentIndex;
    const fillColor = isSelected ? "rgba(160, 115, 88, 0.18)" : "rgba(183, 134, 111, 0.10)";
    const strokeColor = isSelected ? "rgba(118, 72, 46, 0.95)" : "rgba(142, 94, 71, 0.75)";

    overlayCtx.fillStyle = fillColor;
    overlayCtx.strokeStyle = strokeColor;
    overlayCtx.lineWidth = isSelected ? Math.max(3, refs.sourceCanvas.width * 0.0036) : Math.max(2, refs.sourceCanvas.width * 0.0025);
    overlayCtx.fillRect(currentRect.minX, currentRect.minY, currentRect.width, currentRect.height);
    overlayCtx.strokeRect(currentRect.minX, currentRect.minY, currentRect.width, currentRect.height);

    const label = `${index + 1}`;
    const paddingX = 10;
    const paddingY = 6;
    const textWidth = overlayCtx.measureText(label).width;
    const labelWidth = textWidth + paddingX * 2;
    const labelHeight = parseInt(overlayCtx.font, 10) + paddingY * 2;
    const labelX = currentRect.minX;
    const labelY = Math.max(0, currentRect.minY - labelHeight - 4);

    overlayCtx.fillStyle = isSelected ? "rgba(118, 72, 46, 0.96)" : "rgba(142, 94, 71, 0.92)";
    roundRect(overlayCtx, labelX, labelY, labelWidth, labelHeight, 10);
    overlayCtx.fill();

    overlayCtx.fillStyle = "#fffaf5";
    overlayCtx.fillText(label, labelX + paddingX, labelY + paddingY);

    if (isSelected) {
      drawSelectionHandles(currentRect);
    }
  });

  overlayCtx.restore();
}

function getCanvasPoint(event) {
  const rect = refs.overlayCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return null;
  }

  const scaleX = refs.overlayCanvas.width / rect.width;
  const scaleY = refs.overlayCanvas.height / rect.height;

  return {
    x: clamp(Math.round((event.clientX - rect.left) * scaleX), 0, refs.overlayCanvas.width - 1),
    y: clamp(Math.round((event.clientY - rect.top) * scaleY), 0, refs.overlayCanvas.height - 1),
  };
}

function getSelectedComponentRect() {
  if (state.selectedComponentIndex < 0) {
    return null;
  }

  const component = state.detectedComponents[state.selectedComponentIndex];
  if (!component) {
    return null;
  }

  return {
    minX: component.minX,
    minY: component.minY,
    maxX: component.maxX,
    maxY: component.maxY,
    width: component.maxX - component.minX + 1,
    height: component.maxY - component.minY + 1,
  };
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

  return cursorMap[handle] || "pointer";
}

function getCurrentCursor() {
  if (state.dragState?.handle) {
    return getCursorForHandle(state.dragState.handle);
  }

  return "pointer";
}

function findComponentIndexAtPoint(x, y) {
  for (let index = state.detectedComponents.length - 1; index >= 0; index -= 1) {
    const component = state.detectedComponents[index];
    if (x >= component.minX && x <= component.maxX && y >= component.minY && y <= component.maxY) {
      return index;
    }
  }

  return -1;
}

function applyManualReplacement(rect) {
  if (state.selectedComponentIndex < 0 || !state.sourceImageData) {
    return;
  }

  const manualComponent = buildManualComponentFromRect(rect, state.sourceImageData.width);
  const threshold = Number(refs.threshold.value);
  const padding = Number(refs.padding.value);
  const outline = Number(refs.outline.value);
  const bgColor = estimateBackgroundColor(
    state.sourceImageData.data,
    state.sourceImageData.width,
    state.sourceImageData.height
  );

  const sticker = createStickerFromComponent({
    component: manualComponent,
    width: state.sourceImageData.width,
    height: state.sourceImageData.height,
    imageData: state.sourceImageData,
    threshold,
    padding,
    outline,
    bgColor,
    name: `${state.imageName}-sticker-${state.selectedComponentIndex + 1}`,
    transparentBg: refs.transparentBg.checked,
  });

  state.detectedComponents[state.selectedComponentIndex] = manualComponent;
  state.stickers[state.selectedComponentIndex] = sticker;
  syncManualUi();
  drawComponentOverlay(state.detectedComponents);
  renderResults();
  setStatus(`${state.selectedComponentIndex + 1}번 스티커를 드래그 기준으로 수정했습니다.`);
}

function buildManualComponentFromRect(rect, imageWidth) {
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

function handleStickerErasePointerDown(event, index) {
  if (state.activeEraseIndex !== index) {
    return;
  }

  const point = getStickerCanvasPoint(state.stickers[index].canvas, event);
  if (!point) {
    return;
  }

  pushUndoState();
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

function getStickerCanvasPoint(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return null;
  }

  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

  return {
    x: clamp((event.clientX - rect.left) * scaleX, 0, canvas.width),
    y: clamp((event.clientY - rect.top) * scaleY, 0, canvas.height),
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

function deleteSelectedComponent() {
  if (state.selectedComponentIndex < 0) {
    return;
  }

  pushUndoState();
  const removedIndex = state.selectedComponentIndex;
  state.detectedComponents.splice(removedIndex, 1);
  state.stickers.splice(removedIndex, 1);

  if (!state.detectedComponents.length) {
    clearResults(false);
    setStatus("선택한 박스를 삭제했습니다. 남은 스티커가 없습니다.");
    return;
  }

  state.selectedComponentIndex = Math.min(removedIndex, state.detectedComponents.length - 1);
  state.dragState = null;
  refs.resultCount.textContent = `${state.stickers.length}개`;
  renderResults();
  drawComponentOverlay(state.detectedComponents);
  syncManualUi();
  setStatus(`${removedIndex + 1}번 박스를 삭제했습니다.`);
}

function cloneComponent(component) {
  return {
    ...component,
    pixels: Array.isArray(component.pixels) ? [...component.pixels] : [],
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

function loadImageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to restore image"));
    image.src = url;
  });
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
      components.push({ pixels, minX, minY, maxX, maxY, area: pixels.length });
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
