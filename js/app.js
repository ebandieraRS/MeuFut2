(() => {
const $=id=>document.getElementById(id), cfg=window.APP_CONFIG;
const money=c=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format((Number(c)||0)/100);
const dt=v=>v?new Date(v).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'}):'—';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const show=(id,on=true)=>$(id).classList.toggle('hidden',!on);
let db, session, admin=false, members=[], matches=[], publicPlayers=[], publicToken=null, publicGroupToken=null, publicGroupMatches=[], activePublicMatchId=null;
let teamDrafts=new Map(), dirtyTeamDivisions=new Set();
const cfgReady=cfg&&cfg.SUPABASE_URL?.startsWith('https://')&&!cfg.SUPABASE_URL.includes('SEU-PROJETO')&&cfg.SUPABASE_PUBLISHABLE_KEY&&!cfg.SUPABASE_PUBLISHABLE_KEY.includes('SUA_CHAVE')&&cfg.GROUP_ID&&!cfg.GROUP_ID.includes('UUID-');
function toast(s){$('toast').textContent=s;show('toast');setTimeout(()=>show('toast',false),3500)}
function msg(id,s,error=false){$(id).textContent=s;$(id).classList.toggle('error',error)}
function setup(){if(!cfgReady||!window.supabase){show('setup');$('setup').textContent='Edite js/config.js com a URL, publishable key e UUID do grupo Supabase.';return false}db=window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_PUBLISHABLE_KEY);return true}
async function init(){
 const q=new URLSearchParams(location.search);
 if(q.has('historico')){if(!setup())return;show('public-history');await loadMatchHistory('history-games-public');return}
 if(q.has('grupo')){if(!setup())return;show('public-attendance');await loadGroupAttendance(q.get('grupo'));return}
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
document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x===b));document.querySelectorAll('.tabpage').forEach(x=>x.classList.toggle('hidden',x.id!=='tab-'+b.dataset.tab));if(b.dataset.tab==='history')loadMatchHistory('history-games-admin')}));
$('refresh-history').addEventListener('click',()=>loadMatchHistory('history-games-admin'));
// Return to the authenticated dashboard in-place when a valid session exists.
// Public history is intentionally reachable without login, so only unauthenticated visitors
// should be sent back to the root page (which displays the login form).
const historyBack=$('history-back');
if(historyBack)historyBack.addEventListener('click',async e=>{
 e.preventDefault();
 try{
  const {data,error}=await db.auth.getSession();
  if(error)throw error;
  if(!data?.session){location.href='./';return;}
  session=data.session;
  show('public-history',false);
  renderAuth();
  await loadApp();
 }catch(err){
  toast('Não foi possível voltar ao painel: '+(err.message||'erro inesperado'));
 }
});
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
 teamDrafts.clear();dirtyTeamDivisions.clear();
 const userId = session.user.id;
 const {data:me,error}=await db.from('group_members').select('id,role').eq('group_id',cfg.GROUP_ID).eq('user_id',userId).eq('active',true).maybeSingle();
 if(error)throw error;if(!me){await db.auth.signOut();throw new Error('Esta conta não está cadastrada como integrante ativo do grupo.')}
 admin=me.role==='admin';document.querySelectorAll('.admin-only').forEach(el=>show(el.id?el.id:el,admin));
 const a=await db.from('group_members').select('id,display_name,skill_level,active,is_goalkeeper,is_line_goalkeeper,is_fixed').eq('group_id',cfg.GROUP_ID).eq('active',true).order('display_name');if(a.error)throw a.error;members=a.data||[];populateCashMembers();updateCashFields();
 const b=await db.from('matches').select('id,title,starts_at,location,player_limit,status,closed_at').eq('group_id',cfg.GROUP_ID).order('starts_at');if(b.error)throw b.error;
 // Keep the next open games at the top, followed by history (newest completed first).
 const statusRank={scheduled:0,completed:1,cancelled:2};
 matches=Array.from(new Map((b.data||[]).map(match=>[match.id,match])).values())
  .sort((a,b)=>{
   const rank=(statusRank[a.status]??9)-(statusRank[b.status]??9);
   if(rank!==0)return rank;
   const aDate=new Date(a.starts_at).getTime(),bDate=new Date(b.starts_at).getTime();
   return a.status==='scheduled'?aDate-bDate:bDate-aDate;
  });
 await renderPlayers();await renderMatches();await renderTeams();await renderCash();renderStats();populateMatches();await loadMatchHistory('history-games-admin');
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
$('match-form').addEventListener('submit',async e=>{
 e.preventDefault();
 if(!admin)return toast('Somente administradores podem criar peladas.');
 const matchTitle=$('match-name').value.trim();
 if(!matchTitle)return toast('Informe o nome da pelada.');
 const dateValue=$('match-date').value;
 const date=new Date(dateValue);
 if(!dateValue||Number.isNaN(date.getTime()))return toast('Informe uma data e hora válidas.');
 const {error}=await db.from('matches').insert({
  group_id:cfg.GROUP_ID,
  title:matchTitle,
  starts_at:date.toISOString(),
  location:$('match-location').value.trim()||null,
  player_limit:+$('match-limit').value,
  status:'scheduled'
 });
 if(error)return toast(error.message);
 toast(`Pelada criada: ${matchTitle}`);
 $('match-name').value='';
 $('match-date').value='';
 $('match-location').value='';
 $('match-limit').value='20';
 await loadApp();
});
function matchIsTodayOrPast(match){
 const date=new Date(match.starts_at);
 if(Number.isNaN(date.getTime()))return false;
 const matchDay=new Date(date.getFullYear(),date.getMonth(),date.getDate());
 const now=new Date();
 const today=new Date(now.getFullYear(),now.getMonth(),now.getDate());
 return matchDay<=today;
}
function matchStatusLabel(status){
 if(status==='completed')return 'Encerrada';
 if(status==='cancelled')return 'Cancelada';
 return 'Em aberto';
}
async function renderMatches(){
 const el=$('matches');
 if(!matches.length){el.innerHTML='<div class="empty">Nenhum jogo criado.</div>';return}
 const fragment=document.createDocumentFragment();
 const uniqueMatches=Array.from(new Map(matches.map(match=>[match.id,match])).values());
 for(const m of uniqueMatches){
  const {data:a,error}=await db.from('attendance').select('member_id,status').eq('match_id',m.id);
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
  const {data:teamRows,error:teamError}=await db.from('teams')
   .select('id,name,score').eq('match_id',m.id).order('name');
  if(teamError)throw teamError;
  const teams=teamRows||[];
  const allScoresSaved=teams.length>=2&&teams.every(t=>t.score!==null&&t.score!==undefined);
  const scoreMarkup=allScoresSaved
   ? `<small class="match-final-score"><b>Placar final:</b> ${teams.map(t=>`${esc(t.name)} ${t.score}`).join(' · ')}</small>`
   : (m.status==='completed'?'<small class="muted small">Placar não informado.</small>':'');
  const count=buckets.confirmed.length;
  const listMarkup=(names,emptyText)=>names.length?`<ul>${names.map(name=>`<li>${esc(name)}</li>`).join('')}</ul>`:`<p class="muted small">${emptyText}</p>`;
  const statusLabel=matchStatusLabel(m.status);
  const closeButton=admin&&m.status==='scheduled'&&matchIsTodayOrPast(m)
   ? `<button class="primary" data-close-match="${m.id}">Encerrar e salvar placar</button>`:'';
  const editScoreButton=admin&&m.status==='completed'
   ? `<button class="secondary" data-edit-score="${m.id}">Corrigir placar</button>`:'';
  const deleteButton=admin
   ? `<button class="secondary" data-delete-match="${m.id}" style="border-color:#ef4444;color:#b91c1c">Excluir pelada</button>`:'';
  const actions=[closeButton,editScoreButton,deleteButton].filter(Boolean).join('');
  const d=document.createElement('article');
  d.className='item match-item';
  d.innerHTML=`<div class="match-summary"><div>
      <b>${esc(m.title)}</b>
      <small>${dt(m.starts_at)}${m.location?' · '+esc(m.location):''}</small>
      <span class="pill">${statusLabel}</span> <span class="pill">${count}${m.player_limit?' / '+m.player_limit:''} confirmados</span>
      ${scoreMarkup}
    </div>${actions?`<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">${actions}</div>`:''}</div>
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
 el.querySelectorAll('[data-close-match]').forEach(b=>b.onclick=()=>closeMatchWithScore(b.dataset.closeMatch,false));
 el.querySelectorAll('[data-edit-score]').forEach(b=>b.onclick=()=>closeMatchWithScore(b.dataset.editScore,true));
 el.querySelectorAll('[data-delete-match]').forEach(b=>b.onclick=()=>deleteMatch(b.dataset.deleteMatch));
}
async function closeMatchWithScore(matchId,editing=false){
 if(!admin)return toast('Somente administradores podem encerrar peladas ou corrigir placares.');
 const match=matches.find(item=>item.id===matchId);
 if(!match)return toast('Pelada não encontrada. Atualize o painel e tente novamente.');
 if(!editing&&match.status!=='scheduled')return toast('Esta pelada não está em aberto.');
 if(editing&&match.status!=='completed')return toast('Somente peladas encerradas permitem corrigir o placar.');
 if(!editing&&!matchIsTodayOrPast(match))return toast('Só é possível encerrar a pelada no dia do jogo ou depois dele.');
 const {data:teamRows,error}=await db.from('teams')
  .select('id,name,score').eq('match_id',matchId).order('name');
 if(error)return toast('Não foi possível carregar a divisão salva: '+error.message);
 const teams=teamRows||[];
 if(teams.length<2)return toast('Ainda não há uma divisão de pelo menos dois times salva. Vá à aba Times e sorteie a divisão utilizada antes de encerrar a pelada.');
 const rosterByTeam=new Map(teams.map(team=>[team.id,[]]));
 const {data:rosterRows,error:rosterError}=await db.from('team_players')
  .select('team_id,member_id,group_members(display_name)')
  .in('team_id',teams.map(team=>team.id));
 if(rosterError)return toast('Não foi possível carregar os jogadores dos times: '+rosterError.message);
 for(const row of rosterRows||[]){
  const names=rosterByTeam.get(row.team_id);
  if(names)names.push(row.group_members?.display_name||'Jogador não encontrado');
 }
 for(const names of rosterByTeam.values())names.sort((a,b)=>a.localeCompare(b,'pt-BR',{sensitivity:'base'}));
 const actionText=editing?'corrigir o placar':'encerrar a pelada e salvar o placar';
 if(!confirm(`Deseja ${actionText} "${match.title}"?\n\nInforme os gols de cada time nas próximas janelas.${editing?' A divisão salva será mantida.':' A divisão atual ficará registrada no histórico e a pelada deixará de aceitar novas confirmações pelo link do grupo.'}`))return;
 const scores=[];
 for(const team of teams){
  let score=null;
  const roster=rosterByTeam.get(team.id)||[];
  const rosterText=roster.length?roster.map(name=>`• ${name}`).join('\n'):'(nenhum jogador encontrado)';
  while(score===null){
   const raw=window.prompt(`Placar final — ${team.name}\n\nJogadores do time:\n${rosterText}\n\nInforme os gols (número inteiro, zero ou maior):`,team.score===null||team.score===undefined?'0':String(team.score));
   if(raw===null)return;
   const normalized=raw.trim();
   if(/^\d+$/.test(normalized)&&Number.isSafeInteger(Number(normalized))&&Number(normalized)<=2147483647){
    score=Number(normalized);
   }else{
    alert('Informe um número inteiro igual ou maior que zero.');
   }
  }
  scores.push({team_id:team.id,score});
 }
 const {error:saveError}=await db.rpc('close_match_with_scores',{p_match_id:matchId,p_scores:scores});
 if(saveError)return toast('Não foi possível salvar o placar: '+saveError.message);
 toast(editing?'Placar corrigido.':'Pelada encerrada e placar salvo.');
 await loadApp();
}
async function deleteMatch(matchId){
 if(!admin)return toast('Somente administradores podem excluir peladas.');
 const match=matches.find(item=>item.id===matchId);
 if(!match)return toast('Pelada não encontrada. Atualize a página e tente novamente.');
 const warning=`Deseja realmente excluir a pelada "${match.title}" (${dt(match.starts_at)})?\n\nEsta ação remove a pelada, as presenças, os links e os times associados. Não pode ser desfeita.`;
 if(!confirm(warning))return;
 const {error}=await db.from('matches').delete().eq('id',matchId).eq('group_id',cfg.GROUP_ID);
 if(error){
  console.error('Erro ao excluir pelada:',error);
  return toast('Não foi possível excluir a pelada: '+error.message);
 }
 toast('Pelada excluída.');
 await loadApp();
}
$('group-attendance-link').addEventListener('click',makeGroupAttendanceLink);
async function makeGroupAttendanceLink(){
 if(!admin)return toast('Somente administradores podem gerar o link do grupo.');
 if(!confirm('Gerar ou renovar o link único do grupo? Se já existir um link, o anterior deixará de funcionar. Gere novamente somente se precisar substituir o link compartilhado.'))return;
 const {data,error}=await db.rpc('create_group_attendance_link',{p_group_id:cfg.GROUP_ID});
 if(error)return toast('Não foi possível gerar o link do grupo: '+error.message);
 const url=location.origin+location.pathname+'?grupo='+encodeURIComponent(data);
 try{
  await navigator.clipboard.writeText(url);
  alert('Link único do grupo copiado! Compartilhe este mesmo link com a turma para confirmar qualquer pelada agendada.\n\n'+url+'\n\nEste link permanece válido até ser renovado.');
 }catch{prompt('Copie o link único do grupo e compartilhe com a turma:',url)}
}
function populateMatches(){
 const s=$('draw-match'),old=s.value;
 s.innerHTML=matches.filter(m=>m.status==='scheduled').map(m=>`<option value="${m.id}">${esc(m.title)} — ${dt(m.starts_at)}</option>`).join('');
 if(old)s.value=old;
 populateCashMatches();
}
function populateCashMatches(){
 const s=$('cash-match');
 if(!s)return;
 const old=s.value;
 // Completed games are valid for recording their court payment; cancelled games are excluded.
 const eligible=matches.filter(m=>m.status!=='cancelled');
 s.innerHTML='<option value="">Selecione um jogo…</option>'+eligible.map(m=>`<option value="${m.id}">${esc(m.title)} — ${new Date(m.starts_at).toLocaleDateString('pt-BR')}</option>`).join('');
 if(eligible.some(m=>m.id===old))s.value=old;
 updateCashDescription();
}
function monthReferenceLabel(value){
 if(!value)return '';
 const parts=value.split('-');
 if(parts.length!==2)return '';
 const year=Number(parts[0]),month=Number(parts[1]);
 if(!year||month<1||month>12)return '';
 const monthName=new Intl.DateTimeFormat('pt-BR',{month:'long',timeZone:'UTC'}).format(new Date(Date.UTC(year,month-1,1)));
 return `${monthName}/${year}`;
}
function matchDateLabel(match){
 const date=new Date(match.starts_at);
 return Number.isNaN(date.getTime())?'':date.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric'});
}
function updateCashDescription(){
 const description=$('cash-description');
 if(!description)return;
 if($('cash-type').value==='income'){
  const monthLabel=monthReferenceLabel($('cash-month').value);
  description.value=monthLabel?`Mensalidade mês ${monthLabel}`:'';
  $('cash-description-help').textContent=monthLabel
   ?`Descrição automática para a referência ${monthLabel}.`
   :'Selecione o mês de referência.';
 }else{
  const selectedMatch=$('cash-match').value;
  const match=matches.find(m=>m.id===selectedMatch);
  const dateLabel=match?matchDateLabel(match):'';
  description.value=dateLabel?`Pagamento quadra + ${dateLabel}`:'';
  $('cash-description-help').textContent=match
   ?`Despesa vinculada a ${match.title}, em ${dateLabel}.`
   :'Selecione o jogo ao qual o pagamento da quadra se refere.';
 }
}
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
  .select('member_id,group_members(id,group_id,display_name,skill_level,active,is_goalkeeper,is_line_goalkeeper)')
  .eq('match_id',matchId).eq('status','confirmed');
 if(error)return toast('Não foi possível carregar os confirmados: '+error.message);
 const attendanceRows=attendance||[];
 const inactiveConfirmed=attendanceRows.filter(row=>row.group_members && row.group_members.active===false).length;
 const players=Array.from(new Map(attendanceRows
  .filter(row=>row.group_members && row.group_members.active===true && row.group_members.id===row.member_id && row.group_members.group_id===cfg.GROUP_ID)
  .map(row=>row.group_members).map(player=>[player.id,player])).values())
  .map(player=>({...player,skill_level:Number(player.skill_level)||3}));
 if(players.length<teamCount){
  const extra=inactiveConfirmed?' Há '+inactiveConfirmed+' confirmado(s) desativado(s), que foram ignorados no sorteio.':'';
  return toast('Não há jogadores ativos suficientes para essa quantidade de times.'+extra);
 }

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
 teamDrafts.delete(matchId);dirtyTeamDivisions.delete(matchId);
 await renderTeams();
 const assignedCount=teams.filter(team=>team.goalkeeper_member_id!==null).length;
 const keeperSummary=assignedCount===teamCount
  ? 'Todos os times têm goleiro designado.'
  : `${assignedCount} de ${teamCount} times têm goleiro designado; os demais ficaram sem goleiro por falta de jogadores elegíveis.`;
 const skippedNote=inactiveConfirmed?` ${inactiveConfirmed} confirmado(s) desativado(s) ficaram fora do sorteio.`:'';
 toast('Times sorteados. '+keeperSummary+skippedNote);
});
async function renderTeams(){
 const el=$('teams');el.innerHTML='';
 let savedDivisionCount=0;
 for(const match of matches){
  let teams=teamDrafts.get(match.id);
  if(!teams){
   const {data:teamRows,error}=await db.from('teams').select('id,name,score').eq('match_id',match.id).order('name');
   if(error)throw error;
   teams=[];
   for(const team of teamRows||[]){
    const {data:players,error:playersError}=await db.from('team_players')
     .select('member_id,skill_level_at_draw,is_assigned_goalkeeper,group_members(id,display_name,active,is_goalkeeper,is_line_goalkeeper)')
     .eq('team_id',team.id);
    if(playersError)throw playersError;
    const roster=(players||[]).map(p=>({
     id:p.member_id,
     display_name:p.group_members?.display_name||'Jogador não encontrado',
     active:p.group_members?.active===true,
     is_goalkeeper:p.group_members?.is_goalkeeper===true,
     is_line_goalkeeper:p.group_members?.is_line_goalkeeper===true,
     skill_level_at_draw:Number(p.skill_level_at_draw)||0,
     is_assigned_goalkeeper:p.is_assigned_goalkeeper===true
    }));
    const goalkeeper=roster.find(p=>p.is_assigned_goalkeeper);
    teams.push({id:team.id,name:team.name,score:team.score,goalkeeper_member_id:goalkeeper?.id||null,players:roster});
   }
   teamDrafts.set(match.id,teams);
  }
  if(!teams.length)continue;
  savedDivisionCount+=teams.length;
  const editable=admin&&match.status==='scheduled';
  const isDirty=dirtyTeamDivisions.has(match.id);
  const teamCards=teams.map(team=>{
   const roster=[...team.players].sort((a,b)=>Number(b.id===team.goalkeeper_member_id)-Number(a.id===team.goalkeeper_member_id)||a.display_name.localeCompare(b.display_name,'pt-BR',{sensitivity:'base'}));
   const total=roster.reduce((sum,p)=>sum+p.skill_level_at_draw,0);
   const playerRows=roster.map(player=>{
    const keeper=player.id===team.goalkeeper_member_id;
    const inactiveNote=player.active?'':' <span class="muted small">(jogador desativado; mantido na divisão)</span>';
    const mover=editable?`<label class="team-move-control">Mover para<select data-player-move="${esc(player.id)}" data-match-move="${esc(match.id)}" data-current-team="${esc(team.name)}" ${player.active?'':'disabled'}>${teams.map(target=>`<option value="${esc(target.name)}" ${target.name===team.name?'selected':''}>${esc(target.name)}</option>`).join('')}</select></label>`:'';
    return `<li class="team-player-row"><div><span>${esc(player.display_name)}</span> ${keeper?'<span class="goalkeeper-tag">🧤 Goleiro deste time</span>':''} <span class="muted">(${player.skill_level_at_draw})</span>${inactiveNote}</div>${mover}</li>`;
   }).join('');
   return `<article class="team"><div class="team-title-row"><h3>${esc(team.name)}</h3><span class="pill">Nível total ${total}</span>${team.score!==null&&team.score!==undefined?`<span class="pill">Placar: ${team.score}</span>`:''}</div><small>${match.status==='scheduled'?'':matchStatusLabel(match.status)}</small><ul class="team-roster">${playerRows}</ul></article>`;
  }).join('');
  const controls=editable?`<div class="team-division-actions"><p class="muted small">Ajuste a divisão pelos seletores “Mover para”. Cada time precisa manter ao menos um jogador.</p><div><button class="primary" data-save-division="${esc(match.id)}" ${isDirty?'':'disabled'}>Salvar divisão ajustada</button> <button class="secondary" data-cancel-division="${esc(match.id)}" ${isDirty?'':'disabled'}>Descartar ajustes</button></div></div>`:'';
  const block=document.createElement('section');
  block.className='team-division-block';
  block.innerHTML=`<div class="team-division-heading"><div><h3>${esc(match.title)}</h3><small>${dt(match.starts_at)} · ${matchStatusLabel(match.status)}</small></div>${isDirty?'<span class="pill team-unsaved">Alterações não salvas</span>':''}</div>${controls}<div class="team-grid">${teamCards}</div>`;
  el.appendChild(block);
 }
 if(!savedDivisionCount)el.innerHTML='<div class="empty">Nenhum time sorteado.</div>';
}

$('teams').addEventListener('change',async e=>{
 const select=e.target.closest('[data-player-move]');
 if(!select)return;
 if(!admin)return toast('Somente administradores podem ajustar a divisão.');
 const matchId=select.dataset.matchMove,playerId=select.dataset.playerMove,targetName=select.value,currentName=select.dataset.currentTeam;
 const match=matches.find(m=>m.id===matchId);
 if(!match||match.status!=='scheduled')return toast('Somente peladas em aberto podem ter a divisão ajustada.');
 const teams=teamDrafts.get(matchId)||[];
 const source=teams.find(t=>t.name===currentName),target=teams.find(t=>t.name===targetName);
 if(!source||!target||source===target){await renderTeams();return;}
 if(source.players.length<=1){toast('Cada time precisa manter ao menos um jogador.');await renderTeams();return;}
 const index=source.players.findIndex(p=>p.id===playerId);
 if(index<0){await renderTeams();return;}
 const [player]=source.players.splice(index,1);
 if(source.goalkeeper_member_id===player.id)source.goalkeeper_member_id=null;
 target.players.push(player);
 if(!target.goalkeeper_member_id&&(player.is_goalkeeper||player.is_line_goalkeeper))target.goalkeeper_member_id=player.id;
 dirtyTeamDivisions.add(matchId);
 await renderTeams();
});

$('teams').addEventListener('click',async e=>{
 const save=e.target.closest('[data-save-division]');
 if(save){await saveManualDivision(save.dataset.saveDivision);return;}
 const cancel=e.target.closest('[data-cancel-division]');
 if(cancel){
  const matchId=cancel.dataset.cancelDivision;
  if(dirtyTeamDivisions.has(matchId)&&!confirm('Descartar todos os ajustes manuais desta divisão?'))return;
  dirtyTeamDivisions.delete(matchId);teamDrafts.delete(matchId);await renderTeams();
 }
});

async function saveManualDivision(matchId){
 if(!admin)return toast('Somente administradores podem ajustar a divisão.');
 const match=matches.find(m=>m.id===matchId);
 if(!match||match.status!=='scheduled')return toast('Somente peladas em aberto podem ter a divisão ajustada.');
 if(!dirtyTeamDivisions.has(matchId))return;
 const teams=teamDrafts.get(matchId)||[];
 if(teams.length<2)return toast('A divisão precisa ter pelo menos dois times.');
 if(teams.some(team=>team.players.length===0))return toast('Cada time precisa ter ao menos um jogador.');
 const playerIds=teams.flatMap(team=>team.players.map(player=>player.id));
 if(new Set(playerIds).size!==playerIds.length)return toast('Um jogador não pode estar em dois times.');
 const payload=teams.map(team=>({
  name:team.name,
  goalkeeper_member_id:team.goalkeeper_member_id,
  players:team.players.map(player=>({member_id:player.id,skill_level:player.skill_level_at_draw}))
 }));
 const button=Array.from($('teams').querySelectorAll('[data-save-division]')).find(b=>b.dataset.saveDivision===matchId);
 if(button)button.disabled=true;
 const {error}=await db.rpc('save_balanced_teams',{p_match_id:matchId,p_teams:payload});
 if(error){if(button)button.disabled=false;return toast('Não foi possível salvar a divisão ajustada: '+error.message);}
 dirtyTeamDivisions.delete(matchId);teamDrafts.delete(matchId);
 toast('Divisão manual salva. Ela será preservada ao encerrar a pelada.');
 await loadApp();
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
 show('cash-match-wrap',!isIncome);
 $('cash-member').required=isIncome;
 $('cash-month').required=isIncome;
 $('cash-match').required=!isIncome;
 updateCashDescription();
}
$('cash-type').addEventListener('change',updateCashFields);
$('cash-month').addEventListener('change',updateCashDescription);
$('cash-match').addEventListener('change',updateCashDescription);
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
 if(!admin)return toast('Somente administradores podem registrar movimentações.');
 const type=$('cash-type').value;
 const value=Number($('cash-amount').value);
 if(!Number.isFinite(value)||value<=0)return toast('Informe um valor maior que zero.');

 let memberId=null, referenceMonth=null, relatedMatchId=null, description='';
 if(type==='income'){
  memberId=$('cash-member').value;
  const month=$('cash-month').value;
  if(!memberId)return toast('Selecione o jogador que fez o pagamento.');
  if(!month)return toast('Informe o mês a que o pagamento se refere.');
  referenceMonth=`${month}-01`;
  const monthLabel=monthReferenceLabel(month);
  if(!monthLabel)return toast('Mês de referência inválido.');
  description=`Mensalidade mês ${monthLabel}`;
 }else{
  relatedMatchId=$('cash-match').value;
  if(!relatedMatchId)return toast('Selecione o jogo a que o pagamento da quadra se refere.');
  const match=matches.find(m=>m.id===relatedMatchId);
  if(!match)return toast('O jogo selecionado não foi encontrado. Atualize o painel e tente novamente.');
  const dateLabel=matchDateLabel(match);
  if(!dateLabel)return toast('Não foi possível obter a data do jogo.');
  description=`Pagamento quadra + ${dateLabel}`;
 }
 $('cash-description').value=description;
 const payload={
  group_id:cfg.GROUP_ID,
  type,
  amount_cents:Math.round(value*100),
  description,
  created_by:session.user.id,
  member_id:memberId,
  reference_month:referenceMonth,
  match_id:relatedMatchId
 };
 const {error}=await db.from('cash_transactions').insert(payload);
 if(error)return toast(error.message);
 $('cash-amount').value='';
 $('cash-description').value='';
 $('cash-member').value='';
 $('cash-month').value='';
 $('cash-match').value='';
 updateCashFields();
 toast(type==='income'?'Mensalidade registrada.':'Pagamento da quadra registrado.');
 await renderCash();
});
function renderStats(){const m=matches.find(x=>x.status==='scheduled'&&new Date(x.starts_at)>=new Date());$('next-game').textContent=m?.title||'—';$('next-date').textContent=m?dt(m.starts_at):'Nenhum jogo futuro';if(!m){$('confirmed').textContent='0';return}db.from('attendance').select('id',{count:'exact',head:true}).eq('match_id',m.id).eq('status','confirmed').then(r=>{if(!r.error)$('confirmed').textContent=String(r.count||0)})}
async function loadPublicBalance(){const {data,error}=await db.rpc('get_group_balance',{p_group_id:cfg.GROUP_ID});if(error){msg('balance-message','Não foi possível consultar o saldo: '+error.message,true);return}$('public-balance-value').textContent=money(data)}
async function loadMatchHistory(containerId){
 const el=$(containerId);if(!el||!db)return;
 el.innerHTML='<div class="empty">Carregando histórico…</div>';
 const {data,error}=await db.rpc('get_public_match_history',{p_group_id:cfg.GROUP_ID});
 if(error){
  el.innerHTML=`<div class="empty history-error">Não foi possível carregar o histórico. Confirme se a migração <b>013_public_match_history.sql</b> foi executada no Supabase.<small>${esc(error.message)}</small></div>`;
  return;
 }
 const games=Array.isArray(data)?data:[];
 if(!games.length){el.innerHTML='<div class="empty">Ainda não há peladas encerradas com histórico disponível.</div>';return;}
 el.innerHTML=games.map(game=>{
  const teams=Array.isArray(game.teams)?game.teams:[];
  const allScoresKnown=teams.length===2&&teams.every(team=>team.score!==null&&team.score!==undefined);
  const scoreline=allScoresKnown?`<div class="history-scoreline"><span>${esc(teams[0].name||'Time A')}</span><strong>${esc(teams[0].score)} <i>×</i> ${esc(teams[1].score)}</strong><span>${esc(teams[1].name||'Time B')}</span></div>`:'';
  const teamsMarkup=teams.length?teams.map(team=>{
   const players=Array.isArray(team.players)?team.players:[];
   const roster=players.length?`<ul>${players.map(name=>`<li>${esc(name)}</li>`).join('')}</ul>`:'<p class="muted small">Nenhum jogador registrado nesta equipe.</p>';
   const score=team.score===null||team.score===undefined?'—':esc(team.score);
   return `<article class="history-team"><div class="history-team-heading"><h3>${esc(team.name||'Time')}</h3><span class="history-team-score">${score} <small>gols</small></span></div>${roster}</article>`;
  }).join(''):'<div class="empty">A divisão dos times não foi salva para esta pelada.</div>';
  const when=dt(game.starts_at);
  const location=game.location?` · ${esc(game.location)}`:'';
  return `<article class="history-game"><div class="history-game-heading"><div><p class="eyebrow">PELADEIRA ENCERRADA</p><h2>${esc(game.title||'Pelada sem nome')}</h2><small>${when}${location}</small></div><span class="pill history-closed-pill">Encerrada</span></div>${scoreline}<div class="history-teams">${teamsMarkup}</div></article>`;
 }).join('');
}
function fillRosterList(id, players, emptyText){
 const el=$(id);el.innerHTML='';
 if(!players.length){const li=document.createElement('li');li.className='muted empty-list-item';li.textContent=emptyText;el.appendChild(li);return}
 players.forEach(player=>{const li=document.createElement('li');li.textContent=player.player_name;el.appendChild(li)});
}
function buildAttendanceClipboardText(){
 const uniquePlayers=Array.from(new Map((publicPlayers||[]).map(player=>[player.member_id,player])).values());
 // Use each player's latest response timestamp; do not sort alphabetically.
 const inResponseOrder=list=>[...list].sort((a,b)=>{
  const ta=a.attendance_updated_at?new Date(a.attendance_updated_at).getTime():Number.MAX_SAFE_INTEGER;
  const tb=b.attendance_updated_at?new Date(b.attendance_updated_at).getTime():Number.MAX_SAFE_INTEGER;
  return ta-tb;
 }).map(player=>String(player.player_name||'').trim()).filter(Boolean);
 const confirmed=inResponseOrder(uniquePlayers.filter(player=>player.attendance_status==='confirmed'));
 const outside=inResponseOrder(uniquePlayers.filter(player=>player.attendance_status==='declined'));
 const startsAt=uniquePlayers[0]?.starts_at;
 let dayMonth='';
 if(startsAt){
  const date=new Date(startsAt);
  if(!Number.isNaN(date.getTime()))dayMonth=`${String(date.getDate()).padStart(2,'0')}/${String(date.getMonth()+1).padStart(2,'0')}`;
 }
 const confirmationLink=publicGroupToken
  ? `${location.origin}${location.pathname}?grupo=${encodeURIComponent(publicGroupToken)}`
  : publicToken
   ? `${location.origin}${location.pathname}?attendance=${encodeURIComponent(publicToken)}`
   : '';
 const linkLine=confirmationLink?`Link para confirmar presença: ${confirmationLink}`:'';
 return [`Lista Jogo${dayMonth?' '+dayMonth:''}`,'',linkLine,'',
  ...confirmed.map((name,index)=>`${index+1}. ${name}`),
  '','','FORA','',...outside].join('\n').trimEnd();
}
async function copyAttendanceListToClipboard(){
 const text=buildAttendanceClipboardText();
 try{
  if(navigator.clipboard&&window.isSecureContext){
   await navigator.clipboard.writeText(text);
   return true;
  }
 }catch(error){console.warn('Clipboard API falhou; tentando método alternativo.',error)}
 // Fallback para navegadores que bloqueiam Clipboard API após chamadas de rede.
 const textarea=document.createElement('textarea');
 textarea.value=text;textarea.setAttribute('readonly','');
 textarea.style.position='fixed';textarea.style.left='-9999px';textarea.style.top='0';
 document.body.appendChild(textarea);textarea.focus();textarea.select();
 let copied=false;
 try{copied=document.execCommand('copy')}catch(error){console.warn('Cópia alternativa falhou.',error)}
 textarea.remove();
 if(!copied){window.prompt('Copie esta lista de presença:',text);return false}
 return true;
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
 publicGroupToken=null;
 activePublicMatchId=null;
 show('public-match-wrap',false);
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
 const alphabeticPlayers=[...publicPlayers].sort((a,b)=>String(a.player_name||'').localeCompare(String(b.player_name||''),'pt-BR',{sensitivity:'base'}));
 select.innerHTML='<option value="">Selecione teu nome…</option>'+alphabeticPlayers.map(p=>`<option value="${p.member_id}">${esc(p.player_name)}</option>`).join('');
 if(previous&&publicPlayers.some(p=>p.member_id===previous))select.value=previous;
 select.disabled=false;
 select.onchange=renderSelectedAttendanceState;
 $('yes').onclick=()=>respond(token,select.value,'confirmed');
 $('no').onclick=()=>respond(token,select.value,'declined');
 renderSelectedAttendanceState();
 renderPublicRoster();
}
async function loadGroupAttendance(token,preserveMatchId=null,preserveMemberId=null){
 publicGroupToken=token;
 publicToken=null;
 show('public-match-wrap',true);
 $('yes').disabled=$('no').disabled=true;
 $('public-match-select').disabled=true;
 $('public-member-select').disabled=true;
 const {data,error}=await db.rpc('get_group_attendance_matches',{p_token:token});
 if(error){
  $('public-title').textContent='Não foi possível carregar as peladas';
  $('public-meta').textContent='';
  msg('public-message','Erro ao carregar o link do grupo: '+error.message,true);
  show('public-roster-summary',false);
  return;
 }
 publicGroupMatches=Array.from(new Map((data||[]).map(match=>[match.match_id,match])).values());
 if(!publicGroupMatches.length){
  activePublicMatchId=null;
  $('public-title').textContent='Nenhuma pelada disponível';
  $('public-meta').textContent='';
  $('public-match-select').innerHTML='<option value="">Nenhuma pelada agendada</option>';
  $('public-member-select').innerHTML='<option value="">Nenhum jogador disponível</option>';
  $('public-match-select').disabled=true;
  $('public-member-select').disabled=true;
  $('yes').disabled=$('no').disabled=true;
  $('add-guest-button').disabled=true;
  show('guest-registration',false);
  show('public-roster-summary',false);
  msg('public-message','Não há peladas agendadas neste grupo ou o link não é mais válido. Peça ao administrador para verificar.',true);
  return;
 }
 const select=$('public-match-select');
 const previous=preserveMatchId||select.value;
 select.innerHTML=publicGroupMatches.map(match=>`<option value="${match.match_id}">${esc(match.match_title)} — ${dt(match.starts_at)}</option>`).join('');
 activePublicMatchId=publicGroupMatches.some(m=>m.match_id===previous)?previous:publicGroupMatches[0].match_id;
 select.value=activePublicMatchId;
 select.disabled=false;
 select.onchange=async()=>{
  const memberId=$('public-member-select').value;
  activePublicMatchId=select.value;
  try{await loadGroupMatchAttendance(token,activePublicMatchId,memberId)}catch(err){msg('public-message','Não foi possível carregar a pelada: '+err.message,true)}
 };
 await loadGroupMatchAttendance(token,activePublicMatchId,preserveMemberId);
}
async function loadGroupMatchAttendance(token,matchId,preserveMemberId=null){
 publicGroupToken=token;
 publicToken=null;
 activePublicMatchId=matchId;
 const match=publicGroupMatches.find(m=>m.match_id===matchId);
 if(!match){msg('public-message','Selecione uma pelada disponível.',true);return}
 $('yes').disabled=$('no').disabled=true;
 $('public-member-select').disabled=true;
 const {data,error}=await db.rpc('get_group_match_attendance_info',{p_token:token,p_match_id:matchId});
 if(error){msg('public-message','Não foi possível carregar a lista de jogadores: '+error.message,true);return}
 publicPlayers=(data||[]).map(player=>({...match,...player,match_id:match.match_id,match_title:match.match_title,starts_at:match.starts_at,location:match.location,player_limit:match.player_limit}));
 show('guest-registration',true);
 $('add-guest-button').disabled=false;
 $('public-title').textContent=match.match_title;
 $('public-meta').textContent=dt(match.starts_at)+(match.location?' · '+match.location:'');
 const select=$('public-member-select');
 const previous=preserveMemberId||select.value;
 const alphabeticPlayers=[...publicPlayers].sort((a,b)=>String(a.player_name||'').localeCompare(String(b.player_name||''),'pt-BR',{sensitivity:'base'}));
 select.innerHTML='<option value="">Selecione teu nome…</option>'+alphabeticPlayers.map(p=>`<option value="${p.member_id}">${esc(p.player_name)}</option>`).join('');
 if(previous&&publicPlayers.some(p=>p.member_id===previous))select.value=previous;else select.value='';
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
 if(!publicToken&&!publicGroupToken)return;
 const memberId=$('public-member-select').value;
 $('public-refresh-roster').disabled=true;
 try{if(publicGroupToken)await loadGroupMatchAttendance(publicGroupToken,activePublicMatchId,memberId);else await loadAttendance(publicToken,memberId)}catch(e){msg('public-message','Não foi possível atualizar a lista: '+e.message,true)}
 finally{$('public-refresh-roster').disabled=false}
});
async function respond(token,memberId,status){
 if(!memberId){msg('public-message','Escolhe teu nome primeiro.',true);return}
 $('yes').disabled=$('no').disabled=true;
 let error=null;
 const matchId=publicGroupToken?activePublicMatchId:null;
 if(publicGroupToken){
  const result=await db.rpc('respond_to_group_match_attendance',{p_token:token,p_match_id:matchId,p_member_id:memberId,p_status:status});
  error=result.error;
 }else{
  const result=await db.rpc('respond_to_match_attendance',{p_token:token,p_member_id:memberId,p_status:status});
  error=result.error;
 }
 if(error){msg('public-message',error.message,true);renderSelectedAttendanceState();return}
 if(publicGroupToken)await loadGroupMatchAttendance(publicGroupToken,matchId,memberId);
 else await loadAttendance(token,memberId);
 const player=publicPlayers.find(p=>p.member_id===memberId);
 const responseMessage=player?.attendance_status==='waitlist'?'A pelada está lotada. Você entrou na lista de espera.':status==='confirmed'?'Presença confirmada! ⚽':'Ausência registrada.';
 msg('public-message',responseMessage);
 const copied=await copyAttendanceListToClipboard();
 if(copied)msg('public-message',responseMessage+' Lista atualizada copiada para a área de transferência.');
 else msg('public-message',responseMessage+' Se a cópia automática não funcionou, a lista ficou disponível na janela para copiar manualmente.');
}

// A guest is created by a tightly-scoped server-side RPC using the match link token.
// The database sets skill_level=3 and records attendance in the same transaction.
$('guest-form').addEventListener('submit',async e=>{
 e.preventDefault();
 if(!publicToken&&!publicGroupToken)return;
 const name=$('guest-name').value.trim().replace(/\s+/g,' ');
 if(name.length<2||name.length>80){msg('guest-message','Informe um nome entre 2 e 80 caracteres.',true);return;}
 const button=$('add-guest-button');
 button.disabled=true;
 msg('guest-message','Cadastrando convidado…');
 try{
  let data,error;
  if(publicGroupToken){
   ({data,error}=await db.rpc('add_guest_to_group_match',{p_token:publicGroupToken,p_match_id:activePublicMatchId,p_player_name:name}));
  }else{
   ({data,error}=await db.rpc('add_guest_to_match',{p_token:publicToken,p_player_name:name}));
  }
  if(error){msg('guest-message',error.message||'Não foi possível cadastrar o convidado.',true);return;}
  $('guest-name').value='';
  if(publicGroupToken)await loadGroupMatchAttendance(publicGroupToken,activePublicMatchId,data);
  else await loadAttendance(publicToken,data);
  const added=publicPlayers.find(p=>p.member_id===data);
  if(added?.attendance_status==='waitlist')msg('guest-message',`${added.player_name} foi cadastrado como jogador nível 3, mas a pelada está lotada e entrou na lista de espera.`);
  else msg('guest-message',`${added?.player_name||name} foi cadastrado como jogador nível 3 e presença confirmada! ⚽`);
 }catch(err){msg('guest-message',err.message||'Ocorreu um erro ao cadastrar o convidado.',true)}
 finally{button.disabled=false;}
});

init().catch(e=>{console.error(e);toast('Erro: '+e.message)});
})();
