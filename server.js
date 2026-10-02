'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const ENV_PATH = path.join(ROOT, '.env');
const INDEX_PATH = path.join(ROOT, 'index.html');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const TELEGRAM_API = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';

const MAX_BODY_BYTES = 16 * 1024;
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 10 * 60 * 1000;

function readEnvFile() {
  const env = {};
  if (!fs.existsSync(ENV_PATH)) return env;
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

// Read on every request so a token saved into .env works without a restart.
function config() {
  const file = readEnvFile();
  return {
    token: process.env.TELEGRAM_BOT_TOKEN || file.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || file.TELEGRAM_CHAT_ID || '',
  };
}

function saveEnvValue(key, value) {
  const lines = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/) : [];
  let found = false;
  const next = lines.map((line) => {
    if (new RegExp(`^\\s*${key}\\s*=`).test(line)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) next.push(`${key}=${value}`);
  fs.writeFileSync(ENV_PATH, next.join('\n').replace(/\n*$/, '\n'));
}

async function telegram(method, token, payload) {
  const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    const err = new Error(data.description || `Telegram ответил ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data.result;
}

let lastDiscoveryNote = '';
function note(text) {
  if (text !== lastDiscoveryNote) {
    console.log(text);
    lastDiscoveryNote = text;
  }
}

// Until a chat id is known, watch the bot's inbox: the first person who
// writes to the bot (the owner) becomes the chat that receives leads.
async function discoverChatId() {
  const { token, chatId } = config();
  if (!token || chatId) return;
  try {
    const updates = await telegram('getUpdates', token, { timeout: 0 });
    const chat = updates
      .map((u) => (u.message || u.edited_message || u.my_chat_member || {}).chat)
      .filter(Boolean)
      .pop();
    if (!chat) {
      note('Бот подключен. Напиши ему любое сообщение в Telegram — я запомню чат для заявок.');
      return;
    }
    saveEnvValue('TELEGRAM_CHAT_ID', String(chat.id));
    note(`Чат для заявок найден и сохранен: ${chat.first_name || chat.title || chat.id}.`);
    await telegram('sendMessage', token, {
      chat_id: chat.id,
      text: 'Готово: сюда будут приходить заявки с лендинга «После 45».',
    });
  } catch (err) {
    note(err.status === 401 || err.status === 404
      ? 'Telegram не принял ключ бота. Проверь TELEGRAM_BOT_TOKEN в файле .env.'
      : `Не получилось связаться с Telegram: ${err.message}`);
  }
}

const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT;
}

function clean(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleLead(req, res) {
  if (rateLimited(req.socket.remoteAddress || '')) {
    return send(res, 429, { ok: false, error: 'Слишком много заявок подряд. Попробуй через несколько минут.' });
  }

  let data;
  try {
    data = JSON.parse(await readBody(req));
  } catch (err) {
    return send(res, err.status || 400, { ok: false, error: 'Не получилось прочитать заявку. Обнови страницу и попробуй еще раз.' });
  }

  // Bots fill the hidden field; pretend success so they don't retry.
  if (clean(data.website, 200)) return send(res, 200, { ok: true });

  const name = clean(data.name, 100);
  const contact = clean(data.contact, 100);
  const message = typeof data.message === 'string' ? data.message.trim().slice(0, 1000) : '';
  const source = clean(data.source, 100);

  if (!name || contact.length < 3) {
    return send(res, 400, { ok: false, error: 'Заполни имя и контакт.' });
  }
  if (data.consent !== true) {
    return send(res, 400, { ok: false, error: 'Нужно согласие на обработку данных.' });
  }

  const { token, chatId } = config();
  if (!token || !chatId) {
    console.log('Заявка не отправлена: Telegram еще не подключен (см. README).');
    return send(res, 503, { ok: false, error: 'Прием заявок еще не настроен. Попробуй позже.' });
  }

  const text = [
    'Новая заявка с лендинга «После 45»',
    '',
    `Имя: ${name}`,
    `Контакт: ${contact}`,
    `Сообщение: ${message || '—'}`,
    `Источник: ${source || 'прямой заход'}`,
    `Время: ${new Date().toLocaleString('ru-RU')}`,
  ].join('\n');

  try {
    await telegram('sendMessage', token, { chat_id: chatId, text, disable_web_page_preview: true });
    console.log(`Заявка от «${name}» отправлена в Telegram.`);
    return send(res, 200, { ok: true });
  } catch (err) {
    console.log(`Заявка не дошла до Telegram: ${err.message}`);
    return send(res, 502, { ok: false, error: 'Не получилось отправить заявку. Попробуй еще раз чуть позже.' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(INDEX_PATH), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      const { token, chatId } = config();
      return send(res, 200, { ok: true, botToken: Boolean(token), chatId: Boolean(chatId) });
    }
    if (url.pathname === '/api/lead') {
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
      return await handleLead(req, res);
    }
    return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  } catch (err) {
    console.error(err);
    return send(res, 500, { ok: false, error: 'Что-то пошло не так. Попробуй еще раз.' });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Лендинг уже запущен: http://localhost:${PORT}`);
    process.exit(0);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  const { token, chatId } = config();
  console.log(`Лендинг открыт: http://localhost:${PORT}`);
  if (!token) console.log('Telegram не подключен: впиши ключ бота в файл .env (см. README).');
  else if (!chatId) console.log('Ключ бота есть. Жду первое сообщение боту, чтобы узнать чат для заявок.');
  else console.log('Telegram подключен: заявки будут приходить в чат.');
  discoverChatId();
  setInterval(discoverChatId, 3000).unref();
});
