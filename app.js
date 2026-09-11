// Ravenloft Music — попап (пульт управления). Звук по умолчанию играет в
// фоновой странице (background.js), которая живёт всю сессию. Этот файл:
//  - рисует плейлист, кнопки мастера, режим редактирования;
//  - пишет состояние в room metadata (его читают все фоны в комнате);
//  - держит связь с фоном по broadcast LOCAL (громкость, разблокировка);
//  - если фон не смог получить разрешение на звук — играет сам, пока открыт
//    (запасной режим, о чём честно пишет внизу окна).

import OBR from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk@3.1.0/+esm";
import {
  STATE_KEY,
  LIB_KEY,
  SFX_CHANNEL,
  CTL_CHANNEL,
  emptyLibrary,
  computeEffectiveFolders,
  isBuiltinFolder,
  writeLocal,
  readLocalAudioPrefs,
  freshId,
  clamp01,
} from "./library.js";
import { AudioEngine } from "./audio-engine.js";

// ---------- состояние ----------

let role = "PLAYER";
let library = emptyLibrary();
let effectiveFolders = [];
let STREAM_INDEX = new Map();
let roomState = { streams: {} };
let editMode = false;

const savedPrefs = readLocalAudioPrefs();
let localMasterVolume = savedPrefs.masterVolume;
let localMuted = savedPrefs.muted;

// Кто играет звук: "bg" — фон, "local" — этот попап, null — ещё не выяснили.
let audioMode = null;
let bgSeen = false;
let statusTimer = null;
let pendingUnlock = false; // ждём ответа фона на нашу попытку разблокировки

// Запасной движок (включается только в режиме "local").
const localEngine = new AudioEngine({
  tag: "ui",
  onBlocked: () => showUnlockOverlay(),
  onUnblocked: () => hideUnlockOverlay(),
});
localEngine.enabled = false;

// ---------- DOM ----------

const root = document.getElementById("app");
const nowPlayingRoot = document.getElementById("now-playing");
const unlockOverlay = document.getElementById("unlock-overlay");
const editToggleBtn = document.getElementById("edit-toggle");
const hintBar = document.getElementById("hint");

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showUnlockOverlay() {
  unlockOverlay.hidden = false;
}
function hideUnlockOverlay() {
  unlockOverlay.hidden = true;
}
function setHint(text, warn = false) {
  if (!text) {
    hintBar.hidden = true;
    return;
  }
  hintBar.hidden = false;
  hintBar.textContent = text;
  hintBar.classList.toggle("warn", warn);
}

// ---------- связь с фоном ----------

function sendCtl(msg) {
  return OBR.broadcast
    .sendMessage(CTL_CHANNEL, { from: "ui", ...msg }, { destination: "LOCAL" })
    .catch(() => {});
}

function sendLocalPrefs() {
  sendCtl({ type: "local", masterVolume: localMasterVolume, muted: localMuted });
}

function switchToBackground() {
  if (audioMode === "bg") return;
  audioMode = "bg";
  localEngine.stopAll();
  hideUnlockOverlay();
  setHint("");
}

function switchToLocal(reason) {
  if (audioMode !== "local") {
    audioMode = "local";
    localEngine.setLocal({ masterVolume: localMasterVolume, muted: localMuted });
    localEngine.resume();
  }
  setHint(
    reason === "no-bg"
      ? "Фоновый плеер не загрузился — звук идёт из этого окна, не закрывай его."
      : "Браузер не разрешил звук в фоне — звук идёт из этого окна, не закрывай его. " +
          "Чтобы играло и при закрытом окне: настройки сайта owlbear.rodeo → Звук → Разрешить, затем обнови страницу.",
    true,
  );
}

function handleStatus(msg) {
  bgSeen = true;
  if (statusTimer) {
    clearTimeout(statusTimer);
    statusTimer = null;
  }
  if (!msg.blocked) {
    pendingUnlock = false;
    switchToBackground();
    return;
  }
  if (pendingUnlock) {
    // Пользователь уже нажал кнопку, а фон всё равно заблокирован — значит,
    // Owlbear/браузер не пропускает звук в фон. Играем сами.
    pendingUnlock = false;
    switchToLocal("blocked");
  } else if (audioMode !== "local") {
    // Фон есть, но браузеру нужен жест. Просим клик.
    showUnlockOverlay();
  }
}

// Пользователь нажал «Включить звук».
unlockOverlay.querySelector("button").addEventListener("click", () => {
  hideUnlockOverlay();
  // Клик — это жест пользователя для этого окна; Chrome запоминает активацию
  // документа, так что более поздний play() в запасном режиме будет разрешён.
  localEngine.probe();
  if (bgSeen) {
    // Даём фону шанс — он проверит разрешение и ответит статусом. Если ответа
    // нет или он «заблокирован», играем сами.
    pendingUnlock = true;
    sendCtl({ type: "unlock" });
    statusTimer = setTimeout(() => {
      statusTimer = null;
      pendingUnlock = false;
      switchToLocal("blocked");
    }, 1500);
  } else {
    switchToLocal("no-bg");
  }
});

// ---------- запись состояния (только мастер) ----------

async function writeStreamState(streamId, patch) {
  const next = {
    streams: {
      ...roomState.streams,
      [streamId]: { ...(roomState.streams[streamId] || {}), ...patch },
    },
  };
  roomState = next;
  await OBR.room.setMetadata({ [STATE_KEY]: next });
}

async function toggleStream(streamId) {
  const entry = STREAM_INDEX.get(streamId);
  if (!entry) return;
  const current = roomState.streams[streamId];
  if (current?.playing) {
    await writeStreamState(streamId, { playing: false });
  } else {
    await writeStreamState(streamId, {
      playing: true,
      trackIndex: current?.trackIndex ?? 0,
      startedAt: Date.now(),
      volume: current?.volume ?? entry.stream.volume ?? 80,
    });
  }
}

async function setStreamVolume(streamId, volumePercent) {
  await writeStreamState(streamId, { volume: volumePercent });
}

async function triggerSfx(streamId) {
  const entry = STREAM_INDEX.get(streamId);
  const track = entry?.stream.tracks[0];
  if (!track) return;
  // ALL — придёт и в свой фон тоже, поэтому здесь ничего не проигрываем.
  await OBR.broadcast.sendMessage(
    SFX_CHANNEL,
    { link: track.link, volume: entry.stream.volume },
    { destination: "ALL" },
  );
}

// ---------- редактирование библиотеки (только мастер) ----------

async function writeLibrary(next) {
  library = next;
  try {
    await OBR.room.setMetadata({ [LIB_KEY]: next });
  } catch (err) {
    console.error("[Ravenloft Music] не удалось сохранить изменения", err);
    alert("Не сохранилось — похоже, в комнате закончилось место под данные расширений. Удали что-нибудь лишнее и попробуй снова.");
  }
}

async function addStream(folderId, { name, icon, link, type, loop, fadeMs }) {
  const id = freshId("c");
  const stream = {
    id,
    name: name || "Без названия",
    icon: icon || (type === "oneshot" ? "🔊" : "🎵"),
    volume: 80,
    type,
    loop: type === "loop" ? !!loop : undefined,
    fadeMs: type === "loop" ? Math.max(0, Number(fadeMs) || 0) : 0,
    tracks: [{ name: name || "Без названия", link, loop: !!loop }],
  };
  if (isBuiltinFolder(folderId)) {
    const customStreams = { ...(library.customStreams || {}) };
    customStreams[folderId] = [...(customStreams[folderId] || []), stream];
    await writeLibrary({ ...library, customStreams });
  } else {
    const customFolders = (library.customFolders || []).map((f) =>
      f.id === folderId ? { ...f, streams: [...f.streams, stream] } : f,
    );
    await writeLibrary({ ...library, customFolders });
  }
}

async function addFolder({ name, color }) {
  const id = freshId("cf");
  const customFolders = [
    ...(library.customFolders || []),
    { id, name: name || "Новая папка", color: color || "#555", streams: [] },
  ];
  await writeLibrary({ ...library, customFolders });
}

async function removeStream(folderId, streamId) {
  if (String(streamId).startsWith("c-")) {
    const customStreams = { ...(library.customStreams || {}) };
    if (customStreams[folderId]) customStreams[folderId] = customStreams[folderId].filter((s) => s.id !== streamId);
    const customFolders = (library.customFolders || []).map((f) =>
      f.id === folderId ? { ...f, streams: f.streams.filter((s) => s.id !== streamId) } : f,
    );
    await writeLibrary({ ...library, customStreams, customFolders });
  } else {
    const hidden = Array.from(new Set([...(library.hidden || []), streamId]));
    await writeLibrary({ ...library, hidden });
  }
}

async function removeFolder(folderId) {
  const customFolders = (library.customFolders || []).filter((f) => f.id !== folderId);
  await writeLibrary({ ...library, customFolders });
}

async function setStreamOverride(streamId, patch) {
  const overrides = {
    ...(library.overrides || {}),
    [streamId]: { ...(library.overrides?.[streamId] || {}), ...patch },
  };
  await writeLibrary({ ...library, overrides });
}

// ---------- UI: плейлист ----------

function renderFolder(folder) {
  const wrap = el("details", "folder");
  wrap.style.setProperty("--dot", folder.color || "#666");
  wrap.open = false;

  const summary = el("summary");
  summary.appendChild(el("span", "dot"));
  summary.appendChild(el("span", "folder-name", folder.name));
  if (editMode && !folder.builtin) {
    const del = el("button", "icon-btn danger", "✕");
    del.title = "Удалить папку целиком";
    del.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (confirm(`Удалить папку «${folder.name}» вместе со всем, что в ней?`)) removeFolder(folder.id);
    });
    summary.appendChild(del);
  }
  wrap.appendChild(summary);

  const body = el("div", "folder-body");
  for (const stream of folder.streams) body.appendChild(renderStream(folder, stream));
  if (editMode) body.appendChild(renderAddStreamForm(folder));
  wrap.appendChild(body);
  return wrap;
}

function renderStream(folder, stream) {
  const row = el("div", "stream-row");
  row.dataset.streamId = stream.id;
  const main = el("div", "stream-main");

  if (stream.type === "oneshot") {
    const btn = el("button", "sfx-btn", `${stream.icon || ""} ${stream.name}`);
    btn.disabled = role !== "GM";
    btn.addEventListener("click", () => triggerSfx(stream.id));
    main.appendChild(btn);
  } else {
    const playBtn = el("button", "play-btn", "▶");
    playBtn.disabled = role !== "GM";
    playBtn.addEventListener("click", () => toggleStream(stream.id));
    row._playBtn = playBtn;

    const label = el("span", "stream-label", `${stream.icon || ""} ${stream.name}`);

    const volume = el("input", "vol");
    volume.type = "range";
    volume.min = "0";
    volume.max = "100";
    volume.value = String(stream.volume ?? 80);
    volume.disabled = role !== "GM";
    volume.addEventListener("input", () => setStreamVolume(stream.id, Number(volume.value)));
    row._volume = volume;

    main.append(playBtn, label, volume);
  }
  row.appendChild(main);

  if (editMode) {
    const tools = el("div", "stream-tools");
    const rename = el("button", "icon-btn", "✎");
    rename.title = "Переименовать / иконка / зацикливание";
    rename.addEventListener("click", () => toggleInlineEdit(row, folder, stream));
    const del = el("button", "icon-btn danger", "✕");
    del.title = "Скрыть / удалить";
    del.addEventListener("click", () => removeStream(folder.id, stream.id));
    tools.append(rename, del);
    row.appendChild(tools);
  }
  return row;
}

function toggleInlineEdit(row, folder, stream) {
  const existing = row.querySelector(".inline-edit");
  if (existing) {
    existing.remove();
    return;
  }
  const box = el("div", "inline-edit");

  const nameInput = el("input", "text-input");
  nameInput.placeholder = "Название";
  nameInput.value = stream.name;

  const iconInput = el("input", "text-input icon-input");
  iconInput.placeholder = "🎵";
  iconInput.value = stream.icon || "";

  const linkInput = el("input", "text-input");
  linkInput.placeholder = "Ссылка";
  linkInput.value = stream.tracks[0]?.link || "";

  box.append(nameInput, iconInput, linkInput);

  let loopCheckbox;
  let fadeInput;
  if (stream.type === "loop") {
    const loopLabel = el("label", "checkbox-label");
    loopCheckbox = document.createElement("input");
    loopCheckbox.type = "checkbox";
    loopCheckbox.checked = !!(stream.loop ?? stream.tracks[0]?.loop);
    loopLabel.append(loopCheckbox, document.createTextNode(" зациклен"));
    box.appendChild(loopLabel);

    fadeInput = el("input", "text-input fade-input");
    fadeInput.type = "number";
    fadeInput.min = "0";
    fadeInput.step = "500";
    fadeInput.placeholder = "Затухание, мс";
    fadeInput.value = String(stream.fadeMs || 0);
    box.appendChild(fadeInput);
  }

  const save = el("button", "small-btn", "Сохранить");
  save.addEventListener("click", async () => {
    const patch = { name: nameInput.value.trim() || stream.name, icon: iconInput.value.trim() };
    const newLink = linkInput.value.trim();
    if (newLink && newLink !== stream.tracks[0]?.link) patch.link = newLink;
    if (loopCheckbox) patch.loop = loopCheckbox.checked;
    if (fadeInput) patch.fadeMs = Math.max(0, Number(fadeInput.value) || 0);
    await setStreamOverride(stream.id, patch);
    box.remove();
  });
  box.appendChild(save);
  row.appendChild(box);
}

function renderAddStreamForm(folder) {
  const box = el("div", "add-form");
  const toggle = el("button", "add-toggle", "+ добавить трек");
  const form = el("div", "add-form-body");
  form.hidden = true;

  const nameInput = el("input", "text-input");
  nameInput.placeholder = "Название";
  const iconInput = el("input", "text-input icon-input");
  iconInput.placeholder = "🎵";
  const linkInput = el("input", "text-input");
  linkInput.placeholder = "Ссылка (mp3, Dropbox…)";

  const typeSelect = document.createElement("select");
  typeSelect.className = "text-input";
  const optLoop = document.createElement("option");
  optLoop.value = "loop";
  optLoop.textContent = "Зацикленный (эмбиент/бой)";
  const optOneshot = document.createElement("option");
  optOneshot.value = "oneshot";
  optOneshot.textContent = "Одноразовый эффект";
  typeSelect.append(optLoop, optOneshot);

  const loopLabel = el("label", "checkbox-label");
  const loopCheckbox = document.createElement("input");
  loopCheckbox.type = "checkbox";
  loopCheckbox.checked = true;
  loopLabel.append(loopCheckbox, document.createTextNode(" зацикливать проигрывание"));

  const fadeInput = el("input", "text-input fade-input");
  fadeInput.type = "number";
  fadeInput.min = "0";
  fadeInput.step = "500";
  fadeInput.placeholder = "Затухание, мс (0 = без него)";

  const submit = el("button", "small-btn", "Добавить");
  submit.addEventListener("click", async () => {
    if (!linkInput.value.trim()) {
      alert("Нужна ссылка на файл.");
      return;
    }
    await addStream(folder.id, {
      name: nameInput.value.trim(),
      icon: iconInput.value.trim(),
      link: linkInput.value.trim(),
      type: typeSelect.value,
      loop: loopCheckbox.checked,
      fadeMs: fadeInput.value,
    });
    nameInput.value = "";
    iconInput.value = "";
    linkInput.value = "";
    fadeInput.value = "";
    form.hidden = true;
  });

  typeSelect.addEventListener("change", () => {
    loopLabel.hidden = typeSelect.value !== "loop";
    fadeInput.hidden = typeSelect.value !== "loop";
  });

  form.append(nameInput, iconInput, linkInput, typeSelect, loopLabel, fadeInput, submit);
  toggle.addEventListener("click", () => {
    form.hidden = !form.hidden;
  });
  box.append(toggle, form);
  return box;
}

function renderAddFolderForm() {
  const box = el("div", "add-form add-folder-form");
  const toggle = el("button", "add-toggle", "+ новая папка");
  const form = el("div", "add-form-body");
  form.hidden = true;

  const nameInput = el("input", "text-input");
  nameInput.placeholder = "Название папки";
  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.value = "#6b5b95";
  colorInput.className = "color-input";

  const submit = el("button", "small-btn", "Создать");
  submit.addEventListener("click", async () => {
    if (!nameInput.value.trim()) return;
    await addFolder({ name: nameInput.value.trim(), color: colorInput.value });
    nameInput.value = "";
    form.hidden = true;
  });

  form.append(nameInput, colorInput, submit);
  toggle.addEventListener("click", () => {
    form.hidden = !form.hidden;
  });
  box.append(toggle, form);
  return box;
}

function renderAll() {
  root.innerHTML = "";
  for (const folder of effectiveFolders) root.appendChild(renderFolder(folder));
  if (editMode) root.appendChild(renderAddFolderForm());
}

function refreshUiFromState() {
  for (const row of root.querySelectorAll(".stream-row")) {
    if (!row._playBtn) continue;
    const state = roomState.streams?.[row.dataset.streamId];
    row._playBtn.textContent = state?.playing ? "⏸" : "▶";
    row._playBtn.classList.toggle("is-playing", !!state?.playing);
    if (document.activeElement !== row._volume) {
      row._volume.value = String(state?.volume ?? row._volume.value);
    }
  }
  renderNowPlaying();
}

// ---------- UI: «сейчас играет» ----------
// Строки обновляются на месте, иначе перетаскивание ползунка прерывалось бы
// собственным же эхом через onMetadataChange.

const nowPlayingRows = new Map(); // streamId -> {row, volume, nameEl}

function renderNowPlaying() {
  if (!nowPlayingRoot) return;

  const playingIds = new Set();
  const playingEntries = [];
  for (const [, entry] of STREAM_INDEX) {
    if (entry.stream.type !== "loop") continue;
    if (roomState.streams?.[entry.stream.id]?.playing) {
      playingIds.add(entry.stream.id);
      playingEntries.push(entry);
    }
  }

  for (const [id, refs] of nowPlayingRows) {
    if (!playingIds.has(id)) {
      refs.row.remove();
      nowPlayingRows.delete(id);
    }
  }

  if (playingEntries.length === 0) {
    if (!nowPlayingRoot.querySelector(".now-playing-empty")) {
      nowPlayingRoot.innerHTML = "";
      nowPlayingRoot.appendChild(el("div", "now-playing-empty", "Сейчас тихо"));
    }
    return;
  }
  nowPlayingRoot.querySelector(".now-playing-empty")?.remove();

  for (const { folder, stream } of playingEntries) {
    const state = roomState.streams?.[stream.id];
    let refs = nowPlayingRows.get(stream.id);
    if (!refs) {
      const row = el("div", "now-playing-row");
      const top = el("div", "now-playing-top");
      top.appendChild(el("span", "now-playing-folder", folder.name));
      row.appendChild(top);
      const nameEl = el("div", "now-playing-name");
      row.appendChild(nameEl);

      const controls = el("div", "now-playing-controls");
      const stopBtn = el("button", "play-btn is-playing", "⏸");
      stopBtn.disabled = role !== "GM";
      stopBtn.addEventListener("click", () => toggleStream(stream.id));
      const volume = el("input", "vol");
      volume.type = "range";
      volume.min = "0";
      volume.max = "100";
      volume.disabled = role !== "GM";
      volume.addEventListener("input", () => setStreamVolume(stream.id, Number(volume.value)));
      controls.append(stopBtn, volume);
      row.appendChild(controls);

      nowPlayingRoot.appendChild(row);
      refs = { row, volume, nameEl };
      nowPlayingRows.set(stream.id, refs);
    }
    refs.nameEl.textContent = `${stream.icon || ""} ${stream.name}`;
    if (document.activeElement !== refs.volume) {
      refs.volume.value = String(state?.volume ?? stream.volume ?? 80);
    }
  }
}

// ---------- UI: личная громкость ----------

function renderLocalControls() {
  const bar = document.getElementById("local-controls");
  bar.innerHTML = "";

  const muteBtn = el("button", "icon-btn", localMuted ? "🔇" : "🔊");
  muteBtn.addEventListener("click", () => {
    localMuted = !localMuted;
    writeLocal("muted", localMuted);
    muteBtn.textContent = localMuted ? "🔇" : "🔊";
    localEngine.setLocal({ muted: localMuted });
    sendLocalPrefs();
  });

  const vol = el("input", "vol");
  vol.type = "range";
  vol.min = "0";
  vol.max = "100";
  vol.value = String(Math.round(localMasterVolume * 100));
  vol.title = "Твоя личная громкость (не синхронизируется)";
  vol.addEventListener("input", () => {
    localMasterVolume = clamp01(Number(vol.value) / 100);
    writeLocal("masterVolume", localMasterVolume);
    localEngine.setLocal({ masterVolume: localMasterVolume });
    sendLocalPrefs();
  });

  const roleTag = el("span", "role-tag", role === "GM" ? "мастер" : "игрок");
  bar.append(roleTag, muteBtn, vol);
}

editToggleBtn.addEventListener("click", () => {
  editMode = !editMode;
  editToggleBtn.classList.toggle("is-active", editMode);
  renderAll();
  refreshUiFromState();
});

// ---------- инициализация ----------

function rebuild() {
  const result = computeEffectiveFolders(library);
  effectiveFolders = result.folders;
  STREAM_INDEX = result.index;
  localEngine.setIndex(STREAM_INDEX);
}

OBR.onReady(async () => {
  try {
    role = await OBR.player.getRole();
  } catch {
    role = "PLAYER";
  }
  editToggleBtn.hidden = role !== "GM";

  const initialMeta = await OBR.room.getMetadata();
  library = initialMeta[LIB_KEY] || emptyLibrary();
  roomState = initialMeta[STATE_KEY] || { streams: {} };
  rebuild();
  localEngine.setRoomState(roomState);

  renderAll();
  renderLocalControls();
  refreshUiFromState();

  OBR.room.onMetadataChange((metadata) => {
    const nextLibrary = metadata[LIB_KEY] || emptyLibrary();
    const libraryChanged = JSON.stringify(nextLibrary) !== JSON.stringify(library);
    library = nextLibrary;
    roomState = metadata[STATE_KEY] || { streams: {} };
    if (libraryChanged) {
      rebuild();
      renderAll();
    }
    refreshUiFromState();
    localEngine.setRoomState(roomState);
    localEngine.sync(); // no-op, пока движок выключен
  });

  // Ответы фона.
  OBR.broadcast.onMessage(CTL_CHANNEL, (event) => {
    const msg = event.data;
    if (!msg || msg.from !== "bg") return;
    if (msg.type === "status") handleStatus(msg);
  });

  // Одноразовые звуки — играем сами только в запасном режиме.
  OBR.broadcast.onMessage(SFX_CHANNEL, (event) => {
    if (audioMode !== "local") return;
    const { link, volume } = event.data || {};
    if (typeof link === "string") localEngine.playSfx(link, volume ?? 80);
  });

  // Спрашиваем фон, жив ли он и пускает ли его браузер. Если за 1.5 с ответа
  // нет — фон не загрузился (старый Owlbear / ошибка), работаем сами.
  const alreadyPlaying = Object.values(roomState.streams || {}).some((s) => s?.playing);
  sendCtl({ type: "hello" });
  statusTimer = setTimeout(() => {
    statusTimer = null;
    if (!bgSeen) {
      // Без фона играть можем только после клика (нужен жест пользователя).
      if (alreadyPlaying) showUnlockOverlay();
      else switchToLocal("no-bg");
    }
  }, 1500);

  setInterval(() => localEngine.sync(), 5000);
});
