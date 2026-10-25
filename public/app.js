'use strict';
const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const winds = ['東','南','西','北'];
const suitNames = {m:'萬子',p:'筒子',s:'索子',z:'字牌',none:'なし'};
const fieldNames = {bonus_suit:'ボーナス牌種',bonus_points:'1枚ボーナス',speech_keyword:'合言葉',speech_effect:'合言葉効果',speech_points:'合言葉得点'};
let socket = null, reconnectTimer, heartbeat, reconnectDelay = 1000, lastPong = 0;
let session = null, state = null, selected = -1, handSignature = '', lastVersion = -1, busy = false, clockOffset = 0, toastTimeout;
try { session = JSON.parse(sessionStorage.getItem('ittamon-session')); } catch { /* storage is optional */ }
function saveSession(value) { session = value; try { if(value) sessionStorage.setItem('ittamon-session',JSON.stringify(value)); else sessionStorage.removeItem('ittamon-session'); } catch {} }
function toast(text, error=false) { $('toast').textContent=text; $('toast').className='toast'+(error?' error':''); $('toast').hidden=false; clearTimeout(toastTimeout); toastTimeout=setTimeout(()=>{$('toast').hidden=true;},6500); }
async function request(path, body) {
  const response=await fetch(path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(session?{'Authorization':'Bearer '+session.token}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(8000)});
  const result=await response.json();
  if(!response.ok) throw new Error(result.error || '通信に失敗しました。');
  return result;
}
async function action(type, data={}) {
  if(busy) return;
  busy=true;
  try {
    const result=await request('/api/action',{action:type,code:session?.code,...data});
    if(result.token) saveSession({token:result.token,code:result.state.code});
    if(result.left) { disconnectSocket(); saveSession(null); state=null; show('home'); return; }
    if(result.state) { render(result.state); connectSocket(); }
    return result;
  } catch(e) { toast(e.name==='TimeoutError'?'接続がタイムアウトしました。サーバーを確認してください。':e.message,true); }
  finally { busy=false; }
}
function show(view) { for(const id of ['home','lobby','game']) $(id).hidden=id!==view; }
function tileName(tile) { if(tile==='none') return 'なし'; return tile[1]==='z'?['','東','南','西','北','白','發','中'][Number(tile[0])]:tile[0]+suitNames[tile[1]]; }
function tileHTML(tile, small=false, index=null) {
  const suit=tile[1], n=Number(tile[0]), honor=suit==='z';
  const number=honor?['','東','南','西','北','白','發','中'][n]:['','一','二','三','四','五','六','七','八','九'][n];
  const symbol=honor?'':{m:'萬',p:'筒',s:'索'}[suit];
  const classes=`tile ${suit}${small?' small':''}${honor&&n===6?' green':''}${honor&&n===5?' white':''}${index===selected?' selected':''}${index===13?' drawn':''}`;
  const inner=`<span class="number">${number}</span>${symbol?`<span class="suit">${symbol}</span>`:''}`;
  return index===null?`<span class="${classes}" title="${tileName(tile)}">${inner}</span>`:`<button class="${classes}" data-tile="${index}" aria-label="${tileName(tile)}${index===selected?' 選択中':''}" aria-pressed="${index===selected}" ${state.can_discard?'':'disabled'}>${inner}</button>`;
}
function valueLabel(key,value) {
  if(key==='bonus_suit') return suitNames[value];
  if(key==='speech_keyword') return value?'「'+value+'」':'なし';
  if(key==='speech_effect') return value==='win'?'即あがり':'3人から得点';
  return Number(value).toLocaleString()+'点';
}
function render(s) {
  // HTTP replies and WebSocket pushes can arrive in either order.
  if(state?.code===s.code&&s.version<state.version)return;
  if(state?.code!==s.code){lastVersion=-1;handSignature='';selected=-1;}
  const previous=state;
  state=s; clockOffset=s.server_time*1000-Date.now();
  $('connection').classList.remove('offline');
  $('connection').innerHTML='<i></i> ONLINE TABLE';
  $('net-status').textContent='● 同期中';
  if(s.status==='lobby') { show('lobby'); renderLobby(s); return; }
  show('game');
  const sig=s.hand.join(',')+s.can_discard;
  if(sig!==handSignature) { selected=-1; handSignature=sig; }
  $('round').textContent=s.round;
  $('game-code').textContent=s.code;
  $('wall-count').textContent=s.wall;
  $('direction').textContent=s.direction===-1?'↺ 逆回り':'↻ 通常';
  $('turn-text').textContent=s.status==='finished'?'対局終了':s.pending?'✦ AI審判が考え中…':s.claim?'ロン・鳴き受付中':s.turn===s.me?'あなたの番です':s.players[s.turn].name+' の番';
  $('my-table-label').innerHTML=`${s.turn===s.me&&s.status==='playing'?'<strong>▼ あなたの番</strong>':'▼ あなた'} · ${esc(s.players[s.me].name)}`;
  for(const [offset,id] of [[1,'opponent-right'],[2,'opponent-top'],[3,'opponent-left']]) {
    const i=(s.me+offset)%4,p=s.players[i];
    $(id).classList.toggle('is-turn',i===s.turn&&s.status==='playing');
    $(id).innerHTML=`<div class="opponent-info"><span class="wind-badge">${winds[i]}</span><span>${esc(p.name)}</span></div><div class="opponent-score">${p.score.toLocaleString()} <small>点</small></div><div class="backs" aria-label="手牌 ${p.count}枚">${'<span class="back"></span>'.repeat(p.count)}</div>${(p.melds||[]).length?`<div class="melds">${p.melds.map(m=>`<span class="meld">${m.tiles.map(t=>tileHTML(t,true)).join('')}</span>`).join('')}</div>`:''}${!p.online?'<span class="offline-tag">接続待ち</span>':''}`;
  }
  $('rivers').innerHTML=[['bottom',0],['right',1],['top',2],['left',3]].map(([pos,offset])=>`<div class="river river-${pos}" aria-label="${esc(s.players[(s.me+offset)%4].name)} の捨て牌">${s.players[(s.me+offset)%4].river.slice(-24).map(t=>tileHTML(t,true)).join('')}</div>`).join('');
  $('my-info').innerHTML=`<span class="wind-badge">${winds[s.me]}</span> <strong>${esc(s.players[s.me].name)}</strong><span class="score">${s.players[s.me].score.toLocaleString()} 点</span>`;
  $('my-melds').innerHTML=(s.players[s.me].melds||[]).map(m=>`<span class="meld" aria-label="${{chi:'チー',pon:'ポン',kan:'カン',exposed:'公開牌'}[m.type]}">${m.tiles.map(t=>tileHTML(t,true)).join('')}</span>`).join('');
  $('call-options').innerHTML=(s.call_options||[]).map((o,i)=>`<button class="button quiet" data-call="${i}">${{chi:'チー',pon:'ポン',kan:'カン'}[o.type]} ${o.tiles.map(tileName).join('・')}</button>`).join('');
  $('call-options').querySelectorAll('[data-call]').forEach(b=>b.addEventListener('click',()=>{const o=state.call_options[Number(b.dataset.call)];action('call',{type:o.type,tiles:o.tiles});}));
  renderHand();
  $('hand-hint').textContent=s.pending?'AI判定中・時計停止':s.can_discard?'牌を選んで、打牌。':'あなたの手牌';
  $('action-help').textContent=s.pending?'ルール判定が終わるまで一時停止中':s.call_pending?'鳴きを申請しました。ほかの人の応答を待っています。':s.can_ron?'8秒以内にロンを宣言！':s.call_options?.length?'8秒以内に鳴くか、見送ってください。':s.can_tsumo?'今のルールであがれます！':s.status==='finished'?'ルール・持ち点は次の局へ引き継ぎます。':'自由に発言して、対局をひっくり返そう。';
  $('tsumo').hidden=!s.can_tsumo; $('ron').hidden=!s.can_ron; $('pass').hidden=!s.can_ron&&!s.call_options?.length;
  $('discard').hidden=s.status==='finished';
  $('judge-status').textContent=s.pending?'✦ 判定中・時計停止':'AI審判 待機中';
  $('judge-status').classList.toggle('thinking',s.pending);
  $('speech').disabled=s.pending;
  $('send-speech').disabled=s.pending;
  $('speech').placeholder=s.pending?'審判がルールを検討しています…':s.status==='finished'?'感想をどうぞ。次の局でルール変更できます。':'「今から白はジョーカーでしょ！」';
  document.querySelectorAll('[data-say]').forEach(b=>{b.disabled=s.pending||s.status!=='playing';});
  $('reset-rules').hidden=!s.host||s.status==='playing';
  const latest=s.history.findLast(h=>!h.violation);
  $('rule-banner-text').textContent=latest?latest.title:'まだ世界は、普通の麻雀。';
  $('rule-version').textContent='RULE '+String(s.history.length).padStart(2,'0');
  const r=s.rules;
  const keys=[];
  if(r.bonus_suit!=='none') keys.push('bonus_suit','bonus_points');
  if(r.speech_keyword) keys.push('speech_keyword','speech_effect',...(r.speech_effect==='bonus'?['speech_points']:[]));
  const openPrograms=new Set([...document.querySelectorAll('.generated-rule[open]')].map(el=>el.dataset.programId));
  $('current-rules').innerHTML=keys.map(key=>`<div class="rule-row${latest?.changes?.[key]?' changed':''}"><span>${fieldNames[key]}</span><strong>${esc(valueLabel(key,r[key]))}</strong></div>`).join('');
  $('current-rules').insertAdjacentHTML('beforeend',(s.programs||[]).map(p=>`<details class="generated-rule" data-program-id="${esc(p.id)}"${openPrograms.has(p.id)?' open':''}><summary>${esc(p.title)}${p.disabled?'（停止中）':''}</summary><p>${esc(p.explanation)}</p><pre>${esc(JSON.stringify(JSON.parse(p.code),null,2))}</pre></details>`).join(''));
  if(!keys.length&&!s.programs?.length) $('current-rules').textContent='採用ルールはまだありません。';
  $('history-count').textContent=s.history.length;
  $('history').innerHTML=s.history.length?[...s.history].reverse().map(h=>`<div class="history-item"><strong>${esc(h.title)}</strong><p>${esc(h.explanation)}</p>${h.points?`<p>減点：${h.points.toLocaleString()}点</p>`:''}${h.program?`<p>生成ルール：${esc(h.program.mode)} ${esc(h.program.id)}</p>`:''}${Object.entries(h.changes).filter(([key])=>Object.hasOwn(fieldNames,key)).map(([key,v])=>`<p>${fieldNames[key]}：${esc(valueLabel(key,v.before))} → ${esc(valueLabel(key,v.after))}</p>`).join('')}</div>`).join(''):'<div class="history-item">まだ改変はありません。最初のひと言をどうぞ。</div>';
  if(s.version!==lastVersion) {
    const messages=$('messages'), nearBottom=messages.scrollHeight-messages.scrollTop-messages.clientHeight<70;
    messages.innerHTML=s.messages.map(m=> {
      const mine=m.seat===s.me;
      if(m.kind==='speech') return `<div class="message${mine?' mine':''}"><div class="message-name">${esc(m.name)}${mine?' · あなた':''}</div><div class="speech-bubble">${esc(m.text)}</div></div>`;
      const isJudge=['rule','judge','chonbo'].includes(m.kind);
      return `<div class="message ${esc(m.kind)}">${isJudge?'<div class="message-name">✦ AI審判'+(m.kind==='rule'?' · ルール改変！':'')+'</div>':''}${m.title?`<div class="message-title">${esc(m.title)}</div>`:''}${esc(m.text)}${m.tile?' '+tileName(m.tile):''}</div>`;
    }).join('');
    if(nearBottom||lastVersion<0) messages.scrollTop=messages.scrollHeight;
    lastVersion=s.version;
  }
  $('result').hidden=s.status!=='finished';
  if(s.result) {
    const result=s.result;
    $('result').innerHTML=`<span class="small-caps">${result.winner===null?'DRAW GAME':'THAT’S A WIN!'}</span><h3>${esc(result.text)}</h3><div class="result-hand">${result.hand.map(t=>tileHTML(t,true)).join('')}</div><div class="result-score">${s.players.map((p,i)=>`<div>${esc(p.name)}<strong class="${result.deltas[i]>0?'plus':result.deltas[i]<0?'minus':''}">${result.deltas[i]>0?'+':''}${result.deltas[i].toLocaleString()}</strong></div>`).join('')}</div>${s.host?'<button id="next-round" class="button primary">次の局へ →</button><button id="result-reset" class="button quiet">ルールを初期化</button>':'<p class="muted">部屋主が次の局を始めるのを待っています。</p>'}`;
    $('next-round')?.addEventListener('click',()=>action('start'));
    $('result-reset')?.addEventListener('click',()=>action('reset_rules'));
  }
  if(previous?.pending&&!s.pending) { const last=s.messages.at(-1); if(last?.kind==='rule') toast('✦ '+last.title); }
  renderTimer();
}
function renderHand() {
  $('hand').innerHTML=state.hand.map((t,i)=>tileHTML(t,false,i)).join('');
  $('discard').disabled=!state.can_discard||selected<0;
  $('discard').textContent=selected<0?'牌を選んで打牌':tileName(state.hand[selected])+' を切る →';
  $('hand').querySelectorAll('[data-tile]').forEach(b=>b.addEventListener('click',()=>{selected=Number(b.dataset.tile);renderHand();}));
}
function renderLobby(s) {
  $('lobby-code').textContent=s.code; $('invite-url').value=location.origin+'/?room='+s.code;
  $('seats').innerHTML=Array.from({length:4},(_,i)=> {
    const p=s.players[i];
    return p?`<div class="seat-card${i===s.me?' mine':''}"><span class="seat-avatar">${winds[i]}</span><strong>${esc(p.name)}${i===s.me?'（あなた）':''}</strong><span class="seat-state${p.ready?' is-ready':''}">${p.npc?'NPC · 自動操作':p.ready?'✓ 準備完了':!p.online?'接続待ち':i===0?'部屋主 · 準備中':'準備中'}</span>${p.npc&&s.host?`<button class="button quiet" data-remove-npc="${i}" aria-label="${esc(p.name)}を外す">NPCを外す</button>`:''}</div>`:`<div class="seat-card empty"><span class="seat-avatar">${winds[i]}</span><strong>参加者を待っています</strong><span class="seat-state">空席</span></div>`;
  }).join('');
  $('seats').querySelectorAll('[data-remove-npc]').forEach(button=>button.addEventListener('click',()=>action('remove_npc',{seat:Number(button.dataset.removeNpc)})));
  $('add-npc').hidden=!s.host;
  $('add-npc').disabled=s.players.length>=4;
  $('ready').textContent=s.players[s.me].ready?'✓ 準備完了（取り消す）':'準備完了';
  $('start').hidden=!s.host;
  $('start').disabled=s.players.length!==4||!s.players.every(p=>p.ready);
  $('lobby-status').textContent=s.players.length<4?`${s.players.length} / 4人 が着席中。あと${4-s.players.length}人を招待しましょう。`:s.players.every(p=>p.ready)?s.host?'全員準備完了。いつでも開局できます。':'全員準備完了。部屋主の開局を待っています。':'全員の準備完了を待っています。';
}
function renderTimer() {
  if(!state||state.status!=='playing') return;
  const remaining=Math.max(0,Math.ceil((state.deadline*1000-Date.now()-clockOffset)/1000));
  $('timer').textContent=state.pending?'判定中は時計が止まります':state.claim?`ロン・鳴き受付 あと ${remaining} 秒`:`打牌まで ${remaining} 秒`;
  $('timer').classList.toggle('urgent',!state.pending&&remaining<=8);
}
async function copyInvite() {
  const url=location.origin+'/?room='+session.code;
  try { if(navigator.clipboard&&window.isSecureContext) await navigator.clipboard.writeText(url); else { const input=document.createElement('textarea');input.value=url;document.body.appendChild(input);input.select();const copied=document.execCommand('copy');input.remove();if(!copied)throw Error(); } toast('招待URLをコピーしました。友達に送ってください。'); }
  catch { toast('招待URL：'+url); }
}
$('entry-form').addEventListener('submit',e=>{e.preventDefault();action('create',{name:$('name').value.trim()});});
$('join-form').addEventListener('submit',e=>{e.preventDefault(); if(!$('name').value.trim()) { $('name').reportValidity();$('name').focus();return; } action('join',{name:$('name').value.trim(),code:$('room-code').value.toUpperCase().trim()});});
$('ready').addEventListener('click',()=>action('ready'));
$('start').addEventListener('click',()=>action('start'));
$('add-npc').addEventListener('click',()=>action('add_npc'));
$('leave').addEventListener('click',()=>action('leave'));
$('discard').addEventListener('click',()=>{if(selected>=0)action('discard',{tile:state.hand[selected]});});
$('tsumo').addEventListener('click',()=>action('tsumo'));
$('ron').addEventListener('click',()=>action('ron'));
$('pass').addEventListener('click',()=>action('pass'));
$('reset-rules').addEventListener('click',()=>action('reset_rules'));
document.querySelectorAll('.copy-invite').forEach(b=>b.addEventListener('click',copyInvite));
$('speech').addEventListener('input',()=>{$('speech-count').textContent=$('speech').value.length+' / 280';});
$('speech').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('speech-form').requestSubmit();}});
$('speech-form').addEventListener('submit',async e=>{e.preventDefault();const text=$('speech').value.trim();if(!text||busy||state.pending)return;const result=await action('speech',{text});if(result){$('speech').value='';$('speech-count').textContent='0 / 280';}});
document.querySelectorAll('[data-say]').forEach(b=>b.addEventListener('click',()=>{$('speech').value=b.dataset.say;$('speech').dispatchEvent(new Event('input'));$('speech').focus();}));
const invited=new URLSearchParams(location.search).get('room');
if(invited) $('room-code').value=invited.toUpperCase().slice(0,5);
function disconnectSocket() {
  clearTimeout(reconnectTimer); clearInterval(heartbeat);
  const previous=socket;socket=null;
  previous?.close(1000,'退出');
}
function offline() {
  $('connection').classList.add('offline');$('connection').innerHTML='<i></i> 再接続中';$('net-status').textContent='再接続中…';
}
function connectSocket() {
  if(!session) return;
  if(socket&&(socket.readyState===WebSocket.OPEN||socket.readyState===WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);
  const current={...session}, url=new URL('/api/ws/'+current.code,location.href);
  url.protocol=location.protocol==='https:'?'wss:':'ws:';
  // Credentials travel in a header, never in the URL or browser history.
  const ws=new WebSocket(url,['ittamon',current.token]);socket=ws;
  ws.onopen=()=>{
    if(ws!==socket)return;
    reconnectDelay=1000;lastPong=Date.now();clearInterval(heartbeat);
    heartbeat=setInterval(()=>{
      if(ws!==socket||ws.readyState!==WebSocket.OPEN)return;
      if(Date.now()-lastPong>65000){ws.close();return;}
      ws.send('ping');
    },25000);
  };
  ws.onmessage=event=>{
    if(ws!==socket)return;
    lastPong=Date.now();
    if(event.data==='pong')return;
    try {const message=JSON.parse(event.data);if(message.state)render(message.state);}catch{toast('同期データを読み取れませんでした。再接続します。',true);ws.close();}
  };
  ws.onerror=()=>{if(ws===socket)offline();};
  ws.onclose=event=>{
    if(ws!==socket)return;
    socket=null;clearInterval(heartbeat);
    if(event.code===1008){saveSession(null);state=null;show('home');toast(event.reason||'部屋の有効期限が切れました。',true);return;}
    offline();
    if(session){reconnectTimer=setTimeout(connectSocket,reconnectDelay);reconnectDelay=Math.min(30000,reconnectDelay*2);}
  };
}
async function boot() {
  try {
    const health=await request('/api/health');
    $('ai-status').textContent=health.ai?'● AI審判：'+health.model:'AIキーが未設定です。対局はできますがルール変更は利用できません。';
    $('chat-limit').textContent='Enterで送信 / Shift + Enterで改行・1卓80回／全体1日'+health.daily_ai_limit+'回まで';
    if(session) {
      try { const result=await request('/api/state/'+encodeURIComponent(session.code));render(result.state);connectSocket(); }
      catch(e) {
        if(/参加情報|部屋が見つかりません/.test(e.message)){saveSession(null);toast(e.message,true);}
        else {offline();connectSocket();}
      }
    }
  } catch { $('ai-status').textContent='サーバーに接続できません。再接続しています…';setTimeout(boot,5000); }
}
boot();
setInterval(renderTimer,250);
document.addEventListener('visibilitychange',()=>{
  if(!document.hidden){if(socket?.readyState===WebSocket.OPEN)socket.send('ping');else connectSocket();}
});
