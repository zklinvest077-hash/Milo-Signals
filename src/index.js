/**
 * Milo Signals — Telegram AI signal parser for Cornix.
 *
 * Поток данных:
 *   канал-агрегатор (сырые пересланные сигналы, текст/скриншоты)
 *     -> этот Worker (бот-админ читает посты через webhook)
 *     -> OpenRouter LLM (понимает контекст и сленг, читает скриншоты)
 *     -> чистый канал в строгом формате Cornix
 *     -> Cornix -> Bybit
 *
 * Секреты (Cloudflare dashboard -> Settings -> Variables and Secrets, тип Secret):
 *   BOT_TOKEN          — токен бота от @BotFather
 *   OPENROUTER_API_KEY — ключ OpenRouter
 *   WEBHOOK_SECRET     — любая длинная случайная строка (защита webhook)
 *
 * Переменные (тип Text):
 *   SOURCE_CHANNEL_IDS — ID каналов-источников через запятую, напр. "-1001111,-1002222"
 *   TARGET_CHANNEL_ID  — ID чистого канала для Cornix, напр. "-1003333"
 *   ADMIN_CHAT_ID      — (желательно) твой личный chat ID: сюда идут ошибки и
 *                        сомнительные сигналы. Напиши боту /id в личку, чтобы узнать.
 *   MODEL, MIN_CONFIDENCE, REQUIRE_SL, HISTORY_SIZE — см. wrangler.jsonc
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook" && request.method === "POST") {
      const secret = request.headers.get("x-telegram-bot-api-secret-token");
      if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await request.json();
      // Отвечаем Telegram сразу, обработку делаем в фоне
      ctx.waitUntil(
        handleUpdate(update, env).catch((e) => reportError(env, e, update))
      );
      return new Response("ok");
    }

    // Открой в Safari: https://<worker>.workers.dev/setup?secret=<WEBHOOK_SECRET>
    if (url.pathname === "/setup") {
      if (url.searchParams.get("secret") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const res = await tg(env, "setWebhook", {
        url: `${url.origin}/webhook`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "channel_post", "edited_channel_post"],
        drop_pending_updates: true,
      });
      const me = await tg(env, "getMe", {});
      return jsonResponse({
        webhook: res,
        bot: me.result ? `@${me.result.username}` : me,
        hint: "Если webhook.ok=true — всё готово. Добавь бота админом в каналы и напиши /id в каждом.",
      });
    }

    return new Response("Milo Signals bot is running.\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};

// ---------------------------------------------------------------------------
// Обработка входящих сообщений
// ---------------------------------------------------------------------------

async function handleUpdate(update, env) {
  const msg = update.channel_post || update.edited_channel_post || update.message;
  if (!msg || !msg.chat) return;

  const isEdit = Boolean(update.edited_channel_post);
  const chatId = String(msg.chat.id);
  const text = msg.text || msg.caption || "";

  // Служебная команда: узнать ID любого чата, где есть бот
  if (text.trim().startsWith("/id")) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `Chat ID: ${chatId}`,
    });
    return;
  }

  const sources = String(env.SOURCE_CHANNEL_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!sources.includes(chatId)) return;

  const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;
  if (!text && !hasPhoto) return;

  // Защита от дублей (авто-форвардеры любят слать одно и то же)
  const dedupKey = `dedup:${chatId}:${msg.message_id}:${await sha1(text)}`;
  if (await env.KV.get(dedupKey)) return;
  await env.KV.put(dedupKey, "1", { expirationTtl: 3600 });

  const sourceName =
    msg.forward_origin?.chat?.title ||
    msg.forward_origin?.sender_user?.first_name ||
    msg.chat.title ||
    "unknown";

  // Скриншот -> base64 для vision-модели
  let imageDataUrl = null;
  if (hasPhoto) {
    imageDataUrl = await fetchPhotoAsDataUrl(env, msg.photo);
  }

  const history = await loadHistory(env, chatId);

  const decision = await askModel(env, {
    history,
    sourceName,
    text,
    isEdit,
    imageDataUrl,
  });

  // Запоминаем сообщение в истории (вместе с тем, что модель увидела на картинке)
  const historyText =
    (hasPhoto ? `[фото${decision?.image_description ? ": " + decision.image_description : ""}] ` : "") +
    text;
  await appendHistory(env, chatId, {
    t: new Date().toISOString(),
    from: sourceName,
    edit: isEdit || undefined,
    text: historyText.slice(0, 700),
  });

  if (!decision) {
    await notifyAdmin(env, `⚠️ Модель вернула нечитаемый ответ на сообщение из «${sourceName}»:\n\n${text.slice(0, 300)}`);
    return;
  }

  if (decision.action === "ignore") return;

  const minConf = parseFloat(env.MIN_CONFIDENCE || "0.65");
  if ((decision.confidence ?? 0) < minConf) {
    await notifyAdmin(
      env,
      `🤔 Возможный сигнал (уверенность ${decision.confidence ?? "?"}, не опубликован):\n` +
        `${JSON.stringify(decision, null, 2)}\n\nИсходное сообщение из «${sourceName}»:\n${text.slice(0, 400)}`
    );
    return;
  }

  if (decision.action === "signal") {
    await publishSignal(env, chatId, decision, sourceName);
  } else if (decision.action === "update") {
    await publishUpdate(env, chatId, decision, sourceName, text);
  }
}

// ---------------------------------------------------------------------------
// Публикация сигнала в чистый канал (формат Cornix)
// ---------------------------------------------------------------------------

async function publishSignal(env, sourceChatId, sig, sourceName) {
  const symbol = normalizeSymbol(sig.symbol);
  if (!symbol || !sig.direction) {
    await notifyAdmin(env, `⚠️ Сигнал без тикера/направления, пропущен:\n${JSON.stringify(sig)}`);
    return;
  }

  let entries = sig.entries;
  if (entries === "market" || !Array.isArray(entries) || entries.length === 0) {
    // Вход "по рынку" — берём текущую цену с Bybit
    const price = await bybitLastPrice(symbol);
    if (!price) {
      await notifyAdmin(env, `⚠️ Не смог получить цену ${symbol} с Bybit для входа по рынку. Сигнал пропущен:\n${JSON.stringify(sig)}`);
      return;
    }
    entries = [price];
  }

  const requireSl = String(env.REQUIRE_SL || "true") === "true";
  const hasStop = sig.stop !== undefined && sig.stop !== null && sig.stop !== "";
  if (requireSl && !hasStop) {
    await notifyAdmin(
      env,
      `🛑 Сигнал без стоп-лосса НЕ опубликован (REQUIRE_SL=true):\n${JSON.stringify(sig, null, 2)}\n\n` +
        `Источник «${sourceName}». Если хочешь публиковать такие сигналы — настрой дефолтный SL в Cornix и поставь REQUIRE_SL=false.`
    );
    return;
  }

  const dir = String(sig.direction).toUpperCase() === "SHORT" ? "Short" : "Long";
  const pretty = symbol.replace(/USDT$/, "") + "/USDT";

  let out = `#${pretty}\n`;
  out += `Exchanges: ByBit USDT\n`;
  out += `Signal Type: Regular (${dir})\n`;
  if (sig.leverage) {
    const margin = String(sig.margin || "cross").toLowerCase() === "isolated" ? "Isolated" : "Cross";
    out += `Leverage: ${margin} (${String(sig.leverage).replace(/x/i, "")}X)\n`;
  }
  out += `\nEntry Targets:\n`;
  entries.forEach((e, i) => (out += `${i + 1}) ${e}\n`));
  if (Array.isArray(sig.targets) && sig.targets.length > 0) {
    out += `\nTake-Profit Targets:\n`;
    sig.targets.forEach((t, i) => (out += `${i + 1}) ${t}\n`));
  }
  if (hasStop) {
    out += `\nStop Targets:\n1) ${sig.stop}\n`;
  }

  const res = await tg(env, "sendMessage", {
    chat_id: env.TARGET_CHANNEL_ID,
    text: out,
    disable_web_page_preview: true,
  });

  if (res.ok) {
    // Запоминаем message_id сигнала, чтобы потом отвечать на него командами
    await env.KV.put(
      `sigmsg:${symbol}`,
      JSON.stringify({ message_id: res.result.message_id, ts: Date.now() }),
      { expirationTtl: 60 * 60 * 24 * 14 }
    );
    await appendHistory(env, sourceChatId, {
      t: new Date().toISOString(),
      from: "BOT",
      text: `[опубликован сигнал в Cornix-канал] ${dir.toUpperCase()} ${pretty}, entries=${entries.join("/")}, targets=${(sig.targets || []).join("/")}, stop=${sig.stop ?? "-"}`,
    });
  } else {
    await notifyAdmin(env, `❌ Telegram не принял сигнал: ${JSON.stringify(res)}`);
  }
}

// Обновление по уже открытой сделке: ответ (reply) на исходное сообщение сигнала.
// Cornix понимает команды в реплаях: Close, Close 50%, Cancel, Move Stop-Loss to Entry и т.п.
async function publishUpdate(env, sourceChatId, sig, sourceName, originalText) {
  const symbol = normalizeSymbol(sig.symbol);
  const command = (sig.update_command || "").trim();
  if (!symbol || !command) {
    await notifyAdmin(env, `⚠️ Обновление без тикера/команды:\n${JSON.stringify(sig)}`);
    return;
  }

  const stored = await env.KV.get(`sigmsg:${symbol}`, "json");
  if (!stored) {
    await notifyAdmin(
      env,
      `⚠️ Пришло обновление «${command}» по ${symbol}, но я не нашёл исходный сигнал в памяти. Сообщение из «${sourceName}»:\n${originalText.slice(0, 300)}`
    );
    return;
  }

  const res = await tg(env, "sendMessage", {
    chat_id: env.TARGET_CHANNEL_ID,
    text: command,
    reply_parameters: { message_id: stored.message_id },
  });

  if (res.ok) {
    await appendHistory(env, sourceChatId, {
      t: new Date().toISOString(),
      from: "BOT",
      text: `[отправлена команда Cornix] ${symbol}: ${command}`,
    });
  } else {
    await notifyAdmin(env, `❌ Не смог отправить команду «${command}» по ${symbol}: ${JSON.stringify(res)}`);
  }
}

// ---------------------------------------------------------------------------
// LLM (OpenRouter)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a crypto trading signal parser. You read messages forwarded from Russian-language Telegram trading channels and convert them into structured signals for the Cornix auto-trading bot (Bybit USDT perpetual futures).

Messages are messy: slang, hype, screenshots of positions, and follow-ups that only make sense with earlier context. You are given the recent message history of the channel — USE IT. Examples of slang:
- "заряжаем/заряжайте лонг", "заряжаем наверх", "лонгуем" = open LONG
- "шортим", "заряжаем вниз" = open SHORT
- "фиксируем", "фиксанул", "забираем профит" = take profit / close (an UPDATE)
- "стоп в бу", "перенёс в безубыток" = move stop-loss to entry (an UPDATE)
- "выходим", "закрываем", "отмена" = close/cancel (an UPDATE)
- A screenshot of an open position (Bybit/Binance UI) is usually an entry signal: read symbol, direction (Long/Short green/red), entry price, leverage from the image.
- "заряжайте наверх" right after a message discussing SOL = LONG on SOL.

Respond with ONLY a JSON object, no markdown fences, no commentary:
{
  "action": "signal" | "update" | "ignore",
  "confidence": 0.0-1.0,          // how sure you are this is a real actionable signal/update
  "symbol": "SOLUSDT",            // for signal/update; uppercase, USDT pair
  "direction": "LONG" | "SHORT",  // for signal
  "leverage": 10,                 // only if explicitly stated
  "margin": "cross" | "isolated", // only if explicitly stated
  "entries": [150.0, 148.5] | "market", // "market" if they say enter now / по рынку / screenshot of already-open position
  "targets": [155, 160],          // take-profits, only if stated
  "stop": 143.5,                  // stop-loss, only if stated
  "update_command": "Close 50%",  // for action=update: one Cornix reply command in English:
                                  // "Close", "Close 50%", "Cancel", "Move Stop-Loss to Entry"
  "image_description": "...",     // if an image was attached: 1 short sentence of what it shows
  "reason": "..."                 // 1 short sentence why you decided this
}

STRICT RULES:
1. NEVER invent price levels. Only use numbers that appear in the message, the image, or the history. If entry is implied but no price given, use "market". If no targets/stop given, omit those fields.
2. "ignore" for: analysis without a call to action, memes, ads, PR, results/recaps of past trades, generic hype without a ticker, duplicate of a signal already posted by BOT (check history for "[опубликован сигнал" entries).
3. "update" only when there is an existing trade in history to update.
4. If the message is an edited version of an earlier message and adds no new actionable info, "ignore".
5. Lower the confidence when the ticker or direction is guessed from context rather than explicit.
6. Symbol must be a real trading pair ending in USDT (e.g. BTCUSDT, SOLUSDT, 1000PEPEUSDT).`;

async function askModel(env, { history, sourceName, text, isEdit, imageDataUrl }) {
  const histBlock =
    history.length === 0
      ? "(история пуста)"
      : history
          .map((h) => `[${h.t}] ${h.from}${h.edit ? " (edited)" : ""}: ${h.text}`)
          .join("\n");

  const userText =
    `RECENT CHANNEL HISTORY (oldest first):\n${histBlock}\n\n` +
    `NEW MESSAGE from «${sourceName}»${isEdit ? " (EDITED version of an earlier message)" : ""}:\n` +
    `${text || "(без текста, только изображение)"}`;

  const content = imageDataUrl
    ? [
        { type: "text", text: userText },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ]
    : userText;

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "X-Title": "Milo Signals",
    },
    body: JSON.stringify({
      model: env.MODEL || "google/gemini-2.5-flash",
      temperature: 0.1,
      max_tokens: 1000,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content },
      ],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OpenRouter ${resp.status}: ${body.slice(0, 500)}`);
  }
  const data = await resp.json();
  const raw = data.choices?.[0]?.message?.content || "";
  return parseJsonLoose(raw);
}

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

async function tg(env, method, params) {
  const resp = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return resp.json();
}

async function fetchPhotoAsDataUrl(env, photos) {
  try {
    // Берём самый большой размер (последний в массиве)
    const photo = photos[photos.length - 1];
    const fileInfo = await tg(env, "getFile", { file_id: photo.file_id });
    if (!fileInfo.ok) return null;
    const fileResp = await fetch(
      `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${fileInfo.result.file_path}`
    );
    if (!fileResp.ok) return null;
    const buf = await fileResp.arrayBuffer();
    return `data:image/jpeg;base64,${base64(buf)}`;
  } catch {
    return null;
  }
}

function base64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

async function loadHistory(env, chatId) {
  return (await env.KV.get(`history:${chatId}`, "json")) || [];
}

async function appendHistory(env, chatId, entry) {
  const size = parseInt(env.HISTORY_SIZE || "15", 10);
  const history = await loadHistory(env, chatId);
  history.push(entry);
  while (history.length > size) history.shift();
  await env.KV.put(`history:${chatId}`, JSON.stringify(history), {
    expirationTtl: 60 * 60 * 24 * 7,
  });
}

function normalizeSymbol(symbol) {
  if (!symbol) return null;
  let s = String(symbol).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!s) return null;
  if (!s.endsWith("USDT")) s += "USDT";
  return s;
}

async function bybitLastPrice(symbol) {
  try {
    const resp = await fetch(
      `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`
    );
    const data = await resp.json();
    const p = data?.result?.list?.[0]?.lastPrice;
    return p ? parseFloat(p) : null;
  } catch {
    return null;
  }
}

function parseJsonLoose(raw) {
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function notifyAdmin(env, text) {
  if (!env.ADMIN_CHAT_ID) return;
  await tg(env, "sendMessage", {
    chat_id: env.ADMIN_CHAT_ID,
    text: text.slice(0, 4000),
    disable_web_page_preview: true,
  });
}

async function reportError(env, err, update) {
  console.error("handleUpdate error:", err);
  try {
    await notifyAdmin(
      env,
      `❌ Ошибка бота: ${err?.message || err}\n\nUpdate: ${JSON.stringify(update).slice(0, 800)}`
    );
  } catch {}
}

async function sha1(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-1", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
