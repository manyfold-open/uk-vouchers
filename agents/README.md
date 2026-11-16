# Agents on Manyfold / Manyfold 上的 agent

五個 agent，都放在 **Stateful sandbox**（會保留檔案與 `.env`，暫停後可恢復），用 Manyfold **Automations** 排程叫醒。和你帳號裡 collector / maintainer 那種配對一樣。`uv-verifier-2` 用 **Codex**，其他用 Claude Code：驗證時換一個模型，比較不會同一個模型自己驗自己。
Five agents in Stateful sandboxes, woken by Manyfold Automations. uv-verifier-2 runs on Codex so a second model checks the first one's work.

| Agent | 角色 / Role | 排程 / Schedule (Europe/London) | 憑證 / Token | Prompt |
| --- | --- | --- | --- | --- |
| `uv-scout-a` | 掃零售商清單前半（美妝、時尚、精品）/ watchlist part A | 每天 07:00、19:00 | scout，自己 `POST /api/join` | [scout.md](scout.md) |
| `uv-scout-b` | 清單後半（超市、3C、居家、外送、旅遊）＋ 學生 / NHS 方案 / part B + partner schemes | 每天 07:30、19:30 | scout，自己 join | [scout.md](scout.md) |
| `uv-verifier-1` | 對照來源驗證、每日重檢 / checks records and daily rechecks | 每天 09:00、13:00、21:00 | verifier，管理員發 | [verifier.md](verifier.md) |
| `uv-verifier-2` | 同上，用 Codex；之後加瀏覽器處理被擋的網站 / same, on Codex; later the browser one | 每天 10:00、16:00、22:00 | verifier，管理員發 | [verifier.md](verifier.md) |
| `uv-deals` | Narra Messenger 裡的聊天 agent，中英回覆 / the chat agent in Narra | 一直在線（被呼叫時回覆）/ on demand | 不需要（只讀公開 API） | [deals-bot.md](deals-bot.md) |

**為什麼這樣切 / Why this split**
- Scout 依清單分兩半，彼此不重疊，送出的量平均；同一個 verifier 不會審自己 token 送的資料（API 強制）。
- 兩個 verifier 讓「unsure」有第二個人看；兩個都 unsure 才給管理員（你）。
- 每次 automation 都是一輪 LLM 對話，不是單純跑腳本；`scout/scan.ts` 先做機械的抓取，agent 只負責判斷與寫中英文標題，省 token 也省 sandbox 時數。

## 先決條件 / Before creating them

1. **部署 API**：`npx wrangler d1 create uk-vouchers-db` → id 填進 `wrangler.jsonc` → `npx wrangler secret put ADMIN_PASSWORD` → `npm run deploy`。得到 `https://uk-vouchers.<you>.workers.dev`，下面寫成 `$API`。
2. **發 verifier token**（兩個）：
   ```bash
   curl -X POST $API/api/admin/tokens -H "x-admin-password: $ADMIN_PASSWORD" \
     -H 'content-type: application/json' -d '{"label": "uv-verifier-1", "role": "verifier"}'
   ```
3. Repo 是私人的：sandbox 要能 clone，需要一個只讀的 GitHub token（fine-grained，只開這個 repo 的 Contents: read），或把 repo 改公開。

## 建立 / Create (mf CLI)

```bash
# 1. agents（每個一個 sandbox）
mf agent create uv-scout-a    --framework claude-code --model-provider managed
mf agent create uv-scout-b    --framework claude-code --model-provider managed
mf agent create uv-verifier-1 --framework claude-code --model-provider managed
mf agent create uv-verifier-2 --framework codex       --model-provider managed
mf agent create uv-deals      --framework claude-code --model-provider managed

# 2. 第一次設定：在每個 agent 的 workspace terminal 裡
#    git clone https://<read-token>@github.com/tldr0810/uk-vouchers ~/uk-vouchers && cd ~/uk-vouchers && npm ci
#    echo "UK_VOUCHERS_API=$API" >> ~/uk-vouchers/.env
#    verifier 另外：echo "UK_VOUCHERS_TOKEN=uv_…" >> ~/uk-vouchers/.env   （scout 會自己 join 後寫入）

# 3. automations（prompt 用對應的 .md 內容，把 {PART} 換成 A 或 B）
mf automations create --agent-id <uv-scout-a id> --title "Scout A" --prompt "$(sed 's/{PART}/A/' agents/scout.md)" \
  --rrule 'FREQ=DAILY;BYHOUR=7,19;BYMINUTE=0' --timezone Europe/London
mf automations create --agent-id <uv-scout-b id> --title "Scout B" --prompt "$(sed 's/{PART}/B/' agents/scout.md)" \
  --rrule 'FREQ=DAILY;BYHOUR=7,19;BYMINUTE=30' --timezone Europe/London
mf automations create --agent-id <uv-verifier-1 id> --title "Verifier 1" --prompt "$(cat agents/verifier.md)" \
  --rrule 'FREQ=DAILY;BYHOUR=9,13,21;BYMINUTE=0' --timezone Europe/London
mf automations create --agent-id <uv-verifier-2 id> --title "Verifier 2" --prompt "$(cat agents/verifier.md)" \
  --rrule 'FREQ=DAILY;BYHOUR=10,16,22;BYMINUTE=0' --timezone Europe/London
```

`uv-deals` 不用排程：把 [deals-bot.md](deals-bot.md) 放進它的 workspace（`CLAUDE.md`），再接到 Narra（見該檔）。

## 用量估算 / Rough usage

每次 scout 約 10–15 分鐘、verifier 約 5–10 分鐘：scout 2×2×30 ≈ 30 小時、verifier 2×3×30 ≈ 25 小時，一個月約 **55 sandbox 小時**，落在 Plus（60 h）邊緣，Pro（200 h）比較寬。Manyfold 怎麼計 active hours 文件沒寫清楚，第一週看 Settings → Usage 再調頻率。

## 還沒確認的 / Unconfirmed

- Manyfold 文件沒寫 sandbox 能不能連外網、有沒有瀏覽器、能不能 `git clone`；第一次設定時就會知道。
- Narra Messenger 不在 Manyfold 的 channel 清單上，接法見 [deals-bot.md](deals-bot.md)。
