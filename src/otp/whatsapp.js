export async function sendWhatsAppCode(env, phone, code) {
  const res = await fetch(`https://graph.facebook.com/v17.0/${env.WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: phone.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: 'cofiz_otp',
        language: { code: 'en_US' },
        components: [
          {
            type: 'body',
            parameters: [{ type: 'text', text: code }],
          },
        ],
      },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`whatsapp ${res.status}: ${err}`);
  }
}
