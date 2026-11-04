'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { Telegraf } = require('telegraf');
const OpenAI = require('openai');

function readNumber(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function readBoolean(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function parseAllowedUsers(raw) {
  if (!raw || !raw.trim()) {
    console.warn('[config] ALLOWED_USERS is empty; all users will be denied until it is configured.');
    return new Set();
  }

  const ids = raw.split(',').map((part) => part.trim()).filter(Boolean);
  const parsed = ids.map((id) => {
    if (!/^\d+$/.test(id)) throw new Error(`Invalid Telegram user ID in ALLOWED_USERS: ${id}`);
    const numericId = Number(id);
    if (!Number.isSafeInteger(numericId)) throw new Error(`Telegram user ID is out of range: ${id}`);
    return numericId;
  });

  return new Set(parsed);
}

function loadJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to load ${label}: ${error.message}`);
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const personaPath = path.join(__dirname, 'personas', 'remielle.md');
const lorebookPath = path.join(__dirname, 'lorebooks', 'remielle.json');
const personaPrompt = fs.readFileSync(personaPath, 'utf8').trim();
const lorebook = loadJson(lorebookPath, 'Remielle lorebook');

if (!Array.isArray(lorebook.entries)) throw new Error('The Remielle lorebook must contain an entries array.');
for (const entry of lorebook.entries) {
  if (!entry.id || !entry.title || !Array.isArray(entry.keywords) || !entry.content) {
    throw new Error(`Invalid lorebook entry: ${entry.id || 'unknown'}`);
  }
}

const loreDefaults = lorebook.matching || {};
const customSystemPrompt = process.env.SYSTEM_PROMPT?.trim();
const systemPrompt = [
  personaPrompt,
  customSystemPrompt ? `\n\n## Additional owner instructions\n${customSystemPrompt}` : '',
].filter(Boolean).join('\n');

const config = {
  telegramToken: process.env.TELEGRAM_TOKEN,
  apiKey: process.env.API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.BASE_URL || 'https://api.openai.com/v1',
  model: process.env.MODEL || 'gpt-4o-mini',
  systemPrompt,
  allowedUsers: parseAllowedUsers(process.env.ALLOWED_USERS),
  allowGroups: readBoolean('ALLOW_GROUPS', false),
  maxInputChars: readNumber('MAX_INPUT_CHARS', 12000, { min: 100, max: 100000 }),
  maxHistoryMessages: readNumber('MAX_HISTORY_MESSAGES', 20, { min: 2, max: 100 }),
  maxContextChars: readNumber('MAX_CONTEXT_CHARS', 30000, { min: 1000, max: 200000 }),
  sessionTtlMs: readNumber('SESSION_TTL_HOURS', 12, { min: 1, max: 720 }) * 60 * 60 * 1000,
  maxSessions: readNumber('MAX_SESSIONS', 500, { min: 10, max: 10000 }),
  apiTimeoutMs: readNumber('API_TIMEOUT_MS', 90000, { min: 5000, max: 300000 }),
  apiMaxRetries: readNumber('API_MAX_RETRIES', 2, { min: 0, max: 5 }),
  maxTokens: readNumber('MAX_TOKENS', 0, { min: 0, max: 1000000 }),
  maxLoreEntries: readNumber('MAX_LORE_ENTRIES', loreDefaults.maxEntriesPerTurn || 4, { min: 0, max: 12 }),
  maxLoreChars: readNumber('MAX_LORE_CHARS', loreDefaults.maxContextChars || 8500, { min: 0, max: 30000 }),
  loreRecentUserMessages: readNumber('LORE_RECENT_USER_MESSAGES', loreDefaults.recentUserMessages || 2, { min: 0, max: 10 }),
  port: readNumber('PORT', 3000, { min: 1, max: 65535 }),
};

if (!config.telegramToken) throw new Error('TELEGRAM_TOKEN is missing.');
if (!config.apiKey) throw new Error('API_KEY (or OPENAI_API_KEY) is missing.');

const bot = new Telegraf(config.telegramToken);
const client = new OpenAI({
  apiKey: config.apiKey,
  baseURL: config.baseURL,
  timeout: config.apiTimeoutMs,
  maxRetries: config.apiMaxRetries,
});

// In-memory sessions: each Telegram user gets an isolated conversation per chat.
// Sessions intentionally reset when Railway restarts or redeploys this process.
const sessions = new Map();
const queues = new Map();
let botStarted = false;
let shuttingDown = false;
let totalRequests = 0;

function getSessionKey(ctx) {
  return `${ctx.chat.id}:${ctx.from.id}`;
}

function pruneSessions(now = Date.now()) {
  for (const [key, session] of sessions) {
    if (now - session.touchedAt > config.sessionTtlMs) sessions.delete(key);
  }

  if (sessions.size > config.maxSessions) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt);
    const removeCount = sessions.size - config.maxSessions;
    for (let i = 0; i < removeCount; i += 1) sessions.delete(oldest[i][0]);
  }
}

function getSession(key) {
  const now = Date.now();
  pruneSessions(now);

  let session = sessions.get(key);
  if (!session) {
    session = { messages: [], touchedAt: now, lastLoreTitles: [] };
    sessions.set(key, session);
  }

  session.touchedAt = now;
  return session;
}

function trimHistory(messages) {
  let totalChars = messages.reduce((sum, message) => sum + message.content.length, 0);

  while (
    messages.length > config.maxHistoryMessages ||
    (totalChars > config.maxContextChars && messages.length > 0)
  ) {
    const removed = messages.splice(0, Math.min(2, messages.length));
    totalChars -= removed.reduce((sum, message) => sum + message.content.length, 0);
  }
}

function enqueue(key, task) {
  const previous = queues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  queues.set(key, current);

  return current.finally(() => {
    if (queues.get(key) === current) queues.delete(key);
  });
}

function safeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function keywordMatches(text, keyword) {
  const phrase = String(keyword).trim().split(/\s+/).map(escapeRegex).join('\\s+');
  if (!phrase) return false;
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])${phrase}(?=$|[^\\p{L}\\p{N}_])`, 'iu');
  return pattern.test(text);
}

function getTriggeredLore(session, userText) {
  const allPreviousUserMessages = session.messages.filter((message) => message.role === 'user');
  const previousUserMessages = config.loreRecentUserMessages > 0
    ? allPreviousUserMessages.slice(-config.loreRecentUserMessages).map((message) => message.content)
    : [];
  const searchText = [...previousUserMessages, userText].join('\n');

  const matches = lorebook.entries
    .filter((entry) => entry.keywords.some((keyword) => keywordMatches(searchText, keyword)))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0));

  const selected = [];
  let usedChars = 0;
  for (const entry of matches) {
    if (selected.length >= config.maxLoreEntries) break;
    const block = `## ${entry.title}\n${entry.content}`;
    if (usedChars + block.length > config.maxLoreChars) continue;
    selected.push({ entry, block });
    usedChars += block.length;
  }

  return selected;
}

function buildSystemPrompt(session, userText) {
  const triggered = getTriggeredLore(session, userText);
  session.lastLoreTitles = triggered.map(({ entry }) => entry.title);
  if (triggered.length === 0) return config.systemPrompt;

  const loreContext = [
    '## Relevant canon lore (keyword-triggered)',
    'The following notes were selected because related keywords appeared in the recent conversation. Use only the relevant details; do not force them into unrelated answers.',
    ...triggered.map(({ block }) => block),
  ].join('\n\n');

  return `${config.systemPrompt}\n\n${loreContext}`;
}

function splitTelegramMessage(text, limit = 3900) {
  const chunks = [];
  let remaining = text;

  while (remaining.length > limit) {
    let cut = Math.max(
      remaining.lastIndexOf('\n\n', limit),
      remaining.lastIndexOf('\n', limit),
      remaining.lastIndexOf(' ', limit)
    );

    if (cut < limit * 0.5) cut = limit;
    if (cut > 0 && /[\uD800-\uDBFF]/.test(remaining[cut - 1])) cut -= 1;

    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

async function replyInChunks(ctx, text) {
  const chunks = splitTelegramMessage(text);
  for (const chunk of chunks) {
    await ctx.reply(chunk, { link_preview_options: { is_disabled: true } });
  }
}

function isAllowed(ctx) {
  if (!ctx.from || !config.allowedUsers.has(ctx.from.id)) return false;
  if (!config.allowGroups && ctx.chat?.type !== 'private') return false;
  return true;
}

function logApiError(error) {
  const status = error?.status || error?.statusCode || 'unknown';
  const code = error?.code || error?.name || 'APIError';
  console.error(`[llm] Request failed (status=${status}, code=${code}).`);
}

async function handleText(ctx) {
  if (!isAllowed(ctx)) return;

  const userText = safeText(ctx.message?.text);
  if (!userText) return;
  if (userText.length > config.maxInputChars) {
    await ctx.reply(`Pesan terlalu panjang. Batas saat ini ${config.maxInputChars.toLocaleString('en-US')} karakter.`);
    return;
  }

  const key = getSessionKey(ctx);

  await enqueue(key, async () => {
    const session = getSession(key);
    const requestMessages = [
      { role: 'system', content: buildSystemPrompt(session, userText) },
      ...session.messages,
      { role: 'user', content: userText },
    ];

    let typingTimer;
    try {
      await ctx.sendChatAction('typing').catch(() => {});
      typingTimer = setInterval(() => {
        ctx.sendChatAction('typing').catch(() => {});
      }, 4500);
      typingTimer.unref?.();

      const request = {
        model: config.model,
        messages: requestMessages,
      };
      if (config.maxTokens > 0) request.max_tokens = config.maxTokens;

      const completion = await client.chat.completions.create(request);
      const answer = safeText(completion.choices?.[0]?.message?.content);
      if (!answer) throw new Error('The model returned an empty response.');

      session.messages.push(
        { role: 'user', content: userText },
        { role: 'assistant', content: answer }
      );
      trimHistory(session.messages);
      session.touchedAt = Date.now();
      totalRequests += 1;

      await replyInChunks(ctx, answer);
      const usage = completion.usage?.total_tokens;
      const loreLog = session.lastLoreTitles.length ? ` lore=${session.lastLoreTitles.length}` : '';
      console.log(`[chat] user=${ctx.from.id} model=${config.model} total_tokens=${usage ?? 'n/a'}${loreLog}`);
    } catch (error) {
      logApiError(error);
      await ctx.reply('Sepertinya jalurnya sedang terganggu. Coba lagi sebentar, ya.').catch(() => {});
    } finally {
      if (typingTimer) clearInterval(typingTimer);
    }
  });
}

bot.start(async (ctx) => {
  if (!isAllowed(ctx)) return;
  await ctx.reply(
    'Ah, akhirnya muncul juga. Aku hampir mengira harus mencari accomplice lain.\n\n' +
    'Kirim saja apa yang sedang memenuhi pikiranmu. Kita lihat ke mana percakapan ini akan membawa kita.\n\n' +
    'Gunakan /help untuk melihat perintah, atau /reset kalau ingin memulai dari awal.'
  );
});

bot.help(async (ctx) => {
  if (!isAllowed(ctx)) return;
  await ctx.reply(
    '/start — mulai percakapan\n' +
    '/reset — hapus memory percakapan ini\n' +
    '/status — lihat status bot dan sesi\n' +
    '/lore — lihat topik lorebook yang tersedia\n' +
    '/help — bantuan'
  );
});

bot.command('reset', async (ctx) => {
  if (!isAllowed(ctx)) return;
  sessions.delete(getSessionKey(ctx));
  await ctx.reply('Baiklah. Kita singkirkan jejak percakapan lama dan mulai lagi dari awal.');
});

bot.command('status', async (ctx) => {
  if (!isAllowed(ctx)) return;
  const session = sessions.get(getSessionKey(ctx));
  const messageCount = session?.messages.length || 0;
  const activeLore = session?.lastLoreTitles?.length ? session.lastLoreTitles.join(', ') : 'tidak ada';
  await ctx.reply(
    `Status: online\nModel: ${config.model}\nPersona: Remielle Dan\n` +
    `Lorebook: ${lorebook.entries.length} entri\nLore terakhir aktif: ${activeLore}\n` +
    `Memory sesi: ${messageCount} pesan\nSesi aktif: ${sessions.size}\nTotal request sukses: ${totalRequests}`
  );
});

bot.command('lore', async (ctx) => {
  if (!isAllowed(ctx)) return;
  const topics = lorebook.entries.map((entry) => `• ${entry.title}`).join('\n');
  await ctx.reply(`Lorebook Remielle memuat ${lorebook.entries.length} topik. Lore akan masuk otomatis saat keyword relevan muncul.\n\n${topics}`);
});

bot.on('text', async (ctx) => {
  // Commands are handled above; do not send them to the model.
  if (ctx.message.text.startsWith('/')) return;
  await handleText(ctx);
});

bot.catch((error) => {
  console.error('[telegram] Unhandled update error:', error?.name || 'Error');
});

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }

  if (req.url === '/health' || req.url === '/healthz') {
    const healthy = botStarted && !shuttingDown;
    const body = JSON.stringify({
      ok: healthy,
      service: 'telebot',
      bot: healthy ? 'running' : 'starting',
      model: config.model,
      persona: 'remielle',
      lorebook_entries: lorebook.entries.length,
    });
    res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }

  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(req.method === 'HEAD' ? undefined : 'TeleBot is running.');
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  return res.end(req.method === 'HEAD' ? undefined : 'Not found.');
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(`[health] Listening on port ${config.port}.`);
});

async function start() {
  try {
    await bot.launch();
    botStarted = true;
    console.log(`[bot] Telegram polling started. Model=${config.model} Persona=Remielle Lorebook=${lorebook.entries.length}`);
  } catch (error) {
    console.error('[bot] Startup failed:', error?.name || 'Error');
    process.exitCode = 1;
    server.close();
  }
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  botStarted = false;
  console.log(`[system] Received ${signal}; shutting down.`);

  try {
    bot.stop(signal);
  } catch {
    // The bot may not have completed startup yet.
  }

  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

start();
