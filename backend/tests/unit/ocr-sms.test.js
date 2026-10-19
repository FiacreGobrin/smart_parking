import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.SMS_MODE = 'africastalking';
process.env.AT_USERNAME = 'sandbox';
process.env.AT_API_KEY = 'test-key';
const { sendSms } = await import('../../src/integrations/sms/index.js');
const { pickPlate, repairRwandan } = await import('../../src/integrations/anpr/index.js');

describe('plate text extraction from OCR output', () => {
  it('finds a Rwandan plate in noisy text', () => {
    expect(pickPlate('| RAB 123 C |').plate).toBe('RAB123C');
    expect(pickPlate('noise\nRWE 480 K\n').plate).toBe('RWE480K');
  });
  it('repairs look-alike characters by position (O/0, I/1, S/5, B/8)', () => {
    expect(repairRwandan('RA8I23C')).toBe('RAB123C');
    expect(pickPlate('RAB 1O5 C').plate).toBe('RAB105C');
  });
  it('still returns a loose candidate for foreign plates and null for noise', () => {
    expect(pickPlate('KCA 123B').plate).toBe('KCA123B');
    expect(pickPlate('hello world').plate).toBeNull();
    expect(pickPlate('').plate).toBeNull();
  });
});

describe("Africa's Talking SMS adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the documented request and reports delivery', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ SMSMessageData: { Recipients: [{ statusCode: 101, status: 'Success' }] } }) });
    vi.stubGlobal('fetch', fetchMock);
    const r = await sendSms({ to: '+250788123456', body: 'hello' });
    expect(r).toMatchObject({ sent: true, simulated: false });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.sandbox.africastalking.com/version1/messaging');
    expect(init.headers.apiKey).toBe('test-key');
    expect(init.body.get('to')).toBe('+250788123456');
    expect(init.body.get('username')).toBe('sandbox');
  });

  it('never claims success when the gateway rejects or is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ SMSMessageData: { Recipients: [{ statusCode: 403, status: 'InvalidPhoneNumber' }] } }) }));
    expect((await sendSms({ to: 'x', body: 'y' })).sent).toBe(false);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { name: 'TypeError' })));
    expect((await sendSms({ to: 'x', body: 'y' })).sent).toBe(false);
  });
});
