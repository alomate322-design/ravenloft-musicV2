// Общий модуль для background.js (звук) и app.js (интерфейс):
// константы, слияние встроенного плейлиста с правками мастера, утилиты.

import { BUILTIN_FOLDERS } from "./data.js";

export const STATE_KEY = "com.ravenloft.music/state";     // room metadata: что играет
export const LIB_KEY = "com.ravenloft.music/library";     // room metadata: правки плейлиста
export const SFX_CHANNEL = "com.ravenloft.music/sfx";     // broadcast ALL: одноразовые звуки
export const CTL_CHANNEL = "com.ravenloft.music/ctl";     // broadcast LOCAL: попап <-> фон
export const LS_PREFIX = "ravenloft-music:";

export function emptyLibrary() {
  return { hidden: [], overrides: {}, customStreams: {}, customFolders: [] };
}

export function clamp01(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function toDirectUrl(link) {
  // Dropbox: документированный прямой формат — www.dropbox.com/...?rlkey=...&dl=1
  // (сервер отдаёт файл редиректом на dl.dropboxusercontent.com). Работает
  // только если у ссылки доступ «все, у кого есть ссылка» — для ссылок
  // «только приглашённые» анонимам приходит HTML вместо mp3.
  // Ходить на dl.dropboxusercontent.com напрямую нельзя: для ссылок
  // /scl/fi/... он отвечает страницей, а не файлом (проверено).
  try {
    const url = new URL(link);
    const host = url.hostname;
    if (host === "dropbox.com" || host === "www.dropbox.com") {
      url.searchParams.delete("raw");
      url.searchParams.delete("st");
      url.searchParams.set("dl", "1");
      return url.toString();
    }
  } catch {
    /* невалидный URL — отдадим как есть, ошибку покажет audio.onerror */
  }
  return link;
}

export function readLocal(key, fallback) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeLocal(key, value) {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  } catch {
    /* приватный режим / квота — не критично */
  }
}

export function readLocalAudioPrefs() {
  return {
    masterVolume: clamp01(Number(readLocal("masterVolume", 1))),
    muted: !!readLocal("muted", false),
  };
}

export function freshId(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

// id из data.js — числа, а Map/dataset/metadata работают со строками.
// Приводим к строке один раз здесь и дальше везде используем только строку.
export function normalizeId(stream) {
  return String(stream.id);
}

function applyOverride(library, stream) {
  const id = normalizeId(stream);
  const o = library.overrides?.[id];
  if (!o) return { ...stream, id };
  const merged = { ...stream, id, ...o };
  // "link" — правка ссылки первого трека, подставляем на лету.
  if (o.link) {
    merged.tracks = [
      { ...(stream.tracks[0] || {}), link: o.link, loop: o.loop ?? stream.tracks[0]?.loop },
    ];
  }
  delete merged.link;
  return merged;
}

// Возвращает { folders, index }, где index: Map<streamId, {folder, stream}>.
export function computeEffectiveFolders(library) {
  const hidden = new Set((library.hidden || []).map(String));
  const folders = [];

  for (const f of BUILTIN_FOLDERS) {
    const extra = library.customStreams?.[f.id] || [];
    const streams = [...f.streams, ...extra]
      .filter((s) => !hidden.has(normalizeId(s)))
      .map((s) => applyOverride(library, s));
    folders.push({ ...f, id: String(f.id), streams });
  }
  for (const cf of library.customFolders || []) {
    const streams = (cf.streams || [])
      .filter((s) => !hidden.has(normalizeId(s)))
      .map((s) => applyOverride(library, s));
    folders.push({ ...cf, id: String(cf.id), builtin: false, streams });
  }

  const index = new Map();
  for (const folder of folders) {
    for (const stream of folder.streams) index.set(stream.id, { folder, stream });
  }
  return { folders, index };
}

export function isBuiltinFolder(folderId) {
  return BUILTIN_FOLDERS.some((f) => String(f.id) === String(folderId));
}
