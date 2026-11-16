/** Reading a page the way a plain browser request would. Shared by the Worker and the scout tools. */

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 uk-vouchers/0.1';
const PAGE_MAX = 3_000_000;

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
    return { ok: true, status: res.status, url: res.url || url, html: (await res.text()).slice(0, PAGE_MAX) };
  } catch (error) {
    return { ok: false, status: null, reason: error instanceof Error ? error.message : String(error) };
  }
}
