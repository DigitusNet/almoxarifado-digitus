import { createClient } from '@supabase/supabase-js';

const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);
let state = { products: [], movements: [], users: [] };
let currentUser = null;
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;' }[char]));
const product = id => state.products.find(item => String(item.id) === String(id));
const low = item => item.stock <= item.minimum;
const date = value => new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const status = item => item.stock === 0 ? '<span class="badge out">Sem estoque</span>' : low(item) ? '<span class="badge low">Estoque baixo</span>' : '<span class="badge ok">Disponível</span>';
const roleName = role => ({ admin: 'Administrador', operador: 'Operador', tecnico: 'Técnico' }[role] || 'Técnico');

function render() {
  const lows = state.products.filter(low), total = state.products.reduce((sum, item) => sum + item.stock, 0);
  $('#product-count').textContent = state.products.length;
  $('#stock-total').textContent = total.toLocaleString('pt-BR');
  $('#low-stock').textContent = lows.length;
  $('#low-stock-list').innerHTML = lows.length ? lows.map(item => `<div class="compact-row"><div><b>${esc(item.name)}</b><small>${esc(item.code)} · mínimo: ${item.minimum}</small></div><span class="badge low">${item.stock} un.</span></div>`).join('') : '<p class="empty">Nenhum item precisa de reposição.</p>';
  $('#recent-movements').innerHTML = state.movements.slice(0, 5).map(item => `<div class="compact-row"><div><b>${item.type === 'entrada' ? 'Entrada' : 'Saída'} · ${esc(product(item.productId)?.name || 'Produto')}</b><small>${esc(item.person)} · ${item.date}</small></div><span class="badge ${item.type}">${item.type === 'entrada' ? '+' : '-'}${item.quantity}</span></div>`).join('') || '<p class="empty">Sem movimentações.</p>';
  renderProducts(); renderMovement(); renderUsers();
}

function renderProducts() {
  const query = $('#product-search').value.toLowerCase();
  $('#products-table').innerHTML = state.products.filter(item => `${item.name} ${item.code} ${item.category}`.toLowerCase().includes(query)).map(item => `<tr><td><b>${esc(item.name)}</b></td><td>${esc(item.code)}</td><td>${esc(item.category)}</td><td><b>${item.stock}</b><small>mínimo: ${item.minimum}</small></td><td>${status(item)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nenhum produto encontrado.</td></tr>';
}

function renderMovement() {
  const select = $('#movement-product'), selected = select.value;
  select.innerHTML = state.products.map(item => `<option value="${item.id}">${esc(item.name)} (${item.stock} un.)</option>`).join('');
  select.value = selected || state.products[0]?.id;
  $('#movement-history').innerHTML = state.movements.map(item => `<div class="history-item"><span class="history-icon ${item.type === 'saida' ? 'out' : ''}">${item.type === 'entrada' ? '↓' : '↑'}</span><div><b>${item.type === 'entrada' ? 'Entrada' : 'Saída'} de ${item.quantity} un. — ${esc(product(item.productId)?.name || 'Produto')}</b><small>${esc(item.person)} · ${item.date}${item.note ? ' · ' + esc(item.note) : ''}</small></div></div>`).join('') || '<p class="empty">Nenhuma movimentação registrada.</p>';
}

function renderUsers() {
  const table = $('#users-table');
  if (!table) return;
  table.innerHTML = state.users.map(user => `<tr><td><b>${esc(user.name || 'Sem nome')}</b></td><td>${esc(user.email)}</td><td><span class="badge ok">${roleName(user.role)}</span></td><td>${user.active ? '<span class="badge ok">Ativo</span>' : '<span class="badge out">Desativado</span>'}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nenhum usuário cadastrado.</td></tr>';
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
  state.movements = movements.data.map(item => ({ id:item.id, type:item.movement_type, productId:item.product_id, quantity:item.quantity, person:item.recipient, note:item.note, date:date(item.created_at) }));
  try {
    await loadUsers();
  } catch (error) {
    console.warn('Não foi possível carregar a lista de usuários:', error.message);
    state.users = [];
  }
  render();
}

function view(id) {
  document.querySelectorAll('.view').forEach(element => element.classList.toggle('active', element.id === id));
  document.querySelectorAll('.nav-link').forEach(button => button.classList.toggle('active', button.dataset.view === id));
  $('#page-title').textContent = ({ dashboard:'Visão geral', products:'Produtos', movement:'Movimentações', users:'Usuários' })[id];
  $('#header-action').hidden = id === 'users' || id === 'products';
  $('#header-action').textContent = id === 'products' ? '+ Cadastrar produto' : '+ Nova movimentação';
}

async function start(session) {
  const { data: profile } = await supabase.from('profiles').select('full_name, role').eq('id', session.user.id).maybeSingle();
  currentUser = { id: session.user.id, email: session.user.email, role: profile?.role || 'tecnico' };
  const isAdmin = currentUser.role === 'admin';
  document.querySelectorAll('[data-admin-only]').forEach(element => { element.hidden = !isAdmin; });
  $('#users').hidden = !isAdmin;
  try { await load(); } catch (error) { alert(error.message); }
}

document.querySelectorAll('.nav-link').forEach(button => button.onclick = () => view(button.dataset.view));
document.querySelectorAll('[data-go]').forEach(button => button.onclick = () => view(button.dataset.go));
$('#header-action').onclick = () => $('.view.active').id === 'products' ? $('#product-dialog').showModal() : view('movement');
$('#add-product').onclick = () => $('#product-dialog').showModal();
$('#add-user').onclick = () => $('#user-dialog').showModal();
$('#product-search').oninput = renderProducts;

$('#product-form').onsubmit = async event => {
  event.preventDefault();
  const { error } = await supabase.from('products').insert({ name:$('#new-name').value, code:$('#new-code').value, category:$('#new-category').value, stock:Number($('#new-stock').value), minimum_stock:Number($('#new-minimum').value) });
  if (error) return alert(error.message);
  event.target.reset(); $('#product-dialog').close(); await load(); view('products');
};

$('#movement-form').onsubmit = async event => {
  event.preventDefault(); const selectedProduct = product($('#movement-product').value), quantity = Number($('#movement-quantity').value), type = $('#movement-type').value;
  if (type === 'saida' && quantity > selectedProduct.stock) return alert(`Estoque insuficiente. Disponível: ${selectedProduct.stock} unidade(s).`);
  const { error } = await supabase.rpc('record_movement', { p_product_id:selectedProduct.id, p_type:type, p_quantity:quantity, p_recipient:$('#movement-person').value, p_note:$('#movement-note').value || null });
  if (error) return alert(error.message);
  event.target.reset(); $('#movement-quantity').value = 1; await load(); view('dashboard');
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
