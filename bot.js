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

// ── State (in-memory + file persistence) ─────────────────────────────────────
const STATE_FILE = path.join(__dirname, "state.json");

const histories        = {};
const dealIds          = {};
const clientNames      = {};
const clientLang       = {};
const currentStage     = {};
const meetingBooked    = {};
const managerNotified  = {};
const clientChannels   = {};
const pendingMessages  = {};
const pendingTimers    = {};
const followUpSchedule = {}; // { chatId: { step: 0|1|2, nextAt: ms, phone } }

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      dealIds, managerNotified, currentStage, clientLang, clientNames, followUpSchedule
    }));
  } catch(e) { console.error("saveState:", e.message); }
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    Object.assign(dealIds,          s.dealIds          || {});
    Object.assign(managerNotified,  s.managerNotified  || {});
    Object.assign(currentStage,     s.currentStage     || {});
    Object.assign(clientLang,       s.clientLang       || {});
    Object.assign(clientNames,      s.clientNames      || {});
    Object.assign(followUpSchedule, s.followUpSchedule || {});
    const d = Object.keys(dealIds).length;
    const f = Object.keys(followUpSchedule).length;
    console.log(`State loaded: ${d} deals, ${f} pending follow-ups`);
  } catch(e) { console.error("loadState:", e.message); }
}

// ── Follow-up (polling, survives restarts) ────────────────────────────────────
// Delays between steps: 15 min → 1 h → 24 h
const FOLLOWUP_DELAYS = [15 * 60 * 1000, 60 * 60 * 1000, 24 * 60 * 60 * 1000];
const FOLLOWUP_STAGE  = ["msg1_no_answer", "msg2_no_answer", "base_for_messages"];
const FOLLOWUP_MSGS   = {
  0: {
    ru: "Привет! 👋 Ещё интересует краска? Готов помочь с выбором и расчётом.",
    en: "Hi! 👋 Still interested in paint? Happy to help you choose and calculate.",
    th: "สวัสดี! 👋 ยังสนใจสีอยู่ไหมคะ? ยินดีช่วยเลือกและคำนวณให้ค่ะ"
  },
  1: {
    ru: "Добрый день 🙂 Если остались вопросы по краске — напишите, помогу!",
    en: "Hello 🙂 Any questions about the paint — feel free to write!",
    th: "สวัสดีค่ะ 🙂 ถ้ามีคำถามเรื่องสีทักมาได้เลยนะคะ"
  },
  2: {
    ru: "Последнее сообщение от нас 🙏 Если передумаете — мы всегда на связи. Pratta Thailand.",
    en: "Last message from us 🙏 If you change your mind — we're always here. Pratta Thailand.",
    th: "ข้อความสุดท้ายค่ะ 🙏 ถ้าเปลี่ยนใจได้ติดต่อมาได้เสมอนะคะ Pratta Thailand"
  }
};

function startFollowUp(chatId, phone) {
  if (managerNotified[chatId]) return;
  followUpSchedule[chatId] = { step: 0, nextAt: Date.now() + FOLLOWUP_DELAYS[0], phone };
  saveState();
}

function cancelFollowUp(chatId) {
  if (followUpSchedule[chatId]) {
    delete followUpSchedule[chatId];
    saveState();
  }
}

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
  const thaiChars  = (text.match(/[฀-๿]/g) || []).length;
  const ruChars    = (text.match(/[а-яёА-ЯЁ]/g) || []).length;
  const latinChars = (text.match(/[a-zA-Z]/g) || []).length;
  if (thaiChars > 1)  return "th";
  if (ruChars > 1)    return "ru";
  if (latinChars > 2) return "en";
  return null;
}

function getSystem(lang) {
  const langHint = lang
    ? `\nЯзык ответа: ${lang.toUpperCase()} — пиши ТОЛЬКО на этом языке.`
    : "";
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

Сегодня: ${getTodayStr()}${langHint}`;
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
    saveState();
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
  cancelFollowUp(chatId);
  saveState();
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
      system: getSystem(clientLang[chatId]),
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

// ── Follow-up polling (every 60s) ─────────────────────────────────────────────
// Replaces setTimeout-based timers — survives server restarts via state.json
setInterval(async () => {
  const now = Date.now();
  for (const [chatId, sched] of Object.entries(followUpSchedule)) {
    if (managerNotified[chatId]) {
      delete followUpSchedule[chatId];
      saveState();
      continue;
    }
    if (now < sched.nextAt) continue;
    if (!isWorkingHours()) continue;

    const step = sched.step;
    const lang = clientLang[chatId] || "ru";
    const msg  = FOLLOWUP_MSGS[step][lang] || FOLLOWUP_MSGS[step].ru;

    try {
      await wazzupSendMessage(chatId, sched.phone, msg);
      await updateDealStage(chatId, FOLLOWUP_STAGE[step]);
      console.log(`Follow-up step ${step + 1}/3 sent to ${sched.phone}`);
    } catch(e) {
      console.error("Follow-up send error:", e.message);
    }

    if (step < 2) {
      followUpSchedule[chatId] = {
        step: step + 1,
        nextAt: Date.now() + FOLLOWUP_DELAYS[step + 1],
        phone: sched.phone
      };
    } else {
      delete followUpSchedule[chatId];
    }
    saveState();
  }
}, 60 * 1000);

// ── Webhook ───────────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const messages = req.body.messages || [];

  for (const msg of messages) {
    // FIX: when manager writes manually — disable bot for this chat
    if (msg.isEcho === true) {
      const ePhone = msg.chatId || msg.phone || "";
      if (ePhone) {
        const eChatId = `wa_${ePhone}`;
        if (!managerNotified[eChatId]) {
          managerNotified[eChatId] = true;
          cancelFollowUp(eChatId);
          saveState();
          console.log(`Manager took over chat: ${ePhone} — bot disabled`);
        }
      }
      continue;
    }

    const phone  = msg.chatId || msg.phone || "";
    const text   = (typeof msg.text === "string") ? msg.text : (msg.text?.body || "");
    const chatId = `wa_${phone}`;
    const name   = msg.senderName || msg.contact?.name || phone;

    if (msg.channelId) clientChannels[chatId] = msg.channelId;
    if (!phone || !text) continue;

    if (managerNotified[chatId]) {
      console.log(`Manager handling ${phone} — bot silent`);
      continue;
    }

    console.log(`WA in [${phone}]: "${text.slice(0, 60)}"`);

    // Client responded — cancel any pending follow-up
    cancelFollowUp(chatId);

    clientNames[chatId] = name;
    const detectedLang = text.length > 3 ? detectLang(text) : null;
    if (detectedLang) { clientLang[chatId] = detectedLang; saveState(); }

    if (!dealIds[chatId]) {
      await createDeal(chatId, name, phone);
      currentStage[chatId] = "new_lead";
      saveState();
    }

    await addComment(chatId, text, true);

    // Buffer messages — wait for pause before replying (client may send in parts)
    if (!pendingMessages[chatId]) pendingMessages[chatId] = [];
    pendingMessages[chatId].push(text);
    if (pendingTimers[chatId]) clearTimeout(pendingTimers[chatId]);

    const _chatId = chatId, _phone = phone, _name = name;
    pendingTimers[chatId] = setTimeout(async () => {
      const texts = pendingMessages[_chatId] || [];
      delete pendingMessages[_chatId];
      delete pendingTimers[_chatId];
      const combined = texts.join("\n");

      await new Promise(r => setTimeout(r, 2000 + Math.floor(Math.random() * 2000)));

      try {
        const reply = await askClaude(_chatId, combined);

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

        await wazzupSendMessage(_chatId, _phone, cleanReply);
        await addComment(_chatId, cleanReply, false);

        if (stage && STAGES[stage]) {
          currentStage[_chatId] = stage;
          await updateDealStage(_chatId, stage);
          saveState();
        } else if (currentStage[_chatId] === "new_lead") {
          currentStage[_chatId] = "answer";
          await updateDealStage(_chatId, "answer");
          saveState();
        }

        if (sendCatalog && catalogProduct) {
          const product = catalogProduct === "quartz" ? "quartz" : "plastogum";
          const lang = ["ru","en","th"].includes(clientLang[_chatId]) ? clientLang[_chatId] : "ru";
          const label = product === "quartz" ? "Mr. Quartz" : "Plastogum";
          await wazzupSendDocument(_chatId, _phone, CATALOGS[product][lang], `Каталог ${label} 📋`);
        }
        if (sendColorCat) {
          await wazzupSendDocument(_chatId, _phone, CATALOGS.colors, "Каталог цветов Pratta 🎨");
        }

        if (meeting) {
          await createMeeting(_chatId, _name, meeting.date, meeting.time);
          meetingBooked[_chatId] = true;
        }

        if (notifyMgr) {
          await notifyManager(_chatId, _name, _phone);
        }

        // Start 15-min follow-up window after bot responds
        startFollowUp(_chatId, _phone);

      } catch(e) {
        console.error("Bot error:", e.message);
        await wazzupSendMessage(_chatId, _phone, "Секунду, уточняю информацию — напишу вам чуть позже 🙏");
      }
    }, 3000);
  }
});

app.get("/", (req, res) => res.send("Pratta WhatsApp Bot v3 ✓"));

const PORT = process.env.PORT || 3002;
loadState();
app.listen(PORT, () => {
  console.log(`WhatsApp Bot v3 running on port ${PORT}`);
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
