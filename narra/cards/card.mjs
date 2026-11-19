// Quidpaw offer card: one PNG listing up to 5 offers, so a phone shows the whole answer at a glance.
// Usage: echo '{"zh":true,"lead":"…","offers":[…]}' | node card.mjs out.png  → prints {"width","height"}
//        node card.mjs --setup  (downloads the fonts once)
// Offer fields are the public API's: retailer, title, code, discount_type, discount_value,
// min_spend_gbp, expires_on, eligibility, eligibility_zh, via, reports_7d.

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FONT_DIR = join(HERE, 'fonts');
const FONTS = {
  'NotoSansTC-Regular.otf': 'https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/SubsetOTF/TC/NotoSansTC-Regular.otf',
  'NotoSansTC-Bold.otf': 'https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/SubsetOTF/TC/NotoSansTC-Bold.otf',
  'NotoSansSC-Regular.otf': 'https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf',
  'NotoSansSC-Bold.otf': 'https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/SubsetOTF/SC/NotoSansSC-Bold.otf',
};
const C = { navy: '#1F3A5F', orange: '#E4572E', cream: '#FFF6EC', card: '#FFFFFF', line: '#EADFD2', ink: '#1E2430', grey: '#6B7280', bean: '#F7A8A0', warn: '#B45309' };
const W = 400, PAD = 16, BADGE = 72;

function normLang(lang, zh = true) {
  if (typeof lang === 'string') {
    const low = lang.trim().toLowerCase();
    if (low === 'zh-hans' || low === 'zh-cn' || low === 'zh-sg' || low === 'hans') return 'zh-Hans';
    if (low === 'zh-hant' || low === 'zh-tw' || low === 'zh-hk' || low === 'zh' || low === 'hant') return 'zh-Hant';
    if (low === 'en') return 'en';
  }
  return zh ? 'zh-Hant' : 'en';
}

export async function ensureFonts(lang = null) {
  mkdirSync(FONT_DIR, { recursive: true });
  const wanted = lang === 'zh-Hans'
    ? ['NotoSansSC-Regular.otf', 'NotoSansSC-Bold.otf']
    : lang
      ? ['NotoSansTC-Regular.otf', 'NotoSansTC-Bold.otf']
      : Object.keys(FONTS);
  for (const name of wanted) {
    const file = join(FONT_DIR, name);
    if (!existsSync(file)) {
      const res = await fetch(FONTS[name]);
      if (!res.ok) throw new Error(`font ${name}: HTTP ${res.status}`);
      writeFileSync(file + '.part', Buffer.from(await res.arrayBuffer()));
      renameSync(file + '.part', file);
    }
  }
  return Object.keys(FONTS).map((name) => join(FONT_DIR, name)).filter((f) => existsSync(f));
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Rough advance widths: CJK and full-width forms take a full em, Latin about half.
const charW = (ch, size, bold) => (/[⺀-鿿豈-﫿＀-￯　-〿]/.test(ch) ? size : size * (bold ? 0.58 : 0.5));
const textW = (s, size, bold) => [...String(s)].reduce((w, ch) => w + charW(ch, size, bold), 0);

function wrap(s, size, max, lines, bold = false) {
  const chars = [...String(s ?? '')];
  const out = [];
  let cur = '', cut = false;
  for (let k = 0; k < chars.length; k++) {
    const ch = chars[k];
    if (textW(cur + ch, size, bold) <= max) { cur += ch; continue; }
    if (out.length === lines - 1) { cut = true; break; }
    // Break Latin text at the last space when there is one.
    const sp = /[A-Za-z0-9]/.test(ch) ? cur.lastIndexOf(' ') : -1;
    if (sp > 0) { out.push(cur.slice(0, sp)); cur = cur.slice(sp + 1) + ch; } else { out.push(cur); cur = ch.trim() ? ch : ''; }
  }
  if (cut) {
    while (cur && textW(cur + '…', size, bold) > max) cur = [...cur].slice(0, -1).join('');
    cur = cur.trimEnd() + '…';
  }
  if (cur) out.push(cur);
  return out;
}

function badge(v, lang) {
  const n = v.discount_value;
  const sc = lang === 'zh-Hans', zh = lang !== 'en';
  switch (v.discount_type) {
    case 'percent': {
      if (!n) break;
      if (!zh) return [`${n}%`, 'OFF'];
      const f = (100 - n) / 10;
      return [Number.isInteger(f) ? `${f}折` : `${Math.round(f * 10)}折`, `省 ${n}%`];
    }
    case 'fixed': return n ? [`£${n}`, zh ? '折抵' : 'OFF'] : null;
    case 'free-delivery': return sc ? ['免运', '运费'] : zh ? ['免運', '運費'] : ['FREE', 'delivery'];
    case 'bogo': return sc ? ['买一', '送一'] : zh ? ['買一', '送一'] : ['BOGO', 'deal'];
    case 'cashback': return n ? [`${n}%`, sc ? '返现' : zh ? '回饋' : 'back'] : null;
    case 'gift': return sc ? ['赠品', '满额'] : zh ? ['贈品', '滿額'] : ['GIFT', 'with buy'];
  }
  return sc ? ['优惠', ''] : zh ? ['優惠', ''] : ['DEAL', ''];
}

const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
const enDate = (iso) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;

export function cardSvg({ zh = true, lang, lead = '', offers = [], caption = false }) {
  const resolved = normLang(lang, zh);
  const isZh = resolved !== 'en', sc = resolved === 'zh-Hans';
  const fontFamily = sc ? 'Noto Sans SC, Noto Sans TC' : 'Noto Sans TC, Noto Sans SC';
  const logo = 'data:image/png;base64,' + readFileSync(join(HERE, 'quidpaw-64.png')).toString('base64');
  const leadLines = lead ? wrap(lead.replace(/\s+/g, ' '), 13, W - PAD * 2 - 44, 2) : [];
  let y = PAD;
  const parts = [];
  // Header: the paw, the name, the lead.
  parts.push(`<image href="${logo}" x="${PAD}" y="${y}" width="34" height="34"/>`);
  parts.push(`<text x="${PAD + 44}" y="${y + 15}" font-size="15" font-weight="700" fill="${C.navy}">Quidpaw</text>`);
  leadLines.forEach((l, i) => parts.push(`<text x="${PAD + 44}" y="${y + 32 + i * 16}" font-size="13" fill="${C.grey}">${esc(l)}</text>`));
  y += Math.max(40, 22 + leadLines.length * 16) + 8;
  const textX = PAD + BADGE + 12, textMax = W - textX - PAD - 8;
  offers.slice(0, 5).forEach((v, i) => {
    const title = wrap(v.title ?? '', 13, textMax, 2);
    const meta = [];
    const who = isZh ? v.eligibility_zh : (v.eligibility || '').replace(/-/g, ' ');
    if (v.eligibility && v.eligibility !== 'everyone' && who) meta.push(who);
    if (v.via) meta.push(`via ${v.via}`);
    if (v.min_spend_gbp) meta.push(sc ? `满 £${v.min_spend_gbp}` : isZh ? `滿 £${v.min_spend_gbp}` : `min £${v.min_spend_gbp}`);
    if (v.expires_on) meta.push(isZh ? `到 ${v.expires_on.slice(5).replace('-', '/')}` : `ends ${enDate(v.expires_on)}`);
    const warn = (v.reports_7d || 0) >= 3;
    const h = 12 + 18 + title.length * 17 + 30 + (meta.length ? 16 : 0) + (warn ? 16 : 0) + 8;
    parts.push(`<rect x="${PAD}" y="${y}" width="${W - PAD * 2}" height="${h}" rx="12" fill="${C.card}" stroke="${C.line}"/>`);
    // Badge: the size of the saving, big.
    const [big, small] = badge(v, resolved) || ['', ''];
    parts.push(`<rect x="${PAD + 8}" y="${y + 8}" width="${BADGE - 8}" height="${h - 16}" rx="9" fill="${C.navy}"/>`);
    const bigSize = textW(big, 22, true) > BADGE - 16 ? 17 : 22;
    const mid = y + h / 2;
    parts.push(`<text x="${PAD + 4 + BADGE / 2}" y="${mid + (small ? 2 : 8)}" font-size="${bigSize}" font-weight="700" fill="#FFFFFF" text-anchor="middle">${esc(big)}</text>`);
    if (small) parts.push(`<text x="${PAD + 4 + BADGE / 2}" y="${mid + 19}" font-size="11" fill="${C.bean}" text-anchor="middle">${esc(small)}</text>`);
    let ty = y + 12 + 14;
    parts.push(`<text x="${textX}" y="${ty}" font-size="14" font-weight="700" fill="${C.ink}">${i + 1}. ${esc(v.retailer)}</text>`);
    ty += 4;
    title.forEach((l) => { ty += 17; parts.push(`<text x="${textX}" y="${ty}" font-size="13" fill="${C.ink}">${esc(l)}</text>`); });
    ty += 8;
    // The code, as a pill; "no code" in grey.
    const pill = v.code ? (sc ? `码 ${v.code}` : isZh ? `碼 ${v.code}` : `CODE ${v.code}`) : sc ? '免码・结账自动折' : isZh ? '免碼・結帳自動折' : 'No code needed';
    const pw = Math.min(textMax, textW(pill, 13, true) + 22);
    parts.push(`<rect x="${textX}" y="${ty}" width="${pw}" height="24" rx="12" fill="${v.code ? C.cream : '#F1F2F4'}" stroke="${v.code ? C.orange : '#D9DCE1'}" ${v.code ? 'stroke-dasharray="4 3"' : ''}/>`);
    parts.push(`<text x="${textX + 9}" y="${ty + 16.5}" font-size="13" font-weight="700" fill="${v.code ? C.orange : C.grey}">${esc(pill)}</text>`);
    ty += 24;
    if (meta.length) { ty += 16; parts.push(`<text x="${textX}" y="${ty}" font-size="12" fill="${C.grey}">${esc(meta.join(' · '))}</text>`); }
    if (warn) { ty += 16; parts.push(`<text x="${textX}" y="${ty}" font-size="12" fill="${C.warn}">${esc(sc ? '最近有人反馈可能失效，重新确认中' : isZh ? '最近有人回報可能失效，重新確認中' : 'Reported not working; being rechecked')}</text>`); }
    y += h + 10;
  });
  const where = caption
    ? (sc ? '码和链接在图片说明。' : isZh ? '碼和連結在圖片說明。' : ' Codes and links are in the caption.')
    : (sc ? '码和链接在下方文字。' : isZh ? '碼和連結在下方文字。' : ' Codes and links are in the text below.');
  const foot = (sc ? '已对照商店官网，结账时可能仍有限制。' : isZh ? '已對照商店官網，結帳時可能仍有限制。' : "Checked on each shop's own site; checkout may still have limits.") + where;
  const footLines = wrap(foot, 11, W - PAD * 2, 2);
  footLines.forEach((l, i) => parts.push(`<text x="${PAD}" y="${y + 6 + i * 14}" font-size="11" fill="${C.grey}">${esc(l)}</text>`));
  y += 6 + footLines.length * 14 + PAD;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Math.ceil(y)}" viewBox="0 0 ${W} ${Math.ceil(y)}">` +
    `<rect width="100%" height="100%" fill="${C.cream}"/><g font-family="${fontFamily}">${parts.join('')}</g></svg>`;
}

export async function toPng(svg, scale = 2) {
  const { Resvg } = await import('@resvg/resvg-js');
  const sc = svg.includes('font-family="Noto Sans SC');
  const fontFiles = await ensureFonts(sc ? 'zh-Hans' : 'zh-Hant');
  const width = Number(/width="(\d+)"/.exec(svg)[1]) * scale;
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { fontFiles, loadSystemFonts: false, defaultFontFamily: sc ? 'Noto Sans SC' : 'Noto Sans TC' } });
  const img = r.render();
  return { png: img.asPng(), width: img.width, height: img.height };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  if (process.argv[2] === '--setup') {
    await ensureFonts();
    console.log('fonts ready');
  } else {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const { png, width, height } = await toPng(cardSvg(input));
    writeFileSync(process.argv[2], png);
    console.log(JSON.stringify({ width, height, size: png.length }));
  }
}
