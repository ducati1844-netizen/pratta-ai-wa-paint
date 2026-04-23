const express = require("express");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN_PAINT;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
// Каталоги хранятся локально на сервере
const CATALOGS = {
  plastogum: {
    ru: "./catalogs/catalog_plastogum_RU.pdf",
    en: "./catalogs/catalog_plastogum_EN.pdf",
    th: "./catalogs/catalog_plastogum_TH.pdf"
  },
  quartz: {
    ru: "./catalogs/catalog_quartz_RU.pdf",
    en: "./catalogs/catalog_quartz_EN.pdf",
    th: "./catalogs/catalog_quartz_TH.pdf"
  }
};
const CHECKLIST_URL = process.env.PAINT_CHECKLIST_URL || "";

const BITRIX = "https://pratta.bitrix24.ru/rest/1/or2hkvvec6ktuk6y";
const BITRIX_CATEGORY = 121; // воронка Paint TG-auto

const STAGES = {
  new_lead:         "C121:NEW",
  msg1_no_answer:   "C121:UC_A0S2XP",
  msg2_no_answer:   "C121:UC_6RW4V7",
  msg3_no_answer:   "C121:UC_13YDAK",
  answer:           "C121:UC_DYSLZO",
  qualify:          "C121:PREPARATION",
  clear_task:       "C121:UC_AMH32V",
  commercial_offer: "C121:UC_AMH32V",
  invoice:          "C121:PREPAYMENT_INVOI",
  waiting_payment:  "C121:PREPAYMENT_INVOI",
  payed:            "C121:EXECUTING",
  colouring:        "C121:FINAL_INVOICE",
  delivery:         "C121:UC_39GF9W",
  received:         "C121:UC_RMP5KA",
  base_for_messages:"C121:UC_13YDAK",
  won:              "C121:WON",
  lose:             "C121:LOSE",
  apology:          "C121:APOLOGY"
};

// ── helpers ──────────────────────────────────────────────────────────────────

function getTodayStr() {
  const now = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const days = ["воскресенье","понедельник","вторник","среда","четверг","пятница","суббота"];
  const dayName = days[now.getUTCDay()];
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const min = String(now.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min} (${dayName})`;
}

function isWorkingHours() {
  const now = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const hour = now.getUTCHours();
  return hour >= 9 && hour < 20;
}

function getSystem(lang = "ru") {
  return `Ты — AI-продавец компании Pratta Thailand. Продаёшь краски Plastogum и Mister Quartz.

=== ЯЗЫК ===
Определяй язык клиента автоматически и отвечай на том же языке.
Поддерживаемые языки: русский, английский, тайский, и другие.
Текущий язык клиента определяй из его сообщений.

=== О ПРОДУКТАХ ===

**PLASTOGUM** — силоксановая краска
- Паропроницаемая, водоотталкивающая, эластичная
- Перекрывает микротрещины до 0.1 мм
- Интерьер + фасад, морской климат
- ✅ Сертифицирована для медучреждений и аллергиков
- ✅ Без формальдегида, без запаха, стандарт VOC (Европа)
- Цена: 9 900 THB / 15 л (без колеровки)
- Тара: 4 л / 15 л. Расход: 15 л = 90 м²
- Колеровка: светлые +95 THB/л, тёмные +165 THB/л
- Праймер: 1 л = 1 500 THB (~90 м²)
- Нанесение под ключ: 500 THB/м² от 300 м²

**MR QUARTZO** — краска с керамическими добавками
- Эффект лотуса — вода скатывается, поверхность самоочищается
- Wet Abrasion Class 1 (DIN 53 778) — максимальная прочность
- ✅ Допуск для медучреждений, пищевых зон, аллергиков
- ✅ Устойчива к дезинфектантам — можно мыть химией
- Лёгкий глянец. Мокрые зоны + фасад + интерьер
- Цена: 9 900 THB / 15 л (без колеровки)
- Тара: 1 л / 4 л / 15 л. Расход: 15 л = 75 м²
- Колеровка: светлые +95 THB/л, тёмные +195 THB/л

**Колеровка:** RAL, NCS, Pratta, TOA, Jotun, Benjamin Moore, Little Greene

**Экология — тейк продажи:**
Если клиент упоминает детей, аллергию, здоровье, ресторан, отель, медицину — обязательно скажи:
"Наша краска сертифицирована для медучреждений и аллергиков — без формальдегида, европейские стандарты."

**При возражении "дорого":**
Jotun: 9 л → 30 м² → 2 900 THB. Pratta: 15 л → 90 м² → 9 900 THB.
Цена за м² сопоставима — но качество, экология и результат выше.

**ОБРАЗЦЫ:** Бесплатно, доставка за счёт клиента (для удалённых клиентов).

=== ВОРОНКА ПРОДАЖ ===
В конце КАЖДОГО ответа ставь метку [STAGE:название] — служебная, клиент не видит.

Этапы:
- [STAGE:new_lead] — только что написал
- [STAGE:answer] — клиент ответил на первое сообщение
- [STAGE:qualify] — выяснили кто клиент и объект
- [STAGE:clear_task] — полностью понята задача (что красим, площадь, цвет)
- [STAGE:commercial_offer] — отправили расчёт/КП
- [STAGE:invoice] — клиент готов платить, нужен счёт (ПОДКЛЮЧИТЬ МЕНЕДЖЕРА)
- [STAGE:waiting_payment] — счёт выставлен
- [STAGE:payed] — оплата получена
- [STAGE:colouring] — идёт колеровка
- [STAGE:delivery] — отгрузка
- [STAGE:received] — клиент получил товар
- [STAGE:won] — сделка закрыта
- [STAGE:lose] — клиент отказался

=== СТИЛЬ ===
- Коротко — 2–4 предложения максимум
- Никогда не называй себя ботом
- Вместо "менеджер" говори "РОП"
- Один вопрос за раз
- Цену не давай сразу — сначала пойми задачу (кроме прямого вопроса)

=== АЛГОРИТМ ===
ШАГ 1 — вовлечение: узнай что красим, объект, площадь, Пхукет?
ШАГ 2 — квалификация: кто клиент, самостоятельно или услуга, шпаклёвка (финишная/базовая)?
ШАГ 3 — подбор: фасад/мокрые зоны → Mr Quartzo; интерьер/трещины → Plastogum
ШАГ 4 — прогрев: [SEND_CATALOG], опыт 17 лет/16 стран, шоурум (Пхукет), образцы (другой город)
ШАГ 5 — расчёт: Plastogum м²/90*15+10%; Mr Quartzo м²/75*15+10%. Добавь [CALC:продукт|литров|м²]
ШАГ 6 — закрытие: "ок/куда платить" → "Подключаю РОПа для оформления 👍" + [STAGE:invoice] + [NOTIFY_MANAGER]

=== ШПАКЛЁВКА ===
Всегда уточняй какая шпаклёвка нанесена (финишная/базовая).
Если не знает → предложи чеклист: "Хотите пришлю чеклист по подготовке? Там всё по шагам." → [SEND_CHECKLIST]

=== ВСТРЕЧА ===
Сегодня: ${getTodayStr()}
Слоты: пн–сб 10:00 11:00 14:00 16:00
При подтверждении → [MEETING:YYYY-MM-DD|HH:MM] (без этого тега встреча не создастся)
Адрес шоурума отправится автоматически — не пиши ссылку в тексте.

=== ТЕГИ (обязательные) ===
[STAGE:название] — в конце КАЖДОГО ответа
[CALC:продукт|литров|м²] — при расчёте
[MEETING:YYYY-MM-DD|HH:MM] — при подтверждении встречи
[SEND_CATALOG] — каталог продукта
[SEND_COLOR_CATALOG] — каталог цветов
[SEND_CHECKLIST] — чеклист подготовки
[NOTIFY_MANAGER] — клиент готов платить`;
}

// ── state ─────────────────────────────────────────────────────────────────────

const histories = {};
const dealIds = {};
const clientNames = {};
const clientLang = {}; // ru / en / th
const currentStage = {};
const locationSent = {};
const meetingBooked = {};
const followUpTimers = {};
const noAnswerTimers = {};
const lastActivity = {};
const calendarEventIds = {};
const reminderTimers = {};
const managerNotified = {};

// ── Bitrix ───────────────────────────────────────────────────────────────────

async function bitrixCall(method, params) {
  try {
    const res = await fetch(`${BITRIX}/${method}.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params)
    });
    return await res.json();
  } catch(e) {
    console.error("Bitrix error:", e);
    return null;
  }
}

async function createDeal(chatId, name) {
  const result = await bitrixCall("crm.deal.add", {
    fields: {
      TITLE: `Paint Bot: ${name}`,
      CATEGORY_ID: BITRIX_CATEGORY,
      STAGE_ID: STAGES.new_lead,
      SOURCE_ID: "WEBFORM",
      SOURCE_DESCRIPTION: `Telegram chat ID: ${chatId}`,
      COMMENTS: `Клиент написал в Telegram бота Pratta Paints.\nTelegram ID: ${chatId}`
    }
  });
  if (result && result.result) {
    dealIds[chatId] = result.result;
    console.log(`Deal created: ${result.result} for chat ${chatId}`);
  }
}

async function updateDealStage(chatId, stage) {
  if (!dealIds[chatId] || !STAGES[stage]) return;
  await bitrixCall("crm.deal.update", {
    id: dealIds[chatId],
    fields: { STAGE_ID: STAGES[stage] }
  });
}

async function addComment(chatId, text, fromClient) {
  if (!dealIds[chatId]) return;
  await bitrixCall("crm.timeline.comment.add", {
    fields: {
      ENTITY_ID: dealIds[chatId],
      ENTITY_TYPE: "deal",
      COMMENT: fromClient ? `👤 Клиент: ${text}` : `🤖 Бот: ${text}`
    }
  });
}

async function notifyManager(chatId, clientName, stage) {
  if (managerNotified[chatId]) return;
  const dealLink = dealIds[chatId]
    ? `https://pratta.bitrix24.ru/crm/deal/details/${dealIds[chatId]}/`
    : "";

  await bitrixCall("im.notify.personal.add", {
    USER_ID: 1,
    MESSAGE: `🔔 Клиент готов к оплате!\n\nКлиент: ${clientName}\nEtap: ${stage}\nTelegram ID: ${chatId}${dealLink ? `\nСделка: ${dealLink}` : ""}`
  });

  await bitrixCall("tasks.task.add", {
    fields: {
      TITLE: `Выставить счёт: ${clientName}`,
      RESPONSIBLE_ID: 1,
      CREATED_BY: 1,
      DESCRIPTION: `Клиент из Telegram Paint Bot готов к оплате.\nTelegram ID: ${chatId}${dealLink ? `\nСделка: ${dealLink}` : ""}`,
      PRIORITY: 2
    }
  });

  managerNotified[chatId] = true;
  console.log(`Manager notified for chat ${chatId}`);
}

// ── Calendar ─────────────────────────────────────────────────────────────────

async function createMeeting(chatId, clientName, dateStr, timeStr) {
  const [hh, mm] = timeStr.split(":");
  const endHour = String(parseInt(hh) + 1).padStart(2, "0");
  const fromDt = `${dateStr}T${hh}:${mm}:00+07:00`;
  const toDt = `${dateStr}T${endHour}:${mm}:00+07:00`;
  const dealLink = dealIds[chatId]
    ? `https://pratta.bitrix24.ru/crm/deal/details/${dealIds[chatId]}/`
    : "";

  const sectionsRes = await bitrixCall("calendar.section.get", { type: "user", ownerId: 1 });
  console.log("AVAILABLE SECTIONS:", JSON.stringify(sectionsRes));
  let sectionId = undefined;
  if (sectionsRes?.result?.length > 0) {
    sectionId = sectionsRes.result[0].ID;
  }

  if (calendarEventIds[chatId]) {
    await bitrixCall("calendar.event.delete", { type: "user", ownerId: 1, id: calendarEventIds[chatId] });
  }

  const calParams = {
    type: "user", ownerId: 1,
    name: `Paint: встреча с ${clientName}`,
    from: fromDt, to: toDt,
    timezone: "Asia/Bangkok",
    timezone_from: "Asia/Bangkok",
    timezone_to: "Asia/Bangkok",
    description: `Клиент из Telegram Paint Bot.\nДата: ${dateStr} в ${timeStr}\nМесто: Шоурум Pratta Thailand, Пхукет\nChat ID: ${chatId}${dealLink ? `\nСделка: ${dealLink}` : ""}`,
    location: "Шоурум Pratta Thailand, Пхукет",
    color: "#0088CC",
    is_full_day: "N"
  };
  if (sectionId) calParams.section = sectionId;

  const calResult = await bitrixCall("calendar.event.add", calParams);
  console.log("CAL PARAMS:", JSON.stringify(calParams));
  console.log("CAL RESULT:", JSON.stringify(calResult));
  if (calResult?.result) calendarEventIds[chatId] = calResult.result;

  await bitrixCall("im.notify.personal.add", {
    USER_ID: 1,
    MESSAGE: `📅 Новая встреча (Paint Bot)!\n\nКлиент: ${clientName}\nДата: ${dateStr} в ${timeStr}\nМесто: Шоурум Pratta Thailand${dealLink ? `\nСделка: ${dealLink}` : ""}`
  });

  console.log(`Meeting created for ${clientName} on ${dateStr} at ${timeStr}`);
}

async function scheduleReminder(chatId, dateStr, timeStr) {
  const meetingTime = new Date(`${dateStr}T${timeStr}:00+07:00`);
  const reminderTime = new Date(meetingTime.getTime() - 60 * 60 * 1000);
  const delay = reminderTime.getTime() - Date.now();
  if (delay <= 0) return;
  if (reminderTimers[chatId]) clearTimeout(reminderTimers[chatId]);
  reminderTimers[chatId] = setTimeout(async () => {
    await sendMessage(chatId, `Напоминание! Сегодня в ${timeStr} ждём вас в шоуруме Pratta Thailand.\n\nЕсли планы изменились — напишите нам.`);
  }, delay);
  console.log(`Reminder scheduled for ${chatId} in ${Math.round(delay/60000)} min`);
}

// ── Telegram ─────────────────────────────────────────────────────────────────

async function sendMessage(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" })
  });
}

async function sendLocalDocument(chatId, filePath, caption) {
  try {
    const absPath = path.resolve(__dirname, filePath);
    if (!fs.existsSync(absPath)) {
      console.log("File not found:", absPath);
      await sendMessage(chatId, caption + "\n\n(файл временно недоступен)");
      return;
    }

    // Читаем файл и кодируем в base64 для multipart
    const fileBuffer = fs.readFileSync(absPath);
    const filename = path.basename(absPath);
    const boundary = "----TelegramBoundary" + Date.now();

    const bodyParts = [];
    // chat_id
    bodyParts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}`
    );
    // caption
    bodyParts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}`
    );

    const pre = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`
    );
    const post = Buffer.from(`\r\n--${boundary}--\r\n`);

    const textBuf = Buffer.from(bodyParts.join("\r\n") + "\r\n");
    const body = Buffer.concat([textBuf, pre, fileBuffer, post]);

    const result = await fetch(`${TELEGRAM_API}/sendDocument`, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length
      },
      body
    });
    const data = await result.json();
    if (!data.ok) {
      console.log("sendLocalDocument failed:", JSON.stringify(data));
    } else {
      console.log("sendLocalDocument OK:", filename);
    }
  } catch(e) {
    console.error("sendLocalDocument error:", e.message);
  }
}

function detectLang(text) {
  if (!text) return "ru";
  const thaiChars = (text.match(/[฀-๿]/g) || []).length;
  const ruChars = (text.match(/[а-яёА-ЯЁ]/g) || []).length;
  const enChars = (text.match(/[a-zA-Z]/g) || []).length;
  if (thaiChars > 1) return "th";
  if (ruChars > 1) return "ru";
  if (enChars > 1) return "en";
  return "ru"; // default
}

function getCatalogPath(product, lang) {
  const p = product.toLowerCase().includes("quartz") ? "quartz" : "plastogum";
  const l = ["ru","en","th"].includes(lang) ? lang : "ru";
  return CATALOGS[p][l];
}

async function sendDocument(chatId, fileUrl, caption) {
  // Legacy fallback
  console.log("sendDocument URL fallback:", fileUrl);
}


async function sendLocation(chatId) {
  await sendMessage(chatId, "📍 Наш шоурум на Пхукете:\nhttps://maps.app.goo.gl/38euuyoRPJGfFFR58");
}

async function sendTyping(chatId) {
  await fetch(`${TELEGRAM_API}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" })
  });
}

async function getPhotoBase64(fileId) {
  const fileRes = await fetch(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const fileData = await fileRes.json();
  if (!fileData.ok) return null;
  const imgRes = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileData.result.file_path}`);
  const buffer = await imgRes.buffer();
  return buffer.toString("base64");
}

// ── Follow-up / No-answer system ──────────────────────────────────────────────

async function sendSmartFollowUp(chatId) {
  if (meetingBooked[chatId]) return;
  if (Date.now() - (lastActivity[chatId] || 0) < 5 * 60 * 1000) return;

  const stage = currentStage[chatId] || "new_lead";
  const hist = histories[chatId] || [];

  const prompt = `Клиент замолчал. Текущий этап: "${stage}".
Напиши короткий (1-2 предложения) живой follow-up чтобы возобновить диалог.
Этап qualify/new_lead → спроси про объект и площадь.
Этап clear_task → предложи расчёт.
Этап commercial_offer → спроси остались ли вопросы по цене.
Только текст, без тегов [STAGE] и прочего.`;

  try {
    const msgs = [...hist.slice(-6), { role: "user", content: prompt }];
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 150, system: getSystem(), messages: msgs })
    });
    const data = await res.json();
    const text = data.content.map(b => b.type === "text" ? b.text : "").join("").trim();
    if (text) await sendMessage(chatId, text);
    console.log("Smart follow-up sent, stage:", stage);
  } catch(e) {
    console.error("Follow-up error:", e);
  }
}

// No-answer sequence: 2h → msg2, +2d → msg3, +1d → base_for_messages
function scheduleNoAnswerSequence(chatId) {
  if (noAnswerTimers[chatId]) noAnswerTimers[chatId].forEach(t => clearTimeout(t));
  noAnswerTimers[chatId] = [];

  const lang = clientLang[chatId] || "ru";

  const msg1 = {
    ru: "Привет! 👋 Вы интересовались нашей краской — ещё актуально? Могу помочь с выбором.",
    en: "Hi! 👋 You were asking about our paint — still interested? Happy to help you choose.",
    th: "สวัสดี! 👋 คุณสนใจสีของเราใช่ไหม? ยังต้องการอยู่ไหม? ยินดีช่วยเลือกให้ค่ะ"
  };

  const msg2 = {
    ru: "Добрый день 🙂 Если вопрос по краске ещё в планах — напишите, с удовольствием помогу!",
    en: "Hello 🙂 If you're still considering our paint — feel free to reach out anytime!",
    th: "สวัสดี 🙂 ถ้ายังสนใจเรื่องสีอยู่ ทักมาได้เลยนะคะ ยินดีช่วยเสมอ!"
  };

  // +1ч → первый follow-up
  const t1 = setTimeout(async () => {
    if (!["new_lead","msg1_no_answer"].includes(currentStage[chatId])) return;
    if (!isWorkingHours()) return;
    await updateDealStage(chatId, "msg1_no_answer");
    currentStage[chatId] = "msg1_no_answer";
    await sendMessage(chatId, msg1[lang] || msg1.ru);
    console.log("Follow-up 1 sent for", chatId);
  }, 1 * 60 * 60 * 1000);

  // +24ч → второй follow-up → потом замолкаем
  const t2 = setTimeout(async () => {
    if (currentStage[chatId] !== "msg1_no_answer") return;
    if (!isWorkingHours()) return;
    await updateDealStage(chatId, "msg2_no_answer");
    currentStage[chatId] = "msg2_no_answer";
    await sendMessage(chatId, msg2[lang] || msg2.ru);
    // После второго → база рассылок
    setTimeout(async () => {
      await updateDealStage(chatId, "base_for_messages");
      currentStage[chatId] = "base_for_messages";
      console.log("Moved to base_for_messages:", chatId);
    }, 60 * 60 * 1000);
    console.log("Follow-up 2 sent for", chatId);
  }, 24 * 60 * 60 * 1000);

  noAnswerTimers[chatId] = [t1, t2];
}

function setFollowUpTimer(chatId) {
  scheduleNoAnswerSequence(chatId);
}

// ── Claude ────────────────────────────────────────────────────────────────────

function extractStage(reply) {
  const match = reply.match(/\[STAGE:([a-z_]+)\]/);
  return match ? match[1] : null;
}

function extractMeeting(reply) {
  const match = reply.match(/\[MEETING:([0-9-]+)\|([0-9:]+)\]/);
  return match ? { date: match[1], time: match[2] } : null;
}

async function askClaude(chatId, userMessage) {
  if (!histories[chatId]) histories[chatId] = [];
  histories[chatId].push({ role: "user", content: userMessage });
  if (histories[chatId].length > 30) histories[chatId] = histories[chatId].slice(-30);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, system: getSystem(), messages: histories[chatId] })
  });
  const data = await res.json();
  const reply = data.content.map(b => b.type === "text" ? b.text : "").join("");
  histories[chatId].push({ role: "assistant", content: reply });
  return reply;
}

async function askClaudeWithPhoto(chatId, userMessage, photoBase64) {
  if (!histories[chatId]) histories[chatId] = [];
  const userContent = [
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: photoBase64 } },
    { type: "text", text: userMessage || "Клиент прислал фото." }
  ];
  histories[chatId].push({ role: "user", content: userContent });
  if (histories[chatId].length > 30) histories[chatId] = histories[chatId].slice(-30);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, system: getSystem(), messages: histories[chatId] })
  });
  const data = await res.json();
  const reply = data.content.map(b => b.type === "text" ? b.text : "").join("");
  histories[chatId].push({ role: "assistant", content: reply });
  return reply;
}

// ── Webhook ───────────────────────────────────────────────────────────────────

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const msg = req.body.message;
  if (!msg) return;

  const hasText = !!msg.text;
  const hasPhoto = !!(msg.photo?.length > 0);
  if (!hasText && !hasPhoto) return;

  const chatId = msg.chat.id;
  const text = msg.text || msg.caption || "";
  const userName = msg.from.first_name || "Клиент";
  lastActivity[chatId] = Date.now();

  // /start
  if (text === "/start") {
    histories[chatId] = [];
    locationSent[chatId] = false;
    managerNotified[chatId] = false;
    await createDeal(chatId, userName);
    currentStage[chatId] = "new_lead";
    await updateDealStage(chatId, "msg1_no_answer");
    const greeting = `Привет! 👋 Это Pratta Thailand — краски Plastogum и Mister Quartz.\n\nЧто красите — фасад, интерьер или мокрые зоны?`;
    await sendMessage(chatId, greeting);
    scheduleNoAnswerSequence(chatId);
    setFollowUpTimer(chatId);
    return;
  }

  if (!dealIds[chatId]) {
    await createDeal(chatId, userName);
    currentStage[chatId] = "new_lead";
    scheduleNoAnswerSequence(chatId);
  }

  // Клиент ответил — отменяем no-answer таймеры
  if (noAnswerTimers[chatId]) {
    noAnswerTimers[chatId].forEach(t => clearTimeout(t));
    noAnswerTimers[chatId] = [];
  }

  clientNames[chatId] = userName;

  // Определяем язык клиента по каждому сообщению
  if (text && text.length > 3) {
    const detectedLang = detectLang(text);
    clientLang[chatId] = detectedLang; // всегда обновляем
    console.log("Detected lang:", detectedLang, "for:", text.slice(0, 30));
  }

  const commentText = hasPhoto ? `[Фото]${text ? " " + text : ""}` : text;
  await addComment(chatId, commentText, true);

  // Задержка 2–4 сек
  const delay = 2000 + Math.floor(Math.random() * 2000);
  await new Promise(r => setTimeout(r, delay));
  await sendTyping(chatId);

  try {
    let reply;
    if (hasPhoto) {
      const photo = msg.photo[msg.photo.length - 1];
      const photoBase64 = await getPhotoBase64(photo.file_id);
      reply = photoBase64
        ? await askClaudeWithPhoto(chatId, text, photoBase64)
        : await askClaude(chatId, text || "Клиент прислал фото.");
    } else {
      reply = await askClaude(chatId, text);
    }

    console.log("RAW REPLY:", reply);

    const stage = extractStage(reply);
    const meeting = extractMeeting(reply);
    const sendCatalog = reply.includes("[SEND_CATALOG]");
    const sendColorCatalog = reply.includes("[SEND_COLOR_CATALOG]");
    const sendChecklist = reply.includes("[SEND_CHECKLIST]");
    const notifyMgr = reply.includes("[NOTIFY_MANAGER]") || stage === "invoice";

    // Очищаем теги из текста для клиента
    let cleanReply = reply
      .replace(/\[STAGE:[a-z_]+\]/g, "")
      .replace(/\[CALC:[^\]]+\]/g, "")
      .replace(/\[MEETING:[^\]]+\]/g, "")
      .replace(/\[SEND_CATALOG\]/g, "")
      .replace(/\[SEND_COLOR_CATALOG\]/g, "")
      .replace(/\[SEND_CHECKLIST\]/g, "")
      .replace(/\[NOTIFY_MANAGER\]/g, "")
      .replace(/https:\/\/maps\.app\.goo\.gl\/\S+/g, "")
      .trim();

    // Геолокация — один раз за диалог при упоминании шоурума
    if (!locationSent[chatId] && (meeting || cleanReply.toLowerCase().includes("шоурум") || cleanReply.toLowerCase().includes("showroom"))) {
      await sendLocation(chatId);
      locationSent[chatId] = true;
    }

    await sendMessage(chatId, cleanReply);
    await addComment(chatId, cleanReply, false);

    // Обновляем этап
    if (stage) {
      currentStage[chatId] = stage;
      await updateDealStage(chatId, stage);
    } else if (currentStage[chatId] === "new_lead") {
      // Первый ответ клиента → answer
      currentStage[chatId] = "answer";
      await updateDealStage(chatId, "answer");
    }

    // Каталоги — отправляем локальные PDF на языке клиента
    const lang = clientLang[chatId] || "ru";
    if (sendCatalog) {
      // Определяем какой продукт обсуждался
      const hist = histories[chatId] || [];
      const histText = hist.map(m => typeof m.content === "string" ? m.content : "").join(" ").toLowerCase();
      const isQuartz = histText.includes("quartz") || histText.includes("quartzo");
      const product = isQuartz ? "quartz" : "plastogum";
      const catalogPath = getCatalogPath(product, lang);
      const catalogName = isQuartz ? "Mr Quartzo" : "Plastogum";
      await sendLocalDocument(chatId, catalogPath, `Каталог ${catalogName} 📋`);
    }
    if (sendColorCatalog) {
      // Отправляем каталоги обоих продуктов или только нужного
      const lang2 = clientLang[chatId] || "ru";
      await sendLocalDocument(chatId, CATALOGS.plastogum[lang2], "Plastogum — каталог и цены 🎨");
      await sendLocalDocument(chatId, CATALOGS.quartz[lang2], "Mr Quartzo — каталог и цены 🎨");
    }
    if (sendChecklist) {
      if (CHECKLIST_URL) {
        await sendDocument(chatId, CHECKLIST_URL, "Чеклист подготовки поверхности ✅");
      } else {
        const checklist = `✅ *Чеклист подготовки поверхности перед покраской*

1️⃣ *Шпаклёвка*
— нанесена финишная шпаклёвка
— поверхность ровная, без трещин и выбоин
— шпаклёвка полностью высохла (мин. 24–48 ч)

2️⃣ *Грунтовка*
— нанесён праймер Pratta (или совместимый)
— праймер высох полностью

3️⃣ *Поверхность*
— чистая, без пыли, жира, высолов
— влажность стены < 8%
— температура при нанесении: +10°C … +35°C

4️⃣ *Мокрые зоны*
— использована влагостойкая шпаклёвка
— рекомендуется Mister Quartz (эффект лотуса)

5️⃣ *Фасад*
— поверхность защищена от дождя мин. 24 ч до и после нанесения

💡 Правильная подготовка = экономия краски и долговечность результата`;
        await sendMessage(chatId, checklist);
      }
    }

    // Встреча
    if (meeting) {
      await createMeeting(chatId, clientNames[chatId] || userName, meeting.date, meeting.time);
      meetingBooked[chatId] = true;
      await scheduleReminder(chatId, meeting.date, meeting.time);
    }

    // Уведомление менеджера при invoice
    if (notifyMgr) {
      await notifyManager(chatId, clientNames[chatId] || userName, stage || "invoice");
    }

  } catch(e) {
    console.error(e);
    await sendMessage(chatId, "Произошла ошибка, попробуйте ещё раз.");
  }

  setFollowUpTimer(chatId);
});

app.get("/", (req, res) => res.send("Pratta Paint Bot работает ✓"));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Paint Bot running on port ${PORT}`));
