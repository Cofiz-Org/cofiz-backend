import { handleApproveRegistration, handleDenyRegistration } from '../auth/index.js';

export async function sendLoginButton(env, chatId) {
  const loginUrl = `https://cofiz.natanim.dev/auth/telegram/login`;
  const payload = {
    chat_id: chatId,
    text: 'Tap below to log in to Cofiz',
    reply_markup: { inline_keyboard: [[ { text: 'Log in to Cofiz', login_url: { url: loginUrl, request_write_access: true } } ]] }
  };
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const body = await r.text();
  console.log('sendLoginButton', chatId, r.status, body);
  return { status: r.status, body };
}

async function answerCallbackQuery(env, callbackQueryId, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: true }),
  });
}

async function editMessageText(env, chatId, messageId, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text }),
  });
}

async function handleCallbackQuery(callbackQuery, env) {
  const data = callbackQuery.data;
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  if (!data || !chatId) return;

  if (data.startsWith('approve:')) {
    const phone = data.slice('approve:'.length);
    const result = await handleApproveRegistration(phone, env);
    if (result) {
      await answerCallbackQuery(env, callbackQuery.id, `${result.displayName} approved as ${result.requestedRole}`);
      if (messageId) {
        await editMessageText(env, chatId, messageId,
          `✅ Approved\n\n${callbackQuery.message.text}\n\n→ Role: ${result.requestedRole}`);
      }
    } else {
      await answerCallbackQuery(env, callbackQuery.id, 'User not found');
    }
  } else if (data.startsWith('deny:')) {
    const phone = data.slice('deny:'.length);
    await handleDenyRegistration(phone, env);
    await answerCallbackQuery(env, callbackQuery.id, 'Registration denied');
    if (messageId) {
      await editMessageText(env, chatId, messageId,
        `❌ Denied\n\n${callbackQuery.message.text}`);
    }
  }
}

export async function handleTelegramWebhook(request, env) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (env.TELEGRAM_WEBHOOK_SECRET && secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }
  let update;
  try { update = await request.json(); } catch { return new Response('ok'); }
  console.log('webhook update', JSON.stringify(update).slice(0, 800));

  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
    return new Response('ok');
  }

  const msg = update.message;
  if (!msg || !msg.text) return new Response('ok');
  const text = msg.text.trim();
  const chatId = msg.chat.id;

  if (text.startsWith('/start')) {
    const res = await sendLoginButton(env, chatId);
    return new Response(JSON.stringify(res), { headers: { 'content-type': 'application/json' } });
  }

  return new Response('ok');
}

export async function handleTelegramDebug(request, env) {
  const url = new URL(request.url);
  const chatId = url.searchParams.get('chat_id');
  if (!chatId) return new Response('chat_id required', { status: 400 });
  const res = await sendLoginButton(env, chatId);
  return new Response(JSON.stringify(res), { headers: { 'content-type': 'application/json' } });
}
