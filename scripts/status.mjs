// Prints a summary of the public data: run by the "Status" workflow, or locally with `node scripts/status.mjs`.
const api = process.env.UK_VOUCHERS_API ?? 'https://uk-vouchers.netmind-ai.workers.dev';
const { vouchers } = await (await fetch(`${api}/export.json`)).json();
const since = process.env.SINCE || new Date(Date.now() - 24 * 3600_000).toISOString();
const count = (key) => Object.entries(vouchers.reduce((m, v) => ((m[v[key]] = (m[v[key]] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
console.log(`public: ${vouchers.length}  with code: ${vouchers.filter((v) => v.code).length}  retailers: ${new Set(vouchers.map((v) => v.retailer_domain)).size}`);
console.log('by category:', count('category').map(([k, n]) => `${k} ${n}`).join(', '));
console.log('by eligibility:', count('eligibility').map(([k, n]) => `${k} ${n}`).join(', '));
console.log('by retailer:', count('retailer').map(([k, n]) => `${k} ${n}`).join(', '));
const fresh = vouchers.filter((v) => (v.last_checked_at ?? '') >= since);
console.log(`\nchecked since ${since}: ${fresh.length}`);
for (const v of fresh) console.log(`- ${v.retailer}: ${v.title_zh}${v.code ? ` [${v.code}]` : ''} (${v.eligibility}) ${v.offer_url}`);
