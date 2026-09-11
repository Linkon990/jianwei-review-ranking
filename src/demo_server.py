"""Loopback-only, single-workspace demonstration. Not a production API."""
from __future__ import annotations

import argparse
from copy import deepcopy
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import math
import random
from pathlib import Path
from time import monotonic
import uuid

from .comment_ranker import CommentRanker, Episode, Exposure, ExposureLedger

ROOT = Path(__file__).resolve().parents[1]
LOG_ROOT = ROOT.parent / 'work log' / 'runtime' if ROOT.name == 'project' else ROOT / 'data'
STRATEGIES = ['uniform', 'slide', 'center_lower']
MAX_POST_BODY_BYTES = 262144
EARLY_REJECTION_DRAIN_SECONDS = 0.25
ROUND_VISITOR_LIMIT = 6  # Demonstration length, never a statistical sample size.
DEMO_RANDOM_SEED = 20260911
VIEWER_PROFILES = (
    ('小禾', '禾', 'forest'),
    ('小海', '海', 'ocean'),
    ('小橙', '橙', 'sunset'),
    ('小紫', '紫', 'violet'),
    ('小林', '林', 'forest'),
    ('小岚', '岚', 'ocean'),
)


from .sample_data import sample_comments


class Demo:
    def __init__(self, log_path=None):
        self.comments=sample_comments()
        self.log_path=log_path
        self.last_reset_from=None
        self.begin_round(1)

    def begin_round(self,ordinal):
        """Create pristine in-memory demo state; only reset() may call again."""
        self.rankers={s:CommentRanker(self.comments,strategy=s) for s in STRATEGIES}
        self.initial_scores={s:ranker.scores() for s,ranker in self.rankers.items()}
        self.rng=random.Random(DEMO_RANDOM_SEED)
        self.round={'id':uuid.uuid4().hex,'ordinal':ordinal,'limit':ROUND_VISITOR_LIMIT,
                    'completed':0,'status':'running','strategy':None,
                    'outcome_counts':{'purchase':0,'abandon':0,'refund':0},
                    'results':[],'summary':None}
        # Display default only: the center/lower position prior remains an
        # experimental hypothesis; the statistical core is unchanged.
        self.strategy='center_lower'
        self.viewer=self.viewer_at(1)
        self.last_result=None
        self.episode=None
        self.ranking={}
        self.ledger=ExposureLedger()
        self.closed=True
        self.phase='product'
        self.activated=False
        self.current_view_mode={'sort':'recommended','filter':'all'}
        self.event_count=0
        self.episode_count=0
        self.event_keys=set()
        self.segment_counts={}

    @staticmethod
    def viewer_at(ordinal):
        nickname,avatar,theme=VIEWER_PROFILES[(ordinal-1)%len(VIEWER_PROFILES)]
        # Six distinct visitor profiles share four themes. Across rounds,
        # (round_id, user_key) is the unique identity.
        return {'user_key':f'demo-user-{ordinal}','ordinal':ordinal,
                'nickname':nickname,'avatar':avatar,'theme':theme}

    def log(self, kind, payload):
        if self.log_path:
            self.log_path.parent.mkdir(parents=True,exist_ok=True)
            with self.log_path.open('a',encoding='utf-8') as f:
                f.write(json.dumps({'type':kind,'at':datetime.now(timezone.utc).isoformat(),'demo':True,
                                    'round_id':self.round['id'],'round_ordinal':self.round['ordinal'],**payload},ensure_ascii=False)+'\n')

    def state(self):
        episode=None
        if self.episode is not None:
            episode={'episode_id':self.episode.episode_id,
                     'round_id':self.round['id'],
                     'user_key':self.episode.user_key,
                     'started_at':self.episode.started_at.isoformat() if self.activated else None,
                     'closed':self.closed,'phase':self.phase}
        return {'comments':[asdict(c) for c in self.comments],
                'scores':self.rankers[self.strategy].scores(),
                'stats':{cid:asdict(s) for cid,s in self.rankers[self.strategy].stats.items()},
                'episode':episode,'viewer':dict(self.viewer),
                'phase':'product' if self.closed else self.phase,
                'last_result':deepcopy(self.last_result),
                'round':deepcopy(self.round),'last_reset_from':self.last_reset_from,
                'ranking':self.ranking,'strategy':self.strategy,'view_mode':self.current_view_mode,
                'counts':{'events':self.event_count,'episodes':self.episode_count},'strategies':STRATEGIES,'demo':True,'version':'0.5.0'}

    def check_round(self,body,*,allow_completed=False):
        # Internal callers may omit round_id; HTTP enforces it on every
        # mutation. Episode UUIDs separately reject old episode requests.
        if 'round_id' in body and body['round_id']!=self.round['id']:
            raise ValueError('此轮体验已被替换，请刷新查看当前轮次')
        if not allow_completed and self.round['status']=='completed':
            raise ValueError('本轮6位访客均已完成，请查看总结后开启新一轮')

    def start(self, body):
        self.check_round(body)
        strategy=body.get('strategy',self.round['strategy'] or 'center_lower')
        if strategy not in STRATEGIES: raise ValueError('未知策略')
        if self.round['strategy'] is not None and strategy!=self.round['strategy']:
            raise ValueError('本轮策略已锁定，完成本轮并重置后才能选择其他策略')
        if self.episode is not None and not self.closed:
            self.log('episode_discarded',{'episode_id':self.episode.episode_id,'user_key':self.episode.user_key,'reason':'new_demo_episode_before_outcome'})
        self.strategy=strategy
        self.round['strategy']=strategy
        self.episode=Episode(uuid.uuid4().hex,self.viewer['user_key'],'demo-backpack',datetime.now(timezone.utc))
        self.ledger=ExposureLedger()
        self.closed=False
        self.phase='prepared'
        self.activated=False
        self.current_view_mode={'sort':'recommended','filter':'all'}
        self.event_keys=set()
        self.segment_counts={}
        order,meta=self.rankers[strategy].rank(explore=True,seed=self.rng.getrandbits(64))
        self.ranking={'order':order,**meta,'ranking_id':uuid.uuid4().hex}
        self.episode_count+=1
        self.log('ranking_prepared',{'episode_id':self.episode.episode_id,'user_key':self.episode.user_key,'strategy':strategy,'ranking':self.ranking})
        return self.state()

    def check_episode(self,body,*,require_active=True):
        self.check_round(body)
        if self.episode is None or body.get('episode_id') != self.episode.episode_id:
            raise ValueError('此浏览片段不存在或已被替换，请从商品页重新进入评论')
        if self.closed: raise ValueError('此浏览片段已结束，请从商品页重新进入评论')
        if require_active and self.phase!='active': raise ValueError('评论界面尚未就绪，未开始采集')

    def activate(self,body):
        self.check_episode(body,require_active=False)
        if self.phase=='active': return self.state()
        if self.phase!='prepared': raise ValueError('当前片段不能开始采集')
        # Assignment precedes rendering. The attribution/read clock begins only
        # after the client confirms the review screen is laid out and visible.
        self.episode.started_at=datetime.now(timezone.utc)
        self.activated=True
        self.phase='active'
        self.log('review_entered',{'episode_id':self.episode.episode_id,'user_key':self.episode.user_key,'started_at':self.episode.started_at.isoformat(),'ranking_id':self.ranking['ranking_id']})
        return self.state()

    def leave(self,body):
        self.check_round(body,allow_completed=True)
        if self.episode is None or body.get('episode_id')!=self.episode.episode_id:
            raise ValueError('片段已被替换')
        if not self.closed:
            self.phase='left'
            self.closed=True
            # Navigation is not a purchase outcome. Discard an unfinished demo
            # episode without training; it must not turn into a negative label.
            self.log('review_left',{'episode_id':self.episode.episode_id,'user_key':self.episode.user_key,'settled':False})
        return self.state()

    def exposures(self,body):
        self.check_episode(body)
        rows=body.get('events')
        if not isinstance(rows,list) or len(rows)>200: raise ValueError('曝光批次需为列表且不超过200条')
        accepted=0
        elapsed=(datetime.now(timezone.utc)-self.episode.started_at).total_seconds()*1000
        parsed=[]
        # Validate the complete batch before mutating to avoid partial retries.
        for r in rows:
            if not isinstance(r,dict): raise ValueError('曝光必须是对象')
            cid=r.get('comment_id')
            if cid not in self.ranking['order']: raise ValueError('评论不属于本次排序')
            vals=[r.get(k) for k in ('start_ms','end_ms','visible_fraction','center_y')]
            if any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in vals): raise ValueError('曝光数值无效')
            a,b,v,y=vals
            if not (0<=a<=b<=elapsed+1500 and b-a<=60000 and 0<=v<=1 and 0<=y<=1): raise ValueError('曝光区间或可见位置越界')
            if not isinstance(r.get('initial_screen',False),bool): raise ValueError('首屏标记无效')
            e=Exposure(self.episode.episode_id,f'demo-session-{self.episode.user_key}',cid,self.episode.started_at+timedelta(milliseconds=a),self.episode.started_at+timedelta(milliseconds=b),v,y,initial_screen=r.get('initial_screen',False))
            parsed.append((cid,e,r))
        for cid,e,r in parsed:
            if e in self.event_keys: continue
            if self.segment_counts.get(cid,0)>=240: continue
            self.event_keys.add(e)
            self.segment_counts[cid]=self.segment_counts.get(cid,0)+1
            self.ledger.add(e)
            self.event_count+=1
            accepted+=1
            self.log('exposure',{**r,'episode_id':self.episode.episode_id,'user_key':self.episode.user_key})
        return {'accepted':accepted}

    def outcome(self,body):
        self.check_episode(body)
        outcome=body.get('outcome')
        if outcome not in {'purchase','abandon','refund'}: raise ValueError('未知结果，请选择购买、未购买或退款')
        now=datetime.now(timezone.utc)
        if now-self.episode.started_at>timedelta(hours=24):
            raise ValueError('本次演示已超过24小时，请返回商品页重新进入评论')
        if outcome in {'purchase','refund'}:
            self.episode.purchased_at=max(now,self.episode.started_at+timedelta(milliseconds=1))
            self.episode.refunded=(outcome=='refund')
        as_of=self.episode.started_at+timedelta(days=32)
        ranker=self.rankers[self.strategy]
        before=ranker.scores()
        contributions=self.ledger.contribution_vector(self.episode,self.strategy,as_of)
        ranker.update(self.episode,self.ledger,as_of)
        after=ranker.scores()
        # Capture the settled visitor before advancing. Keep only changed or
        # contributing reviews rather than duplicating all 72 score records.
        score_changes={cid:{'before':before[cid],'after':score,'delta':score-before[cid]}
                       for cid,score in after.items() if cid in contributions or score!=before[cid]}
        from_viewer=dict(self.viewer)
        completed=self.round['completed']+1
        to_viewer=self.viewer_at(self.viewer['ordinal']+1) if completed<self.round['limit'] else None
        self.last_result={'round_id':self.round['id'],'episode_id':self.episode.episode_id,
                          'from_viewer':from_viewer,'to_viewer':dict(to_viewer) if to_viewer else None,
                          'outcome':outcome,'strategy':self.strategy,
                          'has_contribution':bool(contributions),
                          'contributions':contributions,'score_changes':score_changes}
        self.closed=True
        self.phase='settled'
        self.round['completed']=completed
        self.round['outcome_counts'][outcome]+=1
        self.round['results'].append(deepcopy(self.last_result))
        if to_viewer:
            self.viewer=to_viewer
        else:
            self.round['status']='completed'
            self.round['summary']=self.round_summary()
        # HTTPServer serializes requests. The settled flag, new viewer and
        # receipt are committed before sending a response; retries/GET cannot
        # apply this outcome or increment the visitor again.
        self.log('outcome',{'episode_id':self.episode.episode_id,'user_key':self.episode.user_key,
                           'outcome':outcome,'strategy':self.strategy,'as_of':as_of.isoformat(),
                           'gross_label':self.episode.label(as_of),'net_label':self.episode.net_label(as_of),
                           'contributions':contributions,'score_changes':score_changes,
                           'has_contribution':bool(contributions),'completed_visitors':completed,
                           'from_viewer':from_viewer,'to_viewer':to_viewer})
        message=('本轮6位访客已全部完成，可查看总结并开启新一轮。' if not to_viewer
                 else '结果已结算，已切换到下一位访客。进入评论可查看继承后的排序。')
        return self.state()|{'message':message}

    def round_summary(self):
        """Descriptive synthetic counts, with all completed visitors included."""
        results=self.round['results']
        completed=len(results)
        counts=dict(self.round['outcome_counts'])
        with_contribution=sum(result['has_contribution'] for result in results)
        paid=counts['purchase']+counts['refund']
        strategy_summaries={}
        for strategy,ranker in self.rankers.items():
            records=[result for result in results if result['strategy']==strategy]
            effective=sum(result['has_contribution'] for result in records)
            before=self.initial_scores[strategy]
            final=ranker.scores()
            strategy_summaries[strategy]={
                'completed':len(records),'with_contribution':effective,
                'without_contribution':len(records)-effective,
                # All comments, including unchanged scores. No sampled display
                # rank is described as a causal or deterministic rank change.
                'score_changes':{cid:{'before':before[cid],'after':score,'delta':score-before[cid]}
                                 for cid,score in final.items()},
            }
        return {'completed':completed,'limit':self.round['limit'],'started_episodes':self.episode_count,
                'outcome_counts':counts,'with_contribution':with_contribution,
                'without_contribution':completed-with_contribution,
                'paid':{'count':paid,'denominator':completed,'rate':paid/completed if completed else None},
                'net_purchase':{'count':counts['purchase'],'denominator':completed,
                                'rate':counts['purchase']/completed if completed else None},
                'strategy_summaries':strategy_summaries}

    def reset(self,body):
        round_id=body.get('round_id')
        if not isinstance(round_id,str) or not round_id:
            raise ValueError('重置体验必须提供对应的round_id')
        discard_running=body.get('discard_running',False)
        if not isinstance(discard_running,bool):
            raise ValueError('discard_running必须是布尔值')
        if round_id==self.last_reset_from:
            # A lost reset response must never erase work in its successor.
            return self.state()
        if round_id!=self.round['id']:
            raise ValueError('此重置请求属于旧轮次，不会影响当前体验')
        if self.round['status']!='completed' and not discard_running:
            raise ValueError('请完成本轮6位访客后再开启新一轮')
        ordinal=self.round['ordinal']+1
        self.begin_round(ordinal)
        self.last_reset_from=round_id
        self.log('round_reset',{'from_round_id':round_id,'to_round_id':self.round['id'],
                               'reason':'stop' if discard_running else 'completed'})
        return self.state()

    def view_mode(self,body):
        self.check_round(body)
        if self.episode is None or body.get('episode_id') != self.episode.episode_id: raise ValueError('片段已被替换')
        if body.get('sort') not in {'recommended','recent','recommend'} or body.get('filter') not in {'all','positive','neutral','negative'}:
            raise ValueError('未知浏览模式')
        self.current_view_mode={'sort':body['sort'],'filter':body['filter']}
        self.log('user_view_mode',{'episode_id':self.episode.episode_id,'sort':body['sort'],'filter':body['filter']})
        return {'recorded':True}


def make_handler(demo,port):
    class Handler(BaseHTTPRequestHandler):
        def reject_early(self,status,data):
            # A client may send headers and body in separate TCP writes. On
            # Windows, closing with the unread body in flight can reset the
            # socket before the client receives our 403/415 response. Consume
            # only an explicitly bounded body, never dispatch it, and impose a
            # total deadline so this single-thread server cannot wait forever.
            self.close_connection=True
            length=0
            if self.command=='POST' and not self.headers.get('Transfer-Encoding'):
                try:
                    declared=int(self.headers.get('Content-Length','0'))
                    if 0<declared<=MAX_POST_BODY_BYTES:
                        length=declared
                except ValueError:
                    pass
            if length:
                previous_timeout=self.connection.gettimeout()
                deadline=monotonic()+EARLY_REJECTION_DRAIN_SECONDS
                try:
                    while length:
                        remaining=deadline-monotonic()
                        if remaining<=0:
                            break
                        self.connection.settimeout(remaining)
                        # read1 performs at most one underlying socket read;
                        # read(n) could reset its timeout for each slow chunk.
                        chunk=self.rfile.read1(min(length,16384))
                        if not chunk:
                            break
                        length-=len(chunk)
                except OSError:
                    # A missing/slow body still gets a best-effort rejection.
                    pass
                finally:
                    self.connection.settimeout(previous_timeout)
            self.send(status,data)

        def send(self,status,data,ctype='application/json; charset=utf-8'):
            blob=data if isinstance(data,bytes) else json.dumps(data,ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type',ctype)
            self.send_header('Content-Length',str(len(blob)))
            self.send_header('Cache-Control','no-store')
            self.send_header('X-Content-Type-Options','nosniff')
            self.send_header('Content-Security-Policy',"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(blob)

        def local_request(self):
            if self.headers.get('Host') not in {f'localhost:{port}',f'127.0.0.1:{port}'}:
                self.reject_early(403,{'error':'仅允许本机访问'}); return False
            origin=self.headers.get('Origin')
            if origin and origin not in {f'http://localhost:{port}',f'http://127.0.0.1:{port}'}:
                self.reject_early(403,{'error':'拒绝跨站请求'}); return False
            return True

        def do_GET(self):
            if not self.local_request(): return
            path=self.path.split('?')[0]
            if path=='/api/state': self.send(200,demo.state()); return
            assets={'/':('index.html','text/html; charset=utf-8'),'/index.html':('index.html','text/html; charset=utf-8'),'/app.js':('app.js','text/javascript; charset=utf-8'),'/style.css':('style.css','text/css; charset=utf-8'),'/sample-data.js':('sample-data.js','text/javascript; charset=utf-8'),'/demo-engine.js':('demo-engine.js','text/javascript; charset=utf-8'),'/favicon.svg':('favicon.svg','image/svg+xml')}
            if path not in assets: self.send(404,{'error':'不存在'}); return
            name,ctype=assets[path]
            content=(ROOT/'web'/name).read_bytes()
            if name=='index.html':
                content=content.replace(b'data-runtime="browser"', b'data-runtime="server"')
            self.send(200,content,ctype)

        def do_POST(self):
            if not self.local_request(): return
            try:
                if self.headers.get('Content-Type','').split(';')[0]!='application/json':
                    self.reject_early(415,{'error':'仅接受JSON请求'});return
                length=int(self.headers.get('Content-Length',0))
                if not 0<length<=MAX_POST_BODY_BYTES: self.send(413,{'error':'请求大小无效'});return
                body=json.loads(self.rfile.read(length))
                if not isinstance(body,dict): raise ValueError('请求必须是JSON对象')
                action={'/api/start':demo.start,'/api/activate':demo.activate,'/api/leave':demo.leave,'/api/exposures':demo.exposures,'/api/outcome':demo.outcome,'/api/view-mode':demo.view_mode,'/api/reset':demo.reset}.get(self.path)
                if action is None: self.send(404,{'error':'不存在'});return
                if self.path!='/api/reset' and body.get('round_id')!=demo.round['id']:
                    raise ValueError('round_id缺失或此轮已被替换，请刷新当前页面')
                self.send(200,action(body))
            except (ValueError,TypeError,KeyError) as e:
                self.send(400,{'error':str(e)})

        def log_message(self,fmt,*args):
            # Audit domain events separately; avoid noisy per-poll access logs.
            pass
    return Handler


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',type=int,default=8765)
    args=parser.parse_args()
    demo=Demo(LOG_ROOT/'demo-audit.jsonl')
    server=HTTPServer(('127.0.0.1',args.port),make_handler(demo,args.port))
    print(f'Demo only: http://127.0.0.1:{args.port} | Ctrl+C stops server',flush=True)
    server.serve_forever()


if __name__=='__main__': main()
