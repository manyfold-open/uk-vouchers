/** Reading a page the way a plain browser request would. Shared by the Worker and the scout tools. */

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 uk-vouchers/0.1';
const PAGE_MAX = 3_000_000;

/**
 * Bot-check pages that answer 200: Imperva ("Pardon Our Interruption"), Cloudflare
 * ("Just a moment..."), Akamai ("Access Denied"), PerimeterX and generic captchas.
 * Treated as a failed read, so nothing on them counts as the page's content.
 */
const BLOCK_TITLES = /<title[^>]*>\s*(pardon our interruption|just a moment|attention required|access denied|are you a (robot|human)|request unsuccessful|security check|verify you are human|robot or human)/i;
const BLOCK_MARKERS = /_Incapsula_Resource|cf-chl-|px-captcha|g-recaptcha|hcaptcha\.com\/1\/api|captcha-delivery\.com/i;

export function blockedPage(html: string): string | null {
  const title = html.match(BLOCK_TITLES);
  if (title) return `bot check page ("${title[1]}")`;
  // A real page can embed a captcha widget; only a small page that is mostly the check counts.
  if (html.length < 60_000 && BLOCK_MARKERS.test(html)) return 'bot check page';
  return null;
}

export type PageResult =
  | { ok: true; status: number; url: string; html: string }
  | { ok: false; status: number | null; reason: string };

export async function fetchPage(url: string, fetcher: typeof fetch = fetch, timeoutMs = 10_000): Promise<PageResult> {
  try {
    const res = await fetcher(url, {
      redirect: 'follow',
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        'accept-language': 'en-GB,en;q=0.9',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, status: res.status, reason: `HTTP ${res.status}` };
    }
    if (!/text|html|json/.test(type)) {
      await res.body?.cancel();
      return { ok: false, status: res.status, reason: `not a web page (${type || 'no content-type'})` };
    }
    const html = (await res.text()).slice(0, PAGE_MAX);
    const blocked = blockedPage(html);
    if (blocked) return { ok: false, status: res.status, reason: blocked };
    return { ok: true, status: res.status, url: res.url || url, html };
  } catch (error) {
    return { ok: false, status: null, reason: error instanceof Error ? error.message : String(error) };
  }
}
