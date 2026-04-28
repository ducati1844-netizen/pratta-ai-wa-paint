const express = require("express");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
app.use("/catalogs", express.static(path.join(__dirname, "catalogs")));

// ── Config ────────────────────────────────────────────────────────────────────
const ANTHROPIC_KEY   = process.env.ANTHROPIC_KEY;
const WAZZUP_API_KEY  = process.env.WAZZUP_API_KEY;
const WAZZUP_CHANNEL  = process.env.WAZZUP_CHANNEL_ID;
const WAZZUP_API      = "https://api.wazzup24.com/v3";
const APP_URL         = (process.env.APP_URL || "").replace(/\/+$/, "");

const BITRIX          = "https://pratta.bitrix24.ru/rest/1/or2hkvvec6ktuk6y";
const BITRIX_CATEGORY = 121; // Paint TG-auto

const STAGES = {
  new_lead:         "C121:NEW",
  msg1_no_answer:   "C121:UC_A0S2XP",
  msg2_no_answer:   "C121:UC_6RW4V7",
  msg3_no_answer:   "C121:UC_13YDAK",
  answer:           "C121:UC_DYSLZO",
  qualify:          "C121:PREPARATION",
  commercial_offer: "C121:UC_AMH32V",
  invoice:          "C121:PREPAYMENT_INVOI",
  payed:            "C121:EXECUTING",
  colouring:        "C121:FINAL_INVOICE",
  delivery:         "C121:UC_39GF9W",
  received:         "C121:UC_RMP5KA",
  base_for_messages:"C121:UC_13YDAK",
  won:              "C121:WON",
  lose:             "C121:LOSE"
};

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

// ── State (in-memory) ─────────────────────────────────────────────────────────
const histories       = {};
const dealIds         = {};
const clientNames     = {};
const clientLang      = {};
const currentStage    = {};
const meetingBooked   = {};
const followUpTimers  = {};
const noAnswerTimers  = {};
const lastActivity    = {};
const managerNotified = {};
const clientChannels  = {};

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
  if (!text) return null;
  const thaiChars = (text.match(/[\u0E00-\u0E7F]/g) || []).length;
  const ruChars   = (text.match(/[а-яёА-ЯЁ]/g) || []).length;
  if (thaiChars > 1) return "th";
  if (ruChars > 1)   return "ru";
  return null; // только латиница — не меняем язык, оставляем текущий
}

function getSystem() {
  return `Ты — консультант Pratta Thailand. Клиент написал в WhatsApp с рекламы или напрямую.

=== ТВОЯ РОЛЬ ===
Ты помогаешь клиенту выбрать краску, делаешь расчёт и доводишь до оплаты.
Ты действуешь как живой менеджер по продажам — тёплый, уверенный, профессиональный.
Никогда не называй себя ботом или AI.

=== ПРОДУКТЫ ===
PLASTOGUM (9900 THB / 15л = 90 м²)
- Паропроницаемая эластичная краска
- Отталкивает воду, стена "дышит"
- Фасады + интерьеры
- Перекрывает трещины до 0.1 мм
- Идеально для климата Таиланда

MR. QUARTZ (9900 THB / 15л = 90 м²)
- Эффект лотуса: вода скатывается
- Лёгкий глянец
- Мокрые зоны + фасады + интерьеры
- Стойкость к загрязнениям

ПРАЙМЕР: 1500 THB/1л (90 м²) | 3800 THB/4л
Колеровка Plastogum: светлые +95 THB/л, тёмные +165 THB/л
Колеровка Quartz: светлые +95 THB/л, тёмные +195 THB/л

=== РАСЧЁТ ===
Вёдер = CEIL(площадь × 1.1 / 90)
Стоимость = вёдер × 9900

=== ВОРОНКА ===
1. Поздоровайся тепло, выясни задачу
2. Уточни: площадь, продукт, цвет, сроки
3. Предложи расчёт
4. Отправь каталог — используй [SEND_CATALOG:PLASTOGUM] или [SEND_CATALOG:QUARTZ]
5. Отработай возражения
6. Доведи до инвойса [NOTIFY_MANAGER]

=== ГЛАВНОЕ ВОЗРАЖЕНИЕ "ДОРОГО" ===
"Если считать за ведро — кажется дороже. Но за м²:
Jotun: ~97 THB/м². Pratta: ~110 THB/м².
Разница 13 THB/м², но вы получаете паропроницаемость + эластичность + защиту от климата."

=== ПРАВИЛА ===
- Отвечай коротко: 2-4 предложения
- Язык клиента: RU / TH / EN — определяй автоматически
- Стиль: неформальный, тёплый (это WhatsApp, не официальное письмо)
- Шоурум упоминай только если клиент сам просит встретиться или посмотреть образцы вживую (адрес: https://maps.app.goo.gl/38euuyoRPJGfFFR58)
- Скидки не давай без согласования с менеджером

=== ТЕГИ (в конце каждого ответа) ===
[STAGE:new_lead] — первый контакт
[STAGE:answer] — клиент ответил, диалог начат
[STAGE:qualify] — идёт квалификация
[STAGE:commercial_offer] — КП отправлено
[STAGE:invoice] — счёт выставлен
[STAGE:payed] — оплата подтверждена
[STAGE:lose] — отказ
[SEND_CATALOG:PLASTOGUM] — отправить каталог Plastogum
[SEND_CATALOG:QUARTZ] — отправить каталог Mr. Quartz
Используй ТОЛЬКО эти два варианта, ничего не добавляй
[NOTIFY_MANAGER] — клиент готов к оплате, нужен менеджер

Сегодня: ${getTodayStr()}`;
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
    const filename = path.basename(absPath);

    if (!fs.existsSync(absPath)) {
      console.log("Catalog file not found:", absPath);
      await wazzupSendMessage(chatId, phone, caption + "\n\n(файл временно недоступен)");
      return;
    }

    if (!APP_URL) {
      console.error("APP_URL not set — cannot send catalog via URL");
      await wazzupSendMessage(chatId, phone, caption + "\n\n(файл временно недоступен)");
      return;
    }

    const ch = (chatId && clientChannels[chatId]) ? clientChannels[chatId] : WAZZUP_CHANNEL;
    const fileUrl = `${APP_URL}/catalogs/${filename}`;
    console.log("Sending catalog URL:", fileUrl);

    const res = await fetch(`${WAZZUP_API}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${WAZZUP_API_KEY}`
      },
      body: JSON.stringify({
        channelId: ch,
        chatType: "whatsapp",
        chatId: phone,
        contentType: "document",
        contentUri: fileUrl,
        fileName: filename,
        caption
      })
    });
    const data = await res.json();
    if (!res.ok) console.error("Wazzup doc error:", JSON.stringify(data));
    else console.log("Wazzup doc sent OK:", filename);
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
  await bitrixCall("calendar.event.add", calParams);
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
      model: "claude-sonnet-4-6",
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
    console.log("Follow-up 1 sent:", phone);
  }, 1 * 60 * 60 * 1000);

  // +24ч → второй follow-up → база
  const t2 = setTimeout(async () => {
    if (currentStage[chatId] !== "msg1_no_answer") return;
    if (!isWorkingHours()) return;
    await updateDealStage(chatId, "msg2_no_answer");
    currentStage[chatId] = "msg2_no_answer";
    await wazzupSendMessage(chatId, phone, msg2[lang] || msg2.ru);
    setTimeout(async () => {
      await updateDealStage(chatId, "base_for_messages");
      currentStage[chatId] = "base_for_messages";
    }, 60 * 60 * 1000);
  }, 24 * 60 * 60 * 1000);

  noAnswerTimers[chatId] = [t1, t2];
}

// ── Webhook ───────────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const messages = req.body.messages || [];

  for (const msg of messages) {
    if (msg.isEcho === true) continue;

    const phone  = msg.chatId || msg.phone || "";
    const text   = (typeof msg.text === "string") ? msg.text : (msg.text?.body || "");
    const chatId = `wa_${phone}`;
    const name   = msg.senderName || msg.contact?.name || phone;

    if (msg.channelId) clientChannels[chatId] = msg.channelId;
    if (!phone || !text) continue;

    lastActivity[chatId] = Date.now();
    console.log(`WA in [${phone}]: "${text.slice(0, 60)}"`);

    // Отменяем таймеры молчания при ответе клиента
    if (noAnswerTimers[chatId]) { noAnswerTimers[chatId].forEach(t => clearTimeout(t)); noAnswerTimers[chatId] = []; }
    if (followUpTimers[chatId]) { followUpTimers[chatId].forEach(t => clearTimeout(t)); followUpTimers[chatId] = []; }

    clientNames[chatId] = name;
    const detectedLang = text.length > 3 ? detectLang(text) : null;
    if (detectedLang) clientLang[chatId] = detectedLang;

    // Создаём сделку если это первое сообщение от номера
    if (!dealIds[chatId]) {
      await createDeal(chatId, name, phone);
      currentStage[chatId] = "new_lead";
      scheduleNoAnswerSequence(chatId, phone);
    }

    await addComment(chatId, text, true);

    // Задержка 2–4 сек (имитация набора)
    await new Promise(r => setTimeout(r, 2000 + Math.floor(Math.random() * 2000)));

    try {
      const reply = await askClaude(chatId, text);

      const stage        = extractStage(reply);
      const meeting      = extractMeeting(reply);
      const catalogMatch = reply.match(/\[SEND_CATALOG:([A-Z]+)\]/);
      const sendCatalog  = !!catalogMatch;
      const catalogProduct = catalogMatch ? catalogMatch[1].toLowerCase() : null;
      const sendColorCat = reply.includes("[SEND_COLOR_CATALOG]");
      const notifyMgr    = reply.includes("[NOTIFY_MANAGER]") || stage === "invoice";

      let cleanReply = reply
        .replace(/\[STAGE:[a-z_]+\]/g, "")
        .replace(/\[CALC:[^\]]+\]/g, "")
        .replace(/\[MEETING:[^\]]+\]/g, "")
        .replace(/\[SEND_CATALOG:[^\]]+\]/g, "")
        .replace(/\[SEND_COLOR_CATALOG\]/g, "")
        .replace(/\[SEND_CHECKLIST\]/g, "")
        .replace(/\[NOTIFY_MANAGER\]/g, "")
        .trim();

      await wazzupSendMessage(chatId, phone, cleanReply);
      await addComment(chatId, cleanReply, false);

      // Обновляем этап
      if (stage && STAGES[stage]) {
        currentStage[chatId] = stage;
        await updateDealStage(chatId, stage);
      } else if (currentStage[chatId] === "new_lead") {
        currentStage[chatId] = "answer";
        await updateDealStage(chatId, "answer");
      }

      // Отправляем каталог
      if (sendCatalog && catalogProduct) {
        const product = catalogProduct === "quartz" ? "quartz" : "plastogum";
        const lang = ["ru","en","th"].includes(clientLang[chatId]) ? clientLang[chatId] : "ru";
        const label = product === "quartz" ? "Mr. Quartz" : "Plastogum";
        await wazzupSendDocument(chatId, phone, CATALOGS[product][lang], `Каталог ${label} 📋`);
      }
      if (sendColorCat) {
        await wazzupSendDocument(chatId, phone, CATALOGS.colors, "Каталог цветов Pratta 🎨");
      }

      if (meeting) {
        await createMeeting(chatId, name, meeting.date, meeting.time);
        meetingBooked[chatId] = true;
      }

      if (notifyMgr) {
        await notifyManager(chatId, name, phone);
      }

      scheduleNoAnswerSequence(chatId, phone);

    } catch(e) {
      console.error("Bot error:", e.message);
      await wazzupSendMessage(chatId, phone, "Секунду, уточняю информацию — напишу вам чуть позже 🙏");
    }
  }
});

app.get("/", (req, res) => res.send("Pratta WhatsApp Bot v2 ✓"));

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`WhatsApp Bot running on port ${PORT}`);
  console.log("CATALOG_DIR:", CATALOG_DIR);
  Object.entries(CATALOGS).forEach(([k, v]) => {
    if (typeof v === "string") {
      console.log(`  catalog ${k}: ${fs.existsSync(v) ? "OK" : "MISSING"}`);
    } else {
      Object.entries(v).forEach(([l, p]) => {
        console.log(`  catalog ${k}/${l}: ${fs.existsSync(p) ? "OK" : "MISSING"}`);
      });
    }
  });
});
