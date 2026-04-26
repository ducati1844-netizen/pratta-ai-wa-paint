const express = require("express");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

// ── Config ────────────────────────────────────────────────────────────────────
const ANTHROPIC_KEY   = process.env.ANTHROPIC_KEY;
const WAZZUP_API_KEY  = process.env.WAZZUP_API_KEY;
const WAZZUP_CHANNEL  = process.env.WAZZUP_CHANNEL_ID; // 67488dc4-5c0f-45d7-b453-10dbb606dff9
const WAZZUP_API      = "https://api.wazzup24.com/v3";

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
const clientChannels  = {}; // реальный channelId из входящего

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
  return `Ты — консультант Pratta Thailand. Клиент пришёл с рекламы Facebook через WhatsApp.

=== ТВОЯ ЗАДАЧА ===
1. Определи язык клиента
2. Поздоровайся тепло на его языке
3. Уточни какой каталог нужен — Plastogum или Mr Quartzo (если не ясно из сообщения)
4. Отправь нужный каталог тегом [SEND_CATALOG]
5. Предложи помочь с подбором или расчётом

=== ПРОДУКТЫ (кратко) ===
PLASTOGUM — силоксановая краска, фасад + интерьер, паропроницаемая, трещины до 0.1мм, для медучреждений и аллергиков
MR QUARTZO — краска с эффектом лотуса, мокрые зоны + фасад, керамика Class 1 DIN 53 778, для медучреждений

=== ПРАВИЛА ===
- Коротко — 2–3 предложения максимум
- Никогда не называй себя ботом
- Отвечай на языке клиента (RU / EN / TH)
- Это WhatsApp — стиль неформальный, тёплый
- Если клиент просит "каталог" без уточнения — спроси какой продукт интересует
- После отправки каталога предложи помочь с расчётом
- Если клиент на Пхукете — пригласи в шоурум: https://maps.app.goo.gl/38euuyoRPJGfFFR58

=== ТЕГИ ===
[SEND_CATALOG] — отправить каталог (Plastogum или Quartzo по контексту)
[STAGE:название] — в конце каждого ответа (new_lead / answer / qualify / commercial_offer / invoice / lose)
[NOTIFY_MANAGER] — когда клиент готов платить`;
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
        channelId: (chatId && clientChannels[chatId]) ? clientChannels[chatId] : WAZZUP_CHANNEL,
        chatType: "whatsapp",
        chatId: phone,
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

async function wazzupSendDocument(chatId, phone, filePath, caption) {
  try {
    const absPath = path.resolve(__dirname, filePath);
    if (!fs.existsSync(absPath)) {
      console.log("File not found:", absPath);
      await wazzupSendMessage(null, phone, caption + "\n\n(файл временно недоступен)");
      return;
    }

    const FormData = require("form-data");
    const form = new FormData();
    const ch = (chatId && clientChannels[chatId]) ? clientChannels[chatId] : WAZZUP_CHANNEL;
    form.append("channelId", ch);
    form.append("chatType", "whatsapp");
    form.append("chatId", phone);
    form.append("caption", caption);
    form.append("file", fs.createReadStream(absPath), {
      filename: path.basename(absPath),
      contentType: "application/pdf"
    });

    const res = await fetch(`${WAZZUP_API}/message`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${WAZZUP_API_KEY}`,
        ...form.getHeaders()
      },
      body: form
    });
    const data = await res.json();
    if (!res.ok) console.error("Wazzup doc error:", JSON.stringify(data));
    else console.log("Wazzup doc sent:", path.basename(absPath));
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
    return await res.json();
  } catch(e) {
    console.error("Bitrix error:", e.message);
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
      max_tokens: 1000,
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
function scheduleNoAnswerSequence(chatId, phone) {
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
    await wazzupSendMessage(chatId, phone, msg1[lang] || msg1.ru);
    console.log("WA follow-up 1 sent:", phone);
  }, 1 * 60 * 60 * 1000);

  // +24ч → второй follow-up → замолкаем навсегда
  const t2 = setTimeout(async () => {
    if (currentStage[chatId] !== "msg1_no_answer") return;
    if (!isWorkingHours()) return;
    await updateDealStage(chatId, "msg2_no_answer");
    currentStage[chatId] = "msg2_no_answer";
    await wazzupSendMessage(chatId, phone, msg2[lang] || msg2.ru);
    setTimeout(async () => {
      await updateDealStage(chatId, "base_for_messages");
      currentStage[chatId] = "base_for_messages";
      console.log("WA moved to base_for_messages:", phone);
    }, 60 * 60 * 1000);
    console.log("WA follow-up 2 sent:", phone);
  }, 24 * 60 * 60 * 1000);

  noAnswerTimers[chatId] = [t1, t2];
}

function setFollowUpTimer(chatId, phone) {
  scheduleNoAnswerSequence(chatId, phone);
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
    // Сохраняем реальный channelId из входящего сообщения
    if (msg.channelId) clientChannels[chatId] = msg.channelId;

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
      console.log("RAW REPLY:", reply.slice(0, 200));

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
      if (stage) {
        currentStage[chatId] = stage;
        await updateDealStage(chatId, stage);
      } else if (currentStage[chatId] === "new_lead") {
        currentStage[chatId] = "answer";
        await updateDealStage(chatId, "answer");
      }

      // Каталоги
      const lang = clientLang[chatId] || "ru";
      if (sendCatalog) {
        const hist = histories[chatId] || [];
        const histText = hist.map(m => typeof m.content === "string" ? m.content : "").join(" ").toLowerCase();
        const isQuartz = (histText + " " + reply).toLowerCase().includes("quartz");
        const product = isQuartz ? "quartz" : "plastogum";
        const l = ["ru","en","th"].includes(lang) ? lang : "ru";
        await wazzupSendDocument(chatId, phone, CATALOGS[product][l], `Каталог ${isQuartz ? "Mr Quartzo" : "Plastogum"} 📋`);
      }
      if (sendColorCat) {
        await wazzupSendDocument(chatId, phone, CATALOGS.colors, "Каталог цветов Pratta 🎨");
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
