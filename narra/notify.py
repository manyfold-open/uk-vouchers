"""Quidpaw speaking first: alerts, reminders, report follow-ups and group digests.

Every message here is something a person opted into: a subscription, a saved offer, a report
they made, or a group setting. Limits: nothing between 21:00 and 09:00 UK time (it waits for
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
]


def setup(db):
    for sql in SCHEMA:
        db.execute(sql)
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
        self.db.executemany('insert or ignore into seen values(?,?)', [(v['id'], now) for v in new])
        if not seeded:  # first run: everything live counts as already known, so nobody gets a flood
            self.db.execute("insert or replace into kv values('seen_seeded','1')"); new = []
        self.db.commit()
        tomorrow = (local + dt.timedelta(days=1)).date().isoformat()
        self._alerts(new, now)
        self._saved(by_id, tomorrow, now)
        self._report_outcomes(by_id, now)
        awake = DAY_START <= local.hour < DAY_END
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
        subs = self.db.execute("select user, kind, value, label from subs where kind in ('retailer','category','eligibility')").fetchall()
        per_user = {}
        for uid, kind, value, label in subs:
            for v in new:
                if matches({'kind': kind, 'value': value}, v):
                    per_user.setdefault(uid, {}).setdefault(v['id'], (label, v))
        for uid, hits in per_user.items():
            u = self.user(uid); zh = (u or {}).get('lang') != 'en'
            offers = [v for _, v in hits.values()][:3]
            labels = '、'.join(sorted({l for l, _ in hits.values()})) if zh else ', '.join(sorted({l for l, _ in hits.values()}))
            head = f'🐾 {labels} 有新優惠！' if zh else f'🐾 New from {labels}!'
            self._queue(uid, head, now, [localize(v, zh) for v in offers], zh,
                        '回「收藏第 1 個」到期前提醒你；回「停止通知」就不再提醒。' if zh else 'Say "save number 1" for an end reminder, or "stop alerts" to stop.')

    def _saved(self, by_id, tomorrow, now):
        for uid, value, label, expires_on, reminded in self.db.execute("select user, value, label, expires_on, reminded from subs where kind='offer'").fetchall():
            u = self.user(uid); zh = (u or {}).get('lang') != 'en'
            v = by_id.get(value)
            if not v:  # taken down (ended, failed a recheck, or a duplicate)
                self._queue(uid, (f'你收藏的「{label}」已經下架了 🐾 想看同類的其他優惠就問我。' if zh else
                                  f'"{label}", which you saved, has been taken down 🐾 Ask me for similar ones.'), now)
                self.db.execute("delete from subs where user=? and kind='offer' and value=?", (uid, value))
            elif v.get('expires_on') == tomorrow and not reminded:
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
