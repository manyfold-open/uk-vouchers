"""Follow-ups after a search that found nothing, and chat replies that end in a colon.
The planner is scripted (it returns the bad plans seen in QA), so these checks are about the program, not the model.
GETs only against the live API. Run: python3 -I narra/qa/qa_followups.py; exits 1 when any check fails.
"""
import asyncio, json, sys
from pathlib import Path
from urllib.request import Request, urlopen
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from quidpaw import Brain
API='https://uk-vouchers.netmind-ai.workers.dev'
def get(u):
    assert u.startswith(API+'/api/')
    with urlopen(Request(u, headers={'User-Agent':'curl/8.0'}), timeout=30) as f: return json.loads(f.read())
async def http(u): return await asyncio.to_thread(get, u)
PLANS=[]; PROMPTS=[]
async def model(prompt, attachment=None):
    PROMPTS.append(prompt); return json.dumps(PLANS.pop(0))
b=Brain(http, model, API)
fails=0
def check(name, cond, detail):
    global fails; fails += not cond; print('ok  ' if cond else 'FAIL', name, '|', detail)
async def main():
    # TC07: no ASOS offers -> fallback list; planner drops the shop on "那學生的呢"
    async def empty_shop_http(u):
        if '/api/vouchers?' in u and 'retailer=asos' in u:
            return {'vouchers': [], 'total': 0}
        return await http(u)
    b_empty = Brain(empty_shop_http, model, API)
    r1 = await b_empty.respond('ASOS 有什麼碼', {'history': []})
    last = {'offers': r1['offers'], 'query': r1['query'], 'page': 1}
    check('asked kept', r1['query'].get('_asked') == {'retailer': 'asos'}, r1['query'])
    PLANS.append({'intent': 'search', 'eligibility': 'student', 'line': '學生優惠：'})
    r2 = await b_empty.respond('那學生的呢', {'history': [{'who':'user','text':'ASOS 有什麼碼'},{'who':'bot','text':r1['text'][:300]}], 'last': last})
    check('follow-up keeps ASOS', 'ASOS' in r2['text'].split('\n')[0], r2['text'].split('\n')[0])
    check('planner sees last_request', '"last_request": {"retailer": "asos"}' in PROMPTS[-1], 'prompt state')
    # "notify me" after a no-result search subscribes to the asked shop, not the fallback category
    PLANS.append({'intent': 'subscribe'})
    r3 = await b_empty.respond('有的話通知我', {'history': [], 'last': last})
    check('subscribe to asked shop', any(a.get('subscribe', {}).get('value') == 'asos' for a in r3['actions']), r3['actions'])
    # more after no-result still pages the alternatives
    r4 = await b_empty.respond('更多', {'history': [], 'last': last})
    check('more still works', bool(r4['offers']) or '沒有更多' in r4['text'], r4['text'].split('\n')[0])
    # TC11: chat line ending in a colon
    PLANS.append({'intent': 'chat', 'category': 'travel', 'line': '我不能訂機票，但可以找旅遊優惠碼：'})
    r5 = await b.respond('幫我訂一張下週去巴黎的機票', {'history': []})
    check('colon + category -> shows travel list', bool(r5['offers']) and r5['text'].startswith('我不能訂機票'), r5['text'][:60].replace('\n',' / '))
    PLANS.append({'intent': 'chat', 'line': "I can't book flights, but here are travel codes:"})
    r6 = await b.respond('book me a flight to Paris', {'history': []})
    check('colon, no filter -> complete sentence', not r6['text'].rstrip().endswith((':', '：')) and not r6['offers'], r6['text'])
    PLANS.append({'intent': 'chat', 'line': '我只找英國折扣喔 🐾'})
    r7 = await b.respond('今天天氣如何', {'history': []})
    check('normal chat line unchanged', r7['text'] == '我只找英國折扣喔 🐾', r7['text'])
    # regression: follow-up after a list that had results keeps using the on-screen query
    r8 = await b.respond('美妝今天有什麼', {'history': []})
    PLANS.append({'intent': 'search', 'eligibility': 'student'})
    r9 = await b.respond('那學生的呢', {'history': [{'who':'user','text':'美妝今天有什麼'}], 'last': {'offers': r8['offers'], 'query': r8['query'], 'page': 1}})
    check('beauty follow-up keeps beauty', r9['query'].get('category') == 'beauty' and r9['query'].get('eligibility') == 'student', r9['query'])
    print('fails', fails); sys.exit(1 if fails else 0)
asyncio.run(main())
