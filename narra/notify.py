"""Quidpaw speaking first: alerts, reminders, report follow-ups and scheduled picks.

Every message here is something a person opted into: a subscription (optionally with a minimum
discount), a saved offer, a report they made, daily or Monday picks, or sale and payday reminders. Limits: nothing between 21:00 and 09:00 UK time (it waits for
the morning), at most two messages a day to one person (offers bundled into one).
DMs only: Narra's agent policy (F23) does not allow an agent to post first in a group, and an
agent cannot open a new DM, so a person must have talked to Quidpaw in a DM before.
"""

import datetime as dt, json, time
from quidpaw import offer_lines

try:
    from zoneinfo import ZoneInfo
    UK = ZoneInfo('Europe/London')
except Exception:  # no tz database: UTC is at most an hour off
    UK = dt.timezone.utc

DAY_START, DAY_END = 9, 21
PER_PERSON_PER_DAY = 2

SCHEMA = [
    'create table if not exists users (user text primary key, room text, lang text, identity text, notify integer default 1, push_day text, pushes integer default 0)',
    'create table if not exists subs (user text, kind text, value text, label text, expires_on text, reminded integer default 0, created real, primary key (user, kind, value))',
    'create table if not exists reports (user text, room text, voucher_id text, retailer text, title text, ts real, resolved integer default 0, primary key (user, voucher_id))',
    'create table if not exists seen (id text primary key, first_seen real)',
    'create table if not exists outbox (id integer primary key autoincrement, user text, room text, body text, created real)',
    'create table if not exists events (user text, key text, primary key (user, key))',
]
SUB_COLUMNS = [('threshold', 'real'), ('fp', 'text')]
SCHEDULE_HOUR = 10   # Daily and Monday picks, sale eves, payday and term start go out from 10:00 UK


def setup(db):
    for sql in SCHEMA:
        db.execute(sql)
    have = {r[1] for r in db.execute('pragma table_info(subs)').fetchall()}
    for col, typ in SUB_COLUMNS:
        if col not in have:
            db.execute(f'alter table subs add column {col} {typ}')
    # Offers seen by the first release were stamped with their seeding time; make them "old" once.
    if db.execute("select 1 from sqlite_master where name='kv'").fetchone() and not db.execute("select 1 from kv where key='seen_v2'").fetchone():
        db.execute('update seen set first_seen=0')
        db.execute("insert or replace into kv values('seen_v2','1')")
    db.commit()


def strength(v):
    value = v.get('discount_value') or 0
    t = v.get('discount_type')
    if t in ('percent', 'cashback'):
        return value
    if t == 'fixed':
        return value / max(v.get('min_spend_gbp') or 0, 50) * 100
    return {'bogo': 25, 'free-delivery': 5}.get(t, 0)


def matches(sub, v):
    k, val = sub['kind'], (sub['value'] or '').lower()
    if k == 'retailer':
        return val in v['retailer'].lower() or val.replace(' ', '') in (v.get('retailer_domain') or '')
    if k == 'category':
        return v.get('category') == val
    if k == 'eligibility':
        return v.get('eligibility') == val
    return False


def occasion(d):
    """Days worth a reminder for people who asked for sale and payday reminders (UK)."""
    if d.month == 11 and d.weekday() == 3 and 21 <= d.day <= 27:
        return 'black-friday-eve'          # the Thursday before the 4th Friday
    if d.month == 12 and d.day == 24:
        return 'boxing-day-eve'           # the 25th is Christmas Day: a day early, kindly
    nxt = d + dt.timedelta(days=1)
    while nxt.weekday() >= 5:
        nxt += dt.timedelta(days=1)
    if d.weekday() < 5 and nxt.month != d.month:
        return 'payday'                   # last working day of the month
    return None


def term_start(d):
    """First Monday of September: students' new term."""
    return d.month == 9 and d.weekday() == 0 and d.day <= 7


def changes_text(label, old, new, zh):
    names = {'code': ('碼', 'code'), 'min_spend_gbp': ('最低消費', 'minimum spend'), 'discount_value': ('折扣', 'discount'), 'expires_on': ('到期日', 'end date')}
    show = lambda k, x: ('無' if zh else 'none') if x in (None, '') else (f'£{x:g}' if k == 'min_spend_gbp' and isinstance(x, (int, float)) else str(x))
    diffs = [f"{names[k][0 if zh else 1]}：{show(k, old.get(k))} → {show(k, new.get(k))}" if zh else
             f"{names[k][1]}: {show(k, old.get(k))} → {show(k, new.get(k))}" for k in names if old.get(k) != new.get(k)]
    head = f'📝 你收藏的「{label}」條件改了：' if zh else f'📝 "{label}", which you saved, changed:'
    return head + '\n' + '\n'.join('• ' + d for d in diffs)


def localize(v, zh):
    """export.json is English; the bundle carries both titles."""
    return {**v, 'title': v.get('title_zh') if zh else v.get('title_en'), 'eligibility_zh': v.get('eligibility_zh')}


class Notifier:
    def __init__(self, db, http, api, send, log):
        self.db, self.http, self.api, self.send, self.log = db, http, api.rstrip('/'), send, log
        setup(db)

    def user(self, uid):
        r = self.db.execute('select room, lang, identity, notify, push_day, pushes from users where user=?', (uid,)).fetchone()
        return dict(zip(('room', 'lang', 'identity', 'notify', 'push_day', 'pushes'), r)) if r else None

    def remember_user(self, uid, room, lang):
        self.db.execute('insert into users(user, room, lang) values(?,?,?) on conflict(user) do update set room=excluded.room, lang=excluded.lang', (uid, room, lang))
        self.db.commit()

    async def tick(self, now=None):
        now = now or time.time()
        local = dt.datetime.fromtimestamp(now, UK)
        live = (await self.http(self.api + '/export.json')).get('vouchers', [])
        by_id = {v['id']: v for v in live}
        seeded = self.db.execute("select 1 from kv where key='seen_seeded'").fetchone()
        new = [v for v in live if not self.db.execute('select 1 from seen where id=?', (v['id'],)).fetchone()]
        # First run: everything live counts as already known (first_seen 0), so nobody gets a flood
        # and Monday picks only count offers that really appeared after Quidpaw started watching.
        self.db.executemany('insert or ignore into seen values(?,?)', [(v['id'], now if seeded else 0) for v in new])
        if not seeded:
            self.db.execute("insert or replace into kv values('seen_seeded','1')"); new = []
        self.db.commit()
        tomorrow = (local + dt.timedelta(days=1)).date().isoformat()
        self._alerts(new, now)
        self._saved(by_id, tomorrow, now)
        self._report_outcomes(by_id, now)
        awake = DAY_START <= local.hour < DAY_END
        if awake and local.hour >= SCHEDULE_HOUR:
            self._scheduled(live, local, now)
        if awake:
            await self._flush(local.date().isoformat())
        return {'live': len(live), 'new': len(new), 'awake': awake}

    # ---- deciding what to say (queued; sent only in the day) ----

    def _queue(self, uid, body, now, offers=None, zh=True, tail=None):
        """body: the lead text; offers are numbered when the day's bundle is sent, so 「收藏第 2 個」 matches."""
        u = self.user(uid)
        if not u or not u['room'] or not u['notify']:
            return
        seg = json.dumps({'head': body, 'offers': offers or [], 'zh': zh, 'tail': tail})
        self.db.execute('insert into outbox(user, room, body, created) values(?,?,?,?)', (uid, u['room'], seg, now))
        self.db.commit()

    def _alerts(self, new, now):
        if not new:
            return
        subs = self.db.execute("select user, kind, value, label, threshold from subs where kind in ('retailer','category','eligibility')").fetchall()
        per_user = {}
        for uid, kind, value, label, minimum in subs:
            for v in new:
                if matches({'kind': kind, 'value': value}, v) and strength(v) >= (minimum or 0):
                    per_user.setdefault(uid, {}).setdefault(v['id'], (label, v))
        for uid, hits in per_user.items():
            u = self.user(uid); zh = (u or {}).get('lang') != 'en'
            offers = [v for _, v in hits.values()][:3]
            labels = '、'.join(sorted({l for l, _ in hits.values()})) if zh else ', '.join(sorted({l for l, _ in hits.values()}))
            head = f'🐾 {labels} 有新優惠！' if zh else f'🐾 New from {labels}!'
            self._queue(uid, head, now, [localize(v, zh) for v in offers], zh,
                        '回「收藏第 1 個」到期前提醒你；回「停止通知」就不再提醒。' if zh else 'Say "save number 1" for an end reminder, or "stop alerts" to stop.')

    def _saved(self, by_id, tomorrow, now):
        for uid, value, label, expires_on, reminded, fp in self.db.execute("select user, value, label, expires_on, reminded, fp from subs where kind='offer'").fetchall():
            u = self.user(uid); zh = (u or {}).get('lang') != 'en'
            v = by_id.get(value)
            if not v:  # taken down (ended, failed a recheck, or a duplicate)
                self._queue(uid, (f'你收藏的「{label}」已經下架了 🐾 想看同類的其他優惠就問我。' if zh else
                                  f'"{label}", which you saved, has been taken down 🐾 Ask me for similar ones.'), now)
                self.db.execute("delete from subs where user=? and kind='offer' and value=?", (uid, value))
                continue
            now_fp = {k: v.get(k) for k in ('code', 'min_spend_gbp', 'discount_value', 'expires_on')}
            old = json.loads(fp) if fp else None
            if old and old != now_fp:
                self._queue(uid, changes_text(label, old, now_fp, zh), now, [localize(v, zh)], zh)
                self.db.execute("update subs set fp=?, reminded=0 where user=? and kind='offer' and value=?", (json.dumps(now_fp), uid, value))
            elif not old:
                self.db.execute("update subs set fp=? where user=? and kind='offer' and value=?", (json.dumps(now_fp), uid, value))
            if v.get('expires_on') == tomorrow and not reminded:
                self._queue(uid, '⏰ 提醒：你收藏的優惠明天到期，記得用！' if zh else '⏰ Reminder: an offer you saved ends tomorrow!', now, [localize(v, zh)], zh)
                self.db.execute("update subs set reminded=1 where user=? and kind='offer' and value=?", (uid, value))
        self.db.commit()

    def _report_outcomes(self, by_id, now):
        rows = self.db.execute('select user, voucher_id, retailer, title, ts from reports where resolved=0').fetchall()
        for uid, vid, retailer, title, ts in rows:
            u = self.user(uid); zh = (u or {}).get('lang') != 'en'
            v = by_id.get(vid)
            if not v:
                body = (f'你回報的 {retailer}「{title}」確認失效，已經下架了。謝謝你幫大家省時間 🐾' if zh else
                        f'You were right: {retailer} "{title}" no longer works and has been taken down. Thanks for helping everyone 🐾')
            elif (v.get('last_checked_at') or '') > dt.datetime.fromtimestamp(ts, dt.timezone.utc).isoformat():
                terms = v.get('terms') or ''
                body = (f'你回報的 {retailer}「{title}」我們重新核對過了，官網上還寫著這個優惠。可能是有限制條件' + (f'：{terms}' if terms else '，例如指定商品或最低消費') + '。' if zh else
                        f'We rechecked {retailer} "{title}": the shop still lists it, so a condition may apply' + (f': {terms}' if terms else ' (selected items or a minimum spend)') + '.')
            elif now - ts > 3 * 86400:
                body = None  # still waiting after 3 days: stop tracking quietly
            else:
                continue
            if body:
                self._queue(uid, body, now)
            self.db.execute('update reports set resolved=1 where user=? and voucher_id=?', (uid, vid))
        self.db.commit()

    def _once(self, uid, key):
        if self.db.execute('select 1 from events where user=? and key=?', (uid, key)).fetchone():
            return False
        self.db.execute('insert into events values(?,?)', (uid, key))
        return True

    def _picks(self, uid, live, since=None, n=3, fresh=None, skip=()):
        """Best offers for this person: their shops and categories first, then their group (student...), then everyone.
        fresh: offers first seen after this time go first. skip: offer ids not to pick."""
        u = self.user(uid) or {}
        subs = [dict(kind=k, value=v) for k, v in self.db.execute(
            "select kind, value from subs where user=? and kind in ('retailer','category','eligibility')", (uid,)).fetchall()]
        seen = lambda v: (self.db.execute('select first_seen from seen where id=?', (v['id'],)).fetchone() or [0])[0]
        pool = [v for v in live if v['id'] not in skip and (since is None or seen(v) >= since)]
        mine = lambda v: any(matches(s, v) for s in subs)
        rank = lambda v: (fresh is not None and seen(v) < fresh, not mine(v), v.get('eligibility') not in (u.get('identity'), 'everyone'), -strength(v))
        picked, per = [], {}
        for v in sorted(pool, key=rank):
            if per.get(v['retailer'], 0) < 1:   # one per shop
                picked.append(v); per[v['retailer']] = 1
            if len(picked) == n:
                break
        return picked

    def _scheduled(self, live, local, now):
        day = local.date()
        week = f'{day.isocalendar()[0]}-W{day.isocalendar()[1]}'
        what = occasion(day)
        for uid, kind in self.db.execute("select user, kind from subs where kind in ('daily','weekly','sales','eligibility')").fetchall():
            u = self.user(uid) or {}; zh = u.get('lang') != 'en'
            if kind == 'daily' and self._once(uid, 'daily-' + day.isoformat()):
                # New in the last day first, then the best of the rest; never an offer this person already got as a daily pick.
                sent = {k[len('daily-offer-'):] for k, in self.db.execute("select key from events where user=? and key like 'daily-offer-%'", (uid,))}
                picks = self._picks(uid, live, fresh=now - 86400, skip=sent)
                for v in picks:
                    self._once(uid, 'daily-offer-' + v['id'])
                if picks:
                    self._queue(uid, '☀️ 今日精選：' if zh else "☀️ Today's picks:", now, [localize(v, zh) for v in picks], zh,
                                '說「關閉每日精選」就不再收到。' if zh else 'Say "daily picks off" to stop these.')
            elif kind == 'weekly' and day.weekday() == 0 and self._once(uid, 'weekly-' + week):
                picks = self._picks(uid, live, since=now - 7 * 86400)
                if picks:  # nothing new this week: no message
                    self._queue(uid, '🐾 本週新上架精選：' if zh else '🐾 New this week:', now, [localize(v, zh) for v in picks], zh,
                                '說「關閉週報」就不再收到。' if zh else 'Say "weekly off" to stop these.')
            elif kind == 'sales' and what and self._once(uid, f'{what}-{day.isoformat()}'):
                head = {'black-friday-eve': ('🖤 明天就是黑色星期五！先看今天最划算的：', '🖤 Black Friday is tomorrow! The best deals today:'),
                        'boxing-day-eve': ('🎁 Boxing Day 快到了，先看現在最划算的：', "🎁 Boxing Day is almost here. The best deals now:"),
                        'payday': ('💷 發薪日快樂！今天最划算的幾個：', '💷 Happy payday! The best deals today:')}[what]
                picks = self._picks(uid, live)
                if picks:
                    self._queue(uid, head[0] if zh else head[1], now, [localize(v, zh) for v in picks], zh,
                                '說「關閉大促提醒」就不再收到。' if zh else 'Say "sale alerts off" to stop these.')
            elif kind == 'eligibility' and term_start(day) and self._once(uid, f'term-{day.year}'):
                picks = [v for v in self._picks(uid, live, n=10) if v.get('eligibility') == 'student'][:3]
                if picks and (self.db.execute("select 1 from subs where user=? and kind='eligibility' and value='student'", (uid,)).fetchone()):
                    self._queue(uid, '🎒 開學快樂！學生優惠精選：' if zh else '🎒 New term! Student picks:', now, [localize(v, zh) for v in picks], zh)
        self.db.commit()

    # ---- sending ----

    async def _flush(self, today):
        for uid, in self.db.execute('select distinct user from outbox').fetchall():
            u = self.user(uid)
            pushes = u['pushes'] if u['push_day'] == today else 0
            rows = self.db.execute('select id, room, body from outbox where user=? order by id', (uid,)).fetchall()
            if pushes >= PER_PERSON_PER_DAY:
                continue  # tomorrow
            # Bundle everything waiting into one message, offers numbered straight through.
            room, parts, shown = rows[-1][1], [], []
            segs = [json.loads(raw) for _, _, raw in rows]
            for k, seg in enumerate(segs):
                block = [seg['head']] + [offer_lines(len(shown) + i, v, seg['zh']) for i, v in enumerate(seg['offers'], 1)]
                shown += seg['offers']
                if seg.get('tail') and not any(later.get('tail') == seg['tail'] for later in segs[k + 1:]):
                    block.append(seg['tail'])  # the how-to line once, at the end
                parts.append('\n\n'.join(block))
            body = '\n\n———\n\n'.join(parts)
            if await self._post(room, body, uid, shown):
                self.db.execute('delete from outbox where user=?', (uid,))
                self.db.execute('update users set push_day=?, pushes=? where user=?', (today, pushes + 1, uid))
                self.db.commit()

    async def _post(self, room, body, uid=None, offers=None):
        try:
            await self.send(room, body, uid, [{k: v.get(k) for k in ('id', 'retailer', 'title', 'expires_on', 'code')} for v in offers or []])
            return True
        except Exception as e:
            self.log.warning('Proactive send failed: %s', type(e).__name__)
            return False
