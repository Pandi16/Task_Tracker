require('dotenv').config();

const TELEGRAM_API_BASE = 'https://api.telegram.org';

function isTelegramConfigured() {
  return String(process.env.TELEGRAM_ENABLED || '').toLowerCase() === 'true'
    && Boolean(process.env.TELEGRAM_BOT_TOKEN);
}

function isTelegramPollingEnabled() {
  return isTelegramConfigured()
    && String(process.env.TELEGRAM_BOT_POLLING_ENABLED || '').toLowerCase() === 'true';
}

function getTelegramPollIntervalMs() {
  const seconds = Number(process.env.TELEGRAM_POLL_INTERVAL_SECONDS || 20);
  const safeSeconds = Number.isFinite(seconds) && seconds >= 5 ? seconds : 20;
  return safeSeconds * 1000;
}

function telegramEndpoint(method) {
  return `${TELEGRAM_API_BASE}/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;
}

function truncate(value, max = 3900) {
  const text = String(value || '');
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

async function callTelegram(method, payload = {}) {
  if (!isTelegramConfigured()) return null;

  const response = await fetch(telegramEndpoint(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const raw = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Telegram returned non-JSON response: ${raw.slice(0, 300)}`);
  }

  if (!response.ok || !parsed.ok) {
    throw new Error(`Telegram ${method} failed: ${raw.slice(0, 500)}`);
  }

  return parsed.result;
}

async function sendTelegramMessage(chatId, text, options = {}) {
  if (!isTelegramConfigured() || !chatId) return false;

  await callTelegram('sendMessage', {
    chat_id: String(chatId),
    text: truncate(text),
    disable_web_page_preview: Boolean(options.disableWebPagePreview ?? true)
  });

  return true;
}

async function getTelegramUpdates(offset = null, timeout = 0) {
  if (!isTelegramConfigured()) return [];

  const payload = {
    timeout,
    allowed_updates: ['message']
  };
  if (offset) payload.offset = offset;

  const result = await callTelegram('getUpdates', payload);
  return Array.isArray(result) ? result : [];
}

module.exports = {
  isTelegramConfigured,
  isTelegramPollingEnabled,
  getTelegramPollIntervalMs,
  sendTelegramMessage,
  getTelegramUpdates,
  callTelegram
};
