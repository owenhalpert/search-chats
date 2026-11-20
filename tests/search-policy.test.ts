import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildChatQuery, buildInstantQuery, fragmentRanking, SEARCH_POLICY, selectRelevant} from '../src/services/search-policy';
import {nativeSearchHits} from '../src/services/turbopuffer-index';
import {resultsFor} from '../src/model';
import type {SessionSummary} from '../src/services/session-types';

test('shipped query includes native-rerank text and scopes diversified candidates to resumable chats',()=>{
 const body=buildChatQuery('deploy',[{id:'a'},{id:'a'},{id:'b'}],SEARCH_POLICY) as any;
 assert.deepEqual(body.rerank_by,['voyage/rerank-3-lite','text','deploy']);
 assert.equal(body.queries.length,2);
 assert.equal(body.limit,25);
 for(const q of body.queries){
  assert.ok(q.include_attributes.includes('text'));
  assert.deepEqual(q.filters,['session_id','In',['a','b']]);
  assert.deepEqual(q.limit,{total:25,per:{attributes:['agent','session_id'],limit:3}});
  assert.deepEqual(q.compute_attributes.highlight, ['Highlight','text',{
    fragment_by:'sentence',fragment_limit:1,rank_fragments_by:fragmentRanking('deploy'),include_offsets:'utf-16',
  }]);
 }
 assert.deepEqual(body.queries.map((q:any)=>q.rank_by[1]),['ANN','BM25']);
});

test('rerank gate discards low scores, merges chunks per chat, and retains only the best broad match',()=>{
 const rows=[
  {session_id:'a',agent:'codex',text:'First passage', $dist:.7},
  {session_id:'a',agent:'codex',text:'Best passage', $dist:.8},
  {session_id:'b',agent:'claude-code',text:'Irrelevant neighbor', $dist:.1},
  {session_id:'c',agent:'codex',text:'Borderline match', $dist:.60},
  {session_id:'d',agent:'unknown',text:'Unrecognized provider', $dist:.99},
  {session_id:'e',agent:'codex',text:'Invalid score', $dist:NaN},
 ];
 const hits=nativeSearchHits(rows);
 assert.deepEqual(hits.map(h=>h.sessionId),['a']);
 assert.equal(hits[0].snippet,'Best passage');
 assert.equal(hits[0].rerankScore,.8);
 assert.deepEqual(selectRelevant([{score:.60,id:'best'},{score:.59,id:'other'}]),[{score:.60,id:'best'}]);
 assert.deepEqual(selectRelevant([{score:.51}]),[]);
});

test('gated semantic matches can use different words while final results stay newest-first',()=>{
 const s={id:'one',agent:'codex',title:'Power settings',preview:'',cwd:'/tmp',projectName:'demo',updatedAt:'2026-10-15'} as SessionSummary;
 const hit=nativeSearchHits([{session_id:s.id,agent:s.agent,text:'Run caffeinate so the machine never sleeps while compiling', $dist:.8}]);
 assert.equal(resultsFor([s],'keep my mac awake during long builds','all',hit).length,1);
 assert.equal(resultsFor([s],'keep my mac awake during long builds','all',[{...hit[0],score:.3,rerankScore:.3}]).length,0);
});

test('instant query is keyword-only with a prefix last word, and stale passages are filtered by the current query',()=>{
 const body=buildInstantQuery('kms rot') as any;
 assert.deepEqual(body.rank_by,['text','BM25','kms rot',{last_as_prefix:true}]);
 assert.deepEqual(body.filters,['text','ContainsAllTokens','kms rot',{last_as_prefix:true}]);
 assert.deepEqual(body.consistency,{level:'eventual'});
 assert.ok(!('rerank_by' in body) && !('queries' in body) && !JSON.stringify(body).includes('Embed'));
 const s={id:'one',agent:'codex',title:'Unrelated',preview:'',cwd:'/tmp',projectName:'demo',updatedAt:'2026-10-15'} as SessionSummary;
 const carried={sessionId:'one',agent:'codex' as const,snippet:'KMS key rotation steps',matches:[],score:1};
 assert.equal(resultsFor([s],'kms rotat','all',[carried]).length,1);
 assert.equal(resultsFor([s],'kms rotax','all',[carried]).length,0);
});

test('highlights add typo-tolerant matches only for words long enough to allow an edit',()=>{
 assert.deepEqual(fragmentRanking('kms key'),['$fragment','BM25','kms key']);
 const fuzzy={max_edit_distance:[{min_query_chars:6,distance:1},{min_query_chars:9,distance:2}],case_sensitive:false};
 assert.deepEqual(fragmentRanking('Rerankng the rerankng thresold'),['Sum',[
  ['$fragment','BM25','Rerankng the rerankng thresold'],
  ['$fragment','Fuzzy','rerankng',fuzzy],
  ['$fragment','Fuzzy','thresold',fuzzy],
 ]]);
});
