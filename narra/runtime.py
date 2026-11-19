#!/usr/bin/env python3
"""Quidpaw: authorized Direct Matrix transport, group etiquette, and API-grounded voucher replies (see quidpaw.py)."""
import asyncio, hashlib, json, logging, os, re, sqlite3, tempfile, time
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import quote, urlencode
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parent
import sys; sys.path.insert(0, str(ROOT))
from quidpaw import Brain, L, group_intro, localize_offer, norm_lang, render_compact, to_html
from notify import Notifier

WORK = ROOT.parent
PRIVATE = WORK / '.narra/agent-b4b94dd2'
API = 'https://api.netmind.chat'
VOUCHERS = os.getenv('UK_VOUCHERS_API', 'https://uk-vouchers.netmind-ai.workers.dev')
AGENT = 'agt_agq6ji22sn6jpd5nnicl5ld7rm'


def _load_runtime_config():
    state_p = PRIVATE / 'runtime-state.json'
    cred_p = PRIVATE / 'matrix-credential.json'
    tok_p = PRIVATE / 'agent-runtime-token'
    if state_p.exists() and cred_p.exists() and tok_p.exists():
        state = json.loads(state_p.read_text())
        cred = json.loads(cred_p.read_text())
        tok = tok_p.read_text().strip()
        rules = (WORK / 'CLAUDE.md').read_text() if (WORK / 'CLAUDE.md').exists() else ''
        boot = (PRIVATE / 'AGENTS.md').read_text() if (PRIVATE / 'AGENTS.md').exists() else ''
        return state, cred, tok, cred['matrix_user_id'], cred['homeserver_url'], rules, boot
    return (
        {},
        {},
        '',
        os.getenv('QUIDPAW_TEST_USER', '@agent-b4b94dd2:netmind.chat'),
        os.getenv('QUIDPAW_TEST_HS', 'https://matrix.invalid'),
        '',
        '',
    )


STATE, C, TOKEN, USER, HS, RULES, BOOTSTRAP = _load_runtime_config()

TASKS = {}; VOICE = {}; CANCELLED = set(); TURNS = set(); LOCKS = {}
LATEST_ROOM_EVENT = {}   # room -> latest non-bot visible m.room.message event_id seen in /sync
SEEN_TIMELINE = set()    # bounded event_id cache so pre-pass + handle() stay idempotent
REDACTED = set()         # redacted event_ids to cancel/skip
BURSTS = {}              # (room, sender) -> {'events': [...], 'snippets': [...], 'context': ..., 'started_at': ..., 'timer': ...}

STALE_MS = 30 * 60 * 1000      # older group questions would only confuse the room
LATE_MS = 12 * 60 * 60 * 1000    # a DM this old (the sandbox slept) still gets an answer, with an apology
BURST_SEC = 1.5                # debounce window for short sequential fragments from the same sender
BURST_MAX_LEN = 120
BURST_MAX_COUNT = 5
BURST_MAX_WAIT = 4.5
CAPTION = os.getenv('QUIDPAW_CARD_CAPTION') == '1'  # card + codes in one m.image with a caption, if Narra shows captions
BEST = {}                      # lang -> (ts, offers): the last good "best right now" list, for when the API is down
NAME = re.compile(r'@?quidpaw(?![\w])', re.I)  # stripped from the text; a mention itself must be m.mentions or a reply (Narra's rule)
NOTIFY_EVERY = 10 * 60
UNMENTIONED_ENABLED = os.getenv('QUIDPAW_UNMENTIONED', '1') != '0'
UNMENTIONED_COOLDOWN_SEC = 30.0
UNMENTIONED_SESSION_SEC = 180.0
UNMENTIONED_YIELD_SEC = 1.8
LAST_AUTO_SESSION = {}         # (room, sender) -> unix timestamp of recent Quidpaw exchange


def request(url, data=None, token=None, method=None, raw=False):
    headers = {'User-Agent': 'curl/8.0', 'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    r = Request(url, data=None if data is None else json.dumps(data).encode(), headers=headers, method=method)
    with urlopen(r, timeout=45) as f:
        b = f.read(25 * 1024 * 1024 + 1)
        if len(b) > 25 * 1024 * 1024:
            raise ValueError('response too large')
        return b if raw else json.loads(b)


async def http(*a, **kw):
    return await asyncio.to_thread(request, *a, **kw)


async def matrix(path, data=None, method=None):
    return await http(HS + '/_matrix/client/v3' + path, data, C.get('access_token'), method)


def esc(s):
    return quote(s, safe='')


async def send(room, typ, content, txn):
    r = await matrix('/rooms/' + esc(room) + '/send/' + esc(typ) + '/' + esc(txn), content, 'PUT')
    if typ == 'm.room.message' and r.get('event_id'):
        DB.execute('insert or ignore into own values(?,?,?)', (r['event_id'], room, time.time()))
        DB.execute('delete from own where room=? and id not in (select id from own where room=? order by ts desc limit 30)', (room, room))
        DB.commit()
    return r


def text_content(body, msgtype='m.text'):
    # Plain body for every client; formatted_body (tappable short links, codes in monospace) where HTML is shown.
    c = {'msgtype': msgtype, 'body': body}
    html = to_html(body)
    if html:
        c.update(format='org.matrix.custom.html', formatted_body=html)
    return c


async def typing(room, on):
    try:
        await matrix('/rooms/' + esc(room) + '/typing/' + esc(USER), {'typing': True, 'timeout': 30000} if on else {'typing': False}, 'PUT')
    except Exception:
        pass  # cosmetic only


async def keep_typing(room):
    # "Quidpaw is typing…" while the planner and the card run (they can take several seconds).
    while True:
        await typing(room, True)
        await asyncio.sleep(20)


def user_lang(user, fallback_text=''):
    u = NOTIFIER.user(user) or {}
    if u.get('lang'):
        return norm_lang(u['lang'], 'zh-Hant')
    return Brain.language(fallback_text, [])


def user_zh(user, fallback_text=''):
    return user_lang(user, fallback_text) != 'en'


def room_state(room):
    row = DB.execute('select lang,welcomed,paused,last_auto from rooms where room=?', (room,)).fetchone()
    if not row:
        DB.execute('insert or ignore into rooms(room) values(?)', (room,))
        DB.commit()
        row = (None, 0, 0, 0.0)
    return {'lang': norm_lang(row[0]) if row[0] else None, 'welcomed': bool(row[1]), 'paused': bool(row[2]), 'last_auto': float(row[3] or 0.0)}


def set_room(room, **kw):
    room_state(room)
    for k, v in kw.items():
        DB.execute(f'update rooms set {k}=? where room=?', (v, room))
    DB.commit()


async def history(room, before_eid, limit=8):
    # Recent text turns for follow-ups ("那學生的呢"). Untrusted: the planner treats it as data.
    try:
        chunk = (await matrix('/rooms/' + esc(room) + '/messages?' + urlencode({'dir': 'b', 'limit': 20}))).get('chunk', [])
    except Exception:
        return []
    turns = []
    for e in chunk:
        if e.get('event_id') == before_eid or e.get('type') != 'm.room.message':
            continue
        body = e.get('content', {}).get('body')
        if not isinstance(body, str) or not body.strip():
            continue
        turns.append({'who': 'bot' if e.get('sender') == USER else 'user', 'sender': e.get('sender'), 'text': clean(body)[:300]})
        if len(turns) >= limit:
            break
    return list(reversed(turns))


def clean(body):
    lines = [l for l in body.split('\n') if not l.startswith('> ')]  # drop quoted reply fallback
    t = NAME.sub(' ', ' '.join(lines).replace(USER, ' ')).strip()
    return t if len(t) <= 1000 else t[:300] + ' … ' + t[-700:]  # the ask is usually at the end of a long message


async def cli(*args):
    p = await asyncio.create_subprocess_exec('npx', '--yes', '@narra-im/narra-cli@latest', *args, '--endpoint', API, '--token-file', str(PRIVATE / 'agent-runtime-token'), cwd=WORK, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    try:
        out, _ = await asyncio.wait_for(p.communicate(), 90)
    except BaseException:
        p.kill(); await p.wait(); raise
    if p.returncode:
        raise RuntimeError('Narra CLI failed')
    return json.loads(out)


async def model(prompt, attachment=None):
    args = ['mf', 'agent', 'send', AGENT, '-', '--json']
    if attachment:
        args += ['--file', str(attachment)]
    p = await asyncio.create_subprocess_exec(*args, cwd=WORK, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(p.communicate(prompt.encode()), 60)
    except BaseException:
        p.terminate(); await p.wait(); raise
    if p.returncode:
        logging.warning('mf agent send exit %s: %s', p.returncode, re.sub(r'[A-Za-z0-9_-]{24,}', '***', err.decode(errors='replace'))[-300:])
        raise RuntimeError('Agent inference unavailable')
    doc = json.loads(out)
    if doc.get('error'):
        raise RuntimeError('Agent inference error')
    return doc['text']


BRAIN = Brain(http, model, VOUCHERS, logging)


def upload_request(data, filename):
    r = Request(HS + '/_matrix/media/v3/upload?' + urlencode({'filename': filename}), data=data, method='POST',
                headers={'User-Agent': 'curl/8.0', 'Content-Type': 'image/png', 'Authorization': 'Bearer ' + C['access_token']})
    with urlopen(r, timeout=45) as f:
        return json.loads(f.read())


async def card_image(card, caption=None):
    # Offer card PNG by cards/card.mjs (resvg + Noto Sans TC/SC); None when anything goes wrong, so text still goes out.
    # caption: the codes and links as the image's caption (MSC2530: body != filename), so the answer is one message.
    (ROOT / 'media').mkdir(exist_ok=True)
    fd, path = tempfile.mkstemp(suffix='.png', dir=ROOT / 'media'); os.close(fd)
    try:
        p = await asyncio.create_subprocess_exec('node', str(ROOT / 'cards' / 'card.mjs'), path, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        out, err = await asyncio.wait_for(p.communicate(json.dumps({**card, 'caption': bool(caption)}, ensure_ascii=False).encode()), 25)
        if p.returncode:
            logging.warning('Card failed: %s', err.decode(errors='replace')[-200:])
            return None
        info = json.loads(out); data = Path(path).read_bytes()
        mxc = (await asyncio.to_thread(upload_request, data, 'quidpaw-offers.png')).get('content_uri')
        if not mxc:
            return None
        image = {'msgtype': 'm.image', 'body': 'quidpaw-offers.png', 'url': mxc, 'info': {'mimetype': 'image/png', 'w': info['width'], 'h': info['height'], 'size': len(data)}}
        if caption:
            image.update({k: v for k, v in text_content(caption).items() if k != 'msgtype'}, filename='quidpaw-offers.png')
        return image
    except Exception as e:
        logging.warning('Card skipped: %s', type(e).__name__)
        return None
    finally:
        Path(path).unlink(missing_ok=True)


async def send_text(room, body, user=None, offers=None):
    if room_state(room)['paused']:
        return {'muted': True}
    r = await send(room, 'm.room.message', text_content(body), 'push-' + hashlib.sha256((room + body + str(time.time())).encode()).hexdigest())
    if offers:  # so 「收藏第 1 個」 or 「第 2 個不能用」 after a push points at the pushed offers
        DB.execute('insert or replace into shown values(?,?,?,?,?,?,?,?,?)', ('push-' + (r.get('event_id') or str(time.time())), r.get('event_id'), room, user, json.dumps(offers), None, 1, len(offers), time.time()))
        DB.commit()
    return r


def init_db(conn=None):
    global DB, NOTIFIER
    DB = conn or sqlite3.connect(os.getenv('QUIDPAW_DB', str(ROOT / 'state.sqlite3')))
    DB.execute('create table if not exists kv (key text primary key, value text)')
    DB.execute('create table if not exists replies (id text primary key, room text, payload text, sent integer default 0)')
    DB.execute('create table if not exists pending (id text primary key, room text, event text)')
    DB.execute('create table if not exists own (id text primary key, room text, ts real)')
    DB.execute('create table if not exists rooms (room text primary key, lang text, paused integer default 0, last_auto real default 0, welcomed integer default 0)')
    have_room_cols = {r[1] for r in DB.execute('pragma table_info(rooms)').fetchall()}
    for col, typ in (('paused', 'integer default 0'), ('last_auto', 'real default 0'), ('welcomed', 'integer default 0')):
        if col not in have_room_cols:
            DB.execute(f'alter table rooms add column {col} {typ}')
    # What each reply showed, so "更多", "第 2 個不能用" and a 👎 on that message know which offers they mean.
    DB.execute('create table if not exists shown (src text primary key, bot text, room text, user text, offers text, query text, page integer, total integer, ts real)')
    DB.execute('create table if not exists pending_sub (room text, user text, sub text, ts real, primary key (room, user))')
    # Earlier releases fixed a group's language from its first message; only explicit commands do now.
    if not DB.execute("select 1 from kv where key='room_lang_v2'").fetchone():
        DB.execute('update rooms set lang=null')
        DB.execute("insert into kv values('room_lang_v2','1')")
    DB.commit()
    NOTIFIER = Notifier(DB, http, VOUCHERS, send_text, logging)
    return DB, NOTIFIER


DB, NOTIFIER = init_db(sqlite3.connect(':memory:') if os.getenv('QUIDPAW_TEST') == '1' else None)


def called(room, content):
    # Narra counts only m.mentions and replies to the agent's own messages, never a name typed in the text.
    ref = content.get('m.relates_to', {}).get('m.in_reply_to', {}).get('event_id')
    return USER in content.get('m.mentions', {}).get('user_ids', []) or bool(ref and DB.execute('select 1 from own where id=?', (ref,)).fetchone())


def aimed_elsewhere(content):
    # Mentions someone else first and Quidpaw only later: talk about the bot, not to it.
    others = [u for u in content.get('m.mentions', {}).get('user_ids', []) if u != USER]
    body = (content.get('body') or '').lstrip().lower()
    if not others or not body.startswith('@'):
        return False
    return not re.match(r'@?(quidpaw|' + re.escape(USER.lower()) + r')\b', body)


def multi_target(content, text_raw=''):
    """True when a group message targets multiple users/bots via m.mentions or multiple @handles."""
    ids = {u for u in (content.get('m.mentions', {}).get('user_ids', []) or []) if u}
    if len(ids) > 1:
        return True
    handles = re.findall(r'(?:^|\s)@([A-Za-z0-9_.:-]+)', text_raw or '')
    return len({h.lower() for h in handles}) > 1


def reporter(user):
    return 'narra:' + hashlib.sha256(user.encode()).hexdigest()[:16]


def track_latest_event(room, event):
    """Record latest non-bot visible timeline event seen in /sync for smart quoting."""
    eid = event.get('event_id')
    if not eid or eid in SEEN_TIMELINE:
        return
    SEEN_TIMELINE.add(eid)
    if len(SEEN_TIMELINE) > 5000:
        SEEN_TIMELINE.clear()
    sender = event.get('sender', '')
    typ = event.get('type', '')
    c = event.get('content', {})
    if sender == USER:
        return
    if typ == 'm.room.message' and c.get('ai.netmind.visibility', {}).get('status') != 'hidden':
        if not event.get('unsigned', {}).get('redacted_because'):
            LATEST_ROOM_EVENT[room] = eid


def compute_should_quote(room, eid, group, voice):
    """Quote only in groups when another visible message arrived after the caller's message."""
    return bool(group and not voice and (LATEST_ROOM_EVENT.get(room) not in (None, eid)))


def is_redacted(eid, source_eids=None):
    ids = list(source_eids or ()) + ([eid] if eid else [])
    return any(x in REDACTED for x in ids)


def cancel_burst_target(room, target):
    """Remove a redacted event from any waiting burst buffer in `room`."""
    for key in [k for k in BURSTS if k[0] == room]:
        buf = BURSTS.get(key)
        if not buf:
            continue
        kept = [(ev, sn) for ev, sn in zip(buf['events'], buf['snippets']) if ev.get('event_id') != target]
        if len(kept) == len(buf['events']):
            continue
        if not kept:
            BURSTS.pop(key, None)
            if buf.get('timer') and not buf['timer'].done():
                buf['timer'].cancel()
        else:
            buf['events'] = [x[0] for x in kept]
            buf['snippets'] = [x[1] for x in kept]


async def handle_redaction(room, event):
    """Cancel or skip any queued, running, or pending replies for redacted events."""
    target = event.get('redacts') or event.get('content', {}).get('redacts')
    if not target:
        return
    REDACTED.add(target)
    if len(REDACTED) > 5000:
        REDACTED.clear()
    if LATEST_ROOM_EVENT.get(room) == target:
        LATEST_ROOM_EVENT.pop(room, None)
    cancel_burst_target(room, target)
    task = TASKS.get(target)
    if task and not task.done():
        task.cancel()
    DB.execute('delete from pending where id=?', (target,))
    DB.execute('update replies set sent=2 where id=? and sent=0', (target,))
    DB.commit()


async def fetch_reply_context(room, content):
    """If replying to a non-Quidpaw message, fetch its event and return a cleaned snippet."""
    ref = content.get('m.relates_to', {}).get('m.in_reply_to', {}).get('event_id')
    if not ref or DB.execute('select 1 from own where id=?', (ref,)).fetchone():
        return None
    try:
        parent = await matrix('/rooms/' + esc(room) + '/event/' + esc(ref))
    except Exception:
        return None
    if not isinstance(parent, dict) or parent.get('sender') == USER or parent.get('type') != 'm.room.message':
        return None
    if parent.get('unsigned', {}).get('redacted_because'):
        return None
    pc = parent.get('content', {})
    pbody = pc.get('body') or (pc.get('ai.netmind.compound') or {}).get('text') or ''
    if not isinstance(pbody, str) or not pbody.strip():
        return None
    snippet = clean(pbody)[:300].strip()
    return snippet or None


async def authorize(room, event, members, mentioned):
    try:
        return await http(API + '/api/agent-runtime/matrix/authorize-event', {'roomId': room, 'senderMatrixUserId': event['sender'], 'memberMatrixUserIds': members, 'mentioned': mentioned}, TOKEN)
    except Exception:
        return {}


def deterministic_uuid4(seed):
    """Deterministic UUID v4-formatted txn_id required by Narra chat proxy send."""
    b = bytearray(hashlib.sha256(('quidpaw-proxy:' + str(seed)).encode()).digest()[:16])
    b[6] = (b[6] & 0x0f) | 0x40
    b[8] = (b[8] & 0x3f) | 0x80
    h = b.hex()
    return f'{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}'


def has_active_session(room, sender, now=None):
    now = time.time() if now is None else now
    ts = LAST_AUTO_SESSION.get((room, sender)) or 0.0
    if now - ts <= UNMENTIONED_SESSION_SEC:
        return True
    row = DB.execute('select max(ts) from shown where room=? and user=?', (room, sender)).fetchone()
    return bool(row and row[0] and (now - float(row[0])) <= UNMENTIONED_SESSION_SEC)


async def chat_proxy_authorize_group_member(room, sender):
    """Server-side fail-closed authorization check via Narra chat/room proxy for unmentioned group turns."""
    try:
        res = await http(API + '/api/agent-runtime/chat/room?' + urlencode({'room_id': room, 'include_members': 'true'}), token=TOKEN)
    except Exception:
        return False
    if not isinstance(res, dict) or res.get('status') != 'ok':
        return False
    rm = (res.get('data') or {}).get('room') or {}
    if rm.get('conversation_type') != 'group':
        return False
    members = rm.get('members') or []
    return any(isinstance(m, dict) and m.get('matrix_user_id') == sender for m in members)


async def has_live_peer_replied_after(room, target_eid, target_ts_ms=0):
    """True when another @agent-* replied after target_eid (anti-pile-on) or target_eid was redacted."""
    chunk = []
    try:
        res = await http(API + '/api/agent-runtime/chat/messages?' + urlencode({'room_id': room, 'dir': 'b', 'limit': '10'}), token=TOKEN)
        if isinstance(res, dict) and res.get('status') == 'ok':
            data = res.get('data') or {}
            chunk = (data.get('raw_matrix') or {}).get('chunk') or data.get('messages') or []
    except Exception:
        chunk = []
    if not chunk:
        try:
            chunk = ((await matrix('/rooms/' + esc(room) + '/messages?' + urlencode({'dir': 'b', 'limit': '10'}))) or {}).get('chunk') or []
        except Exception:
            return False
    for ev in chunk:
        if not isinstance(ev, dict):
            continue
        ev_id = ev.get('event_id')
        if ev_id == target_eid:
            if (ev.get('unsigned') or {}).get('redacted_because'):
                return True
            break
        ev_ts = ev.get('origin_server_ts') or 0
        if target_ts_ms and ev_ts and ev_ts < target_ts_ms:
            break
        if (ev.get('unsigned') or {}).get('redacted_because'):
            continue
        ev_typ = ev.get('type') or 'm.room.message'
        if ev_typ != 'm.room.message':
            continue
        ev_content = ev.get('content') or {}
        if (ev_content.get('ai.netmind.visibility') or {}).get('status') == 'hidden':
            continue
        ev_sender = ev.get('sender') or ''
        if ev_sender and ev_sender != USER and ev_sender.startswith('@agent-'):
            return True
    return False


async def send_via_narra_proxy(room, body, eid):
    """Post an authorized group reply through Narra chat/send and record own event_id for follow-up replies."""
    res = await http(
        API + '/api/agent-runtime/chat/send',
        {'room_id': room, 'text': body, 'txn_id': deterministic_uuid4(eid)},
        token=TOKEN,
    )
    if not isinstance(res, dict) or res.get('status') != 'ok':
        raise RuntimeError('Narra chat proxy send failed')
    data = res.get('data') or {}
    bot_eid = data.get('event_id')
    if bot_eid:
        DB.execute('insert or ignore into own values(?,?,?)', (bot_eid, room, time.time()))
        DB.execute('delete from own where room=? and id not in (select id from own where room=? order by ts desc limit 30)', (room, room))
        DB.commit()
    return data


async def deliver_pending():
    for eid, room, payload in DB.execute('select id,room,payload from replies where sent=0').fetchall():
        pending = DB.execute('select event from pending where id=?', (eid,)).fetchone()
        if not pending:
            continue
        original = json.loads(pending[0])
        if eid in REDACTED or original.get('unsigned', {}).get('redacted_because') or original.get('sender') == USER or original.get('sender', '').startswith('@agent-'):
            DB.execute('update replies set sent=2 where id=?', (eid,))
            DB.execute('delete from pending where id=?', (eid,))
            DB.commit()
            continue
        members = list((await matrix('/rooms/' + esc(room) + '/joined_members')).get('joined', {}))
        mentioned = called(room, original.get('content', {}))
        if (await authorize(room, original, members, mentioned)).get('allow') is not True:
            DB.execute('update replies set sent=2 where id=?', (eid,))
            DB.commit()  # denied now: do not retry forever
            continue
        r = await send(room, 'm.room.message', json.loads(payload), hashlib.sha256(eid.encode()).hexdigest())
        DB.execute('update replies set sent=1 where id=?', (eid,))
        DB.execute('update shown set bot=? where src=?', (r.get('event_id'), eid))
        DB.commit()


COMMANDS = [
    (re.compile(r'^(說英文|講英文|说英文|讲英文|用英文|speak english|english)$', re.I), 'en'),
    (re.compile(r'^(說簡體|講簡體|用簡體|說簡體中文|说简体|讲简体|用简体|说简体中文|说中文|讲中文|simplified chinese|簡體中文|簡體|简体)$', re.I), 'zh-Hans'),
    (re.compile(r'^(說繁體|講繁體|說正體|用繁體|說繁體中文|說中文|講中文|说繁体|讲繁体|用繁体|说繁体中文|traditional chinese|繁體中文|繁體|繁体|speak chinese|中文)$', re.I), 'zh-Hant'),
]

MUTE_CMD = re.compile(
    r'^(先安靜|安靜一點|安靜一下|別插嘴|不要插嘴|別說話|先閉嘴|閉嘴|關閉播報|關掉播報|停止播報|暫停|勿擾|休息一下|'
    r'先安静|安静一点|安静一下|别插嘴|不要插嘴|别说话|先闭嘴|闭嘴|关闭播报|关掉播报|停止播报|暂停|勿扰|'
    r'mute|be quiet|quiet|shh+|pause|snooze|silence|turn off broadcasts)$',
    re.I,
)
UNMUTE_CMD = re.compile(
    r'^(恢復|繼續|可以說話了|打開播報|開啟播報|解除靜音|取消靜音|'
    r'恢复|继续|可以说话了|打开播报|开启播报|解除静音|取消静音|'
    r'unmute|resume|wake up|speak again|turn on broadcasts)$',
    re.I,
)


def command(room, text):
    t = re.sub(r'[\s!！。.~]+$', '', (text or '').strip())
    for rx, cmd in COMMANDS:
        if rx.match(t):
            set_room(room, lang=cmd)
            return L(
                cmd,
                '之後在這個群組都說繁體中文 🐾',
                '之后在这个群里都说简体中文 🐾',
                "I'll use English in this group from now on 🐾",
            )
    return None


def mute_command(room, text, lang):
    t = re.sub(r'[\s!！。.~]+$', '', (text or '').strip())
    if MUTE_CMD.match(t):
        set_room(room, paused=1)
        return L(
            lang,
            '好，我先安靜 🐾 有需要再 @我 問優惠。',
            '好，我先安静 🐾 有需要再 @我 问优惠。',
            "Got it, I'll stay quiet 🐾 @mention me whenever you want deals.",
        )
    if UNMUTE_CMD.match(t):
        set_room(room, paused=0)
        return L(
            lang,
            '我回來了 🐾 要找什麼優惠？',
            '我回来了 🐾 要找什么优惠？',
            "I'm back 🐾 What deals are you looking for?",
        )
    return None


def shown_offers(where, args):
    row = DB.execute('select offers,query,page,total from shown where ' + where + ' order by ts desc limit 1', args).fetchone()
    if not row:
        return None
    return {'offers': json.loads(row[0] or '[]'), 'query': json.loads(row[1]) if row[1] else None, 'page': row[2] or 1, 'total': row[3] or 0}


def context_for(room, user, group, content):
    ref = content.get('m.relates_to', {}).get('m.in_reply_to', {}).get('event_id')
    replied = shown_offers('bot=?', (ref,)) if ref else None
    last = shown_offers('room=? and user=?', (room, user)) if group else shown_offers('room=?', (room,))
    u = NOTIFIER.user(user) or {}
    pend = DB.execute('select sub from pending_sub where room=? and user=? and ts>?', (room, user, time.time() - 3600)).fetchone()
    subs = [dict(zip(('kind', 'value', 'label'), r)) for r in DB.execute('select kind,value,label from subs where user=?', (user,)).fetchall()]
    return {'group': group, 'identity': u.get('identity'), 'lang_hint': u.get('lang'), 'last': last, 'replied': (replied or {}).get('offers'),
            'pending': json.loads(pend[0]) if pend else None, 'subs': subs}


async def apply(actions, room, user, result):
    for a in actions:
        if 'set_identity' in a:
            DB.execute('insert into users(user,room,identity) values(?,?,?) on conflict(user) do update set identity=excluded.identity', (user, room, a['set_identity']))
        elif 'subscribe' in a:
            sub = a['subscribe']
            DB.execute('insert into users(user,room,notify) values(?,?,1) on conflict(user) do update set room=excluded.room, notify=1', (user, room))
            DB.execute('insert or replace into subs(user,kind,value,label,expires_on,reminded,created,threshold,fp) values(?,?,?,?,?,0,?,?,?)',
                       (user, sub['kind'], sub['value'], sub['label'], sub.get('expires_on'), time.time(), sub.get('threshold'), json.dumps(sub['fp']) if sub.get('fp') else None))
        elif 'unsubscribe' in a:
            v = a['unsubscribe']
            if v:
                DB.execute('delete from subs where user=? and value=?', (user, v))
            else:
                DB.execute('delete from subs where user=?', (user,))
                DB.execute('update users set notify=0 where user=?', (user,))
        elif 'pending' in a:
            DB.execute('insert or replace into pending_sub values(?,?,?,?)', (room, user, json.dumps(a['pending']), time.time()))
        elif 'report' in a:
            for vid in a['report']:
                try:
                    await http(VOUCHERS + '/api/vouchers/' + esc(vid) + '/report', {'reporter': reporter(user), 'reason': a.get('reason', '')})
                except Exception as e:
                    logging.warning('Report failed: %s', type(e).__name__)
                v = next((o for o in (result.get('reported_from') or []) if o.get('id') == vid), {})
                DB.execute('insert or ignore into reports(user,room,voucher_id,retailer,title,ts) values(?,?,?,?,?,?)', (user, room, vid, v.get('retailer', ''), v.get('title', ''), time.time()))
        elif 'tip' in a:
            try:
                await http(VOUCHERS + '/api/tips', a['tip'])
            except Exception as e:
                logging.warning('Tip failed: %s', type(e).__name__)
        elif 'demand' in a and a['demand']:
            try:
                await http(VOUCHERS + '/api/demand', a['demand'])
            except Exception:
                pass  # best effort
    # A yes/no question stays open (1 h) until answered, declined or replaced; other messages in between do not cancel it.
    if any('clear_pending' in a or ('subscribe' in a and a['subscribe'].get('kind') != 'offer') for a in actions) and not any('pending' in a for a in actions):
        DB.execute('delete from pending_sub where room=? and user=?', (room, user))
    DB.commit()


async def reply(room, event, context, attachment=None, source_eids=None, parent_snippet=None):
    lock = LOCKS.setdefault(room, asyncio.Lock())
    async with lock:
        await _reply(room, event, context, attachment, source_eids, parent_snippet)


async def _reply(room, event, context, attachment=None, source_eids=None, parent_snippet=None):
    content = event['content']; eid = event['event_id']; voice = content.get('ai.netmind.rtc.agent.turn.started.v2')
    group = bool(context and context.get('group')); unmentioned = bool(context and context.get('unmentioned')); user = event.get('sender', '')
    if user == USER or user.startswith('@agent-') or is_redacted(eid, source_eids):
        DB.execute('delete from pending where id=?', (eid,)); DB.commit()
        return
    typer = None
    try:
        if unmentioned:
            if UNMENTIONED_YIELD_SEC > 0:
                await asyncio.sleep(UNMENTIONED_YIELD_SEC)
            if is_redacted(eid, source_eids) or await has_live_peer_replied_after(room, eid, event.get('origin_server_ts') or 0):
                DB.execute('delete from pending where id=?', (eid,)); DB.commit()
                logging.info('Yielded unmentioned message before inference')
                return
        typer = None if voice else asyncio.create_task(keep_typing(room))
        raw_text = clean(voice.get('transcript', content.get('body', '')) if voice else content.get('body', ''))
        effective_text = f'[Replied message: {parent_snippet}]\n{raw_text}' if parent_snippet else raw_text
        # A group's language is only fixed by 「@Quidpaw 說繁體 / 說簡體 / 說英文」; otherwise each message picks its own.
        st = room_state(room)
        room_lang = st['lang'] if group else None
        result = None
        cmd = command(room, raw_text) if (group and not unmentioned) else None
        if cmd is not None:
            body = cmd
            res_lang = room_state(room)['lang'] or Brain.language(raw_text, [])
        else:
            m_cmd = mute_command(room, raw_text, room_lang or Brain.language(raw_text, [])) if (group and not unmentioned) else None
            if m_cmd is not None:
                body = m_cmd
                res_lang = room_lang or Brain.language(raw_text, [])
            else:
                ctx = context_for(room, user, group, content)
                past = await history(room, eid)
                if group:
                    past = [x for x in past if x['who'] == 'bot' or x.get('sender') == user]  # only this person's side of a busy group
                ctx.update(history=past, attachment=attachment, lang=room_lang, voice=bool(voice), reply_to=parent_snippet,
                           reported=[r[0] for r in DB.execute('select voucher_id from reports where user=? and resolved=0', (user,)).fetchall()])
                result = await BRAIN.respond(effective_text, ctx)
                if unmentioned and (not result or (not result.get('offers') and result.get('query') is None and not result.get('actions'))):
                    DB.execute('delete from pending where id=?', (eid,)); DB.commit()
                    logging.info('Suppressed non-deal unmentioned fallback')
                    return
                res_lang = norm_lang(result.get('lang') or room_lang or user_lang(user, raw_text), 'zh-Hant')
                result['reported_from'] = ctx.get('replied') or (ctx.get('last') or {}).get('offers')
                if not group:
                    NOTIFIER.remember_user(user, room, res_lang)
                await apply(result['actions'], room, user, result)
                body = result['text']
                if result.get('card') and result.get('query') == {} and result.get('page', 1) == 1:
                    BEST[res_lang] = (time.time(), result['card']['offers'])
                if result.get('offers') or result.get('query') is not None:
                    DB.execute('insert or replace into shown values(?,?,?,?,?,?,?,?,?)', (eid, None, room, user, json.dumps(result.get('offers') or []),
                               json.dumps(result.get('query')) if result.get('query') is not None else None, result.get('page', 1), result.get('total', 0), time.time()))
        if is_redacted(eid, source_eids):
            DB.execute('delete from pending where id=?', (eid,)); DB.commit()
            return
        if unmentioned:
            if await has_live_peer_replied_after(room, eid, event.get('origin_server_ts') or 0):
                DB.execute('delete from pending where id=?', (eid,)); DB.commit()
                logging.info('Yielded unmentioned message after peer reply')
                return
            out_body = ((result.get('text') if result else None) or body).strip()
            if not out_body:
                DB.execute('delete from pending where id=?', (eid,)); DB.commit()
                return
            sent_data = await send_via_narra_proxy(room, out_body, eid)
            bot_eid = sent_data.get('event_id')
            DB.execute('insert or replace into replies(id,room,payload,sent) values(?,?,?,1)', (eid, room, json.dumps({'msgtype': 'm.text', 'body': out_body})))
            if bot_eid:
                DB.execute('update shown set bot=? where src=?', (bot_eid, eid))
            DB.execute('delete from pending where id=?', (eid,))
            DB.commit()
            now_ts = time.time()
            set_room(room, last_auto=now_ts)
            LAST_AUTO_SESSION[(room, user)] = now_ts
            logging.info('Answered unmentioned group message via Narra chat proxy')
            return
        # Refresh room state (in case mute/unmute just updated it)
        st_now = room_state(room)
        if group and not st_now['welcomed'] and not voice and not st_now['paused']:
            set_room(room, welcomed=1)
            body = body + '\n\n' + group_intro(res_lang)
        if voice and ((voice['rtc_session_id'], voice['turn_id']) in CANCELLED or VOICE.get(room, {}).get('turn') != voice['turn_id']):
            return
        sorry = L(res_lang, '抱歉晚回了 🐾\n', '抱歉晚回了 🐾\n', 'Sorry for the slow reply 🐾\n') if context and context.get('late') else ''
        should_quote = compute_should_quote(room, eid, group, voice)
        payload = None
        sent_card_image = False
        if result and result.get('card') and not voice:
            intro_txt = group_intro(res_lang)
            intro = ('\n\n' + intro_txt) if group and body.endswith(intro_txt) else ''
            caption = sorry + result['card_text'] + intro
            image = await card_image(result['card'], sorry + result.get('card_caption', result['card_text']) + intro if CAPTION else None)
            if is_redacted(eid, source_eids):
                DB.execute('delete from pending where id=?', (eid,)); DB.commit()
                return
            if image and CAPTION:
                payload = image  # one message: goes through the same authorized delivery as text
            elif image:
                if should_quote:
                    image['m.relates_to'] = {'m.in_reply_to': {'event_id': eid}}
                r = await send(room, 'm.room.message', image, 'card-' + hashlib.sha256(eid.encode()).hexdigest())
                sent_card_image = True
                body = caption
                if r.get('event_id'):  # a reply or 👎 on the picture means its offers too
                    DB.execute('insert or replace into shown values(?,?,?,?,?,?,?,?,?)', ('card-' + eid, r['event_id'], room, user, json.dumps(result.get('offers') or []), None, 1, len(result.get('offers') or []), time.time() - 1))
                    DB.commit()
            else:
                body = sorry + body
        else:
            body = sorry + body
        if is_redacted(eid, source_eids):
            DB.execute('delete from pending where id=?', (eid,)); DB.commit()
            return
        payload = payload or text_content(body)
        # Never put m.in_reply_to on both card image and caption text; only quote on the first message when should_quote is true.
        if should_quote and not sent_card_image:
            payload['m.relates_to'] = {'m.in_reply_to': {'event_id': eid}}
        if voice:
            payload['ai.netmind.rtc.voice_reply'] = {k: voice[k] for k in ('rtc_session_id', 'turn_id')}
        DB.execute('insert or ignore into replies(id,room,payload) values(?,?,?)', (eid, room, json.dumps(payload)))
        DB.commit()
        await deliver_pending()
        DB.execute('delete from pending where id=?', (eid,))
        DB.commit()
        if group:
            LAST_AUTO_SESSION[(room, user)] = time.time()
        logging.info('Answered authorized message')
        if voice and result and result.get('full_text'):
            # Spoken answer stays short; links and the full list go to the chat as plain text.
            await send(room, 'm.room.message', {'msgtype': 'm.text', 'body': result['full_text']}, 'full-' + hashlib.sha256(eid.encode()).hexdigest())
    except asyncio.CancelledError:
        DB.execute('delete from pending where id=?', (eid,))
        DB.commit()
        raise
    except Exception as e:
        if is_redacted(eid, source_eids):
            DB.execute('delete from pending where id=?', (eid,)); DB.commit()
            return
        if unmentioned:
            DB.execute('delete from pending where id=?', (eid,)); DB.commit()
            logging.warning('Unmentioned reply suppressed after error: %s', type(e).__name__)
            return
        logging.error('Reply failed: %s', type(e).__name__)
        payload = text_content(error_text(room, user, group, content.get('body', ''), voice))
        if compute_should_quote(room, eid, group, voice):
            payload['m.relates_to'] = {'m.in_reply_to': {'event_id': eid}}
        if voice:
            payload['ai.netmind.rtc.voice_reply'] = {k: voice[k] for k in ('rtc_session_id', 'turn_id')}
        await send(room, 'm.room.message', payload, 'error-' + hashlib.sha256(eid.encode()).hexdigest())
    finally:
        if typer:
            typer.cancel()
            await typing(room, False)
        if attachment:
            Path(attachment).unlink(missing_ok=True)
        for seid in (source_eids or (eid,)):
            TASKS.pop(seid, None)
        if voice:
            TASKS.pop((voice['rtc_session_id'], voice['turn_id']), None)


def error_text(room, user, group, text, voice=None):
    # Not a dead end: say what to do, and show the last checked best list if there is a recent one.
    lang = (room_state(room)['lang'] if group else None)
    if not lang:
        lang = Brain.language(text, [], user_lang(user, text))
    lang = norm_lang(lang, 'zh-Hant')
    body = L(
        lang,
        '我這邊暫時查不到即時優惠（連線出了點問題）。過一兩分鐘再傳一次同樣的問題就好 🐾',
        '我这边暂时查不到实时优惠（连接出了点问题）。过一两分钟再发一次同样的问题就好 🐾',
        "I can't reach the live offers right now. Send the same question again in a minute or two 🐾",
    )
    ts, offers = BEST.get(lang, (0, None))
    if not offers and lang == 'zh-Hans':
        ts, offers = BEST.get('zh-Hant', (0, None))
        if offers:
            offers = [localize_offer(v, 'zh-Hans') for v in offers]
    if offers and not voice and time.time() - ts < 6 * 3600:
        hours = max(1, round((time.time() - ts) / 3600))
        body += L(
            lang,
            f'\n\n先給你 {hours} 小時內核對過的幾個：\n',
            f'\n\n先给你 {hours} 小时内核对过的几个：\n',
            f'\n\nMeanwhile, the best ones as of {hours}h ago:\n',
        ) + render_compact(offers[:3], lang)
    return body


async def reaction(room, event, members):
    # A 👎 on one of Quidpaw's offer messages = "this didn't work". DMs only (in groups it would need a mention).
    rel = event.get('content', {}).get('m.relates_to', {})
    if rel.get('rel_type') != 'm.annotation' or not str(rel.get('key', '')).startswith('👎'):
        return
    target = rel.get('event_id'); eid = event.get('event_id', '')
    if not DB.execute('select 1 from own where id=?', (target,)).fetchone():
        return
    if DB.execute('select 1 from replies where id=?', (eid,)).fetchone():
        return
    auth = await authorize(room, event, members, False)
    if auth.get('allow') is not True or auth.get('roomKind') != 'dm':
        return
    seen = shown_offers('bot=?', (target,))
    offers = (seen or {}).get('offers') or []
    user = event.get('sender', '')
    lang = user_lang(user)
    if len(offers) == 1 and DB.execute('select 1 from reports where user=? and voucher_id=? and resolved=0', (user, offers[0]['id'])).fetchone():
        body = L(
            lang,
            f"你回報過 {offers[0]['retailer']} 了，已在重新確認 🐾",
            f"你反馈过 {offers[0]['retailer']} 了，已在重新确认 🐾",
            f"You've already reported {offers[0]['retailer']}; it's being rechecked 🐾",
        )
    elif len(offers) == 1:
        await apply([{'report': [offers[0]['id']], 'reason': 'thumbs down'}], room, user, {'reported_from': offers})
        body = L(
            lang,
            f"謝謝回報！我請人重新確認 {offers[0]['retailer']} 這個優惠 🐾",
            f"谢谢反馈！我请人重新确认 {offers[0]['retailer']} 这个优惠 🐾",
            f"Thanks! I've asked for {offers[0]['retailer']} to be rechecked 🐾",
        )
    elif offers:
        body = L(
            lang,
            '是哪一個不能用？回覆那則訊息說「第 2 個不能用」就好。',
            '是哪一个不能用？回复那条消息说「第 2 个不能用」就好。',
            'Which one failed? Reply to that message with "number 2 didn\'t work".',
        )
    else:
        return
    DB.execute('insert or ignore into replies(id,room,payload,sent) values(?,?,?,1)', (eid, room, '{}'))
    DB.commit()
    await send(room, 'm.room.message', {'msgtype': 'm.text', 'body': body}, 'react-' + hashlib.sha256(eid.encode()).hexdigest())


async def image_attachment(room, c):
    # A photo with no caption arrives as m.image; an encrypted one (c["file"]) cannot be read without Matrix crypto.
    url = c.get('url', '')
    if not url.startswith('mxc://') or (c.get('info', {}).get('size') or 0) > 15 * 1024 * 1024:
        return None
    server, mid = url[6:].split('/', 1)
    b = await http(HS + '/_matrix/client/v1/media/download/' + esc(server) + '/' + esc(mid), token=C['access_token'], raw=True)
    suffix = Path(c.get('body', 'image.jpg')).suffix[:10] or '.jpg'
    (ROOT / 'media').mkdir(exist_ok=True)
    fd, path = tempfile.mkstemp(suffix=suffix, dir=ROOT / 'media'); os.write(fd, b); os.close(fd)
    return path


def _spawn_reply(room, event, context, attachment=None, source_eids=None, parent_snippet=None):
    eid = event['event_id']
    eids = list(source_eids or [eid])
    DB.execute('insert or replace into pending values(?,?,?)', (eid, room, json.dumps(event)))
    for earlier in eids[:-1]:
        DB.execute('delete from pending where id=?', (earlier,))
        DB.execute('insert or ignore into replies(id,room,payload,sent) values(?,?,?,1)', (earlier, room, '{}'))
    DB.commit()
    task = asyncio.create_task(reply(room, event, context, attachment, eids, parent_snippet))
    for seid in eids:
        TASKS[seid] = task
    return task


async def flush_burst(key):
    buf = BURSTS.pop(key, None)
    if not buf:
        return
    room, _ = key
    kept = [(ev, sn) for ev, sn in zip(buf['events'], buf['snippets']) if ev.get('event_id') not in REDACTED]
    if not kept:
        return
    events = [x[0] for x in kept]
    snippets = [x[1] for x in kept if x[1]]
    primary = dict(events[-1])
    combined_body = '\n'.join(clean(ev['content'].get('body', '')) for ev in events)
    primary_content = dict(primary['content'], body=combined_body)
    primary['content'] = primary_content
    parent_snippet = snippets[-1] if snippets else None
    source_eids = [ev['event_id'] for ev in events]
    _spawn_reply(room, primary, buf['context'], None, source_eids, parent_snippet)


async def _burst_wait(key):
    try:
        await asyncio.sleep(BURST_SEC)
        await flush_burst(key)
    except asyncio.CancelledError:
        pass


async def queue_or_dispatch(room, sender, event, context, user_text, parent_snippet):
    key = (room, sender)
    eid = event['event_id']
    short = len(user_text) <= BURST_MAX_LEN
    buf = BURSTS.get(key)
    if buf is not None:
        if buf.get('timer') and not buf['timer'].done():
            buf['timer'].cancel()
        buf['events'].append(event)
        buf['snippets'].append(parent_snippet)
        buf['context'] = context
        DB.execute('insert or replace into pending values(?,?,?)', (eid, room, json.dumps(event)))
        DB.commit()
        if not short or len(buf['events']) >= BURST_MAX_COUNT or (time.monotonic() - buf['started_at']) >= BURST_MAX_WAIT:
            await flush_burst(key)
        else:
            buf['timer'] = asyncio.create_task(_burst_wait(key))
        return
    if not short or BURST_SEC <= 0:
        _spawn_reply(room, event, context, None, [eid], parent_snippet)
        return
    DB.execute('insert or replace into pending values(?,?,?)', (eid, room, json.dumps(event)))
    DB.commit()
    BURSTS[key] = {
        'events': [event],
        'snippets': [parent_snippet],
        'context': context,
        'started_at': time.monotonic(),
        'timer': asyncio.create_task(_burst_wait(key)),
    }


async def handle(room, event, members):
    typ = event.get('type', '')
    if typ == 'm.room.redaction':
        await handle_redaction(room, event)
        return
    track_latest_event(room, event)
    sender = event.get('sender', '')
    if sender == USER or sender.startswith('@agent-'):
        return  # never reply to or quote itself or other agents
    c = event.get('content', {}); eid = event.get('event_id', '')
    if event.get('unsigned', {}).get('redacted_because') or eid in REDACTED:
        return
    rtc = typ.startswith('ai.netmind.rtc.agent.')
    if typ == 'm.reaction':
        return await reaction(room, event, members)
    image = typ == 'm.room.message' and c.get('msgtype') == 'm.image'
    if not rtc and not image and (typ != 'm.room.message' or c.get('msgtype') != 'm.text'):
        return
    age = time.time() * 1000 - event.get('origin_server_ts', time.time() * 1000)
    if not rtc and age > LATE_MS:
        return
    mention = called(room, c)
    auth = await authorize(room, event, members, mention)
    group = auth.get('roomKind') != 'dm' if auth.get('roomKind') else len(members) != 2
    if group and not rtc and aimed_elsewhere(c):
        return
    late = not rtc and age > STALE_MS
    if late and group:
        return  # an old group question would only confuse the room; a DM still gets its answer
    if auth.get('allow') is not True:
        if (
            UNMENTIONED_ENABLED
            and not mention
            and auth.get('reason') == 'not_mentioned'
            and auth.get('roomKind') == 'group'
            and not rtc
            and not image
            and not c.get('ai.netmind.hint')
            and not late
            and typ == 'm.room.message'
            and c.get('msgtype') == 'm.text'
            and c.get('ai.netmind.visibility', {}).get('status') != 'hidden'
        ):
            if not (c.get('m.mentions') or {}).get('user_ids') and not (c.get('body') or '').lstrip().startswith('@'):
                if not (DB.execute('select 1 from replies where id=?', (eid,)).fetchone() or eid in TASKS or eid in REDACTED):
                    st_room = room_state(room)
                    if not st_room['paused']:
                        user_text = clean(c.get('body', ''))
                        active_session = has_active_session(room, sender)
                        if active_session or (time.time() - st_room['last_auto']) >= UNMENTIONED_COOLDOWN_SEC:
                            has_pending_sub = bool(DB.execute('select 1 from pending_sub where room=? and user=? and ts>?', (room, sender, time.time() - 3600)).fetchone())
                            if await BRAIN.should_reply_unmentioned(user_text, active_session=active_session, has_pending_sub=has_pending_sub):
                                if await chat_proxy_authorize_group_member(room, sender):
                                    parent_snippet = await fetch_reply_context(room, c)
                                    _spawn_reply(room, event, {'group': True, 'late': False, 'unmentioned': True}, None, [eid], parent_snippet)
                                    return
        notice = auth.get('notice', {})
        if notice.get('send') is True and notice.get('text'):
            await send(room, 'm.room.message', {'msgtype': 'm.notice', 'body': notice['text']}, 'denied-' + hashlib.sha256(eid.encode()).hexdigest())
        return
    if rtc:
        kind = typ.removeprefix('ai.netmind.rtc.agent.').removesuffix('.v2'); sid = c.get('rtc_session_id'); tid = c.get('turn_id')
        if kind == 'call.started':
            VOICE[room] = {'session': sid, 'sender': event['sender']}
        v = VOICE.get(room, {})
        if v.get('session') != sid or v.get('sender') != event['sender']:
            return
        if kind in ('turn.cancelled', 'call.ended'):
            tid = tid or v.get('turn')
            if tid:
                CANCELLED.add((sid, tid))
                task = TASKS.get((sid, tid))
                if task:
                    task.cancel()
        ack = {'ack_of': kind, 'rtc_session_id': sid, 'platform': 'generic', 'call_mode': 'realtime', 'supports_long_task_delivery': False}
        if kind.startswith('turn.'):
            ack['turn_id'] = c.get('turn_id')
        await send(room, 'ai.netmind.rtc.agent.ack.v2', ack, 'ack-' + hashlib.sha256(eid.encode()).hexdigest())
        if kind == 'call.ended':
            VOICE.pop(room, None)
        return
    attachment = None
    hint = c.get('ai.netmind.hint')
    if image:
        if group:
            return  # groups: an image cannot carry a mention
        try:
            attachment = None if c.get('file') else await image_attachment(room, c)  # encrypted: unreadable without Matrix crypto
        except Exception:
            attachment = None
        if not attachment:
            if DB.execute('select 1 from replies where id=?', (eid,)).fetchone():
                return
            DB.execute('insert or ignore into replies(id,room,payload,sent) values(?,?,?,1)', (eid, room, '{}'))
            DB.commit()
            lang = user_lang(sender)
            await send(room, 'm.room.message', text_content(L(
                lang,
                '這張圖我打不開 🐾 可以直接打店名，或貼商品連結給我嗎？',
                '这张图我打不开 🐾 可以直接发店名，或贴商品链接给我吗？',
                "I couldn't open that picture 🐾 Could you type the shop name or paste the product link?",
            )), 'img-' + hashlib.sha256(eid.encode()).hexdigest())
            return
        event = dict(event); c = dict(c); c['body'] = ''; event['content'] = c
    elif hint:
        if hint.get('kind') != 'compound_trigger' or hint.get('version') != 1 or hint.get('target_msgtype') != 'ai.netmind.compound':
            return
        target = hint.get('target_event_id', '')
        original = await matrix('/rooms/' + esc(room) + '/event/' + esc(target))
        oc = original.get('content', {})
        if original.get('sender') == USER or original.get('sender', '').startswith('@agent-'):
            return
        if original.get('type') != 'm.room.message' or oc.get('msgtype') != 'ai.netmind.compound' or original.get('room_id') != room:
            return
        if not oc.get('ai.netmind.compound') or original.get('unsigned', {}).get('redacted_because') or target in REDACTED:
            return
        om = USER in oc.get('m.mentions', {}).get('user_ids', [])
        if group and not om:
            return
        if (await authorize(room, original, members, om)).get('allow') is not True:
            return
        compound = oc['ai.netmind.compound']; media = compound.get('media_url', '')
        if not media.startswith('mxc://'):
            return
        server, mid = media[6:].split('/', 1)
        b = await http(HS + '/_matrix/client/v1/media/download/' + esc(server) + '/' + esc(mid), token=C['access_token'], raw=True)
        suffix = Path(compound.get('file_name', 'media')).suffix[:10]
        (ROOT / 'media').mkdir(exist_ok=True)
        fd, path = tempfile.mkstemp(suffix=suffix, dir=ROOT / 'media'); os.write(fd, b); os.close(fd); attachment = path
        event = original; eid = target; c = dict(oc); c['body'] = compound.get('text', ''); event['content'] = c
    elif c.get('ai.netmind.visibility', {}).get('status') == 'hidden':
        return
    if DB.execute('select 1 from replies where id=?', (eid,)).fetchone() or eid in TASKS or eid in REDACTED:
        if attachment:
            Path(attachment).unlink(missing_ok=True)
        return
    context = {'group': group, 'late': late}
    if re.search(r'https://[^\s]+/update-guide\.md', c.get('body', '')):
        # Future code-changing updates require operator verification; never auto-ACK an unloaded version.
        await send(room, 'm.room.message', {'msgtype': 'm.text', 'body': 'Runtime updates require maintenance in the Manyfold workspace. Please ask the owner to apply the Narra Runtime Update skill there; no update has been acknowledged.'}, 'update-' + hashlib.sha256(eid.encode()).hexdigest())
        return
    voice = c.get('ai.netmind.rtc.agent.turn.started.v2')
    if voice:
        sid = voice.get('rtc_session_id'); tid = voice.get('turn_id'); v = VOICE.get(room, {})
        if v.get('session') != sid or v.get('sender') != event['sender'] or (sid, tid) in CANCELLED or (sid, tid) in TURNS:
            return
        TURNS.add((sid, tid)); v['turn'] = tid
        await send(room, 'ai.netmind.rtc.agent.ack.v2', {'ack_of': 'turn.started', 'rtc_session_id': sid, 'turn_id': tid, 'platform': 'generic', 'call_mode': 'realtime', 'supports_long_task_delivery': False}, 'ack-' + hashlib.sha256(eid.encode()).hexdigest())
        task = _spawn_reply(room, event, context, attachment, [eid])
        TASKS[(sid, tid)] = task
        return

    user_text = clean(c.get('body', ''))
    parent_snippet = await fetch_reply_context(room, c)
    effective_text = f'[Replied message: {parent_snippet}]\n{user_text}' if parent_snippet else user_text

    if group:
        is_lang_cmd = any(rx.match(re.sub(r'[\s!！。.~]+$', '', user_text.strip())) for rx, _ in COMMANDS)
        is_mute_cmd = bool(MUTE_CMD.match(re.sub(r'[\s!！。.~]+$', '', user_text.strip())) or UNMUTE_CMD.match(re.sub(r'[\s!！。.~]+$', '', user_text.strip())))
        # Multi-@ silence: stay silent when multiple targets are mentioned and the query has zero deal/retailer intent.
        if multi_target(c, c.get('body', '')) and not is_mute_cmd:
            if not await BRAIN.has_deal_intent(effective_text):
                if attachment:
                    Path(attachment).unlink(missing_ok=True)
                return
        # Group mute/snooze: suppress unsolicited/non-deal chatter while paused.
        if room_state(room)['paused'] and not is_lang_cmd and not is_mute_cmd:
            if not await BRAIN.has_deal_intent(effective_text):
                if attachment:
                    Path(attachment).unlink(missing_ok=True)
                return
        if is_lang_cmd or is_mute_cmd:
            await flush_burst((room, sender))
            _spawn_reply(room, event, context, attachment, [eid], parent_snippet)
            return

    if attachment or late:
        await flush_burst((room, sender))
        _spawn_reply(room, event, context, attachment, [eid], parent_snippet)
        return
    await queue_or_dispatch(room, sender, event, context, user_text, parent_snippet)


async def main():
    assert STATE.get('runtime_provider') == 'generic' and STATE.get('transport') == 'direct_matrix'
    contract = await http(STATE['runtime_url'], raw=True)
    (ROOT / 'runtime-contract.md').write_bytes(contract)
    who = await matrix('/account/whoami')
    assert who['user_id'] == USER and who['device_id'] == 'NARRA_agent-b4b94dd2'
    logging.info('Verified Matrix user and device; generic direct_matrix release %s', STATE['runtime_release'])
    row = DB.execute("select value from kv where key='since'").fetchone(); since = row[0] if row else None
    # Retry authorized unfinished inputs after a restart before advancing sync.
    for eid, room, event in DB.execute('select id,room,event from pending').fetchall():
        try:
            ev = json.loads(event)
            if ev.get('unsigned', {}).get('redacted_because') or eid in REDACTED:
                DB.execute('delete from pending where id=?', (eid,)); DB.commit()
                continue
            members = list((await matrix('/rooms/' + esc(room) + '/joined_members')).get('joined', {}))
            await handle(room, ev, members)
        except Exception as e:
            logging.warning('Recovery deferred: %s', type(e).__name__)
    await deliver_pending()
    asyncio.create_task(notify_loop())
    while True:
        try:
            query = {'timeout': 25000}
            if since:
                query['since'] = since
            batch = await matrix('/sync?' + urlencode(query))
            for room in batch.get('rooms', {}).get('invite', {}):
                await matrix('/join/' + esc(room), {}, 'POST')
                logging.info('Joined invited room')
            for room, details in batch.get('rooms', {}).get('join', {}).items():
                members = list((await matrix('/rooms/' + esc(room) + '/joined_members')).get('joined', {}))
                events = details.get('timeline', {}).get('events', [])
                for event in events:
                    if event.get('type') == 'm.room.redaction':
                        await handle_redaction(room, event)
                    else:
                        track_latest_event(room, event)
                for event in events:
                    try:
                        await handle(room, event, members)
                    except Exception as e:
                        logging.warning('Event handling failed: %s', type(e).__name__)
            since = batch['next_batch']; DB.execute("insert or replace into kv values('since',?)", (since,)); DB.commit()
            (ROOT / 'ready.json').write_text(json.dumps({'user_id': USER, 'device_id': who['device_id'], 'synced_at': time.time(), 'transport': 'direct_matrix'}))
            logging.info('Matrix sync healthy')
        except Exception as e:
            logging.warning('Sync retry: %s', type(e).__name__)
            await asyncio.sleep(5)


async def notify_loop():
    while True:
        try:
            logging.info('Notify tick %s', json.dumps(await NOTIFIER.tick()))
        except Exception as e:
            logging.warning('Notify tick failed: %s', type(e).__name__)
        await asyncio.sleep(NOTIFY_EVERY)


if __name__ == '__main__':
    os.umask(0o077)
    (ROOT / 'media').mkdir(exist_ok=True)
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    asyncio.run(main())
