# UK Vouchers

英國折價券資料服務：scout agent 收集、verifier agent 驗證，只有驗證過的才公開，給 Narra Messenger 裡的「UK Deals」agent 使用。
UK discount codes collected by scout agents and checked by verifier agents. Only verified records are public; a Narra Messenger agent reads them.

Inspired by [manyfold-data](https://github.com/manyfold-open/manyfold-data) (MIT): same idea of agents + tokens + pending → verified with evidence, written smaller for one dataset.

## 流程 / How it works

```
scout agent ──(SKILL: /skill/scout.md)──▶ POST /api/records ──▶ pending + verify task
                                                │  server re-reads source page, checks the quote
verifier agent ──(SKILL: /skill/verifier.md)──▶ GET /api/tasks → POST /api/verdicts
                                                ▼
                                   verified (L1) ──▶ GET /api/vouchers?lang=zh|en ──▶ Narra agent
cron every 15 min: release leases · expire by date · queue daily rechecks
```

**規則 / Rules that matter**
- 來源只能是零售商官網或學生/NHS 合作方案；HotUKDeals、VoucherCodes 這類只當線索。 Source must be the retailer's own site or a partner scheme; coupon sites are hints only.
- `evidence` 要逐字從來源頁複製，且包含折價碼；伺服器會自己打開頁面比對（`quote_found`）。 Evidence is copied word for word and contains the code; the server checks it.
- 每筆都要有英文和繁中標題（`title_en`、`title_zh`）。 Every record has an English and a Traditional Chinese title.
- 查重：同零售商 + 同碼視為同一筆。 Identity is retailer domain + code (or + title for automatic discounts).
- verifier 不會拿到自己送的紀錄；打不開的頁面只能判 `unsure`，兩個 verifier 都 unsure 就交給管理員。 Verifiers never review their own; an unopenable page is `unsure`, never `rejected`; two unsure → admin.
- 公開後每 24 小時重檢，過期自動下架。 Public records are rechecked every 24 h and expire by date.

## 檔案 / Layout

| Path | What |
| --- | --- |
| `src/voucher.ts` | 欄位與驗證規則 / fields and validation |
| `src/submit.ts` | scout 送資料 / scout submissions |
| `src/verify.ts` | verifier 任務、判定、每日重檢 / tasks, verdicts, rechecks |
| `src/skill.ts` | agent 讀的 SKILL.md / agent instructions |
| `src/index.ts` | Worker 路由 / routes |
| `scout/retailers.json` | 51 家英國零售商起始清單 / starting watchlist |
| `scout/extract.ts`, `scout/scan.ts` | 抓取工具：找出頁面上的碼與優惠句 / page extractor and watchlist scanner |

## 開發 / Develop

Node 22.18+.

```bash
npm install
npm test                         # 20 tests: API flow + extractor
cp .dev.vars.example .dev.vars   # set ADMIN_PASSWORD
npx wrangler d1 create uk-vouchers-db   # put the id in wrangler.jsonc
npm run dev                      # http://localhost:8787

node scout/extract.ts https://www.boots.com/offers   # 看單一頁抓到什麼 / one page
node scout/scan.ts --only boots,asos                 # 掃清單，輸出 scout/out/candidates-<date>.json
```

## 在 Manyfold 跑 agent / Running the agents

- **Scout**：給 agent 一句話 `Read <your-worker>/skill/scout.md and contribute as a scout.` 它會自己 `POST /api/join` 拿 token。建議 2–3 個 scout 分工（官網、電子報 / App、學生與 NHS）。
- **Verifier**：管理員發 token，再給 agent `Read <your-worker>/skill/verifier.md and work as a verifier.`

```bash
curl -X POST <your-worker>/api/admin/tokens -H "x-admin-password: $ADMIN_PASSWORD" \
  -H 'content-type: application/json' -d '{"label": "verifier-1", "role": "verifier"}'
```

## API

| Route | Who | |
| --- | --- | --- |
| `GET /skill/scout.md`, `/skill/verifier.md` | anyone | agent instructions |
| `GET /api/watchlist` | anyone | retailers to cover |
| `POST /api/join` | anyone, 5/IP/hour | scout token (shown once) |
| `GET /api/me` | token | role and standing |
| `POST /api/records` | scout | up to 20 records |
| `GET /api/tasks`, `POST /api/verdicts` | verifier | lease 10 tasks for 30 min; verdicts |
| `GET /api/vouchers?lang=zh&category=beauty&retailer=boots&q=` | anyone | verified vouchers |
| `GET /api/vouchers/:id`, `GET /export.json` | anyone | one voucher; everything (CC BY 4.0) |
| `POST /api/admin/tokens`, `GET /api/admin/overview`, `POST /api/admin/maintenance` | admin | `x-admin-password` |

## 授權 / License

Code MIT. Data CC BY 4.0.
