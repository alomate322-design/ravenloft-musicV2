// Движок воспроизведения. Не знает ничего про Owlbear — ему просто отдают
// индекс стримов, состояние комнаты и локальные настройки громкости, а он
// приводит <audio>-элементы в соответствие. Один и тот же класс используется:
//  - в background.js — основной режим, звук живёт всю сессию;
//  - в app.js — запасной режим, если браузер не пустил звук в фоне.

import { clamp01, toDirectUrl } from "./library.js";

const DRIFT_TOLERANCE_SEC = 1.5;

// 10 мс тишины (8 кГц, 8 бит, моно) — для проверки разрешения на звук.
const SILENT_WAV =
  "data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";

export class AudioEngine {
  constructor({ tag = "engine", onBlocked, onUnblocked, onEnded } = {}) {
    this.tag = tag;
    this.onBlocked = onBlocked;
    this.onUnblocked = onUnblocked;
    this.onEnded = onEnded;

    this.index = new Map(); // streamId -> {folder, stream}
    this.roomState = { streams: {} };
    this.local = { masterVolume: 1, muted: false };

    this.audioEls = new Map();        // streamId -> HTMLAudioElement
    this.fadeAnimations = new Map();  // streamId -> {cancelled}
    this.lastPlaying = new Map();     // streamId -> boolean
    this.enabled = true;

    // unlocked — хотя бы один play() прошёл; blocked — последний play()
    // отклонён браузером (NotAllowedError), т.е. нужен жест пользователя.
    this.unlocked = false;
    this.blocked = false;
  }

  // ---------- входные данные ----------

  setIndex(index) {
    this.index = index;
    // Стримы, которых больше нет (скрыты/удалены мастером), выключаем.
    for (const [id, el] of this.audioEls) {
      if (!index.has(id)) {
        this.cancelFade(id);
        el.pause();
        el.removeAttribute("src");
        this.audioEls.delete(id);
        this.lastPlaying.delete(id);
      }
    }
  }

  setRoomState(state) {
    this.roomState = state && typeof state === "object" ? state : { streams: {} };
    if (!this.roomState.streams) this.roomState.streams = {};
  }

  setLocal({ masterVolume, muted }) {
    if (typeof masterVolume === "number") this.local.masterVolume = clamp01(masterVolume);
    if (typeof muted === "boolean") this.local.muted = muted;
    // Применяем сразу ко всему, что играет (без затухания).
    for (const [id, el] of this.audioEls) {
      if (this.fadeAnimations.has(id)) continue;
      const entry = this.index.get(id);
      const st = this.roomState.streams[id];
      if (entry && st?.playing) this.applyVolume(el, st.volume ?? entry.stream.volume ?? 80);
    }
  }

  // Полная остановка (используется попапом, когда фон перехватывает звук).
  stopAll() {
    this.enabled = false;
    for (const [id, el] of this.audioEls) {
      this.cancelFade(id);
      el.pause();
    }
    this.lastPlaying.clear();
  }

  resume() {
    this.enabled = true;
    this.sync();
  }

  // ---------- внутренности ----------

  getOrCreateAudio(streamId) {
    let el = this.audioEls.get(streamId);
    if (!el) {
      el = new Audio();
      el.preload = "auto";
      el.addEventListener("error", () => {
        console.warn(`[Ravenloft Music/${this.tag}] ошибка потока`, streamId, el.src, el.error);
      });
      // Как только известна длительность — пересчитываем позицию (важно для
      // тех, кто зашёл посреди трека: до этого момента мы не знали, куда
      // мотать).
      el.addEventListener("loadedmetadata", () => this.syncStream(streamId));
      el.addEventListener("ended", () => {
        if (!el.loop) this.onEnded?.(streamId);
      });
      this.audioEls.set(streamId, el);
    }
    return el;
  }

  applyVolume(el, baseVolumePercent) {
    const combined =
      clamp01((baseVolumePercent ?? 0) / 100) *
      clamp01(this.local.masterVolume) *
      (this.local.muted ? 0 : 1);
    try {
      // Всегда в [0,1] — тот самый IndexSizeError из DJinni здесь невозможен.
      el.volume = clamp01(combined);
    } catch (e) {
      console.warn(`[Ravenloft Music/${this.tag}] не удалось выставить громкость`, e);
    }
  }

  cancelFade(streamId) {
    const anim = this.fadeAnimations.get(streamId);
    if (anim) anim.cancelled = true;
    this.fadeAnimations.delete(streamId);
  }

  fadeVolume(el, streamId, fromPercent, toPercent, durationMs, onDone) {
    this.cancelFade(streamId);
    if (!durationMs || durationMs <= 0) {
      this.applyVolume(el, toPercent);
      onDone?.();
      return;
    }
    const token = { cancelled: false };
    this.fadeAnimations.set(streamId, token);
    const start = performance.now();
    const step = (now) => {
      if (token.cancelled) return;
      const t = Math.min(1, (now - start) / durationMs);
      this.applyVolume(el, fromPercent + (toPercent - fromPercent) * t);
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        this.fadeAnimations.delete(streamId);
        onDone?.();
      }
    };
    requestAnimationFrame(step);
  }

  handlePlayResult(promise) {
    if (!promise || typeof promise.then !== "function") return;
    promise
      .then(() => {
        const wasBlocked = this.blocked;
        this.unlocked = true;
        this.blocked = false;
        if (wasBlocked || !this._reportedUnlocked) {
          this._reportedUnlocked = true;
          this.onUnblocked?.();
        }
      })
      .catch((err) => {
        if (err && err.name === "NotAllowedError") {
          // Браузер требует жест пользователя. Не ошибка, просто ждём.
          const wasBlocked = this.blocked;
          this.blocked = true;
          if (!wasBlocked) this.onBlocked?.();
        } else if (err && err.name === "AbortError") {
          // play() прерван новым src/pause() — штатно.
        } else {
          console.warn(`[Ravenloft Music/${this.tag}] play() не удался`, err);
        }
      });
  }

  // ---------- синхронизация ----------

  syncStream(streamId) {
    if (!this.enabled) return;
    const entry = this.index.get(streamId);
    if (!entry || entry.stream.type !== "loop") return;
    const { stream } = entry;
    const state = this.roomState.streams[streamId];
    const el = this.getOrCreateAudio(streamId);
    const wasPlaying = this.lastPlaying.get(streamId) ?? false;
    const targetVolume = state?.volume ?? stream.volume ?? 80;
    const fadeMs = Math.max(0, Number(stream.fadeMs) || 0);

    if (!state || !state.playing) {
      if (wasPlaying && !el.paused) {
        this.fadeVolume(el, streamId, targetVolume, 0, fadeMs, () => el.pause());
      } else if (!el.paused) {
        this.cancelFade(streamId);
        el.pause();
      }
      this.lastPlaying.set(streamId, false);
      return;
    }

    const track = stream.tracks[state.trackIndex ?? 0];
    if (!track) return;

    const wantSrc = toDirectUrl(track.link);
    if (el.dataset.link !== wantSrc) {
      el.src = wantSrc;
      el.dataset.link = wantSrc;
    }
    const loop = stream.loop ?? track.loop ?? true;
    el.loop = loop;

    const startedAt = typeof state.startedAt === "number" ? state.startedAt : Date.now();
    const elapsed = Math.max(0, (Date.now() - startedAt) / 1000);
    const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null;

    // Незацикленный трек, который уже отыграл для всех: не запускаем и не
    // мотаем за конец (раньше именно это давало «тишину» у опоздавших).
    if (!loop && duration && elapsed >= duration) {
      if (!el.paused) el.pause();
      this.lastPlaying.set(streamId, false);
      return;
    }

    const target = duration ? (loop ? elapsed % duration : elapsed) : null;
    const justStarted = !wasPlaying;

    if (el.paused) {
      if (target !== null) this.seek(el, target);
      // если длительность ещё неизвестна — доедем по loadedmetadata
      this.applyVolume(el, justStarted && fadeMs > 0 ? 0 : targetVolume);
      const p = el.play();
      this.handlePlayResult(
        p &&
          p.then(() => {
            if (justStarted && fadeMs > 0) this.fadeVolume(el, streamId, 0, targetVolume, fadeMs);
          }),
      );
    } else {
      if (!this.fadeAnimations.has(streamId)) this.applyVolume(el, targetVolume);
      if (target !== null && Math.abs(el.currentTime - target) > DRIFT_TOLERANCE_SEC) {
        this.seek(el, target);
      }
    }

    this.lastPlaying.set(streamId, true);
  }

  seek(el, seconds) {
    try {
      el.currentTime = seconds;
    } catch {
      /* метаданные ещё не загружены */
    }
  }

  sync() {
    if (!this.enabled) return;
    for (const streamId of this.index.keys()) this.syncStream(streamId);
  }

  // ---------- проверка разрешения ----------

  // Пробуем проиграть 10 мс тишины. Единственный честный способ узнать,
  // пустит ли браузер звук прямо сейчас, не дожидаясь, пока мастер что-то
  // включит. Обновляет unlocked/blocked и дёргает onBlocked/onUnblocked.
  probe() {
    const el = new Audio(SILENT_WAV);
    el.volume = 1;
    const p = el.play();
    this.handlePlayResult(p);
    return (p || Promise.resolve()).then(
      () => true,
      () => false,
    );
  }

  // ---------- одноразовые звуки ----------

  playSfx(link, volumePercent) {
    if (!this.enabled) return;
    const el = new Audio(toDirectUrl(link));
    this.applyVolume(el, volumePercent ?? 80);
    this.handlePlayResult(el.play());
  }
}
