// Presentation only: no persistence or stock operations.
export function pendingPage(rows, { technician='', status='', search='', page=1 }={}, product, deadline) {
  const normalized = text => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('pt-BR');
  const filtered = rows.filter(row => (!technician || row.technician_name === technician) && (!status || deadline(row).key === status) && normalized(product(row.product_id)?.name).includes(normalized(search)))
    .sort((a,b) => (deadline(a).key !== 'overdue') - (deadline(b).key !== 'overdue') || (new Date(a.due_at).getTime() || Infinity) - (new Date(b.due_at).getTime() || Infinity) || String(a.id).localeCompare(String(b.id)));
  const pages=Math.max(1,Math.ceil(filtered.length/8));
  page=Math.max(1,Math.min(page,pages));
  return { rows:filtered.slice((page-1)*8,page*8), total:filtered.length, pages, page };
}
let controls, currentPage=1, context;
export function renderPendingPanel(rows, loadStatus, helpers) {
  context={rows,loadStatus,helpers};
  const body=document.getElementById('dashboard-requests-table');
  const panel=body.closest('section');
  if(!controls){
    panel.classList.add('dashboard-pending-panel');
    panel.parentElement.prepend(panel);
    const heading=panel.querySelector('.dashboard-operation-heading');
    const title=document.createElement('div');title.className='dashboard-command-title';
    title.innerHTML='<span class="dashboard-eyebrow">CONTROLE OPERACIONAL</span>';
    title.append(heading.querySelector('h2'));heading.replaceChildren(title);
    const summary=document.createElement('div');summary.className='dashboard-deadline-summary';
    summary.setAttribute('aria-label','Resumo de prazos de todas as pendências');
    summary.innerHTML='<div><span class="deadline-dot overdue"></span><strong data-deadline-total="overdue">—</strong><span>Atrasadas</span></div><div><span class="deadline-dot warning"></span><strong data-deadline-total="warning">—</strong><span>Vencem em breve</span></div>';
    heading.append(summary);
    document.getElementById('dashboard-reminders-table').closest('section').hidden=true;
    controls=document.createElement('div'); controls.className='dashboard-pending-filters';
    controls.innerHTML='<label>Técnico<select id="dashboard-technician-filter"><option value="">Todos os técnicos</option></select></label><label>Status<select id="dashboard-status-filter"><option value="">Todos os status</option><option value="overdue">Atrasado</option><option value="warning">Vence em breve</option><option value="ok">No prazo</option></select></label><label>Material<input id="dashboard-material-filter" type="search" placeholder="Pesquisar material" /></label>';
    panel.querySelector('.table-wrap').before(controls);
    const footer=document.createElement('div'); footer.className='dashboard-pagination';
    footer.innerHTML='<span role="status" aria-live="polite"></span><div><button type="button" class="secondary-button" aria-label="Página anterior de pendências">Anterior</button><button type="button" class="secondary-button" aria-label="Próxima página de pendências">Próxima</button></div>';
    panel.append(footer);
    const refresh=()=>renderPendingPanel(context.rows,context.loadStatus,context.helpers);
    controls.oninput=()=>{currentPage=1;refresh();};
    const buttons=footer.querySelectorAll('button');
    buttons[0].onclick=()=>{currentPage--;refresh();};buttons[1].onclick=()=>{currentPage++;refresh();};
  }
  const {product,deadline,esc,date,quantity,open}=helpers;
  for(const key of ['overdue','warning']) panel.querySelector(`[data-deadline-total="${key}"]`).textContent=loadStatus==='success'?rows.filter(row=>deadline(row).key===key).length:'—';
  for(const id of ['dashboard-overdue-loans-table','dashboard-expiring-table']){
    const table=document.getElementById(id);
    table.closest('section').classList.toggle('dashboard-secondary-empty',Boolean(table.querySelector('td.empty')));
  }
  const technician=controls.querySelector('select'), selected=technician.value;
  const options=[...new Set(rows.map(row=>row.technician_name).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'pt-BR'));
  const optionsHtml='<option value="">Todos os técnicos</option>'+options.map(name=>`<option value="${esc(name)}">${esc(name)}</option>`).join('');
  if(technician.innerHTML!==optionsHtml){technician.innerHTML=optionsHtml;technician.value=options.includes(selected)?selected:'';}
  const result=pendingPage(rows,{technician:technician.value,status:controls.querySelectorAll('select')[1].value,search:controls.querySelector('input').value,page:currentPage},product,deadline);
  currentPage=result.page;
  body.innerHTML=loadStatus==='loading'?'<tr><td colspan="7" class="empty">Carregando pendências…</td></tr>':loadStatus==='error'?'<tr><td colspan="7" class="empty">Não foi possível carregar as pendências.</td></tr>':result.rows.map(item=>{const state=deadline(item);return `<tr class="deadline-${state.key}"><td>${esc(item.technician_name)}</td><td>${esc(product(item.product_id)?.name||'Material')}</td><td>${quantity(item.quantity)}</td><td>${date(item.withdrawn_at)}</td><td>${date(item.due_at)}</td><td><span class="pending-status ${state.key}">${state.label}</span></td><td><button type="button" class="secondary-button" data-view-pending="${esc(item.id)}">Ver</button></td></tr>`;}).join('')||'<tr><td colspan="7" class="empty">Nenhuma pendência para os filtros selecionados.</td></tr>';
  body.querySelectorAll('[data-view-pending]').forEach(button=>button.onclick=()=>open(button.dataset.viewPending));
  const footer=panel.querySelector('.dashboard-pagination');
  footer.querySelector('span').textContent=['loading','error'].includes(loadStatus)?'Aguardando dados':`${result.total} pendências · Página ${result.page} de ${result.pages}`;
  const buttons=footer.querySelectorAll('button');buttons[0].disabled=result.page===1||loadStatus!=='success';buttons[1].disabled=result.page===result.pages||loadStatus!=='success';
}

// Returns to the beginning of the existing, filtered list without selecting a record.
export function focusPendingPanel() {
  if (!context || !controls) return;
  currentPage = 1;
  renderPendingPanel(context.rows, context.loadStatus, context.helpers);
  const panel = document.querySelector('.dashboard-pending-panel');
  panel?.querySelector('.dashboard-operation-heading')?.scrollIntoView({ behavior:'smooth', block:'start' });
}
