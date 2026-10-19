// SMS gateway adapter.
//   send({ to, body }) -> { sent: boolean, simulated: boolean, detail }
//
// SMS_MODE=africastalking : real delivery through Africa's Talking (covers Rwanda). Needs AT_USERNAME and
//                           AT_API_KEY from your Africa's Talking account (username "sandbox" uses their test
//                           environment, which delivers nothing to real phones).
// SMS_MODE=http           : generic gateway, POST { to, message, from } to SMS_API_URL with a bearer key.
// SMS_MODE=simulation     : nothing is transmitted; the message is only recorded in the SMS log.
import { env } from '../../config/env.js';

async function africasTalking({ to, body }) {
  if (!env.AT_USERNAME || !env.AT_API_KEY) {
    return { sent: false, simulated: false, detail: 'Africa\'s Talking is selected but AT_USERNAME / AT_API_KEY are not set' };
  }
  const host = env.AT_USERNAME === 'sandbox' ? 'api.sandbox.africastalking.com' : 'api.africastalking.com';
  const form = new URLSearchParams({ username: env.AT_USERNAME, to, message: body });
  if (env.AT_SENDER_ID) form.set('from', env.AT_SENDER_ID);
  try {
    const res = await fetch(`https://${host}/version1/messaging`, {
      method: 'POST',
      headers: { apiKey: env.AT_API_KEY, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(10000),
    });
    const json = await res.json().catch(() => ({}));
    const recipient = json?.SMSMessageData?.Recipients?.[0];
    // statusCode 100-102 = processed / sent / queued
    const ok = res.ok && recipient && [100, 101, 102].includes(Number(recipient.statusCode));
    return { sent: !!ok, simulated: false, detail: ok ? `Accepted by Africa's Talking (${recipient.status})` : `Africa's Talking: ${recipient?.status || json?.SMSMessageData?.Message || res.status}` };
  } catch (err) {
    return { sent: false, simulated: false, detail: `Gateway unreachable: ${err.name}` };
  }
}

async function genericHttp({ to, body }) {
  if (!env.SMS_API_URL || !env.SMS_API_KEY) return { sent: false, simulated: false, detail: 'SMS_API_URL / SMS_API_KEY not set' };
  try {
    const res = await fetch(env.SMS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.SMS_API_KEY}` },
      body: JSON.stringify({ to, message: body, from: env.SMS_SENDER || 'SmartParking' }),
      signal: AbortSignal.timeout(8000),
    });
    return { sent: res.ok, simulated: false, detail: res.ok ? 'Accepted by gateway' : `Gateway responded ${res.status}` };
  } catch (err) {
    return { sent: false, simulated: false, detail: `Gateway unreachable: ${err.name}` };
  }
}

export async function sendSms(message) {
  if (env.SMS_MODE === 'africastalking') return africasTalking(message);
  if (env.SMS_MODE === 'http') return genericHttp(message);
  return { sent: false, simulated: true, detail: 'SMS gateway not connected: message recorded but NOT delivered' };
}
