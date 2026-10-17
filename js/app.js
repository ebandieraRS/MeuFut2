(() => {
const $=id=>document.getElementById(id), cfg=window.APP_CONFIG;
const money=c=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format((Number(c)||0)/100);
const dt=v=>v?new Date(v).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'}):'—';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const show=(id,on=true)=>$(id).classList.toggle('hidden',!on);
let db, session, admin=false, members=[], matches=[];
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
document.querySelectorAll('.tab').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => {
      x.classList.toggle('active', x === b);
    });

    document.querySelectorAll('.tabpage').forEach(x => {
      x.classList.toggle(
        'hidden',
        x.id !== `tab-${b.dataset.tab}`
      );
    });
  });
});
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
async function renderMatches(){const el=$('matches');el.innerHTML='';if(!matches.length){el.innerHTML='<div class="empty">Nenhum jogo criado.</div>';return}
for(const m of matches){const {data:a,error}=await db.from('attendance').select('status').eq('match_id',m.id);if(error)throw error;const count=(a||[]).filter(x=>x.status==='confirmed').length;const d=document.createElement('article');d.className='item';d.innerHTML=`<div><b>${esc(m.title)}</b><small>${dt(m.starts_at)}${m.location?' · '+esc(m.location):''}</small><span class="pill">${count}${m.player_limit?' / '+m.player_limit:''} confirmados</span></div>${admin?`<button class="secondary" data-links="${m.id}">Gerar links individuais</button>`:''}`;el.appendChild(d)}
el.querySelectorAll('[data-links]').forEach(b=>b.onclick=()=>makeLinks(b.dataset.links))}
async function makeLinks(matchId){const rows=[];for(const p of members){const {data,error}=await db.rpc('create_attendance_link',{p_match_id:matchId,p_member_id:p.id});if(error)return toast(error.message);rows.push(`${p.display_name}: ${location.origin+location.pathname}?attendance=${encodeURIComponent(data)}`)}const text=rows.join('\n');try{await navigator.clipboard.writeText(text);alert('Links copiados. Envie cada link somente ao jogador correspondente:\n\n'+text)}catch{prompt('Copie os links e envie individualmente:',text)}}
function populateMatches(){const s=$('draw-match'),old=s.value;s.innerHTML=matches.filter(m=>m.status==='scheduled').map(m=>`<option value="${m.id}">${esc(m.title)} — ${dt(m.starts_at)}</option>`).join('');if(old)s.value=old}
$('draw-form').addEventListener('submit',async e=>{e.preventDefault();const id=$('draw-match').value,n=+$('team-count').value;if(!id)return toast('Crie um jogo primeiro');const {data:a,error}=await db.from('attendance').select('member_id, group_members(id,display_name,skill_level)').eq('match_id',id).eq('status','confirmed');if(error)return toast(error.message);const ps=(a||[]).map(x=>x.group_members).filter(Boolean).map(p=>({...p,tie:Math.random()}));if(ps.length<n)return toast('Não há jogadores suficientes');ps.sort((x,y)=>y.skill_level-x.skill_level||x.tie-y.tie);const ts=Array.from({length:n},(_,i)=>({name:'Time '+String.fromCharCode(65+i),players:[],sum:0}));for(const p of ps){const min=Math.min(...ts.map(t=>t.sum)),opts=ts.filter(t=>t.sum===min),t=opts[Math.floor(Math.random()*opts.length)];t.players.push({member_id:p.id,skill_level:p.skill_level});t.sum+=p.skill_level}const {error:saveErr}=await db.rpc('save_balanced_teams',{p_match_id:id,p_teams:ts});if(saveErr)return toast(saveErr.message);await renderTeams();toast('Times sorteados')});
async function renderTeams(){const el=$('teams');el.innerHTML='';for(const m of matches){const {data:ts,error}=await db.from('teams').select('id,name').eq('match_id',m.id);if(error)throw error;for(const t of ts||[]){const {data:ps,error:pErr}=await db.from('team_players').select('skill_level_at_draw,group_members(display_name)').eq('team_id',t.id);if(pErr)throw pErr;const d=document.createElement('article');d.className='team';d.innerHTML=`<h3>${esc(t.name)}</h3><small>${esc(m.title)} · nível total ${(ps||[]).reduce((s,p)=>s+p.skill_level_at_draw,0)}</small><ul>${(ps||[]).map(p=>`<li>${esc(p.group_members?.display_name)} (${p.skill_level_at_draw})</li>`).join('')}</ul>`;el.appendChild(d)}}if(!el.children.length)el.innerHTML='<div class="empty">Nenhum time sorteado.</div>'}
async function renderCash(){const {data:bal,error}=await db.rpc('get_group_balance',{p_group_id:cfg.GROUP_ID});if(error)throw error;$('cash-balance').textContent=money(bal);$('balance').textContent=money(bal);const el=$('transactions');el.innerHTML='';if(!admin)return;const {data:rows,error:err}=await db.from('cash_transactions').select('type,amount_cents,description,occurred_at').eq('group_id',cfg.GROUP_ID).order('occurred_at',{ascending:false}).limit(50);if(err)throw err;if(!rows?.length){el.innerHTML='<div class="empty">Nenhuma movimentação.</div>';return}rows.forEach(t=>{const d=document.createElement('article');d.className='item';d.innerHTML=`<div><b>${esc(t.description)}</b><small>${dt(t.occurred_at)}</small></div><strong class="${t.type==='income'?'positive':'negative'}">${t.type==='income'?'+':'−'} ${money(t.amount_cents)}</strong>`;el.appendChild(d)})}
$('cash-form').addEventListener('submit',async e=>{e.preventDefault();const value=Number($('cash-amount').value);if(!Number.isFinite(value)||value<=0)return toast('Valor inválido');const {error}=await db.from('cash_transactions').insert({group_id:cfg.GROUP_ID,type:$('cash-type').value,amount_cents:Math.round(value*100),description:$('cash-description').value.trim(),created_by:session.user.id});if(error)return toast(error.message);$('cash-amount').value='';$('cash-description').value='';await renderCash()});
function renderStats(){const m=matches.find(x=>x.status==='scheduled'&&new Date(x.starts_at)>=new Date());$('next-game').textContent=m?.title||'—';$('next-date').textContent=m?dt(m.starts_at):'Nenhum jogo futuro';if(!m){$('confirmed').textContent='0';return}db.from('attendance').select('id',{count:'exact',head:true}).eq('match_id',m.id).eq('status','confirmed').then(r=>{if(!r.error)$('confirmed').textContent=String(r.count||0)})}
async function loadPublicBalance(){const {data,error}=await db.rpc('get_group_balance',{p_group_id:cfg.GROUP_ID});if(error){msg('balance-message','Não foi possível consultar o saldo: '+error.message,true);return}$('public-balance-value').textContent=money(data)}
async function loadAttendance(token){$('yes').disabled=$('no').disabled=true;const {data,error}=await db.rpc('get_attendance_link_info',{p_token:token});if(error||!data?.length){$('public-title').textContent='Link inválido ou expirado';$('public-meta').textContent='Solicite um novo link ao administrador.';msg('public-message','Este link não está mais disponível.',true);return}const d=data[0];$('public-title').textContent=d.match_title;$('public-meta').textContent=dt(d.starts_at)+(d.location?' · '+d.location:'');$('public-player').textContent='Olá, '+d.player_name+'!';msg('public-message','Situação atual: '+({confirmed:'confirmado',declined:'não vai',waitlist:'lista de espera'}[d.status]||d.status));$('yes').disabled=$('no').disabled=false;$('yes').onclick=()=>respond(token,'confirmed');$('no').onclick=()=>respond(token,'declined')}
async function respond(token,status){$('yes').disabled=$('no').disabled=true;const {error}=await db.rpc('respond_to_attendance',{p_token:token,p_status:status});if(error){msg('public-message',error.message,true);return}msg('public-message',status==='confirmed'?'Presença confirmada! ⚽':'Ausência registrada.');await loadAttendance(token)}
init().catch(e=>{console.error(e);toast('Erro: '+e.message)});
})();
