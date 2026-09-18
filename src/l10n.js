export const STR = {
  nightlyTitle: { en: 'Cofiz → Daily Reminder', am: 'Cofiz → ዕለታዊ ማሳሰቢያ' },
  nightlyBody: {
    en: "No transaction recorded today: add today's purchases/distributions",
    am: 'ዛሬ ምንም ግብይት አልተመዘገበም: የዛሬ ግዢዎች/ስርጭቶች ያክሉ',
  },
  debtTitle: { en: 'Cofiz → Debt Reminder', am: 'Cofiz → የዕዳ ማሳሰቢያ' },
  debtBody: (s) => ({
    en: s ? `Reminder: ${s}` : 'Reminder: open debts need attention',
    am: s ? `ማሳሰቢያ: ${s}` : 'ማሳሰቢያ: ክፍት ዕዳዎች ትኩረት ያስፈልጋቸዋል',
  }),
  checkinTitle: { en: 'Cofiz → Weekly Check-in', am: 'Cofiz → ሳምንታዊ መግቢያ' },
  checkinBody: {
    en: "Check in: see this week's business",
    am: 'ይግቡ: የዚህ ሳምንት ስራ ይመልከቱ',
  },
  updateTitle: { en: 'Cofiz → New Update', am: 'Cofiz → አዲስ ዝመና' },
  approvedTitle: {
    en: 'Cofiz → Registration Approved',
    am: 'Cofiz → ምዝገባ ጸድቋል',
  },
  deniedTitle: {
    en: 'Cofiz → Registration Denied',
    am: 'Cofiz → ምዝገባ ውድቅ ሆኗል',
  },
  approvedBody: (name) => ({
    en: `Hi ${name}, your Cofiz registration was approved. You can now sign in.`,
    am: `ሰላም ${name}, የCofiz ምዝገባዎ ጸድቋል። አሁን መግባት ይችላሉ።`,
  }),
  deniedBody: (name) => ({
    en: `Hi ${name}, your Cofiz registration was denied.`,
    am: `ሰላም ${name}, የCofiz ምዝገባዎ ውድቅ ሆኗል።`,
  }),
};

export function pick(pair, lang) {
  if (!pair) return '';
  if (typeof pair === 'string') return pair;
  return lang === 'am' ? pair.am : pair.en;
}

export function langOf(userData) {
  const code = userData && userData.language_code;
  if (typeof code === 'string' && code.toLowerCase().startsWith('am')) {
    return 'am';
  }
  return 'en';
}

export function sanitizeNotificationText(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/\u2014/g, ':').replace(/\u2013/g, '-');
}
