import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nativeSearchHits} from '../src/services/turbopuffer-index';
import {MATCH_STYLE,wrapRich,renderRich,clean,width} from '../src/terminal';
import {detailContent,render,type ViewState} from '../src/view';

const row={session_id:'session',agent:'codex',text:'Full winning chunk', $dist:.8};
test('native highlights use fragment-relative UTF-16 offsets, normalize ranges, and retain semantic passages',()=>{
 const [hit]=nativeSearchHits([{...row,session_id:'caveat',text:'<local-command-caveat>Deploy', $dist:1}, {...row,highlight:[{text:'😀 Deploy API',fragment_range:[100,113],match_ranges:[[109,112],[103,109],[111,200],[-20,99]]}]}]);
 assert.equal(hit.sessionId,'session');
 assert.equal(hit.snippet,'😀 Deploy API');
 assert.deepEqual(hit.matches,[[3,13]]);
 assert.equal(hit.snippet.slice(...hit.matches[0]),'Deploy API');
 const [semantic]=nativeSearchHits([{...row,highlight:[]}]);
 assert.equal(semantic.snippet,row.text);
 assert.deepEqual(semantic.matches,[]);
});

test('server-highlighted text survives terminal sanitization and wrapping without leaking controls',()=>{
 const text='😀 \x1b[31mDeploy\x1b[0m\tAPI\nnext';
 const from=text.indexOf('Deploy');
 const lines=wrapRich(text,[[from,from+6]],8);
 assert.equal(lines.map(l=>l.text).join(''), '😀 Deploy  APInext');
 const rendered=lines.map(l=>renderRich(l,8)).join('\n');
 assert.ok(rendered.includes(MATCH_STYLE));
 assert.ok(!rendered.includes('\x1b[31m'));
 assert.ok(rendered.split('\n').every(line=>width(line)<=8));
 assert.equal(clean(rendered).replace(/\s+/g,''),'😀DeployAPInext');
 const hostile=wrapRich('\x1b]52;c;bad\x07hello',[[16,21]],20).map(l=>renderRich(l,20)).join('');
 assert.ok(!hostile.includes('\x1b]52'));
});

function state():ViewState{
 const session={...row,id:row.session_id,agent:'codex' as const,title:'A chat',preview:'Truncated summary…',projectName:'demo',cwd:'/tmp/demo',gitBranch:null,origin:null,cliVersion:null,startedAt:null,updatedAt:'2026-10-15',filePath:'/tmp/chat.jsonl',sizeBytes:1,archived:false};
 return {query:'deploy',filter:'all', filters:['all'],results:[{session,local:false,hit:{sessionId:session.id,agent:'codex',snippet:'Configure Deploy API',matches:[[10,16]],score:.8,rerankScore:.8}}],total:1,selected:0,top:0,loading:false,searching:false,localOnly:false,status:'',transcriptLoading:false,transcriptError:'',detailOpen:false,previewFocus:false,previewScroll:0,help:false,
 transcript:{messageCount:2,totalItems:2,truncated:false,items:[{kind:'message',id:'one',role:'user',text:'The complete opening message, after the truncated summary',timestamp:null},{kind:'message',id:'two',role:'assistant',text:'Recent message that should not crowd out the opening',timestamp:null}]}};
}
test('preview shows the actual opening message before the highlighted passage, without recent activity',()=>{
 const s=state(),lines=detailContent(s,45);
 const plain=lines.map(l=>l.text).join('\n');
 assert.ok(plain.indexOf('OPENING MESSAGE')<plain.indexOf('MATCHING PASSAGE'));
 assert.ok(plain.includes('The complete opening message'));
 assert.ok(!plain.includes('Truncated summary'));
 assert.ok(!plain.includes('Recent message'));
 assert.ok(render(s,120,32).includes(MATCH_STYLE));
 s.results[0].hit!.matches=[];
 const semantic=detailContent(s,45).map(l=>l.text).join('\n');
 assert.ok(semantic.includes('RELATED PASSAGE · semantic'));
 assert.ok(!render(s,120,32).includes(MATCH_STYLE));
 s.detailOpen=true;
 assert.ok(detailContent(s,45).map(l=>l.text).join('\n').includes('Recent message'));
});
