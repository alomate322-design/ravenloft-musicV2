// Фоновая страница расширения (manifest.background_url). Owlbear загружает её
// невидимо при входе в комнату и не выгружает, пока комната открыта — в
// отличие от попапа, который уничтожается при каждом клике по карте.
// Поэтому весь звук живёт здесь. Попап — только пульт управления.

import OBR from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk@3.1.0/+esm";
import {
  STATE_KEY,
  LIB_KEY,
  SFX_CHANNEL,
  CTL_CHANNEL,
  emptyLibrary,
  computeEffectiveFolders,
  readLocalAudioPrefs,
} from "./library.js";
import { AudioEngine } from "./audio-engine.js";

let role = "PLAYER";
let library = emptyLibrary();
let roomState = { streams: {} };
let notifiedBlocked = false;

const engine = new AudioEngine({
  tag: "bg",
  onBlocked: async () => {
    // Браузер не пустил звук без жеста. Помечаем значок расширения и один раз
    // подсказываем — любой клик в комнате (или кнопка в попапе) снимает блок.
    await setBadge("🔇");
    if (!notifiedBlocked) {
      notifiedBlocked = true;
      try {
        await OBR.notification.show(
          "Ravenloft Music: нажми в любом месте комнаты или открой плеер, чтобы включить звук",
          "WARNING",
        );
      } catch {
        /* ignore */
      }
    }
    sendStatus();
  },
  onUnblocked: async () => {
    await setBadge(undefined);
    sendStatus();
  },
  onEnded: async (streamId) => {
    // Незацикленный трек доиграл. Мастер (и только он) снимает флаг playing,
    // чтобы кнопка в интерфейсе не висела в состоянии «играет».
    if (role !== "GM") return;
    const st = roomState.streams?.[streamId];
    if (!st?.playing) return;
    const next = { streams: { ...roomState.streams, [streamId]: { ...st, playing: false } } };
    roomState = next;
    try {
      await OBR.room.setMetadata({ [STATE_KEY]: next });
    } catch (e) {
      console.warn("[Ravenloft Music/bg] не удалось обновить состояние", e);
    }
  },
});

async function setBadge(text) {
  try {
    await OBR.action.setBadgeText(text);
  } catch {
    try {
      await OBR.action.setBadgeText(text ?? "");
    } catch {
      /* ignore */
    }
  }
}

function sendStatus() {
  OBR.broadcast
    .sendMessage(
      CTL_CHANNEL,
      { from: "bg", type: "status", unlocked: engine.unlocked, blocked: engine.blocked },
      { destination: "LOCAL" },
    )
    .catch(() => {});
}

function rebuild() {
  const { index } = computeEffectiveFolders(library);
  engine.setIndex(index);
}

OBR.onReady(async () => {
  try {
    role = await OBR.player.getRole();
  } catch {
    role = "PLAYER";
  }

  const meta = await OBR.room.getMetadata();
  library = meta[LIB_KEY] || emptyLibrary();
  roomState = meta[STATE_KEY] || { streams: {} };
  rebuild();
  engine.setLocal(readLocalAudioPrefs());
  engine.setRoomState(roomState);
  engine.sync();

  OBR.room.onMetadataChange((metadata) => {
    const nextLibrary = metadata[LIB_KEY] || emptyLibrary();
    if (JSON.stringify(nextLibrary) !== JSON.stringify(library)) {
      library = nextLibrary;
      rebuild();
    }
    roomState = metadata[STATE_KEY] || { streams: {} };
    engine.setRoomState(roomState);
    engine.sync();
  });

  OBR.player.onChange((player) => {
    if (player?.role) role = player.role;
  });

  // Одноразовые звуки: мастер шлёт broadcast ALL, каждый фон проигрывает у себя.
  OBR.broadcast.onMessage(SFX_CHANNEL, (event) => {
    const { link, volume } = event.data || {};
    if (typeof link === "string") engine.playSfx(link, volume ?? 80);
  });

  // Канал попап -> фон (только внутри этого клиента).
  OBR.broadcast.onMessage(CTL_CHANNEL, (event) => {
    const msg = event.data;
    if (!msg || msg.from !== "ui") return;
    switch (msg.type) {
      case "hello":
      case "unlock":
        // Попап открыт / пользователь нажал «включить звук». Проверяем
        // разрешение на звук прямо сейчас (клик в попапе активирует и
        // родительскую страницу Owlbear, а с permission "autoplay" в манифесте
        // этого достаточно), затем догоняем состояние и отвечаем попапу.
        engine.setLocal(readLocalAudioPrefs());
        engine.probe().then(() => {
          engine.sync();
          sendStatus();
        });
        break;
      case "local":
        engine.setLocal({ masterVolume: msg.masterVolume, muted: msg.muted });
        break;
      default:
        break;
    }
  });

  // Периодическая сверка: дрейф позиции, повтор play() после блокировки,
  // страховка на случай пропущенного события metadata.
  setInterval(() => engine.sync(), 5000);
});
