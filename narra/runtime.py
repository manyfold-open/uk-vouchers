#!/usr/bin/env python3
"""Quidpaw: authorized Direct Matrix transport, group etiquette, and API-grounded voucher replies (see quidpaw.py)."""
import asyncio, hashlib, json, logging, os, re, sqlite3, tempfile, time
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import quote, urlencode
from urllib.error import HTTPError

ROOT=Path(__file__).resolve().parent
import sys; sys.path.insert(0,str(ROOT))
from quidpaw import Brain, group_intro
from notify import Notifier
WORK=ROOT.parent
PRIVATE=WORK/'.narra/agent-b4b94dd2'
API='https://api.netmind.chat'
VOUCHERS=os.getenv('UK_VOUCHERS_API','https://uk-vouchers.netmind-ai.workers.dev')
STATE=json.loads((PRIVATE/'runtime-state.json').read_text())
C=json.loads((PRIVATE/'matrix-credential.json').read_text())
TOKEN=(PRIVATE/'agent-runtime-token').read_text().strip()
USER=C['matrix_user_id']; HS=C['homeserver_url']
AGENT='agt_agq6ji22sn6jpd5nnicl5ld7rm'
RULES=(WORK/'CLAUDE.md').read_text()
BOOTSTRAP=(PRIVATE/'AGENTS.md').read_text()
DB=sqlite3.connect(ROOT/'state.sqlite3')
DB.execute('create table if not exists kv (key text primary key, value text)')
DB.execute('create table if not exists replies (id text primary key, room text, payload text, sent integer default 0)')
DB.execute('create table if not exists pending (id text primary key, room text, event text)')
DB.execute('create table if not exists own (id text primary key, room text, ts real)')
DB.execute('create table if not exists rooms (room text primary key, lang text, paused integer default 0, last_auto real default 0, welcomed integer default 0)')
# What each reply showed, so "更多", "第 2 個不能用" and a 👎 on that message know which offers they mean.
DB.execute('create table if not exists shown (src text primary key, bot text, room text, user text, offers text, query text, page integer, total integer, ts real)')
DB.execute('create table if not exists pending_sub (room text, user text, sub text, ts real, primary key (room, user))')
DB.commit()
TASKS={}; VOICE={}; CANCELLED=set(); TURNS=set(); LOCKS={}
STALE_MS=30*60*1000      # older questions would only confuse the room
NAME=re.compile(r'@?quidpaw(?![\w])',re.I)  # stripped from the text; a mention itself must be m.mentions or a reply (Narra's rule)
NOTIFY_EVERY=10*60

def request(url,data=None,token=None,method=None,raw=False):
    headers={'User-Agent':'curl/8.0','Content-Type':'application/json'}
    if token: headers['Authorization']='Bearer '+token
    r=Request(url,data=None if data is None else json.dumps(data).encode(),headers=headers,method=method)
    with urlopen(r,timeout=45) as f:
        b=f.read(25*1024*1024+1)
        if len(b)>25*1024*1024: raise ValueError('response too large')
        return b if raw else json.loads(b)
async def http(*a,**kw): return await asyncio.to_thread(request,*a,**kw)
async def matrix(path,data=None,method=None): return await http(HS+'/_matrix/client/v3'+path,data,C['access_token'],method)
def esc(s): return quote(s,safe='')
async def send(room,typ,content,txn):
    r=await matrix('/rooms/'+esc(room)+'/send/'+esc(typ)+'/'+esc(txn),content,'PUT')
    if typ=='m.room.message' and r.get('event_id'):
        DB.execute('insert or ignore into own values(?,?,?)',(r['event_id'],room,time.time()))
        DB.execute('delete from own where room=? and id not in (select id from own where room=? order by ts desc limit 30)',(room,room));DB.commit()
    return r
def room_state(room):
    row=DB.execute('select lang,welcomed from rooms where room=?',(room,)).fetchone()
    if not row: DB.execute('insert or ignore into rooms(room) values(?)',(room,));DB.commit();row=(None,0)
    return {'lang':row[0],'welcomed':bool(row[1])}
def set_room(room,**kw):
    room_state(room)
    for k,v in kw.items(): DB.execute(f'update rooms set {k}=? where room=?',(v,room))
    DB.commit()
async def history(room,before_eid,limit=8):
    # Recent text turns for follow-ups ("那學生的呢"). Untrusted: the planner treats it as data.
    try: chunk=(await matrix('/rooms/'+esc(room)+'/messages?'+urlencode({'dir':'b','limit':20}))).get('chunk',[])
    except Exception: return []
    turns=[]
    for e in chunk:
        if e.get('event_id')==before_eid or e.get('type')!='m.room.message': continue
        body=e.get('content',{}).get('body')
        if not isinstance(body,str) or not body.strip(): continue
        turns.append({'who':'bot' if e.get('sender')==USER else 'user','text':clean(body)[:300]})
        if len(turns)>=limit: break
    return list(reversed(turns))
def clean(body):
    lines=[l for l in body.split('\n') if not l.startswith('> ')]  # drop quoted reply fallback
    return NAME.sub(' ',' '.join(lines).replace(USER,' ')).strip()[:1000]
async def cli(*args):
    p=await asyncio.create_subprocess_exec('npx','--yes','@narra-im/narra-cli@latest',*args,'--endpoint',API,'--token-file',str(PRIVATE/'agent-runtime-token'),cwd=WORK,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL)
    try: out,_=await asyncio.wait_for(p.communicate(),90)
    except BaseException:
        p.kill(); await p.wait(); raise
    if p.returncode: raise RuntimeError('Narra CLI failed')
    return json.loads(out)
async def model(prompt,attachment=None):
    args=['mf','agent','send',AGENT,'-','--json']
    if attachment: args+=['--file',str(attachment)]
    p=await asyncio.create_subprocess_exec(*args,cwd=WORK,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
    try: out,err=await asyncio.wait_for(p.communicate(prompt.encode()),60)
    except BaseException:
        p.terminate(); await p.wait(); raise
    if p.returncode:
        logging.warning('mf agent send exit %s: %s',p.returncode,re.sub(r'[A-Za-z0-9_-]{24,}','***',err.decode(errors='replace'))[-300:])
        raise RuntimeError('Agent inference unavailable')
    doc=json.loads(out)
    if doc.get('error'): raise RuntimeError('Agent inference error')
    return doc['text']

BRAIN=Brain(http,model,VOUCHERS,logging)
def upload_request(data,filename):
    r=Request(HS+'/_matrix/media/v3/upload?'+urlencode({'filename':filename}),data=data,method='POST',
              headers={'User-Agent':'curl/8.0','Content-Type':'image/png','Authorization':'Bearer '+C['access_token']})
    with urlopen(r,timeout=45) as f: return json.loads(f.read())
async def card_image(card):
    # Offer card PNG by cards/card.mjs (resvg + Noto Sans TC); None when anything goes wrong, so text still goes out.
    fd,path=tempfile.mkstemp(suffix='.png',dir=ROOT/'media');os.close(fd)
    try:
        p=await asyncio.create_subprocess_exec('node',str(ROOT/'cards'/'card.mjs'),path,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
        out,err=await asyncio.wait_for(p.communicate(json.dumps(card,ensure_ascii=False).encode()),25)
        if p.returncode: logging.warning('Card failed: %s',err.decode(errors='replace')[-200:]); return None
        info=json.loads(out); data=Path(path).read_bytes()
        mxc=(await asyncio.to_thread(upload_request,data,'quidpaw-offers.png')).get('content_uri')
        if not mxc: return None
        return {'msgtype':'m.image','body':'quidpaw-offers.png','url':mxc,'info':{'mimetype':'image/png','w':info['width'],'h':info['height'],'size':len(data)}}
    except Exception as e:
        logging.warning('Card skipped: %s',type(e).__name__); return None
    finally: Path(path).unlink(missing_ok=True)
async def send_text(room,body,user=None,offers=None):
    r=await send(room,'m.room.message',{'msgtype':'m.text','body':body},'push-'+hashlib.sha256((room+body+str(time.time())).encode()).hexdigest())
    if offers:  # so 「收藏第 1 個」 or 「第 2 個不能用」 after a push points at the pushed offers
        DB.execute('insert or replace into shown values(?,?,?,?,?,?,?,?,?)',('push-'+(r.get('event_id') or str(time.time())),r.get('event_id'),room,user,json.dumps(offers),None,1,len(offers),time.time()));DB.commit()
NOTIFIER=Notifier(DB,http,VOUCHERS,send_text,logging)
def called(room,content):
    # Narra counts only m.mentions and replies to the agent's own messages, never a name typed in the text.
    ref=content.get('m.relates_to',{}).get('m.in_reply_to',{}).get('event_id')
    return USER in content.get('m.mentions',{}).get('user_ids',[]) or bool(ref and DB.execute('select 1 from own where id=?',(ref,)).fetchone())
def reporter(user): return 'narra:'+hashlib.sha256(user.encode()).hexdigest()[:16]

async def authorize(room,event,members,mentioned):
    try: return await http(API+'/api/agent-runtime/matrix/authorize-event',{'roomId':room,'senderMatrixUserId':event['sender'],'memberMatrixUserIds':members,'mentioned':mentioned},TOKEN)
    except Exception: return {}
async def deliver_pending():
    for eid,room,payload in DB.execute('select id,room,payload from replies where sent=0').fetchall():
        pending=DB.execute('select event from pending where id=?',(eid,)).fetchone()
        if not pending:continue
        original=json.loads(pending[0])
        members=list((await matrix('/rooms/'+esc(room)+'/joined_members')).get('joined',{}))
        mentioned=called(room,original.get('content',{}))
        if (await authorize(room,original,members,mentioned)).get('allow') is not True:
            DB.execute('update replies set sent=2 where id=?',(eid,));DB.commit()  # denied now: do not retry forever
            continue
        r=await send(room,'m.room.message',json.loads(payload),hashlib.sha256(eid.encode()).hexdigest())
        DB.execute('update replies set sent=1 where id=?',(eid,))
        DB.execute('update shown set bot=? where src=?',(r.get('event_id'),eid));DB.commit()
COMMANDS=[(re.compile(r'^(說英文|講英文|speak english|english)$',re.I),'en'),(re.compile(r'^(說中文|講中文|speak chinese|中文)$',re.I),'zh')]
def command(room,text,zh):
    t=re.sub(r'[\s!！。.~]+$','',text.strip())
    for rx,cmd in COMMANDS:
        if rx.match(t):
            set_room(room,lang=cmd); return '之後在這個群組都說中文 🐾' if cmd=='zh' else "I'll use English in this group from now on 🐾"
    return None
def shown_offers(where,args):
    row=DB.execute('select offers,query,page,total from shown where '+where+' order by ts desc limit 1',args).fetchone()
    if not row: return None
    return {'offers':json.loads(row[0] or '[]'),'query':json.loads(row[1]) if row[1] else None,'page':row[2] or 1,'total':row[3] or 0}
def context_for(room,user,group,content):
    ref=content.get('m.relates_to',{}).get('m.in_reply_to',{}).get('event_id')
    replied=shown_offers('bot=?',(ref,)) if ref else None
    last=shown_offers('room=? and user=?',(room,user)) if group else shown_offers('room=?',(room,))
    u=NOTIFIER.user(user) or {}
    pend=DB.execute('select sub from pending_sub where room=? and user=? and ts>?',(room,user,time.time()-3600)).fetchone()
    subs=[dict(zip(('kind','value','label'),r)) for r in DB.execute('select kind,value,label from subs where user=?',(user,)).fetchall()]
    return {'group':group,'identity':u.get('identity'),'lang_hint':u.get('lang'),'last':last,'replied':(replied or {}).get('offers'),
            'pending':json.loads(pend[0]) if pend else None,'subs':subs}
async def apply(actions,room,user,result):
    for a in actions:
        if 'set_identity' in a:
            DB.execute('insert into users(user,room,identity) values(?,?,?) on conflict(user) do update set identity=excluded.identity',(user,room,a['set_identity']))
        elif 'subscribe' in a:
            sub=a['subscribe']
            DB.execute('insert into users(user,room,notify) values(?,?,1) on conflict(user) do update set room=excluded.room, notify=1',(user,room))
            DB.execute('insert or replace into subs(user,kind,value,label,expires_on,reminded,created,threshold,fp) values(?,?,?,?,?,0,?,?,?)',
                       (user,sub['kind'],sub['value'],sub['label'],sub.get('expires_on'),time.time(),sub.get('threshold'),json.dumps(sub['fp']) if sub.get('fp') else None))
        elif 'unsubscribe' in a:
            v=a['unsubscribe']
            if v: DB.execute('delete from subs where user=? and value=?',(user,v))
            else: DB.execute('delete from subs where user=?',(user,)); DB.execute('update users set notify=0 where user=?',(user,))
        elif 'pending' in a:
            DB.execute('insert or replace into pending_sub values(?,?,?,?)',(room,user,json.dumps(a['pending']),time.time()))
        elif 'report' in a:
            for vid in a['report']:
                try: await http(VOUCHERS+'/api/vouchers/'+esc(vid)+'/report',{'reporter':reporter(user),'reason':a.get('reason','')})
                except Exception as e: logging.warning('Report failed: %s',type(e).__name__)
                v=next((o for o in (result.get('reported_from') or []) if o.get('id')==vid),{})
                DB.execute('insert or ignore into reports(user,room,voucher_id,retailer,title,ts) values(?,?,?,?,?,?)',(user,room,vid,v.get('retailer',''),v.get('title',''),time.time()))
        elif 'demand' in a and a['demand']:
            try: await http(VOUCHERS+'/api/demand',a['demand'])
            except Exception: pass  # best effort
    if not any('pending' in a for a in actions):
        DB.execute('delete from pending_sub where room=? and user=?',(room,user))
    DB.commit()
async def reply(room,event,context,attachment=None):
    lock=LOCKS.setdefault(room,asyncio.Lock())
    async with lock: await _reply(room,event,context,attachment)
async def _reply(room,event,context,attachment=None):
    content=event['content']; eid=event['event_id']; voice=content.get('ai.netmind.rtc.agent.turn.started.v2')
    group=bool(context and context.get('group')); user=event.get('sender','')
    try:
        text=clean(voice.get('transcript',content.get('body','')) if voice else content.get('body',''))
        st=room_state(room); lang=st['lang'] if group else None
        zh=(lang or ('zh' if re.search('[\u3400-\u9fff]',text) else 'en'))=='zh'
        result=None
        cmd=command(room,text,zh) if group else None
        if cmd is None:
            ctx=context_for(room,user,group,content)
            ctx.update(history=await history(room,eid),attachment=attachment,lang=lang,voice=bool(voice))
            result=await BRAIN.respond(text,ctx)
            result['reported_from']=ctx.get('replied') or (ctx.get('last') or {}).get('offers')
            if group and not lang: set_room(room,lang=BRAIN.language(text,ctx['history']))  # one language per group
            if not group: NOTIFIER.remember_user(user,room,'zh' if re.search('[\u3400-\u9fff]',result['text']) else 'en')
            await apply(result['actions'],room,user,result)
            body=result['text']
            if result.get('offers') or result.get('query') is not None:
                DB.execute('insert or replace into shown values(?,?,?,?,?,?,?,?,?)',(eid,None,room,user,json.dumps(result.get('offers') or []),
                           json.dumps(result.get('query')) if result.get('query') is not None else None,result.get('page',1),result.get('total',0),time.time()))
        else:
            body=cmd
        if group and not st['welcomed'] and not voice:
            set_room(room,welcomed=1); body=body+'\n\n'+group_intro(zh)
        if voice and ((voice['rtc_session_id'],voice['turn_id']) in CANCELLED or VOICE.get(room,{}).get('turn')!=voice['turn_id']):return
        if result and result.get('card') and not voice:
            image=await card_image(result['card'])
            if image:
                if group: image['m.relates_to']={'m.in_reply_to':{'event_id':eid}}
                r=await send(room,'m.room.message',image,'card-'+hashlib.sha256(eid.encode()).hexdigest())
                body=result['card_text']+(('\n\n'+group_intro(zh)) if group and body.endswith(group_intro(zh)) else '')
                if r.get('event_id'):  # a reply or 👎 on the picture means its offers too
                    DB.execute('insert or replace into shown values(?,?,?,?,?,?,?,?,?)',('card-'+eid,r['event_id'],room,user,json.dumps(result.get('offers') or []),None,1,len(result.get('offers') or []),time.time()-1));DB.commit()
        payload={'msgtype':'m.text','body':body}
        if group and not voice:payload['m.relates_to']={'m.in_reply_to':{'event_id':eid}}  # thread under the asker in busy groups
        if voice:payload['ai.netmind.rtc.voice_reply']={k:voice[k] for k in ('rtc_session_id','turn_id')}
        DB.execute('insert or ignore into replies(id,room,payload) values(?,?,?)',(eid,room,json.dumps(payload)));DB.commit()
        await deliver_pending(); DB.execute('delete from pending where id=?',(eid,));DB.commit(); logging.info('Answered authorized message')
        if voice and result and result.get('full_text'):
            # Spoken answer stays short; links and the full list go to the chat as plain text.
            await send(room,'m.room.message',{'msgtype':'m.text','body':result['full_text']},'full-'+hashlib.sha256(eid.encode()).hexdigest())
    except asyncio.CancelledError: raise
    except Exception as e:
        logging.error('Reply failed: %s',type(e).__name__)
        body='暫時無法查詢優惠，請稍後再試。' if re.search('[\u3400-\u9fff]',content.get('body','')) else 'I cannot check offers right now. Please try again shortly.'
        payload={'msgtype':'m.text','body':body}
        if voice:payload['ai.netmind.rtc.voice_reply']={k:voice[k] for k in ('rtc_session_id','turn_id')}
        await send(room,'m.room.message',payload,'error-'+hashlib.sha256(eid.encode()).hexdigest())
    finally:
        if attachment: Path(attachment).unlink(missing_ok=True)
        TASKS.pop(eid,None)
        if voice:TASKS.pop((voice['rtc_session_id'],voice['turn_id']),None)

async def reaction(room,event,members):
    # A 👎 on one of Quidpaw's offer messages = "this didn't work". DMs only (in groups it would need a mention).
    rel=event.get('content',{}).get('m.relates_to',{})
    if rel.get('rel_type')!='m.annotation' or not str(rel.get('key','')).startswith('👎'):return
    target=rel.get('event_id'); eid=event.get('event_id','')
    if not DB.execute('select 1 from own where id=?',(target,)).fetchone():return
    if DB.execute('select 1 from replies where id=?',(eid,)).fetchone():return
    auth=await authorize(room,event,members,False)
    if auth.get('allow') is not True or auth.get('roomKind')!='dm':return
    seen=shown_offers('bot=?',(target,))
    offers=(seen or {}).get('offers') or []
    user=event.get('sender','')
    u=NOTIFIER.user(user) or {}; zh=u.get('lang')!='en'
    if len(offers)==1:
        await apply([{'report':[offers[0]['id']],'reason':'thumbs down'}],room,user,{'reported_from':offers})
        body=f"謝謝回報！我請人重新確認 {offers[0]['retailer']} 這個優惠 🐾" if zh else f"Thanks! I've asked for {offers[0]['retailer']} to be rechecked 🐾"
    elif offers:
        body='是哪一個不能用？回覆那則訊息說「第 2 個不能用」就好。' if zh else 'Which one failed? Reply to that message with "number 2 didn\'t work".'
    else:
        return
    DB.execute('insert or ignore into replies(id,room,payload,sent) values(?,?,?,1)',(eid,room,'{}'));DB.commit()
    await send(room,'m.room.message',{'msgtype':'m.text','body':body},'react-'+hashlib.sha256(eid.encode()).hexdigest())

async def image_attachment(room,c):
    # A photo with no caption arrives as m.image; an encrypted one (c["file"]) cannot be read without Matrix crypto.
    url=c.get('url','')
    if not url.startswith('mxc://') or (c.get('info',{}).get('size') or 0)>15*1024*1024:return None
    server,mid=url[6:].split('/',1)
    b=await http(HS+'/_matrix/client/v1/media/download/'+esc(server)+'/'+esc(mid),token=C['access_token'],raw=True)
    suffix=Path(c.get('body','image.jpg')).suffix[:10] or '.jpg'
    fd,path=tempfile.mkstemp(suffix=suffix,dir=ROOT/'media');os.write(fd,b);os.close(fd)
    return path

async def handle(room,event,members):
    sender=event.get('sender','')
    if sender==USER or sender.startswith('@agent-'):return  # never answer itself or other agents
    c=event.get('content',{}); typ=event.get('type',''); eid=event.get('event_id','')
    rtc=typ.startswith('ai.netmind.rtc.agent.')
    if typ=='m.reaction':return await reaction(room,event,members)
    image=typ=='m.room.message' and c.get('msgtype')=='m.image'
    if not rtc and not image and (typ!='m.room.message' or c.get('msgtype')!='m.text'):return
    if not rtc and time.time()*1000-event.get('origin_server_ts',time.time()*1000)>STALE_MS:return
    mention=called(room,c)
    auth=await authorize(room,event,members,mention)
    group=auth.get('roomKind')!='dm' if auth.get('roomKind') else len(members)!=2
    if auth.get('allow') is not True:
        notice=auth.get('notice',{})
        if notice.get('send') is True and notice.get('text'):
            await send(room,'m.room.message',{'msgtype':'m.notice','body':notice['text']},'denied-'+hashlib.sha256(eid.encode()).hexdigest())
        return
    if rtc:
        kind=typ.removeprefix('ai.netmind.rtc.agent.').removesuffix('.v2'); sid=c.get('rtc_session_id'); tid=c.get('turn_id')
        if kind=='call.started':VOICE[room]={'session':sid,'sender':event['sender']}
        v=VOICE.get(room,{})
        if v.get('session')!=sid or v.get('sender')!=event['sender']:return
        if kind in ('turn.cancelled','call.ended'):
            tid=tid or v.get('turn')
            if tid:
                CANCELLED.add((sid,tid))
                task=TASKS.get((sid,tid))
                if task:task.cancel()
        ack={'ack_of':kind,'rtc_session_id':sid,'platform':'generic','call_mode':'realtime','supports_long_task_delivery':False}
        if kind.startswith('turn.'):ack['turn_id']=c.get('turn_id')
        await send(room,'ai.netmind.rtc.agent.ack.v2',ack,'ack-'+hashlib.sha256(eid.encode()).hexdigest())
        if kind=='call.ended':VOICE.pop(room,None)
        return
    attachment=None
    hint=c.get('ai.netmind.hint')
    if image:
        if group or c.get('file'):return  # groups: an image cannot carry a mention; encrypted: unreadable
        attachment=await image_attachment(room,c)
        if not attachment:return
        event=dict(event); c=dict(c); c['body']=''; event['content']=c
    elif hint:
        if hint.get('kind')!='compound_trigger' or hint.get('version')!=1 or hint.get('target_msgtype')!='ai.netmind.compound':return
        target=hint.get('target_event_id','')
        original=await matrix('/rooms/'+esc(room)+'/event/'+esc(target))
        oc=original.get('content',{})
        if original.get('type')!='m.room.message' or oc.get('msgtype')!='ai.netmind.compound' or original.get('room_id')!=room:return
        if not oc.get('ai.netmind.compound') or original.get('unsigned',{}).get('redacted_because'):return
        om=USER in oc.get('m.mentions',{}).get('user_ids',[])
        if group and not om:return
        if (await authorize(room,original,members,om)).get('allow') is not True:return
        compound=oc['ai.netmind.compound']; media=compound.get('media_url','')
        if not media.startswith('mxc://'):return
        server,mid=media[6:].split('/',1)
        b=await http(HS+'/_matrix/client/v1/media/download/'+esc(server)+'/'+esc(mid),token=C['access_token'],raw=True)
        suffix=Path(compound.get('file_name','media')).suffix[:10]
        fd,path=tempfile.mkstemp(suffix=suffix,dir=ROOT/'media');os.write(fd,b);os.close(fd);attachment=path
        event=original;eid=target;c=dict(oc);c['body']=compound.get('text','');event['content']=c
    elif c.get('ai.netmind.visibility',{}).get('status')=='hidden':return
    if DB.execute('select 1 from replies where id=?',(eid,)).fetchone() or eid in TASKS:
        if attachment:Path(attachment).unlink(missing_ok=True)
        return
    context={'group':group}
    if re.search(r'https://[^\s]+/update-guide\.md',c.get('body','')):
        # Future code-changing updates require operator verification; never auto-ACK an unloaded version.
        await send(room,'m.room.message',{'msgtype':'m.text','body':'Runtime updates require maintenance in the Manyfold workspace. Please ask the owner to apply the Narra Runtime Update skill there; no update has been acknowledged.'},'update-'+hashlib.sha256(eid.encode()).hexdigest());return
    voice=c.get('ai.netmind.rtc.agent.turn.started.v2')
    if voice:
        sid=voice.get('rtc_session_id');tid=voice.get('turn_id');v=VOICE.get(room,{})
        if v.get('session')!=sid or v.get('sender')!=event['sender'] or (sid,tid) in CANCELLED or (sid,tid) in TURNS:return
        TURNS.add((sid,tid));v['turn']=tid
        await send(room,'ai.netmind.rtc.agent.ack.v2',{'ack_of':'turn.started','rtc_session_id':sid,'turn_id':tid,'platform':'generic','call_mode':'realtime','supports_long_task_delivery':False},'ack-'+hashlib.sha256(eid.encode()).hexdigest())
    DB.execute('insert or replace into pending values(?,?,?)',(eid,room,json.dumps(event)));DB.commit()
    task=asyncio.create_task(reply(room,event,context,attachment));TASKS[eid]=task
    if voice:TASKS[(sid,tid)]=task

async def main():
    assert STATE['runtime_provider']=='generic' and STATE['transport']=='direct_matrix'
    contract=await http(STATE['runtime_url'],raw=True)
    (ROOT/'runtime-contract.md').write_bytes(contract)
    who=await matrix('/account/whoami')
    assert who['user_id']==USER and who['device_id']=='NARRA_agent-b4b94dd2'
    logging.info('Verified Matrix user and device; generic direct_matrix release %s',STATE['runtime_release'])
    row=DB.execute("select value from kv where key='since'").fetchone(); since=row[0] if row else None
    # Retry authorized unfinished inputs after a restart before advancing sync.
    for eid,room,event in DB.execute('select id,room,event from pending').fetchall():
        try:
            members=list((await matrix('/rooms/'+esc(room)+'/joined_members')).get('joined',{}))
            await handle(room,json.loads(event),members)
        except Exception as e:logging.warning('Recovery deferred: %s',type(e).__name__)
    await deliver_pending()
    asyncio.create_task(notify_loop())
    while True:
        try:
            query={'timeout':25000}
            if since:query['since']=since
            batch=await matrix('/sync?'+urlencode(query))
            for room in batch.get('rooms',{}).get('invite',{}):
                await matrix('/join/'+esc(room),{},'POST');logging.info('Joined invited room')
            for room,details in batch.get('rooms',{}).get('join',{}).items():
                members=list((await matrix('/rooms/'+esc(room)+'/joined_members')).get('joined',{}))
                for event in details.get('timeline',{}).get('events',[]):
                    try: await handle(room,event,members)
                    except Exception as e:logging.warning('Event handling failed: %s',type(e).__name__)
            since=batch['next_batch'];DB.execute("insert or replace into kv values('since',?)",(since,));DB.commit()
            (ROOT/'ready.json').write_text(json.dumps({'user_id':USER,'device_id':who['device_id'],'synced_at':time.time(),'transport':'direct_matrix'}))
            logging.info('Matrix sync healthy')
        except Exception as e: logging.warning('Sync retry: %s',type(e).__name__);await asyncio.sleep(5)

async def notify_loop():
    while True:
        try: logging.info('Notify tick %s',json.dumps(await NOTIFIER.tick()))
        except Exception as e: logging.warning('Notify tick failed: %s',type(e).__name__)
        await asyncio.sleep(NOTIFY_EVERY)

if __name__=='__main__':
    os.umask(0o077)
    (ROOT/'media').mkdir(exist_ok=True)
    logging.basicConfig(level=logging.INFO,format='%(asctime)s %(levelname)s %(message)s')
    asyncio.run(main())
