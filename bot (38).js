const express = require("express");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

// Раздаём каталоги как статику — Wazzup скачает их по публичному URL
app.use("/catalogs", express.static(path.join(__dirname, "catalogs")));

// ── Config ────────────────────────────────────────────────────────────────────
const ANTHROPIC_KEY   = process.env.ANTHROPIC_KEY;
const WAZZUP_API_KEY  = process.env.WAZZUP_API_KEY;
const WAZZUP_CHANNEL  = process.env.WAZZUP_CHANNEL_ID; // 67488dc4-5c0f-45d7-b453-10dbb606dff9
const WAZZUP_API      = "https://api.wazzup24.com/v3";

// Публичный URL этого сервера (нужен для отправки файлов в Wazzup)
// Установи переменную окружения PUBLIC_URL=https://your-domain.com
const PUBLIC_URL      = (process.env.PUBLIC_URL || "https://pratta-ai-wa-paint-production.up.railway.app").replace(/\/$/, "");

const BITRIX          = "https://pratta.bitrix24.ru/rest/1/or2hkvvec6ktuk6y";
const BITRIX_CATEGORY = 121; // Paint TG-auto

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

// Ключевые слова для активации бота
const TRIGGER_WORDS = [
  "plastogum", "plasto", "quartzo", "quartz", "краска", "paint", "сколько стоит",
  "покрасить", "фасад", "стены", "колеровка", "pratta", "สี", "painting"
];

// ── Catalogs ──────────────────────────────────────────────────────────────────
const CATALOG_DIR = path.join(__dirname, "catalogs");
const CATALOGS = {
  plastogum: {
    ru: path.join(CATALOG_DIR, "catalog_plastogum_RU.pdf"),
    en: path.join(CATALOG_DIR, "catalog_plastogum_EN.pdf"),
    th: path.join(CATALOG_DIR, "catalog_plastogum_TH.pdf")
  },
  quartz: {
    ru: path.join(CATALOG_DIR, "catalog_quartz_RU.pdf"),
    en: path.join(CATALOG_DIR, "catalog_quartz_EN.pdf"),
    th: path.join(CATALOG_DIR, "catalog_quartz_TH.pdf")
  },
  colors: path.join(CATALOG_DIR, "color_catalog.pdf")
};

// ── State ─────────────────────────────────────────────────────────────────────
const histories       = {};
const dealIds         = {};
const clientNames     = {};
const clientLang      = {};
const currentStage    = {};
const locationSent    = {};
const meetingBooked   = {};
const followUpTimers  = {};
const noAnswerTimers  = {};
const lastActivity    = {};
const managerNotified = {};
const botActive       = {}; // бот активен для этого чата?

// ── Helpers ───────────────────────────────────────────────────────────────────
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

function detectLang(text) {
  if (!text) return "ru";
  const thaiChars = (text.match(/[\u0E00-\u0E7F]/g) || []).length;
  const ruChars   = (text.match(/[а-яёА-ЯЁ]/g) || []).length;
  const enChars   = (text.match(/[a-zA-Z]/g) || []).length;
  if (thaiChars > 1) return "th";
  if (ruChars > 1)   return "ru";
  if (enChars > 1)   return "en";
  return "ru";
}

function hasTriggerWord(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return TRIGGER_WORDS.some(w => lower.includes(w));
}

function getSystem() {
  return `Ты — консультант компании Pratta Thailand. Продаёшь краски Plastogum и Mr Quartzo через WhatsApp.

=== ЯЗЫК ===
Отвечай на языке клиента (RU / EN / TH).

=== ПРОДУКТЫ ===

**PLASTOGUM** — силоксановая краска
- Паропроницаемая, водоотталкивающая, эластичная
- Перекрывает микротрещины до 0.1 мм
- Интерьер + фасад, морской климат
- ✅ Сертифицирована для медучреждений и аллергиков
- ✅ Без формальдегида, без запаха, стандарт VOC (Европа)
- Цена: 9 900 THB / 15 л. Расход: 15 л = 90 м²
- Тара: 4 л / 15 л
- Колеровка: светлые +95 THB/л, тёмные +165 THB/л
- Праймер: 1 л = 1 500 THB (~90 м²)
- Нанесение под ключ: 500 THB/м² от 300 м²

**MR QUARTZO** — краска с керамическими добавками
- Эффект лотуса — вода скатывается, поверхность самоочищается
- Wet Abrasion Class 1 (DIN 53 778)
- ✅ Допуск для медучреждений, пищевых зон, аллергиков
- ✅ Устойчива к дезинфектантам
- Лёгкий глянец. Мокрые зоны + фасад + интерьер
- Цена: 9 900 THB / 15 л. Расход: 15 л = 75 м²
- Тара: 1 л / 4 л / 15 л
- Колеровка: светлые +95 THB/л, тёмные +195 THB/л

**Колеровка:** RAL, NCS, Pratta, TOA, Jotun, Benjamin Moore, Little Greene

**Экология — тейк продажи:**
Если клиент упоминает детей, аллергию, здоровье, ресторан, отель, медицину — скажи:
"Наша краска сертифицирована для медучреждений и аллергиков — без формальдегида, европейские стандарты."

**При возражении "дорого":**
Jotun: 9 л → 30 м² → 2 900 THB. Pratta: 15 л → 90 м² → 9 900 THB.
Цена за м² сопоставима — но качество, экология и результат выше.

**ОБРАЗЦЫ:** Бесплатно, доставка за счёт клиента (для удалённых клиентов).

=== СТИЛЬ ===
- Коротко — 2–4 предложения максимум
- Никогда не называй себя ботом
- Вместо "менеджер" говори "РОП"
- Один вопрос за раз
- Цену не давай сразу — сначала пойми задачу (кроме прямого вопроса)
- Это WhatsApp — стиль неформальный, тёплый

=== АЛГОРИТМ ===
ШАГ 1 — вовлечение: узнай что красим, объект, площадь, Пхукет?
ШАГ 2 — квалификация: кто клиент, самостоятельно или услуга, шпаклёвка (финишная/базовая)?
ШАГ 3 — подбор: фасад/мокрые зоны → Mr Quartzo; интерьер/трещины → Plastogum
ШАГ 4 — прогрев: [SEND_CATALOG], опыт 17 лет/16 стран, шоурум (Пхукет), образцы (другой город)
ШАГ 5 — расчёт: Plastogum м²/90*15+10%; Mr Quartzo м²/75*15+10%. Добавь [CALC:продукт|литров|м²]
ШАГ 6 — закрытие: "ок/куда платить" → "Подключаю РОПа для оформления 👍" + [STAGE:invoice] + [NOTIFY_MANAGER]

=== ШПАКЛЁВКА ===
Всегда уточняй какая шпаклёвка нанесена (финишная/базовая).
Если не знает → [SEND_CHECKLIST]

=== ШОУРУМ ===
Адрес: https://maps.app.goo.gl/38euuyoRPJGfFFR58
Если клиент на Пхукете — пригласи. Ссылку можно написать в тексте (это WhatsApp, не Telegram).

=== ВСТРЕЧА ===
Сегодня: ${getTodayStr()}
Слоты: пн–сб 10:00 11:00 14:00 16:00
При подтверждении → [MEETING:YYYY-MM-DD|HH:MM]

=== ТЕГИ (обязательные) ===
[STAGE:название] — в конце КАЖДОГО ответа
[CALC:продукт|литров|м²] — при расчёте
[MEETING:YYYY-MM-DD|HH:MM] — при подтверждении встречи
[SEND_CATALOG] — каталог продукта
[SEND_COLOR_CATALOG] — каталог цветов
[SEND_CHECKLIST] — чеклист подготовки
[NOTIFY_MANAGER] — клиент готов платить`;
}

// ── Wazzup API ────────────────────────────────────────────────────────────────
async function wazzupSendMessage(chatId, phone, text) {
  try {
    const res = await fetch(`${WAZZUP_API}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${WAZZUP_API_KEY}`
      },
      body: JSON.stringify({
        channelId: WAZZUP_CHANNEL,
        chatType: "whatsapp",
        chatId: phone, // номер телефона
        text
      })
    });
    const data = await res.json();
    if (!res.ok) console.error("Wazzup send error:", JSON.stringify(data));
    else console.log("Wazzup message sent to", phone);
  } catch(e) {
    console.error("Wazzup send exception:", e.message);
  }
}

async function wazzupSendDocument(phone, filePath, caption) {
  try {
    if (!fs.existsSync(filePath)) {
      console.log("File not found:", filePath);
      await wazzupSendMessage(null, phone, caption + "\n\n(файл временно недоступен)");
      return;
    }

    // Wazzup требует публичный URL файла (contentUri), multipart не поддерживается
    const filename = path.basename(filePath);
    const publicUrl = `${PUBLIC_URL}/catalogs/${filename}`;
    console.log("Sending doc via contentUri:", publicUrl);

    // Сначала отправляем caption текстом, затем файл без text
    await wazzupSendMessage(null, phone, caption);

    const res = await fetch(`${WAZZUP_API}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${WAZZUP_API_KEY}`
      },
      body: JSON.stringify({
        channelId: WAZZUP_CHANNEL,
        chatType: "whatsapp",
        chatId: phone,
        contentUri: publicUrl
      })
    });
    const data = await res.json();
    if (!res.ok) console.error("Wazzup doc error:", JSON.stringify(data));
    else console.log("Wazzup doc sent:", filename);
  } catch(e) {
    console.error("Wazzup doc exception:", e.message);
  }
}

// ── Bitrix ────────────────────────────────────────────────────────────────────
async function bitrixCall(method, params) {
  try {
    const res = await fetch(`${BITRIX}/${method}.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params)
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      console.error(`Bitrix ${method} ERROR:`, JSON.stringify(data));
    }
    return data;
  } catch(e) {
    console.error(`Bitrix ${method} EXCEPTION:`, e.message);
    return null;
  }
}

async function createDeal(chatId, name, phone) {
  const result = await bitrixCall("crm.deal.add", {
    fields: {
      TITLE: `WhatsApp: ${name} (${phone})`,
      CATEGORY_ID: BITRIX_CATEGORY,
      STAGE_ID: STAGES.new_lead,
      SOURCE_ID: "WEBFORM",
      SOURCE_DESCRIPTION: `WhatsApp: ${phone}`,
      COMMENTS: `Клиент написал через WhatsApp.\nТелефон: ${phone}`
    }
  });
  if (result?.result) {
    dealIds[chatId] = result.result;
    console.log(`Deal created: ${result.result} for WA ${phone}`);
  }
}

async function updateDealStage(chatId, stage) {
  if (!dealIds[chatId]) {
    console.error(`updateDealStage: no dealId for ${chatId}`);
    return;
  }
  if (!STAGES[stage]) {
    console.error(`updateDealStage: unknown stage "${stage}"`);
    return;
  }
  const stageId = STAGES[stage];
  console.log(`Bitrix update deal ${dealIds[chatId]}: stage → ${stage} (${stageId})`);
  const result = await bitrixCall("crm.deal.update", {
    id: dealIds[chatId],
    fields: { STAGE_ID: stageId }
  });
  if (result?.result === true) {
    console.log(`Bitrix deal ${dealIds[chatId]} updated OK`);
  } else {
    console.error(`Bitrix deal update FAILED:`, JSON.stringify(result));
  }
}

async function addComment(chatId, text, fromClient) {
  if (!dealIds[chatId]) return;
  await bitrixCall("crm.timeline.comment.add", {
    fields: {
      ENTITY_ID: dealIds[chatId],
      ENTITY_TYPE: "deal",
      COMMENT: fromClient ? `👤 Клиент (WA): ${text}` : `🤖 Бот: ${text}`
    }
  });
}

async function notifyManager(chatId, clientName, phone) {
  if (managerNotified[chatId]) return;
  const dealLink = dealIds[chatId]
    ? `https://pratta.bitrix24.ru/crm/deal/details/${dealIds[chatId]}/`
    : "";
  await bitrixCall("im.notify.personal.add", {
    USER_ID: 1,
    MESSAGE: `🔔 WhatsApp — клиент готов к оплате!\n\nКлиент: ${clientName}\nТелефон: ${phone}${dealLink ? `\nСделка: ${dealLink}` : ""}`
  });
  managerNotified[chatId] = true;
}

// ── Calendar ──────────────────────────────────────────────────────────────────
async function createMeeting(chatId, clientName, dateStr, timeStr) {
  const [hh, mm] = timeStr.split(":");
  const endHour = String(parseInt(hh) + 1).padStart(2, "0");
  const fromDt = `${dateStr}T${hh}:${mm}:00+07:00`;
  const toDt = `${dateStr}T${endHour}:${mm}:00+07:00`;
  const dealLink = dealIds[chatId]
    ? `https://pratta.bitrix24.ru/crm/deal/details/${dealIds[chatId]}/`
    : "";

  const sectionsRes = await bitrixCall("calendar.section.get", { type: "user", ownerId: 1 });
  let sectionId;
  if (sectionsRes?.result?.length > 0) sectionId = sectionsRes.result[0].ID;

  const calParams = {
    type: "user", ownerId: 1,
    name: `WhatsApp: встреча с ${clientName}`,
    from: fromDt, to: toDt,
    timezone: "Asia/Bangkok",
    timezone_from: "Asia/Bangkok",
    timezone_to: "Asia/Bangkok",
    description: `Клиент из WhatsApp.\nДата: ${dateStr} в ${timeStr}\nМесто: Шоурум Pratta Thailand, Пхукет${dealLink ? `\nСделка: ${dealLink}` : ""}`,
    location: "Шоурум Pratta Thailand, Пхукет",
    color: "#25D366",
    is_full_day: "N"
  };
  if (sectionId) calParams.section = sectionId;

  const calResult = await bitrixCall("calendar.event.add", calParams);
  console.log("CAL RESULT:", JSON.stringify(calResult));

  await bitrixCall("im.notify.personal.add", {
    USER_ID: 1,
    MESSAGE: `📅 Новая встреча (WhatsApp)!\n\nКлиент: ${clientName}\nДата: ${dateStr} в ${timeStr}\nМесто: Шоурум Pratta Thailand${dealLink ? `\nСделка: ${dealLink}` : ""}`
  });
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
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 1500,
      system: getSystem(),
      messages: histories[chatId]
    })
  });

  const data = await res.json();
  if (!data.content) {
    console.error("Claude API error:", JSON.stringify(data));
    throw new Error("Claude API error");
  }
  const reply = data.content.map(b => b.type === "text" ? b.text : "").join("");
  histories[chatId].push({ role: "assistant", content: reply });
  return reply;
}

// ── Follow-up ─────────────────────────────────────────────────────────────────
const MIN15  = 15 * 60 * 1000;
const HOUR23 = 23 * 60 * 60 * 1000;

// Вспомогательная функция: отправить в рабочее время, иначе отложить до 10:00
async function sendWhenWorking(phone, text, delayIfOff = 0) {
  if (isWorkingHours()) {
    await wazzupSendMessage(null, phone, text);
  } else {
    // Считаем сколько ждать до 10:00 следующего рабочего дня
    const now = new Date(Date.now() + 7 * 60 * 60 * 1000);
    let wait = (10 - now.getUTCHours()) * 60 * 60 * 1000 - now.getUTCMinutes() * 60 * 1000;
    if (wait < 0) wait += 24 * 60 * 60 * 1000; // уже после 10 — ждём до завтра
    setTimeout(async () => { await wazzupSendMessage(null, phone, text); }, wait);
  }
}

// Сценарий 1: клиент написал первый раз но НЕ ответил боту
// 15 мин → 23 ч → 23 ч
function scheduleNoAnswerSequence(chatId, phone) {
  if (noAnswerTimers[chatId]) noAnswerTimers[chatId].forEach(t => clearTimeout(t));
  noAnswerTimers[chatId] = [];

  const t1 = setTimeout(async () => {
    if (currentStage[chatId] !== "new_lead") return;
    await updateDealStage(chatId, "msg1_no_answer");
    currentStage[chatId] = "msg1_no_answer";
    await sendWhenWorking(phone, "Привет! 👋 Вы недавно интересовались нашей краской.\n\nЕщё актуально? Подберу вариант под вашу задачу.");
    console.log("WA no-answer 1st:", phone);
  }, MIN15);

  const t2 = setTimeout(async () => {
    if (currentStage[chatId] !== "msg1_no_answer") return;
    await updateDealStage(chatId, "msg2_no_answer");
    currentStage[chatId] = "msg2_no_answer";
    await sendWhenWorking(phone, "Добрый день 🙂\n\nЕсли вопрос по краске ещё актуален — я здесь. Могу рассчитать количество и стоимость.");
    console.log("WA no-answer 2nd:", phone);
  }, MIN15 + HOUR23);

  const t3 = setTimeout(async () => {
    if (currentStage[chatId] !== "msg2_no_answer") return;
    await updateDealStage(chatId, "msg3_no_answer");
    currentStage[chatId] = "msg3_no_answer";
    await sendWhenWorking(phone, "Последнее сообщение 🙏\n\nКогда будете готовы — напишите. Всегда поможем!");
    console.log("WA no-answer 3rd:", phone);
    setTimeout(async () => {
      if (currentStage[chatId] === "msg3_no_answer") {
        await updateDealStage(chatId, "base_for_messages");
        currentStage[chatId] = "base_for_messages";
      }
    }, HOUR23);
  }, MIN15 + HOUR23 + HOUR23);

  noAnswerTimers[chatId] = [t1, t2, t3];
}

// Сценарий 2: клиент переписывался но замолчал
// 15 мин → 23 ч → 23 ч (с контекстом диалога)
function setFollowUpTimer(chatId, phone) {
  const stage = currentStage[chatId];
  if (!stage || ["new_lead","msg1_no_answer","msg2_no_answer","msg3_no_answer","base_for_messages","won","lose"].includes(stage)) return;

  if (followUpTimers[chatId]) followUpTimers[chatId].forEach(t => clearTimeout(t));

  const makeFollowUp = (attempt) => async () => {
    if (meetingBooked[chatId]) return;
    const st = currentStage[chatId] || "answer";
    if (["won","lose","base_for_messages"].includes(st)) return;
    const hist = histories[chatId] || [];
    const prompts = [
      `Клиент замолчал после переписки. Попытка №1 (через 15 мин). Этап: "${st}". Напиши короткое тёплое сообщение — напомни о чём говорили, спроси всё ли в порядке. Только текст, без тегов, 1-2 предложения.`,
      `Клиент не отвечает уже сутки. Попытка №2. Этап: "${st}". Напиши живое сообщение с мягким дожимом, можно упомянуть выгоду или дедлайн. Только текст, без тегов, 1-2 предложения.`,
      `Клиент молчит двое суток. Финальная попытка №3. Этап: "${st}". Напиши прощальное но тёплое сообщение — оставь дверь открытой. Только текст, без тегов, 1-2 предложения.`
    ];
    try {
      const msgs = [...hist.slice(-8), { role: "user", content: prompts[attempt - 1] }];
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 200, system: getSystem(), messages: msgs })
      });
      const data = await res.json();
      if (!data.content) return;
      const text = data.content.map(b => b.type === "text" ? b.text : "").join("").trim();
      if (text) await sendWhenWorking(phone, text);
      console.log(`WA follow-up #${attempt} sent to ${phone}`);
    } catch(e) { console.error("WA follow-up error:", e.message); }
  };

  const t1 = setTimeout(makeFollowUp(1), MIN15);
  const t2 = setTimeout(makeFollowUp(2), MIN15 + HOUR23);
  const t3 = setTimeout(async () => {
    await makeFollowUp(3)();
    setTimeout(async () => {
      if (!["won","lose","payed","colouring","delivery","received"].includes(currentStage[chatId])) {
        await updateDealStage(chatId, "base_for_messages");
        currentStage[chatId] = "base_for_messages";
      }
    }, HOUR23);
  }, MIN15 + HOUR23 + HOUR23);

  followUpTimers[chatId] = [t1, t2, t3];
}

// ── Fallback определение этапа по тексту ─────────────────────────────────────
function detectStageFromReply(reply, userMsg, current) {
  const r = reply.toLowerCase();
  const u = (userMsg || "").toLowerCase();

  // Оплата / инвойс
  if (r.includes("ропа") || r.includes("роп") || r.includes("оформлени") || r.includes("счёт") || r.includes("счет") || r.includes("invoice")) {
    return "invoice";
  }
  // Клиент подтвердил оплату
  if (u.includes("оплатил") || u.includes("оплачу") || u.includes("перевёл") || u.includes("перевел")) {
    return "payed";
  }
  // Расчёт / КП
  if (r.includes("[calc:") || r.includes("литров") && r.includes("м²")) {
    return "commercial_offer";
  }
  // Отправили каталог — этап qualify
  if (reply.includes("[SEND_CATALOG]") && current === "answer") {
    return "qualify";
  }
  // Клиент ответил впервые
  if (current === "new_lead") {
    return "answer";
  }
  // Квалификация — узнаём площадь/объект
  if ((r.includes("площадь") || r.includes("м²") || r.includes("кв.м") || r.includes("объект") || r.includes("шпаклёвка") || r.includes("шпаклевка")) && current === "answer") {
    return "qualify";
  }
  return current; // не меняем
}

// ── Webhook handler ───────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const body = req.body;
  console.log("WA webhook:", JSON.stringify(body).slice(0, 300));

  // Wazzup отправляет массив messages
  const messages = body.messages || [];

  for (const msg of messages) {
    // Только входящие от клиента (не наши исходящие)
    if (msg.isEcho === true) continue;

    const phone   = msg.chatId || msg.phone || "";
    const text    = (typeof msg.text === "string") ? msg.text : (msg.text?.body || "");
    const chatId  = `wa_${phone}`;
    const name    = msg.senderName || msg.contact?.name || phone;

    if (!phone || !text) continue;

    lastActivity[chatId] = Date.now();
    console.log(`WA message from ${phone}: "${text.slice(0, 50)}"`);

    // ── Триггер активации ──────────────────────────────────────────────────
    if (!botActive[chatId]) {
      if (!hasTriggerWord(text)) {
        console.log("WA: no trigger word, ignoring:", text.slice(0, 50));
        continue; // бот молчит
      }
      // Активируем бота для этого чата
      botActive[chatId] = true;
      console.log("WA: bot activated for", phone);
    }

    // Отменяем таймеры молчания
    if (noAnswerTimers[chatId]) { noAnswerTimers[chatId].forEach(t => clearTimeout(t)); noAnswerTimers[chatId] = []; }
    if (followUpTimers[chatId]) { followUpTimers[chatId].forEach(t => clearTimeout(t)); followUpTimers[chatId] = []; }

    clientNames[chatId] = name;
    if (text.length > 3) clientLang[chatId] = detectLang(text);

    // Создаём сделку если нет
    if (!dealIds[chatId]) {
      await createDeal(chatId, name, phone);
      currentStage[chatId] = "new_lead";
      scheduleNoAnswerSequence(chatId, phone);
    }

    await addComment(chatId, text, true);

    // Задержка 2–4 сек
    const delay = 2000 + Math.floor(Math.random() * 2000);
    await new Promise(r => setTimeout(r, delay));

    try {
      const reply = await askClaude(chatId, text);
      console.log("RAW REPLY:", reply);

      const stage          = extractStage(reply);
      const meeting        = extractMeeting(reply);
      const sendCatalog    = reply.includes("[SEND_CATALOG]");
      const sendColorCat   = reply.includes("[SEND_COLOR_CATALOG]");
      const sendChecklist  = reply.includes("[SEND_CHECKLIST]");
      const notifyMgr      = reply.includes("[NOTIFY_MANAGER]") || stage === "invoice";

      // Очищаем теги
      let cleanReply = reply
        .replace(/\[STAGE:[a-z_]+\]/g, "")
        .replace(/\[CALC:[^\]]+\]/g, "")
        .replace(/\[MEETING:[^\]]+\]/g, "")
        .replace(/\[SEND_CATALOG\]/g, "")
        .replace(/\[SEND_COLOR_CATALOG\]/g, "")
        .replace(/\[SEND_CHECKLIST\]/g, "")
        .replace(/\[NOTIFY_MANAGER\]/g, "")
        .trim();

      await wazzupSendMessage(null, phone, cleanReply);
      await addComment(chatId, cleanReply, false);

      // Обновляем этап
      const detectedStage = stage || detectStageFromReply(reply, text, currentStage[chatId]);
      console.log(`Stage check: tag="${stage}" detected="${detectedStage}" current="${currentStage[chatId]}" dealId="${dealIds[chatId]}"`);
      if (detectedStage && detectedStage !== currentStage[chatId]) {
        console.log(`Stage: ${currentStage[chatId]} → ${detectedStage} (tag: ${!!stage})`);
        currentStage[chatId] = detectedStage;
        await updateDealStage(chatId, detectedStage);
      }

      // Каталоги
      const lang = clientLang[chatId] || "ru";
      if (sendCatalog) {
        const hist = histories[chatId] || [];
        const histText = hist.map(m => typeof m.content === "string" ? m.content : "").join(" ").toLowerCase();
        const isQuartz = (histText + " " + reply).toLowerCase().includes("quartz");
        const product = isQuartz ? "quartz" : "plastogum";
        const l = ["ru","en","th"].includes(lang) ? lang : "ru";
        await wazzupSendDocument(phone, CATALOGS[product][l], `Каталог ${isQuartz ? "Mr Quartzo" : "Plastogum"} 📋`);
      }
      if (sendColorCat) {
        await wazzupSendDocument(phone, CATALOGS.colors, "Каталог цветов Pratta 🎨");
      }
      if (sendChecklist) {
        const checklist = `✅ *Чеклист подготовки поверхности*\n\n1️⃣ Шпаклёвка финишная — высохла (24–48 ч)\n2️⃣ Грунтовка — нанесена и высохла\n3️⃣ Поверхность чистая, без пыли и жира\n4️⃣ Влажность стены < 8%\n5️⃣ Температура +10°C … +35°C\n\n💡 Правильная подготовка = долговечный результат`;
        await wazzupSendMessage(null, phone, checklist);
      }

      // Встреча
      if (meeting) {
        await createMeeting(chatId, name, meeting.date, meeting.time);
        meetingBooked[chatId] = true;
      }

      // Уведомление менеджера
      if (notifyMgr) {
        await notifyManager(chatId, name, phone);
      }

      setFollowUpTimer(chatId, phone);

    } catch(e) {
      console.error("WA bot error:", e.message);
      await wazzupSendMessage(null, phone, "Произошла ошибка, попробуйте ещё раз.");
    }
  }
});

// Wazzup требует 200 на тестовый запрос {test: true}
app.get("/", (req, res) => res.send("Pratta WhatsApp Bot работает ✓"));

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`WhatsApp Bot running on port ${PORT}`);
  if (!PUBLIC_URL) console.warn("⚠️  PUBLIC_URL не задан! Каталоги не будут отправляться. Добавь переменную окружения PUBLIC_URL=https://your-domain.com");
  else console.log("PUBLIC_URL:", PUBLIC_URL);
  console.log("CATALOG_DIR:", CATALOG_DIR);
  Object.entries(CATALOGS).forEach(([k, v]) => {
    if (typeof v === "string") {
      console.log(`Catalog ${k}: ${fs.existsSync(v) ? "OK" : "MISSING"}`);
    } else {
      Object.entries(v).forEach(([l, p]) => {
        console.log(`Catalog ${k}/${l}: ${fs.existsSync(p) ? "OK" : "MISSING"}`);
      });
    }
  });
});
