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
// Prevent overlapping loads (e.g. form submit + Supabase SIGNED_IN event).
let appLoadPromise = null;
function loadApp() {
 if (!session) return Promise.resolve();
 if (appLoadPromise) return appLoadPromise;
 appLoadPromise = loadAppInternal().finally(() => { appLoadPromise = null; });
 return appLoadPromise;
}
async function loadAppInternal(){
 if(!session)return;
 const userId = session.user.id;
 const {data:me,error}=await db.from('group_members').select('id,role').eq('group_id',cfg.GROUP_ID).eq('user_id',userId).eq('active',true).maybeSingle();
 if(error)throw error;if(!me){await db.auth.signOut();throw new Error('Esta conta não está cadastrada como integrante ativo do grupo.')}
 admin=me.role==='admin';document.querySelectorAll('.admin-only').forEach(el=>show(el.id?el.id:el,admin));
 const a=await db.from('group_members').select('id,display_name,skill_level,active,is_goalkeeper,is_line_goalkeeper,is_fixed').eq('group_id',cfg.GROUP_ID).eq('active',true).order('display_name');if(a.error)throw a.error;members=a.data||[];populateCashMembers();updateCashFields();
 const b=await db.from('matches').select('id,title,starts_at,location,player_limit,status').eq('group_id',cfg.GROUP_ID).order('starts_at');if(b.error)throw b.error;
 // Defensive deduplication by primary key. The database query itself should return unique IDs.
 matches=Array.from(new Map((b.data||[]).map(match=>[match.id,match])).values());
 await renderPlayers();await renderMatches();await renderTeams();await renderCash();renderStats();populateMatches();
}
$('player-form').addEventListener('submit',async e=>{
 e.preventDefault();
 const payload={
  group_id:cfg.GROUP_ID,
  display_name:$('player-name').value.trim(),
  skill_level:+$('player-level').value,
  role:'player',
  is_goalkeeper:$('player-is-goalkeeper').checked,
  is_line_goalkeeper:$('player-is-line-goalkeeper').checked,
  is_fixed:$('player-is-fixed').checked
 };
 const {error}=await db.from('group_members').insert(payload);
 if(error)return toast(error.message);
 $('player-name').value='';
 $('player-level').value='3';
 $('player-is-goalkeeper').checked=false;
 $('player-is-line-goalkeeper').checked=false;
 $('player-is-fixed').checked=false;
 toast('Jogador cadastrado.');
 await loadApp();
});
async function renderPlayers(){
 const el=$('players');el.innerHTML='';
 if(!members.length){el.innerHTML='<div class="empty">Nenhum jogador cadastrado.</div>';return;}
 members.forEach(p=>{
  const badges=[p.is_goalkeeper?'Goleiro':null,p.is_line_goalkeeper?'Goleiro linha':null,p.is_fixed?'Fixo · mensalista':null].filter(Boolean);
  const badgeMarkup=badges.length?badges.map(label=>`<span class="player-badge">${label}</span>`).join(''):'<span class="muted small">Sem marcações</span>';
  const d=document.createElement('article');d.className='item player-item';
  d.innerHTML=`<div class="player-main"><div class="player-name-row"><b>${esc(p.display_name)}</b><span class="pill">Nível ${p.skill_level}</span></div><div class="player-badges">${badgeMarkup}</div></div>${admin?`<div class="player-admin-controls"><label class="check-label"><input type="checkbox" data-player-flag="is_goalkeeper" data-player="${p.id}" ${p.is_goalkeeper?'checked':''}> Goleiro</label><label class="check-label"><input type="checkbox" data-player-flag="is_line_goalkeeper" data-player="${p.id}" ${p.is_line_goalkeeper?'checked':''}> Goleiro linha</label><label class="check-label"><input type="checkbox" data-player-flag="is_fixed" data-player="${p.id}" ${p.is_fixed?'checked':''}> Fixo</label><select aria-label="Nível de ${esc(p.display_name)}" data-level="${p.id}">${[1,2,3,4,5].map(n=>`<option ${n===p.skill_level?'selected':''} value="${n}">Nível ${n}</option>`).join('')}</select><button class="secondary" data-disable="${p.id}">Desativar</button></div>`:''}`;
  el.appendChild(d);
 });
 el.querySelectorAll('[data-level]').forEach(x=>x.onchange=async()=>{
  const id=x.dataset.level;const previous=members.find(p=>p.id===id)?.skill_level;
  x.disabled=true;
  const {error}=await db.from('group_members').update({skill_level:+x.value}).eq('id',id).eq('group_id',cfg.GROUP_ID);
  x.disabled=false;
  if(error){if(previous)x.value=String(previous);toast('Não foi possível atualizar o nível: '+error.message);return;}
  const p=members.find(p=>p.id===id);if(p)p.skill_level=+x.value;
  const name=members.find(p=>p.id===id)?.display_name||'Jogador';
  toast('Nível de '+name+' atualizado.');
 });
 el.querySelectorAll('[data-player-flag]').forEach(x=>x.addEventListener('change',async()=>{
  const id=x.dataset.player,field=x.dataset.playerFlag,next=x.checked;
  const player=members.find(p=>p.id===id);
  x.disabled=true;
  const {error}=await db.from('group_members').update({[field]:next}).eq('id',id).eq('group_id',cfg.GROUP_ID);
  x.disabled=false;
  if(error){x.checked=!next;toast('Não foi possível salvar a marcação: '+error.message);return;}
  if(player)player[field]=next;
  const labels={is_goalkeeper:'Goleiro',is_line_goalkeeper:'Goleiro linha',is_fixed:'Fixo / mensalista'};
  toast(`${labels[field]} ${next?'ativado':'desativado'} para ${player?.display_name||'jogador'}.`);
  await renderPlayers();
 }));
 el.querySelectorAll('[data-disable]').forEach(x=>x.onclick=async()=>{if(!confirm('Desativar jogador?'))return;const {error}=await db.from('group_members').update({active:false}).eq('id',x.dataset.disable).eq('group_id',cfg.GROUP_ID);if(error)toast(error.message);else await loadApp();});
}
$('match-form').addEventListener('submit',async e=>{e.preventDefault();const date=new Date($('match-date').value);if(isNaN(date))return toast('Data inválida');const {error}=await db.from('matches').insert({group_id:cfg.GROUP_ID,title:$('match-name').value.trim(),starts_at:date.toISOString(),location:$('match-location').value.trim()||null,player_limit:+$('match-limit').value,status:'scheduled'});if(error)return toast(error.message);await loadApp()});
async function renderMatches(){
 const el=$('matches');
 if(!matches.length){el.innerHTML='<div class="empty">Nenhum jogo criado.</div>';return}
 // Build the complete list off-DOM, then replace once. This prevents duplicate cards
 // if another refresh starts while attendance queries are still resolving.
 const fragment=document.createDocumentFragment();
 const uniqueMatches=Array.from(new Map(matches.map(match=>[match.id,match])).values());
 for(const m of uniqueMatches){
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
  fragment.appendChild(d);
 }
 el.replaceChildren(fragment);
 el.querySelectorAll('[data-links]').forEach(b=>b.onclick=()=>makeLinks(b.dataset.links));
}
async function makeLinks(matchId){if(!confirm('Gerar o link único desta pelada? Se já existir um link, ele será substituído e o anterior deixará de funcionar.'))return;const {data,error}=await db.rpc('create_match_attendance_link',{p_match_id:matchId});if(error)return toast('Não foi possível gerar o link: '+error.message);const url=location.origin+location.pathname+'?attendance='+encodeURIComponent(data);try{await navigator.clipboard.writeText(url);alert('Link único da pelada copiado! Compartilhe este mesmo link com a turma.\n\n'+url+'\n\nAtenção: se gerar outro link para esta pelada, o anterior será invalidado.')}catch{prompt('Copie o link único da pelada e compartilhe com a turma:',url)}}
function populateMatches(){const s=$('draw-match'),old=s.value;s.innerHTML=matches.filter(m=>m.status==='scheduled').map(m=>`<option value="${m.id}">${esc(m.title)} — ${dt(m.starts_at)}</option>`).join('');if(old)s.value=old}
function shufflePlayers(list){
 const copy=[...list];
 for(let i=copy.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[copy[i],copy[j]]=[copy[j],copy[i]];}
 return copy;
}
$('draw-form').addEventListener('submit',async e=>{
 e.preventDefault();
 const matchId=$('draw-match').value;
 const teamCount=Number($('team-count').value);
 if(!matchId)return toast('Crie um jogo primeiro.');
 const {data:attendance,error}=await db.from('attendance')
  .select('member_id,group_members(id,display_name,skill_level,is_goalkeeper,is_line_goalkeeper)')
  .eq('match_id',matchId).eq('status','confirmed');
 if(error)return toast('Não foi possível carregar os confirmados: '+error.message);
 const players=Array.from(new Map((attendance||[])
  .map(row=>row.group_members).filter(Boolean).map(player=>[player.id,player])).values())
  .map(player=>({...player,skill_level:Number(player.skill_level)||3}));
 if(players.length<teamCount)return toast('Não há jogadores suficientes para essa quantidade de times.');

 // Prioridade: goleiros cadastrados como goleiro. Só usamos goleiro linha para
 // preencher vagas de goleiro que continuem faltando.
 const primaryKeepers=shufflePlayers(players.filter(p=>p.is_goalkeeper));
 const lineKeepers=shufflePlayers(players.filter(p=>p.is_line_goalkeeper&&!p.is_goalkeeper));
 const chosenKeepers=primaryKeepers.slice(0,teamCount);
 if(chosenKeepers.length<teamCount){
  chosenKeepers.push(...lineKeepers.slice(0,teamCount-chosenKeepers.length));
 }
 // Não bloqueia o sorteio quando faltam goleiros elegíveis.
 // Todos os goleiros disponíveis serão designados; os demais times ficam sem goleiro marcado.


 const teams=Array.from({length:teamCount},(_,i)=>({
  name:'Time '+String.fromCharCode(65+i),players:[],sum:0,goalkeeper_member_id:null
 }));
 const selectedKeeperIds=new Set(chosenKeepers.map(p=>p.id));
 // Distribui primeiro os goleiros escolhidos, colocando o de maior nível no
 // time com menor soma atual; isso equilibra também a posição de goleiro.
 const orderedKeepers=shufflePlayers(chosenKeepers).sort((a,b)=>b.skill_level-a.skill_level);
 for(const keeper of orderedKeepers){
  const lowest=Math.min(...teams.map(t=>t.sum));
  const candidates=teams.filter(t=>t.sum===lowest);
  const team=candidates[Math.floor(Math.random()*candidates.length)];
  team.goalkeeper_member_id=keeper.id;
  team.players.push(keeper);
  team.sum+=keeper.skill_level;
 }

 // Distribui todos os demais confirmados pelo menor total de nível disponível.
 const fieldPlayers=shufflePlayers(players.filter(p=>!selectedKeeperIds.has(p.id)))
  .sort((a,b)=>b.skill_level-a.skill_level);
 for(const player of fieldPlayers){
  const lowest=Math.min(...teams.map(t=>t.sum));
  const candidates=teams.filter(t=>t.sum===lowest);
  const team=candidates[Math.floor(Math.random()*candidates.length)];
  team.players.push(player);
  team.sum+=player.skill_level;
 }

 const payload=teams.map(team=>({
  name:team.name,
  goalkeeper_member_id:team.goalkeeper_member_id,
  players:team.players.map(player=>({member_id:player.id,skill_level:player.skill_level}))
 }));
 const {error:saveError}=await db.rpc('save_balanced_teams',{p_match_id:matchId,p_teams:payload});
 if(saveError)return toast('Não foi possível salvar os times: '+saveError.message);
 await renderTeams();
 const assignedCount=teams.filter(team=>team.goalkeeper_member_id!==null).length;
 const keeperSummary=assignedCount===teamCount
  ? 'Todos os times têm goleiro designado.'
  : `${assignedCount} de ${teamCount} times têm goleiro designado; os demais ficaram sem goleiro por falta de jogadores elegíveis.`;
 toast('Times sorteados. '+keeperSummary);
});
async function renderTeams(){
 const el=$('teams');el.innerHTML='';
 for(const match of matches){
  const {data:teamRows,error}=await db.from('teams').select('id,name').eq('match_id',match.id).order('name');
  if(error)throw error;
  for(const team of teamRows||[]){
   const {data:players,error:playersError}=await db.from('team_players')
    .select('skill_level_at_draw,is_assigned_goalkeeper,group_members(display_name)')
    .eq('team_id',team.id);
   if(playersError)throw playersError;
   const roster=players||[];
   const total=roster.reduce((sum,p)=>sum+p.skill_level_at_draw,0);
   roster.sort((a,b)=>Number(Boolean(b.is_assigned_goalkeeper))-Number(Boolean(a.is_assigned_goalkeeper)));
   const card=document.createElement('article');card.className='team';
   card.innerHTML=`<div class="team-title-row"><h3>${esc(team.name)}</h3><span class="pill">Nível total ${total}</span></div><small>${esc(match.title)} · ${dt(match.starts_at)}</small><ul>${roster.map(p=>`<li>${esc(p.group_members?.display_name||'Jogador')} ${p.is_assigned_goalkeeper?'<span class="goalkeeper-tag">🧤 Goleiro deste time</span>':''} <span class="muted">(${p.skill_level_at_draw})</span></li>`).join('')}</ul>`;
   el.appendChild(card);
  }
 }
 if(!el.children.length)el.innerHTML='<div class="empty">Nenhum time sorteado.</div>';
}
function populateCashMembers(){
 const select=$('cash-member');
 if(!select)return;
 const current=select.value;
 select.innerHTML='<option value="">Selecione um jogador…</option>'+members.map(p=>`<option value="${p.id}">${esc(p.display_name)}</option>`).join('');
 if(members.some(p=>p.id===current))select.value=current;
}
function updateCashFields(){
 const isIncome=$('cash-type').value==='income';
 show('cash-member-wrap',isIncome);
 show('cash-month-wrap',isIncome);
 $('cash-member').required=isIncome;
 $('cash-month').required=isIncome;
}
$('cash-type').addEventListener('change',updateCashFields);
async function renderCash(){
 const {data:bal,error}=await db.rpc('get_group_balance',{p_group_id:cfg.GROUP_ID});
 if(error)throw error;
 $('cash-balance').textContent=money(bal);
 $('balance').textContent=money(bal);
 const el=$('transactions');el.innerHTML='';if(!admin)return;
 const {data:rows,error:err}=await db.from('cash_transactions')
  .select('type,amount_cents,description,occurred_at,member_id,reference_month,group_members(display_name)')
  .eq('group_id',cfg.GROUP_ID).order('occurred_at',{ascending:false}).limit(100);
 if(err)throw err;
 if(!rows?.length){el.innerHTML='<div class="empty">Nenhuma movimentação.</div>';return;}
 rows.forEach(t=>{
  const d=document.createElement('article');d.className='item';
  const month=t.reference_month?`${t.reference_month.slice(5,7)}/${t.reference_month.slice(0,4)}`:null;
  const detail=t.type==='income'
   ? `<small>Pago por: ${esc(t.group_members?.display_name || (t.member_id?'Jogador não encontrado':'Registro antigo sem vínculo'))}</small><small>Mês de referência: ${month?esc(month):'não informado (registro antigo)'}</small>`
   : '';
  d.innerHTML=`<div><b>${esc(t.description)}</b><small>${dt(t.occurred_at)}</small>${detail}</div><strong class="${t.type==='income'?'positive':'negative'}">${t.type==='income'?'+':'−'} ${money(t.amount_cents)}</strong>`;
  el.appendChild(d);
 });
}
$('cash-form').addEventListener('submit',async e=>{
 e.preventDefault();
 const type=$('cash-type').value;
 const value=Number($('cash-amount').value);
 if(!Number.isFinite(value)||value<=0)return toast('Informe um valor maior que zero.');
 let memberId=null, referenceMonth=null;
 if(type==='income'){
  memberId=$('cash-member').value;
  const month=$('cash-month').value;
  if(!memberId)return toast('Selecione o jogador que fez o pagamento.');
  if(!month)return toast('Informe o mês a que o pagamento se refere.');
  referenceMonth=`${month}-01`;
 }
 const payload={group_id:cfg.GROUP_ID,type,amount_cents:Math.round(value*100),description:$('cash-description').value.trim(),created_by:session.user.id,member_id:memberId,reference_month:referenceMonth};
 const {error}=await db.from('cash_transactions').insert(payload);
 if(error)return toast(error.message);
 $('cash-amount').value='';$('cash-description').value='';$('cash-member').value='';
 toast(type==='income'?'Pagamento registrado.':'Despesa registrada.');
 await renderCash();
});
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
  $('add-guest-button').disabled=true;
  show('guest-registration',false);
  show('public-roster-summary',false);
  msg('public-message','Este link não está mais disponível.',true);
  return;
 }
 const d=data[0];
 publicPlayers=data;
 show('guest-registration',true);
 $('add-guest-button').disabled=false;
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
async function respond(token,memberId,status){if(!memberId){msg('public-message','Escolhe teu nome primeiro.',true);return}$('yes').disabled=$('no').disabled=true;const {error}=await db.rpc('respond_to_match_attendance',{p_token:token,p_member_id:memberId,p_status:status});if(error){msg('public-message',error.message,true);renderSelectedAttendanceState();return}await loadAttendance(token,memberId);const player=publicPlayers.find(p=>p.member_id===memberId);if(player?.attendance_status==='waitlist')msg('public-message','A pelada está lotada. Você entrou na lista de espera.');else msg('public-message',status==='confirmed'?'Presença confirmada! ⚽':'Ausência registrada.')}

// A guest is created by a tightly-scoped server-side RPC using the match link token.
// The database sets skill_level=3 and records attendance in the same transaction.
$('guest-form').addEventListener('submit',async e=>{
 e.preventDefault();
 if(!publicToken)return;
 const name=$('guest-name').value.trim().replace(/\s+/g,' ');
 if(name.length<2||name.length>80){msg('guest-message','Informe um nome entre 2 e 80 caracteres.',true);return;}
 const button=$('add-guest-button');
 button.disabled=true;
 msg('guest-message','Cadastrando convidado…');
 try{
  const {data,error}=await db.rpc('add_guest_to_match',{p_token:publicToken,p_player_name:name});
  if(error){msg('guest-message',error.message||'Não foi possível cadastrar o convidado.',true);return;}
  $('guest-name').value='';
  await loadAttendance(publicToken,data);
  const added=publicPlayers.find(p=>p.member_id===data);
  if(added?.attendance_status==='waitlist')msg('guest-message',`${added.player_name} foi cadastrado como jogador nível 3, mas a pelada está lotada e entrou na lista de espera.`);
  else msg('guest-message',`${added?.player_name||name} foi cadastrado como jogador nível 3 e presença confirmada! ⚽`);
 }catch(err){msg('guest-message',err.message||'Ocorreu um erro ao cadastrar o convidado.',true)}
 finally{button.disabled=false;}
});

init().catch(e=>{console.error(e);toast('Erro: '+e.message)});
})();
