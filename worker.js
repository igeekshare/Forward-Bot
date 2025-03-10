const TOKEN = ENV_BOT_TOKEN // Get it from @BotFather
const WEBHOOK = '/endpoint'
const SECRET = ENV_BOT_SECRET // A-Z, a-z, 0-9, _ and -
const ADMIN_UID = ENV_ADMIN_UID // your user id, get it from https://t.me/username_to_id_bot

const NOTIFY_INTERVAL = 3600 * 1000;
const fraudDb = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/fraud.db';
const notificationUrl = 'https://raw.githubusercontent.com/igeekshare/Forward-Bot/refs/heads/main/data/notification.txt'
const startMsgUrl = 'https://raw.githubusercontent.com/igeekshare/Forward-Bot/refs/heads/main/data/startMessage.md';

const enable_notification = true

// 生成随机加减法验证码
function generateCaptcha() {
  const num1 = Math.floor(Math.random() * 10); // 生成 0-9 的随机数
  const num2 = Math.floor(Math.random() * 10);
  const operator = Math.random() < 0.5 ? '+' : '-'; // 随机选择加法或减法
  const question = `${num1} ${operator} ${num2} = ?`;
  let answer = operator === '+' ? num1 + num2 : num1 - num2;
  return { question, answer: answer.toString() };
}

/**
 * Return url to telegram api, optionally with parameters added
 */
function apiUrl(methodName, params = null) {
  let query = '';
  if (params) {
    query = '?' + new URLSearchParams(params).toString();
  }
  return `https://api.telegram.org/bot${TOKEN}/${methodName}${query}`;
}

function requestTelegram(methodName, body, params = null) {
  return fetch(apiUrl(methodName, params), body)
    .then(r => r.json());
}

function makeReqBody(body) {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  };
}

function sendMessage(msg = {}) {
  return requestTelegram('sendMessage', makeReqBody(msg));
}

function copyMessage(msg = {}) {
  return requestTelegram('copyMessage', makeReqBody(msg));
}

function forwardMessage(msg) {
  return requestTelegram('forwardMessage', makeReqBody(msg));
}

/**
 * Wait for requests to the worker
 */
addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.pathname === WEBHOOK) {
    event.respondWith(handleWebhook(event));
  } else if (url.pathname === '/registerWebhook') {
    event.respondWith(registerWebhook(event, url, WEBHOOK, SECRET));
  } else if (url.pathname === '/unRegisterWebhook') {
    event.respondWith(unRegisterWebhook(event));
  } else {
    event.respondWith(new Response('No handler for this request'));
  }
});

/**
 * Handle requests to WEBHOOK
 */
async function handleWebhook(event) {
  if (event.request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== SECRET) {
    return new Response('Unauthorized', { status: 403 });
  }
  const update = await event.request.json();
  event.waitUntil(onUpdate(update));
  return new Response('Ok');
}

/**
 * Handle incoming Update
 */
async function onUpdate(update) {
  if ('message' in update) {
    await onMessage(update.message);
  }
}

/**
 * Handle incoming Message
 */
async function onMessage(message) {
  if (message.text === '/start') {
    let startMsg = await fetch(startMsgUrl).then(r => r.text());
    return sendMessage({
      chat_id: message.chat.id,
      text: startMsg,
    });
  }
  if (message.chat.id.toString() === ADMIN_UID) {
    if (!message?.reply_to_message?.chat) {
      return sendMessage({
        chat_id: ADMIN_UID,
        text: '使用方法，回复转发的消息，并发送回复消息，或者`/block`、`/unblock`、`/checkblock`等指令'
      });
    }
    if (/^\/block$/.exec(message.text)) {
      return handleBlock(message);
    }
    if (/^\/unblock$/.exec(message.text)) {
      return handleUnBlock(message);
    }
    if (/^\/checkblock$/.exec(message.text)) {
      return checkBlock(message);
    }
    let guestChatId = await nfd.get('msg-map-' + message?.reply_to_message.message_id, { type: "json" });
    return copyMessage({
      chat_id: guestChatId,
      from_chat_id: message.chat.id,
      message_id: message.message_id,
    });
  }
  return handleGuestMessage(message);
}

/**
 * Handle messages from guest users with verification
 */
async function handleGuestMessage(message) {
  let chatId = message.chat.id;
  let isBlocked = await nfd.get('isblocked-' + chatId, { type: "json" });

  if (isBlocked) {
    return sendMessage({
      chat_id: chatId,
      text: 'Your are blocked'
    });
  }

  let verified = await nfd.get('verified-' + chatId, { type: "json" });
  if (!verified) {
    let captcha = await nfd.get('captcha-' + chatId, { type: "json" });
    if (!captcha) {
      // 如果没有验证码，生成并发送
      captcha = generateCaptcha();
      await nfd.put('captcha-' + chatId, JSON.stringify(captcha));
      await sendMessage({
        chat_id: chatId,
        text: `请回答以下问题以完成验证：${captcha.question}`
      });
      return;
    } else {
      // 检查用户回答是否正确
      if (message.text === captcha.answer) {
        await nfd.put('verified-' + chatId, true);
        await nfd.delete('captcha-' + chatId);
        await sendMessage({
          chat_id: chatId,
          text: '验证成功！您现在可以发送消息。'
        });
        return; // 验证成功后不转发任何消息给管理员
      } else {
        await sendMessage({
          chat_id: chatId,
          text: '回答错误，请重试。'
        });
        return;
      }
    }
  }

  // 用户已验证，检查消息是否为 /start
  if (message.text === '/start') {
    // 如果是 /start 命令，只回复用户，不转发给管理员
    let startMsg = await fetch(startMsgUrl).then(r => r.text());
    return sendMessage({
      chat_id: chatId,
      text: startMsg,
    });
  }

  // 转发普通消息给管理员
  let forwardReq = await forwardMessage({
    chat_id: ADMIN_UID,
    from_chat_id: message.chat.id,
    message_id: message.message_id
  });
  if (forwardReq.ok) {
    await nfd.put('msg-map-' + forwardReq.result.message_id, chatId);
    await sendMessage({
      chat_id: chatId,
      text: '发送成功✅'
    });
  }
  return handleNotify(message);
}

async function handleNotify(message) {
  let chatId = message.chat.id;
  if (await isFraud(chatId)) {
    return sendMessage({
      chat_id: ADMIN_UID,
      text: `检测到骗子，UID${chatId}`
    });
  }
  if (enable_notification) {
    let lastMsgTime = await nfd.get('lastmsg-' + chatId, { type: "json" });
    if (!lastMsgTime || Date.now() - lastMsgTime > NOTIFY_INTERVAL) {
      await nfd.put('lastmsg-' + chatId, Date.now());
      return sendMessage({
        chat_id: ADMIN_UID,
        text: await fetch(notificationUrl).then(r => r.text())
      });
    }
  }
}

async function handleBlock(message) {
  let guestChatId = await nfd.get('msg-map-' + message.reply_to_message.message_id, { type: "json" });
  if (guestChatId === ADMIN_UID) {
    return sendMessage({
      chat_id: ADMIN_UID,
      text: '不能屏蔽自己'
    });
  }
  await nfd.put('isblocked-' + guestChatId, true);
  return sendMessage({
    chat_id: ADMIN_UID,
    text: `UID:${guestChatId}屏蔽成功`,
  });
}

async function handleUnBlock(message) {
  let guestChatId = await nfd.get('msg-map-' + message.reply_to_message.message_id, { type: "json" });
  await nfd.put('isblocked-' + guestChatId, false);
  return sendMessage({
    chat_id: ADMIN_UID,
    text: `UID:${guestChatId}解除屏蔽成功`,
  });
}

async function checkBlock(message) {
  let guestChatId = await nfd.get('msg-map-' + message.reply_to_message.message_id, { type: "json" });
  let blocked = await nfd.get('isblocked-' + guestChatId, { type: "json" });
  return sendMessage({
    chat_id: ADMIN_UID,
    text: `UID:${guestChatId}` + (blocked ? '被屏蔽' : '没有被屏蔽')
  });
}

/**
 * Send plain text message
 */
async function sendPlainText(chatId, text) {
  return sendMessage({
    chat_id: chatId,
    text
  });
}

/**
 * Set webhook to this worker's url
 */
async function registerWebhook(event, requestUrl, suffix, secret) {
  const webhookUrl = `${requestUrl.protocol}//${requestUrl.hostname}${suffix}`;
  const r = await (await fetch(apiUrl('setWebhook', { url: webhookUrl, secret_token: secret }))).json();
  return new Response('ok' in r && r.ok ? 'Ok' : JSON.stringify(r, null, 2));
}

/**
 * Remove webhook
 */
async function unRegisterWebhook(event) {
  const r = await (await fetch(apiUrl('setWebhook', { url: '' }))).json();
  return new Response('ok' in r && r.ok ? 'Ok' : JSON.stringify(r, null, 2));
}

async function isFraud(id) {
  id = id.toString();
  let db = await fetch(fraudDb).then(r => r.text());
  let arr = db.split('\n').filter(v => v);
  return arr.includes(id);
}
