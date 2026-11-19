"""Adversarial intent QA for Quidpaw's Brain.respond. GETs only against the live API.
Run: python3 -I adv_qa.py [--dry] [--cap 40] [--only N,N]
--dry: the model raises (planner falls back to rules); shows which cases would reach the model.
"""
import argparse, asyncio, json, subprocess, sys, time
from urllib.request import Request, urlopen
sys.path.insert(0, str(__import__('pathlib').Path(__file__).resolve().parents[1]))
from quidpaw import Brain

API = 'https://uk-vouchers.netmind-ai.workers.dev'
AGENT = 'agt_agq6ji22sn6jpd5nnicl5ld7rm'
ap = argparse.ArgumentParser(); ap.add_argument('--dry', action='store_true'); ap.add_argument('--cap', type=int, default=40)
ap.add_argument('--only'); ap.add_argument('--json')
A = ap.parse_args()

def get(url):
    assert url.startswith(API + '/api/') or url.startswith(API + '/export'), url
    with urlopen(Request(url, headers={'User-Agent': 'curl/8.0'}), timeout=30) as f: return json.loads(f.read())
async def http(url): return await asyncio.to_thread(get, url)

CALLS = []
async def model(prompt, attachment=None):
    CALLS.append(1)
    if A.dry or len(CALLS) > A.cap: raise RuntimeError('model disabled')
    r = await asyncio.to_thread(subprocess.run, ['mf', '--profile', 'manyfold', 'agent', 'send', AGENT, '-', '--json'],
                                input=prompt.encode(), capture_output=True, timeout=90)
    if r.returncode: raise RuntimeError('mf exit %s' % r.returncode)
    return json.loads(r.stdout)['text']

OFFERS = [{'id': 'a1', 'retailer': 'Boots', 'title': '15% off skincare', 'expires_on': '2026-11-30'},
          {'id': 'a2', 'retailer': 'Boots', 'title': '£5 off £40', 'expires_on': None},
          {'id': 'a3', 'retailer': 'Superdrug', 'title': '3 for 2 fragrance', 'expires_on': '2026-11-25'}]
LAST = {'last': {'offers': OFFERS, 'query': {'retailer': 'boots'}, 'page': 1},
        'history': [{'who': 'user', 'text': 'boots codes'}, {'who': 'bot', 'text': '1. Boots｜15% off skincare'}]}
PEND = {'pending': {'kind': 'eligibility', 'value': 'student', 'label': 'student'},
        'history': [{'who': 'user', 'text': "I'm a student"}, {'who': 'bot', 'text': 'Want a DM when new student offers appear? Say "yes".'}]}
PEND_ZH = {'pending': {'kind': 'eligibility', 'value': 'student', 'label': '學生'},
           'history': [{'who': 'user', 'text': '我是學生'}, {'who': 'bot', 'text': '有新的學生優惠要通知你嗎？回「好」就行。'}]}
N = {}
# (message, ctx, expected kind or set of kinds, extra checks)
# extra: r=retailer (substring of query/demand retailer, lower), c=category, e=eligibility, not_c, not_r, not_sort, sub=sub value, unsub=value ('*'=all)
CASES = [
    # --- searches with a shop / group, incl. trap words ---
    ('any promo codes for boots?', N, 'search', dict(r='boots')),
    ('got any student deals', N, 'search', dict(e='student')),
    ('let me know any discount codes i can use in boots', N, 'search', dict(r='boots')),
    ('let me know if boots has any codes', N, 'search', dict(r='boots')),
    ("tell me if there's a student discount at asos", N, 'search', dict(r='asos')),
    ('save money at boots', N, 'search', dict(r='boots')),
    ('more deals on trainers?', N, 'search', dict(not_c='travel')),
    ('is there a new customer code for deliveroo', N, 'search', dict(r='deliveroo', e='new-customer')),
    ('stop paying full price at asos', N, 'search', dict(r='asos')),
    ("any codes that haven't expired", N, {'browse', 'search'}, {}),
    ('football boots at jd sports', N, 'search', dict(r='jd sports')),
    ('ugg boots discount', N, 'search', dict(not_r='boots')),
    ('gymshark code', N, 'search', dict(r='gymshark')),
    ('superdry discount', N, 'search', dict(r='superdry')),
    ('h&m student discount', N, 'search', dict(r='h&m')),
    ('tk maxx deals pls', N, 'search', dict(r='tk maxx')),
    ('laptop deals', N, 'search', {}),
    ('perfume discounts', N, 'search', {}),
    ('cheap flights to iceland', N, 'search', dict(not_r='iceland')),
    ('pets at home codes', N, 'search', dict(r='pets at home', not_c='home')),
    ('hotel chocolat voucher', N, 'search', dict(r='hotel chocolat', not_c='travel')),
    ('carpets on sale anywhere?', N, 'search', dict(not_c='pets')),
    ('recommend something good at boots', N, 'search', dict(r='boots', not_sort='ending')),
    ('weekend deals for students', N, 'search', dict(e='student', not_sort='ending')),
    ('nhs staff discounts at asos', N, 'search', dict(r='asos')),
    ('any blue light card discounts', N, 'search', dict(e='nhs-blue-light')),
    ('deals for nurses?', N, 'search', dict(e='nhs-blue-light')),
    ('dog food codes', N, 'search', dict(c='pets')),
    ('subscribe and save amazon codes', N, 'search', dict(r='amazon')),
    ('let me know if there are any deals on trainers rn', N, 'search', dict(not_c='travel')),
    ('Black Friday deals at Boots', N, 'search', dict(r='boots')),
    ('apple pay deals?', N, {'browse', 'search', 'text'}, dict(not_r='apple')),
    ('any codes for boots 💄💄', N, 'search', dict(r='boots')),
    ('boots codez plz', N, 'search', dict(r='boots')),
    ('wats gud at asos rn', N, 'search', dict(r='asos')),
    # --- identity ---
    ("i'm a student, any asos codes?", N, 'identity', dict(r='asos')),
    ("I'm no longer a student", N, 'identity_clear', {}),
    ("I'm an NHS nurse", N, 'identity', {}),
    ('im a student lol', N, 'identity', {}),
    # --- alerts / subscriptions ---
    ('notify me when boots has a new code', N, 'subscribe', dict(sub='boots')),
    ('alert me about gymshark', N, 'subscribe', dict(sub='gymshark')),
    ('ping me if superdrug drops a code', N, 'subscribe', dict(sub='superdrug')),
    ('let me know when asos has a black friday code', N, 'subscribe', dict(sub='asos')),
    ('notify me about boots black friday deals', N, 'subscribe', dict(sub='boots')),
    ('remind me about black friday', N, 'sales_on', {}),
    ('turn off weekly digest', N, 'weekly_off', {}),
    ('unsubscribe from the weekly digest', N, 'weekly_off', {}),
    ('stop sale alerts', N, 'sales_off', {}),
    ('turn off sale alerts', N, 'sales_off', {}),
    ('cancel my alerts', N, 'unsubscribe', dict(unsub='*')),
    ('stop messaging me', N, 'unsubscribe', dict(unsub='*')),
    ('turn off notifications', N, 'unsubscribe', dict(unsub='*')),
    ('stop alerts for boots', N, 'unsubscribe', dict(unsub='boots')),
    ('what alerts do i have?', N, 'mysubs', {}),
    ('what am i subscribed to', N, 'mysubs', {}),
    ('show me the weekly picks', N, {'browse'}, {}),
    ('weekly digest on pls', N, 'weekly_on', {}),
    ('daily picks on', N, 'daily_on', {}),
    ('stop the daily picks', N, 'daily_off', {}),
    ('開啟每日精選', N, 'daily_on', {}),
    ('每日精選不要了', N, 'daily_off', {}),
    ('今天的精選', N, {'browse'}, {}),
    # --- shopper tips ---
    ('I used SAVE15 at boots, 15% off', N, 'tip', {}),
    ('BOOTS10 works at boots', N, 'tip', {}),
    ('我在 ASOS 用了 ASOS20 有效', N, 'tip', {}),
    ('分享一個 superdrug 的碼 SD10', N, 'tip', {}),
    ('found a code: HELLO10', N, {'tip', 'tipask'}, {}),
    ('does SAVE15 work at boots?', N, {'search'}, {}),
    # --- chat / bot questions / off-topic ---
    ('cancel culture lol', N, 'text', {}),
    ('are you kidding me 😂', N, 'text', {}),
    ('do you remember me?', N, 'text', {}),
    ('how do you notify me?', N, 'text', {}),
    ('remind me what you can do', N, 'text', {}),
    ('who made you?', N, 'text', {}),
    ('are you a bot?', N, 'text', {}),
    ('ideal', N, 'text', {}),
    ('hiya', N, 'text', {}),
    ('cheers mate', N, 'text', {}),
    ("what's the weather in london", N, 'text', {}),
    ('is this legit or a scam', N, 'text', {}),
    # --- context: a list on screen ---
    ('more please', LAST, 'more', {}),
    ('show me more', LAST, 'more', {}),
    ('any more?', LAST, 'more', {}),
    ("number 2 didn't work", LAST, 'report', dict(ids=['a2'])),
    ("the second one doesn't work", LAST, 'report', dict(ids=['a2'])),
    ('the superdrug one is invalid', LAST, 'report', dict(ids=['a3'])),
    ('code says not valid', LAST, {'report', 'which'}, {}),
    ('said expired at checkout for #1', LAST, 'report', dict(ids=['a1'])),
    ("what if it doesn't work?", LAST, 'text', {}),
    ('save number 2', LAST, 'subscribe', dict(sub='a2')),
    ('save 2', LAST, 'subscribe', dict(sub='a2')),
    ('remind me which code was for skincare', LAST, {'text', 'search'}, {}),
    ('有哪些快失效的碼', LAST, {'browse', 'search'}, dict(sort='ending')),
    ('第二個不行', LAST, 'report', dict(ids=['a2'])),
    ('第2個用唔到', LAST, 'report', dict(ids=['a2'])),
    ('第三個冇效', LAST, 'report', dict(ids=['a3'])),
    # --- context: a pending alert question ---
    ('yes please', PEND, 'subscribe', dict(sub='student')),
    ('sure 👍', PEND, 'subscribe', dict(sub='student')),
    ('yes', PEND, 'subscribe', dict(sub='student')),
    ('no thanks', PEND, 'text', {}),
    ('好呀', PEND_ZH, 'subscribe', dict(sub='student')),
    ('可以啊', PEND_ZH, 'subscribe', dict(sub='student')),
    # --- Chinese / Cantonese / mixed ---
    ('有沒有便宜的', N, 'browse', {}),
    ('有冇boots嘅code', N, 'search', dict(r='boots')),
    ('學生有冇優惠', N, 'search', dict(e='student')),
    ('宜家有優惠嗎', N, 'search', dict(r='ikea')),
    ('瑪莎百貨有折扣嗎', N, 'search', dict(r='marks')),
    ('亞馬遜有碼嗎', N, 'search', dict(r='amazon')),
    ('運動用品有折扣嗎', N, 'search', dict(c='sports')),
    ('鞋子有折扣嗎', N, 'search', {}),
    ('我要精選優惠', N, {'browse'}, {}),
    ('不要錯過 Boots 的優惠，有新的通知我', N, 'subscribe', dict(sub='boots')),
    ('我不想再錯過，Boots 有新碼就提醒我', N, 'subscribe', dict(sub='boots')),
    ('不想收週報了', N, 'weekly_off', {}),
    ('訂閱制的優惠有嗎 像 hellofresh', N, 'search', dict(r='hellofresh')),
    ('提醒我一下怎麼用', N, 'text', {}),
    ('你有什麼功能', N, 'text', {}),
    ('忘記密碼怎麼辦', N, 'text', {}),
    ('唔該', N, 'text', {}),
    ('多謝晒', N, 'text', {}),
    ('Boots有咩code呀', N, 'search', dict(r='boots')),
    ('我是學生，有 asos 的嗎', N, 'identity', dict(r='asos')),
    ('我已經畢業了，不是學生', N, 'identity_clear', {}),
    ('取消 Boots 的通知', N, 'unsubscribe', dict(unsub='boots')),
    ('我的通知有哪些', N, 'mysubs', {}),
    ('停止週報', N, 'weekly_off', {}),
    ('黑五 Boots 有什麼', N, 'search', dict(r='boots')),
    ('黑五有優惠記得通知我', N, 'sales_on', {}),
    ('asos 有冇 student discount', N, 'search', dict(r='asos', e='student')),
    ('等 boots 有新嘅 code 就話我知', N, 'subscribe', dict(sub='boots')),
    ('uber eats 新客碼', N, 'search', dict(r='uber eats', e='new-customer')),
    ('你係咪機械人', N, 'text', {}),
    ('有冇平嘢買', N, 'browse', {}),
    # --- Simplified Chinese (zh-Hans) ---
    ('开启每日精选', N, 'daily_on', {}),
    ('每日精选不要了', N, 'daily_off', {}),
    ('我在 ASOS 试了这个码 ASOS20 有效', N, 'tip', {}),
    ('第2个用不了', LAST, 'report', dict(ids=['a2'])),
    ('我是学生，有 asos 的吗', N, 'identity', dict(r='asos')),
    ('取消 Boots 的通知', N, 'unsubscribe', dict(unsub='boots')),
    ('关闭大促提醒', N, 'sales_off', {}),
    ('运动用品有折扣吗', N, 'search', dict(c='sports')),
]


def classify(out):
    acts = out.get('actions') or []
    for a in acts:
        if 'set_identity' in a: return ('identity' if a['set_identity'] else 'identity_clear'), a
    for a in acts:
        if 'report' in a: return 'report', a
        if 'tip' in a: return 'tip', a
        if 'unsubscribe' in a:
            v = a['unsubscribe']
            return {'weekly': 'weekly_off', 'daily': 'daily_off', 'sales': 'sales_off'}.get(v, 'unsubscribe'), a
        if 'subscribe' in a:
            k = a['subscribe']['kind']
            return {'weekly': 'weekly_on', 'daily': 'daily_on', 'sales': 'sales_on'}.get(k, 'subscribe'), a
    t = out.get('text', '')
    if t.startswith(('Which shop or category', '要通知哪家店')): return 'subask', None
    if t.startswith(('Which one failed', '是哪一個不能用', '是哪一个不能用')): return 'which', None
    if t.startswith(('Thanks! Which shop', 'Thanks! What is the', '謝謝分享！這是哪家店', '谢谢分享！这是哪家店')) or '的碼是哪幾個字' in t or '的码是哪几个字' in t: return 'tipask', None
    if t.startswith(("I haven't shown you a list", '我這裡還沒有給你看過清單', '我这里还没有给你看过清单')): return 'nolist', None
    if t.startswith(('Your alerts', '你的通知', 'No alerts yet', '你還沒有訂閱', '你还没有订阅')): return 'mysubs', None
    demand = next((a['demand'] for a in acts if 'demand' in a), None)
    if out.get('page', 1) > 1: return 'more', None
    if demand: return 'search', demand
    if out.get('offers'):
        q = out.get('query') or {}
        return ('search' if any(q.get(k) for k in ('retailer', 'category', 'eligibility', 'q')) else 'browse'), q
    return 'text', None


def check(kind, info, out, exp, extra):
    probs = []
    kinds = exp if isinstance(exp, set) else {exp}
    if kind not in kinds: probs.append(f'kind {kind}')
    q = dict(out.get('query') or {})
    if isinstance(info, dict) and kind == 'search': q.update(info)
    lowr = (q.get('retailer') or '').lower()
    if kind in kinds:
        if 'r' in extra and extra['r'] not in lowr: probs.append(f"retailer={q.get('retailer')!r}")
        if 'c' in extra and q.get('category') != extra['c']: probs.append(f"category={q.get('category')!r}")
        if 'e' in extra and q.get('eligibility') != extra['e']: probs.append(f"eligibility={q.get('eligibility')!r}")
        if 'sort' in extra and q.get('sort') != extra['sort']: probs.append(f"sort={q.get('sort')!r}")
        if 'sub' in extra:
            v = str((info or {}).get('subscribe', {}).get('value', '')).lower()
            if extra['sub'] not in v: probs.append(f'sub value={v!r}')
        if 'unsub' in extra:
            v = (info or {}).get('unsubscribe')
            if (extra['unsub'] == '*' and v) or (extra['unsub'] != '*' and extra['unsub'] not in str(v).lower()): probs.append(f'unsub value={v!r}')
        if 'ids' in extra and (info or {}).get('report') != extra['ids']: probs.append(f"report ids={(info or {}).get('report')}")
    if 'not_c' in extra and q.get('category') == extra['not_c']: probs.append(f"category={q.get('category')!r}")
    if 'not_r' in extra and extra['not_r'] in lowr: probs.append(f"retailer={q.get('retailer')!r}")
    if 'not_sort' in extra and q.get('sort') == extra['not_sort']: probs.append(f"sort={q.get('sort')!r}")
    return probs


async def main():
    b = Brain(http, model, API)
    only = {int(x) for x in A.only.split(',')} if A.only else None
    rows, fails = [], 0
    for i, (text, ctx, exp, extra) in enumerate(CASES):
        if only and i not in only: continue
        n = len(CALLS); t0 = time.time()
        try:
            out = await b.respond(text, json.loads(json.dumps(ctx)))
            kind, info = classify(out)
            probs = check(kind, info, out, exp, extra)
        except Exception as e:
            out, kind, probs = {'text': f'!! {type(e).__name__}: {e}'}, 'crash', ['crash']
        used = len(CALLS) > n
        fails += bool(probs)
        first = (out.get('text') or '').split('\n')[0][:70]
        expd = '/'.join(sorted(exp)) if isinstance(exp, set) else exp
        tag = ('M?' if A.dry else 'M') if used else '-'
        rows.append(dict(i=i, text=text, exp=expd, got=kind, probs=probs, model=used, first=first,
                         query=out.get('query'), actions=out.get('actions')))
        print(f"{i:3} {'FAIL' if probs else 'ok  '} {tag:2} {text[:42]:42} exp={expd:14} got={kind:14} {'; '.join(probs)}\n          | {first}", flush=True)
    total = len(rows)
    print(f'\n{total - fails}/{total} passed ({100 * (total - fails) / total:.0f}%), model calls attempted {len(CALLS)}')
    if A.json:
        json.dump(rows, open(A.json, 'w'), ensure_ascii=False, indent=1, default=str)

asyncio.run(main())
