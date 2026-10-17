(() => {
const $=id=>document.getElementById(id), cfg=window.APP_CONFIG;
const money=c=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format((Number(c)||0)/100);
const dt=v=>v?new Date(v).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'}):'—';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const show=(id,on=true)=>$(id).classList.toggle('hidden',!on);
let db, session, admin=false, members=[], matches=[], publicPlayers=[], publicToken=null;
const cfgReady=cfg&&cfg.SUPABASE_URL?.startsWith('https://')&&!cfg.SUPABASE_URL.includes('SEU-PROJETO')&&cfg.SUPABASE_PUBLISHABLE_KEY&&!cfg.SUPABASE_PUBLISHABLE_KEY.includes('SUA_CHAVE')&&cfg.GROUP_ID&&!cfg.GROUP_ID.includes('UUID-');
function toast(s){$('toast').textContent=s;show('toast');setTimeout(()=>show('toast',false),3500)}
function msg(id,s,error=false){$(id).textContent=s;$(id).classList.toggle('error',error)}
function setup(){if(!cfgReady||!window.supabase){show('setup');$('setup').textContent='Edite js/config.js com a URL, publishable key e UUID do grupo Supabase.';return false}db=window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_PUBLISHABLE_KEY);return true}
async function init(){
 const q=new URLSearchParams(location.search);
 if(q.has('attendance')){if(!setup())return;show('public-attendance');await loadAttendance(q.get('attendance'));return}
 if(q.has('caixa')){if(!setup())return;show('public-balance');await loadPublicBalance();return}
 if(!setup()){show('login');return}
 const {data}=await db.auth.getSession();session=data.session;renderAuth();
 db.auth.onAuthStateChange((_e,s)=>{session=s;renderAuth();if(session)loadApp().catch(e=>toast(e.message))});
 if(session)await loadApp();
}
function renderAuth(){show('login',!session);show('dashboard',!!session);show('logout',!!session)}
$('login-form').addEventListener('submit',async e=>{e.preventDefault();msg('login-message','Entrando…');const {data,error}=await db.auth.signInWithPassword({email:$('email').value.trim(),password:$('password').value});if(error)return msg('login-message',error.message,true);session=data.session;renderAuth();try{await loadApp()}catch(err){msg('login-message',err.message,true)}});
$('logout').addEventListener('click',async()=>{await db.auth.signOut();session=null;renderAuth()});
$('refresh').addEventListener('click',()=>loadApp().catch(e=>toast(e.message)));
document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x===b));document.querySelectorAll('.tabpage').forEach(x=>x.classList.toggle('hidden',x.id!=='tab-'+b.dataset.tab))}));
async function loadApp(){
 if(!session)return;
 const {data:me,error}=await db.from('group_members').select('id,role').eq('group_id',cfg.GROUP_ID).eq('user_id',session.user.id).eq('active',true).maybeSingle();
 if(error)throw error;if(!me){await db.auth.signOut();throw new Error('Esta conta não está cadastrada como integrante ativo do grupo.')}
 admin=me.role==='admin';document.querySelectorAll('.admin-only').forEach(el=>show(el.id?el.id:el,admin));
 const a=await db.from('group_members').select('id,display_name,skill_level,active').eq('group_id',cfg.GROUP_ID).eq('active',true).order('display_name');if(a.error)throw a.error;members=a.data||[];
 const b=await db.from('matches').select('id,title,starts_at,location,player_limit,status').eq('group_id',cfg.GROUP_ID).order('starts_at');if(b.error)throw b.error;matches=b.data||[];
 await renderPlayers();await renderMatches();await renderTeams();await renderCash();renderStats();populateMatches();
}
$('player-form').addEventListener('submit',async e=>{e.preventDefault();const {error}=await db.from('group_members').insert({group_id:cfg.GROUP_ID,display_name:$('player-name').value.trim(),skill_level:+$('player-level').value,role:'player'});if(error)return toast(error.message);$('player-name').value='';await loadApp()});
async function renderPlayers(){const el=$('players');el.innerHTML='';if(!members.length){el.innerHTML='<div class="empty">Nenhum jogador cadastrado.</div>';return}members.forEach(p=>{const d=document.createElement('article');d.className='item';d.innerHTML=`<div><b>${esc(p.display_name)}</b><small>Nível ${p.skill_level}</small></div>${admin?`<div class="actions"><select data-level="${p.id}">${[1,2,3,4,5].map(n=>`<option ${n===p.skill_level?'selected':''} value="${n}">Nível ${n}</option>`).join('')}</select><button class="secondary" data-disable="${p.id}">Desativar</button></div>`:''}`;el.appendChild(d)});
el.querySelectorAll('[data-level]').forEach(x=>x.onchange=async()=>{const {error}=await db.from('group_members').update({skill_level:+x.value}).eq('id',x.dataset.level);if(error)toast(error.message)});
el.querySelectorAll('[data-disable]').forEach(x=>x.onclick=async()=>{if(!confirm('Desativar jogador?'))return;const {error}=await db.from('group_members').update({active:false}).eq('id',x.dataset.disable);if(error)toast(error.message);else loadApp()})}
$('match-form').addEventListener('submit',async e=>{e.preventDefault();const date=new Date($('match-date').value);if(isNaN(date))return toast('Data inválida');const {error}=await db.from('matches').insert({group_id:cfg.GROUP_ID,title:$('match-name').value.trim(),starts_at:date.toISOString(),location:$('match-location').value.trim()||null,player_limit:+$('match-limit').value,status:'scheduled'});if(error)return toast(error.message);await loadApp()});
async function renderMatches(){
 const el=$('matches');
 el.innerHTML='';
 if(!matches.length){el.innerHTML='<div class="empty">Nenhum jogo criado.</div>';return}
 for(const m of matches){
  const {data:a,error}=await db.from('attendance')
    .select('member_id,status')
    .eq('match_id',m.id);
  if(error)throw error;
  const statusByMember=new Map((a||[]).map(x=>[x.member_id,x.status]));
  const buckets={confirmed:[],declined:[],waitlist:[],pending:[]};
  members.forEach(p=>{
   const status=statusByMember.get(p.id);
   if(status==='confirmed')buckets.confirmed.push(p.display_name);
   else if(status==='declined')buckets.declined.push(p.display_name);
   else if(status==='waitlist')buckets.waitlist.push(p.display_name);
   else buckets.pending.push(p.display_name);
  });
  const count=buckets.confirmed.length;
  const listMarkup=(names,emptyText)=>names.length?`<ul>${names.map(name=>`<li>${esc(name)}</li>`).join('')}</ul>`:`<p class="muted small">${emptyText}</p>`;
  const d=document.createElement('article');
  d.className='item match-item';
  d.innerHTML=`<div class="match-summary"><div><b>${esc(m.title)}</b><small>${dt(m.starts_at)}${m.location?' · '+esc(m.location):''}</small><span class="pill">${count}${m.player_limit?' / '+m.player_limit:''} confirmados</span></div>${admin?`<button class="secondary" data-links="${m.id}">Gerar link da pelada</button>`:''}</div>
    <details class="attendance-details"><summary>Ver lista de presença · ${count} confirmados, ${buckets.pending.length} pendentes</summary>
      <div class="roster-counts"><span class="status-chip status-confirmed">${count} confirmados</span><span class="status-chip status-declined">${buckets.declined.length} não vão</span><span class="status-chip status-pending">${buckets.pending.length} pendentes</span><span class="status-chip status-waitlist">${buckets.waitlist.length} em espera</span></div>
      <div class="attendance-columns">
       <section><h3>✅ Confirmados</h3>${listMarkup(buckets.confirmed,'Ninguém confirmou ainda.')}</section>
       <section><h3>⏳ Pendentes</h3>${listMarkup(buckets.pending,'Todos responderam.')}</section>
       <section><h3>❌ Não vão</h3>${listMarkup(buckets.declined,'Nenhuma recusa.')}</section>
       <section><h3>📋 Lista de espera</h3>${listMarkup(buckets.waitlist,'Ninguém na lista de espera.')}</section>
      </div>
    </details>`;
  el.appendChild(d);
 }
 el.querySelectorAll('[data-links]').forEach(b=>b.onclick=()=>makeLinks(b.dataset.links));
}
async function makeLinks(matchId){if(!confirm('Gerar o link único desta pelada? Se já existir um link, ele será substituído e o anterior deixará de funcionar.'))return;const {data,error}=await db.rpc('create_match_attendance_link',{p_match_id:matchId});if(error)return toast('Não foi possível gerar o link: '+error.message);const url=location.origin+location.pathname+'?attendance='+encodeURIComponent(data);try{await navigator.clipboard.writeText(url);alert('Link único da pelada copiado! Compartilhe este mesmo link com a turma.\n\n'+url+'\n\nAtenção: se gerar outro link para esta pelada, o anterior será invalidado.')}catch{prompt('Copie o link único da pelada e compartilhe com a turma:',url)}}
function populateMatches(){const s=$('draw-match'),old=s.value;s.innerHTML=matches.filter(m=>m.status==='scheduled').map(m=>`<option value="${m.id}">${esc(m.title)} — ${dt(m.starts_at)}</option>`).join('');if(old)s.value=old}
$('draw-form').addEventListener('submit',async e=>{e.preventDefault();const id=$('draw-match').value,n=+$('team-count').value;if(!id)return toast('Crie um jogo primeiro');const {data:a,error}=await db.from('attendance').select('member_id, group_members(id,display_name,skill_level)').eq('match_id',id).eq('status','confirmed');if(error)return toast(error.message);const ps=(a||[]).map(x=>x.group_members).filter(Boolean).map(p=>({...p,tie:Math.random()}));if(ps.length<n)return toast('Não há jogadores suficientes');ps.sort((x,y)=>y.skill_level-x.skill_level||x.tie-y.tie);const ts=Array.from({length:n},(_,i)=>({name:'Time '+String.fromCharCode(65+i),players:[],sum:0}));for(const p of ps){const min=Math.min(...ts.map(t=>t.sum)),opts=ts.filter(t=>t.sum===min),t=opts[Math.floor(Math.random()*opts.length)];t.players.push({member_id:p.id,skill_level:p.skill_level});t.sum+=p.skill_level}const {error:saveErr}=await db.rpc('save_balanced_teams',{p_match_id:id,p_teams:ts});if(saveErr)return toast(saveErr.message);await renderTeams();toast('Times sorteados')});
async function renderTeams(){const el=$('teams');el.innerHTML='';for(const m of matches){const {data:ts,error}=await db.from('teams').select('id,name').eq('match_id',m.id);if(error)throw error;for(const t of ts||[]){const {data:ps,error:pErr}=await db.from('team_players').select('skill_level_at_draw,group_members(display_name)').eq('team_id',t.id);if(pErr)throw pErr;const d=document.createElement('article');d.className='team';d.innerHTML=`<h3>${esc(t.name)}</h3><small>${esc(m.title)} · nível total ${(ps||[]).reduce((s,p)=>s+p.skill_level_at_draw,0)}</small><ul>${(ps||[]).map(p=>`<li>${esc(p.group_members?.display_name)} (${p.skill_level_at_draw})</li>`).join('')}</ul>`;el.appendChild(d)}}if(!el.children.length)el.innerHTML='<div class="empty">Nenhum time sorteado.</div>'}
async function renderCash(){const {data:bal,error}=await db.rpc('get_group_balance',{p_group_id:cfg.GROUP_ID});if(error)throw error;$('cash-balance').textContent=money(bal);$('balance').textContent=money(bal);const el=$('transactions');el.innerHTML='';if(!admin)return;const {data:rows,error:err}=await db.from('cash_transactions').select('type,amount_cents,description,occurred_at').eq('group_id',cfg.GROUP_ID).order('occurred_at',{ascending:false}).limit(50);if(err)throw err;if(!rows?.length){el.innerHTML='<div class="empty">Nenhuma movimentação.</div>';return}rows.forEach(t=>{const d=document.createElement('article');d.className='item';d.innerHTML=`<div><b>${esc(t.description)}</b><small>${dt(t.occurred_at)}</small></div><strong class="${t.type==='income'?'positive':'negative'}">${t.type==='income'?'+':'−'} ${money(t.amount_cents)}</strong>`;el.appendChild(d)})}
$('cash-form').addEventListener('submit',async e=>{e.preventDefault();const value=Number($('cash-amount').value);if(!Number.isFinite(value)||value<=0)return toast('Valor inválido');const {error}=await db.from('cash_transactions').insert({group_id:cfg.GROUP_ID,type:$('cash-type').value,amount_cents:Math.round(value*100),description:$('cash-description').value.trim(),created_by:session.user.id});if(error)return toast(error.message);$('cash-amount').value='';$('cash-description').value='';await renderCash()});
function renderStats(){const m=matches.find(x=>x.status==='scheduled'&&new Date(x.starts_at)>=new Date());$('next-game').textContent=m?.title||'—';$('next-date').textContent=m?dt(m.starts_at):'Nenhum jogo futuro';if(!m){$('confirmed').textContent='0';return}db.from('attendance').select('id',{count:'exact',head:true}).eq('match_id',m.id).eq('status','confirmed').then(r=>{if(!r.error)$('confirmed').textContent=String(r.count||0)})}
async function loadPublicBalance(){const {data,error}=await db.rpc('get_group_balance',{p_group_id:cfg.GROUP_ID});if(error){msg('balance-message','Não foi possível consultar o saldo: '+error.message,true);return}$('public-balance-value').textContent=money(data)}
function fillRosterList(id, players, emptyText){
 const el=$(id);el.innerHTML='';
 if(!players.length){const li=document.createElement('li');li.className='muted empty-list-item';li.textContent=emptyText;el.appendChild(li);return}
 players.forEach(player=>{const li=document.createElement('li');li.textContent=player.player_name;el.appendChild(li)});
}
function renderPublicRoster(){
 const grouped={confirmed:[],declined:[],pending:[],waitlist:[]};
 publicPlayers.forEach(player=>{
  const status=player.attendance_status;
  if(status==='confirmed')grouped.confirmed.push(player);
  else if(status==='declined')grouped.declined.push(player);
  else if(status==='waitlist')grouped.waitlist.push(player);
  else grouped.pending.push(player);
 });
 $('public-confirmed-count').textContent=grouped.confirmed.length;
 $('public-declined-count').textContent=grouped.declined.length;
 $('public-pending-count').textContent=grouped.pending.length;
 $('public-waitlist-count').textContent=grouped.waitlist.length;
 fillRosterList('public-confirmed-list',grouped.confirmed,'Ninguém confirmou ainda.');
 fillRosterList('public-pending-list',grouped.pending,'Todos responderam.');
 fillRosterList('public-declined-list',grouped.declined,'Nenhuma recusa.');
 fillRosterList('public-waitlist-list',grouped.waitlist,'Ninguém na lista de espera.');
 show('public-roster-summary',true);
}
async function loadAttendance(token,preserveMemberId=null){
 publicToken=token;
 $('yes').disabled=$('no').disabled=true;
 $('public-member-select').disabled=true;
 const {data,error}=await db.rpc('get_match_attendance_link_info',{p_token:token});
 if(error||!data?.length){
  $('public-title').textContent='Link inválido ou expirado';
  $('public-meta').textContent='Solicite um novo link ao administrador.';
  $('public-member-select').innerHTML='<option value="">Nenhum jogador disponível</option>';
  show('public-roster-summary',false);
  msg('public-message','Este link não está mais disponível.',true);
  return;
 }
 const d=data[0];
 publicPlayers=data;
 $('public-title').textContent=d.match_title;
 $('public-meta').textContent=dt(d.starts_at)+(d.location?' · '+d.location:'');
 const select=$('public-member-select');
 const previous=preserveMemberId||select.value;
 select.innerHTML='<option value="">Selecione teu nome…</option>'+publicPlayers.map(p=>`<option value="${p.member_id}">${esc(p.player_name)}</option>`).join('');
 if(previous&&publicPlayers.some(p=>p.member_id===previous))select.value=previous;
 select.disabled=false;
 select.onchange=renderSelectedAttendanceState;
 $('yes').onclick=()=>respond(token,select.value,'confirmed');
 $('no').onclick=()=>respond(token,select.value,'declined');
 renderSelectedAttendanceState();
 renderPublicRoster();
}
function renderSelectedAttendanceState(){
 const memberId=$('public-member-select').value;
 const player=publicPlayers.find(p=>p.member_id===memberId);
 const enabled=Boolean(player);
 $('yes').disabled=!enabled;$('no').disabled=!enabled;
 if(!player){msg('public-message','Escolhe teu nome para continuar.');return}
 const labels={confirmed:'confirmado',declined:'não vai',waitlist:'lista de espera',not_responded:'ainda não respondeu'};
 msg('public-message',`Situação registrada para ${player.player_name}: ${labels[player.attendance_status]||player.attendance_status}.`);
}
$('public-refresh-roster').addEventListener('click',async()=>{
 if(!publicToken)return;
 const memberId=$('public-member-select').value;
 $('public-refresh-roster').disabled=true;
 try{await loadAttendance(publicToken,memberId)}catch(e){msg('public-message','Não foi possível atualizar a lista: '+e.message,true)}
 finally{$('public-refresh-roster').disabled=false}
});
async function respond(token,memberId,status){if(!memberId){msg('public-message','Escolhe teu nome primeiro.',true);return}$('yes').disabled=$('no').disabled=true;const {error}=await db.rpc('respond_to_match_attendance',{p_token:token,p_member_id:memberId,p_status:status});if(error){msg('public-message',error.message,true);renderSelectedAttendanceState();return}await loadAttendance(token,memberId);msg('public-message',status==='confirmed'?'Presença confirmada! ⚽':'Ausência registrada.')}
init().catch(e=>{console.error(e);toast('Erro: '+e.message)});
})();
