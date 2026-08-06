import { createClient } from '@supabase/supabase-js';

const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);
let state = { products: [], movements: [], users: [], productFilter: 'all' };
let currentUser = null;
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;' }[char]));
const product = id => state.products.find(item => String(item.id) === String(id));
const low = item => item.stock <= item.minimum;
const date = value => new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const status = item => item.stock === 0 ? '<span class="badge out">Sem estoque</span>' : low(item) ? '<span class="badge low">Estoque baixo</span>' : '<span class="badge ok">Disponível</span>';
const roleName = role => ({ admin: 'Administrador', operador: 'Operador', tecnico: 'Técnico' }[role] || 'Técnico');
const holderTypeName = type => ({ tecnico: 'Técnico', veiculo: 'Veículo', cliente: 'Cliente', outro: 'Outro' }[type] || 'Outro');
const movementName = item => item.fieldUsage ? 'Uso em OS' : item.type === 'entrada' ? 'Entrada' : 'Saída';

function getFilteredMovements() {
  const query = $('#history-search').value.trim().toLowerCase();
  const typeFilter = $('#history-type').value, holderFilter = $('#history-holder').value;
  const from = $('#history-from').value, to = $('#history-to').value;
  return state.movements.filter(item => {
    const text = `${product(item.productId)?.name || ''} ${item.person} ${item.workOrder || ''} ${item.note || ''}`.toLowerCase();
    const day = item.createdAt?.slice(0, 10) || '';
    const matchesType = !typeFilter || (typeFilter === 'uso_os' ? item.fieldUsage : item.type === typeFilter && !item.fieldUsage);
    return (!query || text.includes(query)) && matchesType && (!holderFilter || item.holderType === holderFilter) && (!from || day >= from) && (!to || day <= to);
  });
}

function getFieldStockItems() {
  const balances = new Map();
  state.movements.filter(item => ['tecnico', 'veiculo'].includes(item.holderType)).forEach(item => {
    const key = `${item.holderType}|${item.person}|${item.productId}`;
    const current = balances.get(key) || { ...item, balance: 0 };
    current.balance += item.fieldUsage ? -item.quantity : item.type === 'saida' ? item.quantity : -item.quantity;
    balances.set(key, current);
  });
  return [...balances.values()].filter(item => item.balance > 0).sort((a, b) => `${a.person}${a.productId}`.localeCompare(`${b.person}${b.productId}`, 'pt-BR'));
}

function createReportSheet(XLSX, title, headers, rows, widths) {
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Digitus Net | Almoxarifado'],
    [title],
    [`Relatório gerado em ${new Date().toLocaleString('pt-BR')}`],
    [],
    headers,
    ...rows
  ]);
  sheet['!cols'] = widths.map(width => ({ wch: width }));
  sheet['!autofilter'] = { ref: `A5:${XLSX.utils.encode_col(headers.length - 1)}${Math.max(rows.length + 5, 5)}` };
  return sheet;
}

async function exportExcelReport() {
  try {
    const XLSX = await import('xlsx');
    const workbook = XLSX.utils.book_new();
    const stockRows = state.products.map(item => [
      item.name, item.code, item.category, item.stock, item.minimum,
      item.stock === 0 ? 'Sem estoque' : low(item) ? 'Estoque baixo' : 'Disponível'
    ]);
    const fieldRows = getFieldStockItems().map(item => [
      holderTypeName(item.holderType), item.person, product(item.productId)?.name || 'Produto removido',
      product(item.productId)?.code || '—', item.balance
    ]);
    const movementRows = getFilteredMovements().map(item => [
      item.date, movementName(item), product(item.productId)?.name || 'Produto removido',
      product(item.productId)?.code || '—', item.quantity, holderTypeName(item.holderType),
      item.person, item.workOrder || '', item.note || ''
    ]);
    XLSX.utils.book_append_sheet(workbook, createReportSheet(XLSX, 'Estoque atual', ['Produto', 'Código', 'Categoria', 'Estoque atual', 'Estoque mínimo', 'Status'], stockRows, [30, 18, 22, 16, 16, 18]), 'Estoque atual');
    XLSX.utils.book_append_sheet(workbook, createReportSheet(XLSX, 'Materiais em campo', ['Tipo', 'Responsável / veículo', 'Produto', 'Código', 'Quantidade'], fieldRows, [15, 28, 30, 18, 14]), 'Materiais em campo');
    XLSX.utils.book_append_sheet(workbook, createReportSheet(XLSX, 'Movimentações', ['Data e hora', 'Tipo', 'Produto', 'Código', 'Quantidade', 'Destino', 'Responsável / destino', 'Número da OS', 'Observação'], movementRows, [20, 15, 30, 18, 13, 15, 28, 18, 36]), 'Movimentações');
    const today = new Date();
    const reportDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    XLSX.writeFile(workbook, `relatorio-almoxarifado-${reportDate}.xlsx`, { compression: true });
  } catch (error) {
    console.error('Não foi possível gerar o relatório Excel:', error);
    alert('Não foi possível gerar o relatório Excel. Tente novamente.');
  }
}

function render() {
  const lows = state.products.filter(low), total = state.products.reduce((sum, item) => sum + item.stock, 0);
  $('#product-count').textContent = state.products.length;
  $('#stock-total').textContent = total.toLocaleString('pt-BR');
  $('#low-stock').textContent = lows.length;
  $('#low-stock-list').innerHTML = lows.length ? lows.map(item => `<div class="compact-row"><div><b>${esc(item.name)}</b><small>${esc(item.code)} · mínimo: ${item.minimum}</small></div><span class="badge low">${item.stock} un.</span></div>`).join('') : '<p class="empty">Nenhum item precisa de reposição.</p>';
  $('#recent-movements').innerHTML = state.movements.slice(0, 5).map(item => `<div class="compact-row"><div><b>${movementName(item)} · ${esc(product(item.productId)?.name || 'Produto')}</b><small>${esc(item.person)} · ${item.date}</small></div><span class="badge ${item.type}">${item.type === 'entrada' ? '+' : '-'}${item.quantity}</span></div>`).join('') || '<p class="empty">Sem movimentações.</p>';
  renderProducts(); renderMovement(); renderFieldStock(); renderUsers();
}

function renderProducts() {
  const query = $('#product-search').value.toLowerCase();
  const canDelete = currentUser?.role === 'admin';
  const canEdit = ['admin', 'operador'].includes(currentUser?.role);
  const products = state.products.filter(item => (state.productFilter !== 'low' || low(item)) && `${item.name} ${item.code} ${item.category}`.toLowerCase().includes(query));
  $('#products-table').innerHTML = products.map(item => `<tr><td><b>${esc(item.name)}</b></td><td>${esc(item.code)}</td><td>${esc(item.category)}</td><td><b>${item.stock}</b><small>mínimo: ${item.minimum}</small></td><td>${status(item)}</td><td><div class="table-actions">${canEdit ? `<button class="secondary-button" data-edit-product="${item.id}">Editar</button>` : ''}${canDelete ? `<button class="danger-button" data-delete-product="${item.id}">Apagar</button>` : ''}${!canEdit && !canDelete ? '—' : ''}</div></td></tr>`).join('') || '<tr><td colspan="6" class="empty">Nenhum produto encontrado.</td></tr>';
  document.querySelectorAll('[data-edit-product]').forEach(button => button.onclick = () => openProductEditor(button.dataset.editProduct));
  document.querySelectorAll('[data-delete-product]').forEach(button => button.onclick = () => deleteProduct(button.dataset.deleteProduct));
}

function renderMovement() {
  const select = $('#movement-product'), selected = select.value;
  const canDelete = currentUser?.role === 'admin';
  select.innerHTML = state.products.map(item => `<option value="${item.id}">${esc(item.name)} (${item.stock} un.)</option>`).join('');
  select.value = selected || state.products[0]?.id;
  const movements = getFilteredMovements();
  $('#movement-history').innerHTML = movements.map(item => `<div class="history-item"><span class="history-icon ${item.type === 'saida' ? 'out' : ''}">${item.type === 'entrada' ? '↓' : '↑'}</span><div><b>${movementName(item)} de ${item.quantity} un. — ${esc(product(item.productId)?.name || 'Produto')}</b><small>${holderTypeName(item.holderType)}: ${esc(item.person)} · ${item.date}${item.workOrder ? ' · OS: ' + esc(item.workOrder) : ''}${item.note ? ' · ' + esc(item.note) : ''}</small></div>${canDelete ? `<button class="danger-button" data-delete-movement="${item.id}">Apagar</button>` : ''}</div>`).join('') || '<p class="empty">Nenhuma movimentação encontrada.</p>';
  document.querySelectorAll('[data-delete-movement]').forEach(button => button.onclick = () => deleteMovement(button.dataset.deleteMovement));
}

function renderFieldStock() {
  const items = getFieldStockItems();
  $('#field-stock-list').innerHTML = items.length ? items.map(item => `<div class="compact-row"><div><b>${esc(item.person)} · ${esc(product(item.productId)?.name || 'Produto')}</b><small>${holderTypeName(item.holderType)} · código: ${esc(product(item.productId)?.code || '—')}</small></div><span class="badge entrada">${item.balance} un.</span></div>`).join('') : '<p class="empty">Nenhum material está registrado com técnicos ou veículos.</p>';
}

function renderUsers() {
  const table = $('#users-table');
  if (!table) return;
  table.innerHTML = state.users.map(user => `<tr><td><b>${esc(user.name || 'Sem nome')}</b></td><td>${esc(user.email)}</td><td><span class="badge ok">${roleName(user.role)}</span></td><td>${user.active ? '<span class="badge ok">Ativo</span>' : '<span class="badge out">Desativado</span>'}</td><td>${user.id === currentUser?.id ? '—' : `<button class="danger-button" data-delete-user="${user.id}">Remover</button>`}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nenhum usuário cadastrado.</td></tr>';
  document.querySelectorAll('[data-delete-user]').forEach(button => button.onclick = () => deleteUser(button.dataset.deleteUser));
}

async function loadUsers() {
  if (currentUser?.role !== 'admin') return;
  const { data: { session } } = await supabase.auth.getSession();
  const response = await fetch('/api/users', { headers: { Authorization: `Bearer ${session.access_token}` } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Não foi possível carregar usuários.');
  state.users = data;
}

async function load() {
  const [products, movements] = await Promise.all([
    supabase.from('products').select('*').order('name'),
    supabase.from('movements').select('*').order('created_at', { ascending: false })
  ]);
  if (products.error || movements.error) throw products.error || movements.error;
  state.products = products.data.map(item => ({ ...item, minimum: item.minimum_stock }));
  state.movements = movements.data.map(item => ({ id:item.id, type:item.movement_type, productId:item.product_id, quantity:item.quantity, person:item.recipient, holderType:item.holder_type || 'cliente', workOrder:item.work_order, fieldUsage:item.field_usage || false, note:item.note, createdAt:item.created_at, date:date(item.created_at) }));
  try {
    await loadUsers();
  } catch (error) {
    console.warn('Não foi possível carregar a lista de usuários:', error.message);
    state.users = [];
  }
  render();
}

async function deleteProduct(id) {
  const item = product(id);
  if (!item || !confirm(`Apagar o produto “${item.name}” e todas as movimentações dele? Esta ação não pode ser desfeita.`)) return;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Sessão inválida. Entre novamente no sistema.');
    const response = await fetch(`/api/products?id=${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${session.access_token}` } });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Não foi possível apagar o produto.');
    }
    await load();
  } catch (error) {
    alert(error.message);
  }
}

async function deleteMovement(id) {
  const item = state.movements.find(movement => movement.id === id);
  if (!item || !confirm(`Apagar esta movimentação? O estoque será ajustado automaticamente. Esta ação não pode ser desfeita.`)) return;
  try {
    const { error } = await supabase.rpc('delete_movement', { p_movement_id: id });
    if (error) throw error;
    await load();
  } catch (error) {
    alert(error.message);
  }
}

async function deleteUser(id) {
  const user = state.users.find(item => item.id === id);
  if (!user || !confirm(`Remover o acesso de ${user.email}? Esta ação não pode ser desfeita.`)) return;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const response = await fetch(`/api/users?id=${encodeURIComponent(id)}`, { method:'DELETE', headers:{ Authorization:`Bearer ${session.access_token}` } });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'Não foi possível remover o usuário.');
    }
    await loadUsers(); renderUsers();
  } catch (error) {
    alert(error.message);
  }
}

function view(id) {
  document.querySelectorAll('.view').forEach(element => element.classList.toggle('active', element.id === id));
  document.querySelectorAll('.nav-link').forEach(button => button.classList.toggle('active', button.dataset.view === id));
  document.querySelector('main').classList.toggle('dashboard-mode', id === 'dashboard');
  $('#page-title').textContent = ({ dashboard:'Visão geral', products:'Produtos', movement:'Movimentações', users:'Usuários' })[id];
  $('#header-action').hidden = id === 'users' || id === 'products';
  $('#header-action').textContent = id === 'products' ? '+ Cadastrar produto' : '+ Nova movimentação';
}

document.querySelector('main').classList.add('dashboard-mode');

function showProducts(filter = 'all') {
  state.productFilter = filter;
  $('#product-search').value = '';
  view('products');
  renderProducts();
}

function openProductEditor(id) {
  const item = product(id);
  if (!item) return;
  $('#edit-product-form').reset();
  $('#edit-product-id').value = item.id;
  $('#edit-name').value = item.name;
  $('#edit-code').value = item.code;
  $('#edit-category').value = item.category;
  $('#edit-stock').value = item.stock;
  $('#edit-minimum').value = item.minimum;
  $('#edit-product-dialog').showModal();
}

async function start(session) {
  const { data: profile } = await supabase.from('profiles').select('full_name, role').eq('id', session.user.id).maybeSingle();
  currentUser = { id: session.user.id, email: session.user.email, role: profile?.role || 'tecnico' };
  const isAdmin = currentUser.role === 'admin';
  document.querySelectorAll('[data-admin-only]').forEach(element => { element.hidden = !isAdmin; });
  $('#users').hidden = !isAdmin;
  try { await load(); } catch (error) { alert(error.message); }
}

document.querySelectorAll('.nav-link').forEach(button => button.onclick = () => button.dataset.view === 'products' ? showProducts() : view(button.dataset.view));
document.querySelectorAll('[data-go]').forEach(button => button.onclick = () => button.dataset.go === 'products' ? showProducts() : view(button.dataset.go));
$('#header-action').onclick = () => $('.view.active').id === 'products' ? $('#product-dialog').showModal() : view('movement');
$('#add-product').onclick = () => $('#product-dialog').showModal();
$('#add-user').onclick = () => $('#user-dialog').showModal();
document.querySelectorAll('[data-close-dialog]').forEach(button => button.onclick = () => button.closest('dialog').close());
$('#low-stock-card').onclick = () => showProducts('low');
$('#product-search').oninput = () => { state.productFilter = 'all'; renderProducts(); };
document.querySelectorAll('[data-history-filter]').forEach(element => { element.oninput = renderMovement; element.onchange = renderMovement; });
$('#clear-history-filters').onclick = () => { document.querySelectorAll('[data-history-filter]').forEach(element => { element.value = ''; }); renderMovement(); };
$('#export-excel').onclick = exportExcelReport;
function updateMovementRecipientPlaceholder() {
  const placeholders = { tecnico: 'Ex.: João Silva — Equipe externa', veiculo: 'Ex.: Carro 01 — Equipe Norte', cliente: 'Ex.: Cliente ou endereço', outro: 'Descreva o destino' };
  $('#movement-person').placeholder = placeholders[$('#movement-holder-type').value];
}
function updateMovementMode() {
  const isFieldUsage = $('#movement-type').value === 'uso_os';
  const holder = $('#movement-holder-type'), workOrder = $('#movement-work-order');
  if (isFieldUsage) holder.value = 'tecnico';
  holder.disabled = isFieldUsage;
  workOrder.required = isFieldUsage;
  $('#movement-type-help').textContent = isFieldUsage ? 'Registre o material que o técnico usou em uma instalação. O saldo do técnico será reduzido.' : 'Transfira o material do almoxarifado para um técnico, veículo, cliente ou outro destino.';
  $('#movement-destination-label').textContent = isFieldUsage ? 'Destino (técnico)' : 'Destino';
  $('#movement-person-label').textContent = isFieldUsage ? 'Técnico responsável' : 'Responsável / destino';
  $('#movement-os-label').textContent = isFieldUsage ? 'Número da OS *' : 'Número da OS';
  updateMovementRecipientPlaceholder();
}
$('#movement-type').onchange = updateMovementMode;
$('#movement-holder-type').onchange = updateMovementRecipientPlaceholder;
updateMovementMode();

$('#product-form').onsubmit = async event => {
  event.preventDefault();
  const { error } = await supabase.from('products').insert({ name:$('#new-name').value, code:$('#new-code').value, category:$('#new-category').value, stock:Number($('#new-stock').value), minimum_stock:Number($('#new-minimum').value) });
  if (error) return alert(error.message);
  event.target.reset(); $('#product-dialog').close(); await load(); view('products');
};

$('#edit-product-form').onsubmit = async event => {
  event.preventDefault();
  const id = $('#edit-product-id').value;
  try {
    const productData = { name:$('#edit-name').value, code:$('#edit-code').value, category:$('#edit-category').value, minimum_stock:Number($('#edit-minimum').value) };
    const { error } = await supabase.from('products').update(productData).eq('id', id);
    if (error) throw error;
    $('#edit-product-dialog').close(); await load(); view('products');
  } catch (error) {
    alert(error.message);
  }
};

$('#movement-form').onsubmit = async event => {
  event.preventDefault(); const selectedProduct = product($('#movement-product').value), quantity = Number($('#movement-quantity').value), operation = $('#movement-type').value, fieldUsage = operation === 'uso_os', type = fieldUsage ? 'saida' : operation, workOrder = $('#movement-work-order').value.trim();
  if (fieldUsage && !workOrder) return alert('Informe o número da OS para registrar o uso do material.');
  if (!fieldUsage && type === 'saida' && quantity > selectedProduct.stock) return alert(`Estoque insuficiente. Disponível: ${selectedProduct.stock} unidade(s).`);
  const movementData = { p_product_id:selectedProduct.id, p_type:type, p_quantity:quantity, p_recipient:$('#movement-person').value, p_note:$('#movement-note').value || null, p_holder_type:$('#movement-holder-type').value, p_work_order:workOrder || null };
  if (fieldUsage) movementData.p_field_usage = true;
  const { error } = await supabase.rpc('record_movement', movementData);
  if (error) return alert(error.message);
  event.target.reset(); $('#movement-quantity').value = 1; updateMovementMode(); await load(); view('dashboard');
};

$('#user-form').onsubmit = async event => {
  event.preventDefault(); const errorText = $('#user-error'); errorText.hidden = true;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const response = await fetch('/api/users', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${session.access_token}` }, body:JSON.stringify({ name:$('#user-name').value, email:$('#user-email').value, password:$('#user-password').value, role:$('#user-role').value }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Não foi possível criar o usuário.');
    event.target.reset(); $('#user-dialog').close(); await loadUsers(); renderUsers(); alert('Usuário criado com sucesso.');
  } catch (error) { errorText.textContent = error.message; errorText.hidden = false; }
};

$('#login-form').onsubmit = async event => {
  event.preventDefault(); const errorText = $('#login-error'); errorText.hidden = true;
  const { data, error } = await supabase.auth.signInWithPassword({ email:$('#login-email').value, password:$('#login-password').value });
  if (error) { errorText.textContent = error.message; errorText.hidden = false; return; }
  $('#auth-gate').hidden = true; await start(data.session);
};

$('#today').textContent = new Date().toLocaleDateString('pt-BR', { weekday:'long', day:'2-digit', month:'long', year:'numeric' });
render();
const { data:{ session } } = await supabase.auth.getSession();
if (session) start(session); else $('#auth-gate').hidden = false;
