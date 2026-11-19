"""Comprehensive unit & integration QA for Quidpaw trilingual (zh-Hant / zh-Hans / en),
card rendering, notifications, smart quoting, multi-@ silence, reply-to-other, redaction,
burst coalescing, @agent-* ignore, and group mute/snooze.

Run: python3 -I narra/qa/qa_runtime.py
Exits 0 on full pass, 1 on any failure (no external network or live model required).
"""
import asyncio, importlib.util, json, os, sqlite3, subprocess, sys, tempfile, time, unittest
from pathlib import Path

os.environ['QUIDPAW_TEST'] = '1'
os.environ['QUIDPAW_TEST_USER'] = '@agent-quidpaw:netmind.chat'
os.environ['QUIDPAW_CARD_CAPTION'] = '0'

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import quidpaw as qp
import notify as nf
import runtime as rt

SAMPLE_VOUCHERS = [
    {
        'id': 'v1',
        'retailer': 'Boots',
        'retailer_url': 'https://www.boots.com',
        'retailer_domain': 'boots.com',
        'title': '保養品滿 £40 透過 UNiDAYS 打 8 折',
        'title_en': '20% off skincare when you spend £40 via UNiDAYS',
        'title_zh': '保養品滿 £40 透過 UNiDAYS 打 8 折',
        'code': 'GLOW20',
        'discount_type': 'percent',
        'discount_value': 20,
        'min_spend_gbp': 40,
        'category': 'beauty',
        'category_zh': '美妝',
        'eligibility': 'student',
        'eligibility_zh': '學生',
        'expires_on': '2026-12-31',
        'offer_url': 'https://www.boots.com/offers/glow20',
        'terms': '僅限指定商品與台灣/英國線上訂單。',
        'terms_en': 'Selected items online only.',
        'terms_zh': '僅限指定商品與台灣/英國線上訂單。',
        'via': 'UNiDAYS',
        'reports_7d': 3,
        'last_checked_at': '2026-11-19T08:00:00Z',
    },
    {
        'id': 'v2',
        'retailer': 'Marks & Spencer',
        'retailer_url': 'https://www.marksandspencer.com',
        'retailer_domain': 'marksandspencer.com',
        'title': '精選家居與寢具免運費',
        'title_en': 'Free delivery on selected home & bedding',
        'title_zh': '精選家居與寢具免運費',
        'code': None,
        'discount_type': 'free-delivery',
        'discount_value': None,
        'min_spend_gbp': None,
        'category': 'home',
        'category_zh': '居家',
        'eligibility': 'everyone',
        'eligibility_zh': '所有人',
        'expires_on': None,
        'offer_url': 'https://www.marksandspencer.com/c/home',
        'terms': None,
        'terms_en': None,
        'terms_zh': None,
        'via': None,
        'reports_7d': 0,
        'last_checked_at': '2026-11-19T08:00:00Z',
    },
]

META = {
    'categories': [
        {'value': 'beauty', 'zh': '美妝'},
        {'value': 'home', 'zh': '居家'},
        {'value': 'fashion', 'zh': '時尚'},
        {'value': 'sports', 'zh': '運動戶外'},
        {'value': 'travel', 'zh': '旅遊'},
    ],
    'eligibility': [
        {'value': 'everyone', 'zh': '所有人'},
        {'value': 'student', 'zh': '學生'},
        {'value': 'nhs-blue-light', 'zh': 'NHS / Blue Light'},
        {'value': 'new-customer', 'zh': '新客限定'},
        {'value': 'members', 'zh': '會員限定'},
        {'value': 'app-only', 'zh': 'App 限定'},
    ],
}

WATCH = {
    'retailers': [
        {'name': 'Boots', 'url': 'https://www.boots.com', 'category': 'beauty'},
        {'name': 'Marks & Spencer', 'url': 'https://www.marksandspencer.com', 'category': 'home'},
        {'name': 'ASOS', 'url': 'https://www.asos.com', 'category': 'fashion'},
        {'name': 'JD Sports', 'url': 'https://www.jdsports.co.uk', 'category': 'sports'},
        {'name': 'Iceland', 'url': 'https://www.iceland.co.uk', 'category': 'grocery'},
        {'name': 'Next', 'url': 'https://www.next.co.uk', 'category': 'fashion'},
    ]
}


async def fake_api_http(url, data=None, token=None, method=None, raw=False):
    if '/api/meta' in url:
        return META
    if '/api/watchlist' in url:
        return WATCH
    if '/export.json' in url:
        return {'vouchers': SAMPLE_VOUCHERS}
    if '/api/vouchers' in url:
        from urllib.parse import parse_qs, urlparse
        qs = parse_qs(urlparse(url).query)
        lang = qs.get('lang', ['en'])[0]
        ret = (qs.get('retailer') or [''])[0].lower()
        rows = [v for v in SAMPLE_VOUCHERS if not ret or ret in v['retailer'].lower()]
        shaped = []
        for v in rows:
            item = dict(v)
            item['title'] = v['title_zh'] if lang == 'zh' else v['title_en']
            item['terms'] = v['terms_zh'] if lang == 'zh' else v['terms_en']
            shaped.append(item)
        return {'vouchers': shaped, 'total': len(shaped)}
    return {}


class FakeMatrixMixin:
    def reset_runtime(self):
        if getattr(rt, 'DB', None) is not None:
            try:
                rt.DB.close()
            except Exception:
                pass
        rt.init_db(sqlite3.connect(':memory:'))
        rt.LATEST_ROOM_EVENT.clear()
        rt.SEEN_TIMELINE.clear()
        rt.REDACTED.clear()
        rt.BURSTS.clear()
        rt.TASKS.clear()
        rt.LOCKS.clear()
        rt.BEST.clear()
        rt.BURST_SEC = 0.0  # override per test when testing burst debounce
        rt.CAPTION = False
        self.sent = []
        self.room_events = {}
        self.prompts = []
        self.plan_queue = []
        self.auth_kind = 'group'
        self.auth_allow = True
        self.card_png_calls = []

        async def fake_matrix(path, data=None, method=None):
            if '/send/' in path:
                eid = f'$bot_{len(self.sent) + 1}'
                self.sent.append({'path': path, 'content': data, 'event_id': eid})
                return {'event_id': eid}
            if '/messages?' in path:
                return {'chunk': []}
            if '/joined_members' in path:
                return {'joined': {'@alice:netmind.chat': {}, '@bob:netmind.chat': {}, rt.USER: {}}}
            if '/event/' in path:
                ref = path.rsplit('/event/', 1)[1]
                from urllib.parse import unquote
                ref = unquote(ref)
                if ref in self.room_events:
                    return self.room_events[ref]
                raise RuntimeError('not found')
            return {}

        async def fake_authorize(room, event, members, mentioned):
            if self.auth_kind == 'dm':
                return {'allow': self.auth_allow, 'roomKind': 'dm'}
            return {'allow': self.auth_allow, 'roomKind': 'group'}

        async def fake_model(prompt, attachment=None):
            self.prompts.append(prompt)
            if self.plan_queue:
                return json.dumps(self.plan_queue.pop(0))
            return json.dumps({'intent': 'chat', 'line': '我是找英國折扣的小幫手。'})

        async def fake_card_image(card, caption=None):
            self.card_png_calls.append({'card': card, 'caption': caption})
            return {
                'msgtype': 'm.image',
                'body': 'quidpaw-offers.png',
                'url': 'mxc://netmind.chat/fake123',
                'info': {'mimetype': 'image/png', 'w': 800, 'h': 400, 'size': 1234},
            }

        rt.matrix = fake_matrix
        rt.authorize = fake_authorize
        rt.http = fake_api_http
        rt.BRAIN = qp.Brain(fake_api_http, fake_model, 'https://api.invalid')
        rt.NOTIFIER.http = fake_api_http
        rt.card_image = fake_card_image


class TestTrilingualAndLocalization(unittest.IsolatedAsyncioTestCase):
    def test_language_detection_and_inheritance(self):
        self.assertEqual(qp.Brain.language('你們好，請問 Boots 有什麼碼？', []), 'zh-Hant')
        self.assertEqual(qp.Brain.language('你们好，请问 Boots 有什么码？', []), 'zh-Hans')
        self.assertEqual(qp.Brain.language('Boots promo codes please', []), 'en')
        # Backward compat hint='zh' -> 'zh-Hant'
        self.assertEqual(qp.Brain.language('boots', [], hint='zh'), 'zh-Hant')
        self.assertEqual(qp.Brain.language('boots', [], hint='zh-Hans'), 'zh-Hans')
        self.assertEqual(qp.Brain.language('boots', [], hint='en'), 'en')
        # Short follow-ups & OK inherit user turns first, then history/hint
        hist_hans = [{'who': 'user', 'text': '最近有什么优惠码'}, {'who': 'bot', 'text': '這些優惠：'}]
        self.assertEqual(qp.Brain.language('Boots', hist_hans), 'zh-Hans')
        self.assertEqual(qp.Brain.language('OK', hist_hans), 'zh-Hans')
        self.assertEqual(qp.Brain.language('ok', [{'who': 'user', 'text': '請問有什麼碼'}]), 'zh-Hant')
        self.assertEqual(qp.Brain.language('OK', []), 'en')
        # Bot-only history fallback when no decisive user turns exist
        self.assertEqual(qp.Brain.language('Boots', [{'who': 'user', 'text': 'OK'}, {'who': 'bot', 'text': '这里有最新优惠：'}]), 'zh-Hans')
        # Explicit script overrides history
        self.assertEqual(qp.Brain.language('還有嗎', hist_hans), 'zh-Hant')
        self.assertEqual(qp.Brain.language('还有吗', [{'who': 'user', 'text': '請問有碼嗎'}]), 'zh-Hans')
        self.assertEqual(qp.Brain.language('#2 expired', hist_hans), 'en')
        # Neutral CJK inherits recent Chinese script, never switches to English
        self.assertEqual(qp.Brain.language('你好', [{'who': 'user', 'text': '帮我找优惠'}]), 'zh-Hans')
        self.assertEqual(qp.Brain.language('你好', [{'who': 'user', 'text': 'hello'}]), 'zh-Hant')

    def test_script_conversion_preserves_codes_brands_urls(self):
        v = dict(SAMPLE_VOUCHERS[0], code='TW_SAVE20')
        loc = qp.localize_offer(v, 'zh-Hans')
        self.assertEqual(loc['code'], 'TW_SAVE20')
        self.assertEqual(loc['retailer'], 'Boots')
        self.assertEqual(loc['offer_url'], 'https://www.boots.com/offers/glow20')
        self.assertIn('护肤品', loc['title'])
        self.assertIn('通过 UNiDAYS', loc['title'])
        self.assertIn('台湾', loc['terms'])
        self.assertEqual(loc['eligibility_zh'], '学生')
        self.assertFalse(qp._ZH_HANT_ONLY.search(loc['title']))
        self.assertFalse(qp._ZH_HANT_ONLY.search(loc['terms']))
        self.assertFalse(qp._ZH_HANT_ONLY.search(loc['eligibility_zh']))

    async def test_brain_respond_trilingual_and_backward_compat(self):
        prompts = []
        async def model(p, att=None):
            prompts.append(p)
            return json.dumps({'intent': 'chat', 'line': '我是幫你找折扣的小幫手！'})
        b = qp.Brain(fake_api_http, model, 'https://api.invalid')

        r_hans = await b.respond('Boots 有什么码？', {'history': []})
        self.assertEqual(r_hans['lang'], 'zh-Hans')
        self.assertEqual(r_hans['card']['lang'], 'zh-Hans')
        self.assertIn('码：GLOW20', r_hans['text'])
        self.assertIn('码 GLOW20', r_hans['card_text'])
        self.assertFalse(qp._ZH_HANT_ONLY.search(r_hans['text']))

        r_hant = await b.respond('Boots 有什麼碼？', {'history': []})
        self.assertEqual(r_hant['lang'], 'zh-Hant')
        self.assertIn('碼：GLOW20', r_hant['text'])
        self.assertFalse(qp._ZH_HANS_ONLY.search(r_hant['text']))

        # Backward compat: lang='zh' -> 'zh-Hant'
        r_legacy_zh = await b.respond('boots', {'lang': 'zh'})
        self.assertEqual(r_legacy_zh['lang'], 'zh-Hant')
        self.assertIn('碼：GLOW20', r_legacy_zh['text'])

        # _model_plan receives Simplified Chinese instruction & converts accidental TC chat line
        r_chat_hans = await b.respond('今天天气真不错呀', {'history': []})
        self.assertEqual(r_chat_hans['lang'], 'zh-Hans')
        self.assertIn('Simplified Chinese', prompts[-1])
        self.assertNotIn('幫', r_chat_hans['text'])
        self.assertIn('帮', r_chat_hans['text'])

    async def test_notify_trilingual_and_mute_respect(self):
        db = sqlite3.connect(':memory:')
        db.execute('create table rooms (room text primary key, lang text, paused integer default 0, last_auto real default 0, welcomed integer default 0)')
        sent_msgs = []
        async def fake_send(room, body, uid=None, offers=None):
            sent_msgs.append((room, body, uid))
        n = nf.Notifier(db, fake_api_http, 'https://api.invalid', fake_send, qp.logging if hasattr(qp, 'logging') else None)
        import logging
        n.log = logging.getLogger('test')
        # Simplified Chinese user
        n.remember_user('@u_hans', '!dm_hans', 'zh-Hans')
        db.execute("update users set notify=1 where user='@u_hans'")
        db.execute("insert into subs(user,kind,value,label,created) values(?,?,?,?,?)", ('@u_hans', 'retailer', 'boots', 'Boots', 1.0))
        # Traditional Chinese legacy user ('zh')
        n.remember_user('@u_hant', '!dm_hant', 'zh')
        self.assertEqual(n.user('@u_hant')['lang'], 'zh-Hant')
        db.execute("update users set notify=1 where user='@u_hant'")
        db.execute("insert into subs(user,kind,value,label,created) values(?,?,?,?,?)", ('@u_hant', 'retailer', 'boots', 'Boots', 1.0))
        # Muted room user
        n.remember_user('@u_muted', '!dm_muted', 'zh-Hans')
        db.execute("update users set notify=1 where user='@u_muted'")
        db.execute("insert into subs(user,kind,value,label,created) values(?,?,?,?,?)", ('@u_muted', 'retailer', 'boots', 'Boots', 1.0))
        db.execute("insert into rooms(room, paused) values('!dm_muted', 1)")
        # Seed seen so tick finds v1 as new
        db.execute("insert into kv values('seen_seeded','1')")
        db.commit()

        await n.tick(now=dt_noon_uk())
        self.assertEqual(len(sent_msgs), 2)
        hans_body = next(b for r, b, _ in sent_msgs if r == '!dm_hans')
        hant_body = next(b for r, b, _ in sent_msgs if r == '!dm_hant')
        self.assertIn('有新优惠', hans_body)
        self.assertIn('GLOW20', hans_body)
        self.assertFalse(qp._ZH_HANT_ONLY.search(hans_body))
        self.assertIn('有新優惠', hant_body)
        self.assertFalse(qp._ZH_HANS_ONLY.search(hant_body))
        self.assertFalse(any(r == '!dm_muted' for r, _, _ in sent_msgs))

    def test_card_mjs_trilingual_svg_and_png(self):
        card_mjs = ROOT / 'cards' / 'card.mjs'
        with tempfile.TemporaryDirectory() as td:
            out_png = Path(td) / 'sc.png'
            payload = {
                'lang': 'zh-Hans',
                'lead': 'Boots 优惠：',
                'offers': [qp.localize_offer(SAMPLE_VOUCHERS[0], 'zh-Hans')],
            }
            p = subprocess.run(['node', str(card_mjs), str(out_png)], input=json.dumps(payload, ensure_ascii=False).encode(), capture_output=True, timeout=30)
            self.assertEqual(p.returncode, 0, p.stderr.decode())
            data = out_png.read_bytes()
            self.assertTrue(data.startswith(b'\x89PNG'))
            self.assertGreater(len(data), 5000)

        script = (
            f"import {{cardSvg}} from {json.dumps(str(card_mjs))};"
            "const s1 = cardSvg({lang:'zh-Hans', lead:'Boots 优惠', offers:[{retailer:'Boots',title:'护肤品满 £40 打 8 折',code:'GLOW20',discount_type:'percent',discount_value:20,min_spend_gbp:40,expires_on:'2026-12-31',eligibility:'student',eligibility_zh:'学生',via:'UNiDAYS',reports_7d:3}]});"
            "const s2 = cardSvg({zh:true, lead:'Boots 優惠', offers:[{retailer:'Boots',title:'保養品滿 £40 打 8 折',code:'GLOW20',discount_type:'percent',discount_value:20}]});"
            "console.log(JSON.stringify({s1, s2}));"
        )
        p2 = subprocess.run(['node', '--input-type=module', '-e', script], capture_output=True, timeout=15)
        self.assertEqual(p2.returncode, 0, p2.stderr.decode())
        svgs = json.loads(p2.stdout.decode())
        self.assertIn('Noto Sans SC', svgs['s1'])
        self.assertIn('码 GLOW20', svgs['s1'])
        self.assertIn('满 £40', svgs['s1'])
        self.assertIn('已对照商店官网', svgs['s1'])
        self.assertIn('Noto Sans TC', svgs['s2'])
        self.assertIn('碼 GLOW20', svgs['s2'])


def dt_noon_uk():
    import datetime as dt
    return dt.datetime(2026, 11, 19, 12, 0, tzinfo=nf.UK).timestamp()


class TestRuntimeGroupIntelligence(unittest.IsolatedAsyncioTestCase, FakeMatrixMixin):
    def setUp(self):
        self.reset_runtime()

    async def test_smart_quoting_latest_vs_intervened_and_no_double_quote(self):
        room = '!grp:netmind.chat'
        members = ['@alice:netmind.chat', '@bob:netmind.chat', rt.USER]
        now_ms = int(time.time() * 1000)

        # Case 1: Latest event in group -> should_quote False -> NEITHER image NOR caption has m.in_reply_to
        e1 = {
            'type': 'm.room.message', 'event_id': '$e1', 'sender': '@alice:netmind.chat', 'origin_server_ts': now_ms,
            'content': {'msgtype': 'm.text', 'body': '@Quidpaw Boots 有什麼碼？', 'm.mentions': {'user_ids': [rt.USER]}},
        }
        await rt.handle(room, e1, members)
        await asyncio.sleep(0.05)
        msgs1 = [m['content'] for m in self.sent if '/m.room.message/' in m['path']]
        self.assertEqual(len(msgs1), 2)  # card image + caption text
        self.assertNotIn('m.relates_to', msgs1[0])
        self.assertNotIn('m.relates_to', msgs1[1])

        # Case 2: Another event intervenes BEFORE reply finishes -> quote ONLY on FIRST message (image), NEVER on second (caption)
        self.sent.clear()
        e2 = {
            'type': 'm.room.message', 'event_id': '$e2', 'sender': '@alice:netmind.chat', 'origin_server_ts': now_ms + 100,
            'content': {'msgtype': 'm.text', 'body': '@Quidpaw Boots 有什麼碼？', 'm.mentions': {'user_ids': [rt.USER]}},
        }
        e_other = {
            'type': 'm.room.message', 'event_id': '$e_other', 'sender': '@bob:netmind.chat', 'origin_server_ts': now_ms + 120,
            'content': {'msgtype': 'm.text', 'body': 'wait what about lunch?'},
        }
        # Pre-pass like /sync batch
        rt.track_latest_event(room, e2)
        rt.track_latest_event(room, e_other)
        await rt.handle(room, e2, members)
        await asyncio.sleep(0.05)
        msgs2 = [m['content'] for m in self.sent if '/m.room.message/' in m['path']]
        self.assertEqual(len(msgs2), 2)
        self.assertEqual(msgs2[0]['msgtype'], 'm.image')
        self.assertEqual(msgs2[0].get('m.relates_to'), {'m.in_reply_to': {'event_id': '$e2'}})
        self.assertEqual(msgs2[1]['msgtype'], 'm.text')
        self.assertNotIn('m.relates_to', msgs2[1])

        # Case 3: CAPTION=True single-message card when another agent posted after human -> quotes human $e3, never @agent-helper
        self.sent.clear()
        rt.CAPTION = True
        e3 = {
            'type': 'm.room.message', 'event_id': '$e3', 'sender': '@alice:netmind.chat', 'origin_server_ts': now_ms + 200,
            'content': {'msgtype': 'm.text', 'body': '@Quidpaw Boots 有什麼碼？', 'm.mentions': {'user_ids': [rt.USER]}},
        }
        e_agent = {
            'type': 'm.room.message', 'event_id': '$e_agent', 'sender': '@agent-helper:netmind.chat', 'origin_server_ts': now_ms + 210,
            'content': {'msgtype': 'm.text', 'body': 'hello from another bot'},
        }
        rt.track_latest_event(room, e3)
        rt.track_latest_event(room, e_agent)
        await rt.handle(room, e3, members)
        await asyncio.sleep(0.05)
        msgs3 = [m['content'] for m in self.sent if '/m.room.message/' in m['path']]
        self.assertEqual(len(msgs3), 1)
        self.assertEqual(msgs3[0].get('m.relates_to'), {'m.in_reply_to': {'event_id': '$e3'}})

        # Case 4: DM never quotes even when another event exists
        self.sent.clear()
        rt.CAPTION = False
        self.auth_kind = 'dm'
        dm = '!dm:netmind.chat'
        e_dm = {
            'type': 'm.room.message', 'event_id': '$dm1', 'sender': '@alice:netmind.chat', 'origin_server_ts': now_ms + 300,
            'content': {'msgtype': 'm.text', 'body': 'Boots 有什么码？'},
        }
        rt.track_latest_event(dm, e_dm)
        rt.track_latest_event(dm, {'type': 'm.room.message', 'event_id': '$dm2', 'sender': '@alice:netmind.chat', 'content': {'msgtype': 'm.text', 'body': 'hi'}})
        await rt.handle(dm, e_dm, ['@alice:netmind.chat', rt.USER])
        await asyncio.sleep(0.05)
        for m in self.sent:
            self.assertNotIn('m.relates_to', m['content'])
        self.assertEqual(rt.NOTIFIER.user('@alice:netmind.chat')['lang'], 'zh-Hans')

    async def test_multi_mention_silence_offtopic_vs_deal_intent(self):
        room = '!grp:netmind.chat'
        members = ['@alice:netmind.chat', '@agent-other:netmind.chat', rt.USER]
        now_ms = int(time.time() * 1000)

        # Multi-@ with zero voucher/retailer intent -> completely silent
        e_off = {
            'type': 'm.room.message', 'event_id': '$m1', 'sender': '@alice:netmind.chat', 'origin_server_ts': now_ms,
            'content': {'msgtype': 'm.text', 'body': '@Quidpaw @OtherBot 今天天氣如何？', 'm.mentions': {'user_ids': [rt.USER, '@agent-other:netmind.chat']}},
        }
        await rt.handle(room, e_off, members)
        await asyncio.sleep(0.05)
        self.assertEqual(len(self.sent), 0)

        # Multi-@ with ambiguous trap ("football boots") -> still zero deal intent -> silent
        e_ambig = {
            'type': 'm.room.message', 'event_id': '$m2', 'sender': '@alice:netmind.chat', 'origin_server_ts': now_ms + 10,
            'content': {'msgtype': 'm.text', 'body': '@Quidpaw @OtherBot going to buy football boots', 'm.mentions': {'user_ids': [rt.USER, '@agent-other:netmind.chat']}},
        }
        await rt.handle(room, e_ambig, members)
        await asyncio.sleep(0.05)
        self.assertEqual(len(self.sent), 0)

        # Multi-@ WITH deal/retailer intent -> replies!
        e_deal = {
            'type': 'm.room.message', 'event_id': '$m3', 'sender': '@alice:netmind.chat', 'origin_server_ts': now_ms + 20,
            'content': {'msgtype': 'm.text', 'body': '@Quidpaw @OtherBot Boots 有什么码？', 'm.mentions': {'user_ids': [rt.USER, '@agent-other:netmind.chat']}},
        }
        await rt.handle(room, e_deal, members)
        await asyncio.sleep(0.05)
        self.assertGreater(len(self.sent), 0)
        self.assertIn('Boots', self.sent[-1]['content']['body'])

    async def test_never_reply_to_or_quote_agent_senders(self):
        room = '!grp:netmind.chat'
        members = ['@alice:netmind.chat', '@agent-helper:netmind.chat', rt.USER]
        now_ms = int(time.time() * 1000)

        e_bot = {
            'type': 'm.room.message', 'event_id': '$agent_msg', 'sender': '@agent-helper:netmind.chat', 'origin_server_ts': now_ms,
            'content': {'msgtype': 'm.text', 'body': '@Quidpaw Boots 有什麼碼？', 'm.mentions': {'user_ids': [rt.USER]}},
        }
        await rt.handle(room, e_bot, members)
        await asyncio.sleep(0.05)
        self.assertEqual(len(self.sent), 0)

    async def test_reply_to_other_context_resolves_shop(self):
        room = '!grp:netmind.chat'
        members = ['@alice:netmind.chat', '@bob:netmind.chat', rt.USER]
        now_ms = int(time.time() * 1000)
        self.room_events['$bob_msg'] = {
            'type': 'm.room.message',
            'event_id': '$bob_msg',
            'sender': '@bob:netmind.chat',
            'content': {'msgtype': 'm.text', 'body': '剛去逛了 Boots 好貴喔'},
        }
        self.plan_queue.append({'intent': 'search', 'retailer': 'boots'})
        e_reply = {
            'type': 'm.room.message', 'event_id': '$alice_q', 'sender': '@alice:netmind.chat', 'origin_server_ts': now_ms,
            'content': {
                'msgtype': 'm.text',
                'body': '@Quidpaw 這家有碼嗎？',
                'm.mentions': {'user_ids': [rt.USER]},
                'm.relates_to': {'m.in_reply_to': {'event_id': '$bob_msg'}},
            },
        }
        await rt.handle(room, e_reply, members)
        await asyncio.sleep(0.05)
        self.assertTrue(any('剛去逛了 Boots 好貴喔' in p for p in self.prompts))
        self.assertTrue(any('GLOW20' in m['content']['body'] for m in self.sent))

    async def test_redaction_cancels_burst_and_running_task(self):
        room = '!dm:netmind.chat'
        self.auth_kind = 'dm'
        members = ['@alice:netmind.chat', rt.USER]
        now_ms = int(time.time() * 1000)

        # Case A: redact while in burst debounce window -> never even sends
        rt.BURST_SEC = 0.2
        e1 = {
            'type': 'm.room.message', 'event_id': '$red1', 'sender': '@alice:netmind.chat', 'origin_server_ts': now_ms,
            'content': {'msgtype': 'm.text', 'body': 'Boots'},
        }
        await rt.handle(room, e1, members)
        await rt.handle(room, {'type': 'm.room.redaction', 'event_id': '$r1', 'sender': '@alice:netmind.chat', 'redacts': '$red1', 'content': {}}, members)
        await asyncio.sleep(0.3)
        self.assertEqual(len(self.sent), 0)

        # Case B: redact while model/reply is in-flight (Room v11 content.redacts)
        rt.BURST_SEC = 0.0
        gate = asyncio.Event()
        async def slow_model(prompt, att=None):
            await gate.wait()
            return json.dumps({'intent': 'chat', 'line': '嗨！'})
        rt.BRAIN.model = slow_model
        e2 = {
            'type': 'm.room.message', 'event_id': '$red2', 'sender': '@alice:netmind.chat', 'origin_server_ts': now_ms + 50,
            'content': {'msgtype': 'm.text', 'body': '幫我查個奇怪問題'},
        }
        await rt.handle(room, e2, members)
        await asyncio.sleep(0.02)
        await rt.handle(room, {'type': 'm.room.redaction', 'event_id': '$r2', 'sender': '@alice:netmind.chat', 'content': {'redacts': '$red2'}}, members)
        gate.set()
        await asyncio.sleep(0.05)
        self.assertEqual(len(self.sent), 0)

    async def test_burst_coalescing(self):
        room = '!dm:netmind.chat'
        self.auth_kind = 'dm'
        rt.BURST_SEC = 0.08
        members = ['@alice:netmind.chat', rt.USER]
        now_ms = int(time.time() * 1000)

        e1 = {'type': 'm.room.message', 'event_id': '$b1', 'sender': '@alice:netmind.chat', 'origin_server_ts': now_ms, 'content': {'msgtype': 'm.text', 'body': 'Boots'}}
        e2 = {'type': 'm.room.message', 'event_id': '$b2', 'sender': '@alice:netmind.chat', 'origin_server_ts': now_ms + 20, 'content': {'msgtype': 'm.text', 'body': '有什么码？'}}
        await rt.handle(room, e1, members)
        await asyncio.sleep(0.02)
        await rt.handle(room, e2, members)
        await asyncio.sleep(0.15)
        # Coalesced into ONE reply in Simplified Chinese
        msgs = [m['content'] for m in self.sent if m['content']['msgtype'] == 'm.text']
        self.assertEqual(len(msgs), 1)
        self.assertIn('GLOW20', msgs[0]['body'])
        self.assertIn('码 GLOW20', msgs[0]['body'])

    async def test_group_language_switch_and_mute_snooze(self):
        room = '!grp:netmind.chat'
        members = ['@alice:netmind.chat', rt.USER]
        now_ms = int(time.time() * 1000)

        # Switch room language to zh-Hans
        e_cmd = {'type': 'm.room.message', 'event_id': '$c1', 'sender': '@alice:netmind.chat', 'origin_server_ts': now_ms,
                 'content': {'msgtype': 'm.text', 'body': '@Quidpaw 說簡體', 'm.mentions': {'user_ids': [rt.USER]}}}
        await rt.handle(room, e_cmd, members)
        await asyncio.sleep(0.05)
        self.assertEqual(rt.room_state(room)['lang'], 'zh-Hans')
        self.assertIn('简体中文', self.sent[-1]['content']['body'])

        # Mute group
        self.sent.clear()
        e_mute = {'type': 'm.room.message', 'event_id': '$c2', 'sender': '@alice:netmind.chat', 'origin_server_ts': now_ms + 10,
                  'content': {'msgtype': 'm.text', 'body': '@Quidpaw 先安靜', 'm.mentions': {'user_ids': [rt.USER]}}}
        await rt.handle(room, e_mute, members)
        await asyncio.sleep(0.05)
        self.assertTrue(rt.room_state(room)['paused'])

        # Unsolicited greeting / chatter while muted -> completely silent
        self.sent.clear()
        e_hi = {'type': 'm.room.message', 'event_id': '$c3', 'sender': '@alice:netmind.chat', 'origin_server_ts': now_ms + 20,
                'content': {'msgtype': 'm.text', 'body': '@Quidpaw 嗨', 'm.mentions': {'user_ids': [rt.USER]}}}
        await rt.handle(room, e_hi, members)
        await asyncio.sleep(0.05)
        self.assertEqual(len(self.sent), 0)

        # Proactive send_text while muted -> skipped
        res = await rt.send_text(room, 'unsolicited ping')
        self.assertEqual(res, {'muted': True})
        self.assertEqual(len(self.sent), 0)

        # Unmute
        e_unmute = {'type': 'm.room.message', 'event_id': '$c4', 'sender': '@alice:netmind.chat', 'origin_server_ts': now_ms + 30,
                    'content': {'msgtype': 'm.text', 'body': '@Quidpaw 恢復', 'm.mentions': {'user_ids': [rt.USER]}}}
        await rt.handle(room, e_unmute, members)
        await asyncio.sleep(0.05)
        self.assertFalse(rt.room_state(room)['paused'])
        self.assertGreater(len(self.sent), 0)


if __name__ == '__main__':
    res = unittest.main(verbosity=2, exit=False)
    sys.exit(0 if res.result.wasSuccessful() else 1)
