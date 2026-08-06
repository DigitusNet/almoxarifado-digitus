import { createClient } from '@supabase/supabase-js';

const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);
let state = { products: [], movements: [], users: [], collaborators: [], vehicles: [], locations: [], serialItems: [], serialMovements: [], productFilter: 'all' };
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
const unitName = unit => ({ unidade: 'un.', metro: 'm', par: 'par', caixa: 'cx.' }[unit] || 'un.');
const quantity = value => Number(value || 0).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const stockLabel = item => `${quantity(item.stock)} ${unitName(item.unit_of_measure)}`;
const serialStatusName = status => ({ disponivel:'Disponível', com_colaborador:'Com colaborador', com_veiculo:'Com veículo', instalado_cliente:'Instalado no cliente', emprestado:'Emprestado', aguardando_triagem:'Aguardando triagem', laboratorio:'Laboratório', manutencao:'Em manutenção', defeito:'Defeito', baixado:'Baixado' })[status] || status;
const serialStatusClass = status => ({ disponivel:'ok', com_colaborador:'saida', com_veiculo:'saida', instalado_cliente:'saida', emprestado:'saida', aguardando_triagem:'low', laboratorio:'low', manutencao:'low', defeito:'out', baixado:'out' })[status] || 'low';
const serialActionName = action => ({ transferencia:'Transferência', instalacao:'Instalação em cliente', laboratorio:'Envio ao laboratório', retorno:'Retorno ao almoxarifado', baixa:'Baixa / sucata' })[action] || action;

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
      item.name, item.code, item.category, unitName(item.unit_of_measure), item.stock, item.minimum,
      item.stock === 0 ? 'Sem estoque' : low(item) ? 'Estoque baixo' : 'Disponível'
    ]);
    const fieldRows = getFieldStockItems().map(item => [
      holderTypeName(item.holderType), item.person, product(item.productId)?.name || 'Produto removido',
      product(item.productId)?.code || '—', item.balance
    ]);
    const movementRows = getFilteredMovements().map(item => [
      item.date, movementName(item), product(item.productId)?.name || 'Produto removido',
      product(item.productId)?.code || '—', unitName(product(item.productId)?.unit_of_measure), item.quantity, holderTypeName(item.holderType),
      item.person, item.workOrder || '', item.note || ''
    ]);
    XLSX.utils.book_append_sheet(workbook, createReportSheet(XLSX, 'Estoque atual', ['Produto', 'Código', 'Categoria', 'Unidade', 'Estoque atual', 'Estoque mínimo', 'Status'], stockRows, [30, 18, 22, 12, 16, 16, 18]), 'Estoque atual');
    XLSX.utils.book_append_sheet(workbook, createReportSheet(XLSX, 'Materiais em campo', ['Tipo', 'Responsável / veículo', 'Produto', 'Código', 'Quantidade'], fieldRows, [15, 28, 30, 18, 14]), 'Materiais em campo');
    XLSX.utils.book_append_sheet(workbook, createReportSheet(XLSX, 'Movimentações', ['Data e hora', 'Tipo', 'Produto', 'Código', 'Unidade', 'Quantidade', 'Destino', 'Responsável / destino', 'Número da OS', 'Observação'], movementRows, [20, 15, 30, 18, 12, 13, 15, 28, 18, 36]), 'Movimentações');
    const today = new Date();
    const reportDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    XLSX.writeFile(workbook, `relatorio-almoxarifado-${reportDate}.xlsx`, { compression: true });
  } catch (error) {
    console.error('Não foi possível gerar o relatório Excel:', error);
    alert('Não foi possível gerar o relatório Excel. Tente novamente.');
  }
}

function render() {
  const lows = state.products.filter(low), total = state.products.filter(item => Number(item.stock) > 0).length;
  $('#product-count').textContent = state.products.length;
  $('#stock-total').textContent = total.toLocaleString('pt-BR');
  $('#low-stock').textContent = lows.length;
  $('#low-stock-list').innerHTML = lows.length ? lows.map(item => `<div class="compact-row"><div><b>${esc(item.name)}</b><small>${esc(item.code)} · mínimo: ${stockLabel({ ...item, stock: item.minimum })}</small></div><span class="badge low">${stockLabel(item)}</span></div>`).join('') : '<p class="empty">Nenhum item precisa de reposição.</p>';
  $('#recent-movements').innerHTML = state.movements.slice(0, 5).map(item => `<div class="compact-row"><div><b>${movementName(item)} · ${esc(product(item.productId)?.name || 'Produto')}</b><small>${esc(item.person)} · ${item.date}</small></div><span class="badge ${item.type}">${item.type === 'entrada' ? '+' : '-'}${quantity(item.quantity)} ${unitName(product(item.productId)?.unit_of_measure)}</span></div>`).join('') || '<p class="empty">Sem movimentações.</p>';
  renderProducts(); renderMovement(); renderFieldStock(); renderUsers(); renderRegistry(); renderSerials();
}

function renderProducts() {
  const query = $('#product-search').value.toLowerCase();
  const canDelete = currentUser?.role === 'admin';
  const canEdit = ['admin', 'operador'].includes(currentUser?.role);
  const products = state.products.filter(item => (state.productFilter !== 'low' || low(item)) && `${item.name} ${item.code} ${item.category}`.toLowerCase().includes(query));
  $('#products-table').innerHTML = products.map(item => `<tr><td><b>${esc(item.name)}</b><small>${esc([item.brand, item.model].filter(Boolean).join(' · ') || (item.tracking_mode === 'serializado' ? 'Rastreável por serial/MAC' : 'Controle por quantidade'))}</small></td><td>${esc(item.code)}</td><td>${esc(item.category)}</td><td><b>${stockLabel(item)}</b><small>mínimo: ${quantity(item.minimum)} ${unitName(item.unit_of_measure)}</small></td><td>${status(item)}</td><td><div class="table-actions">${canEdit ? `<button class="secondary-button" data-edit-product="${item.id}">Editar</button>` : ''}${canDelete ? `<button class="danger-button" data-delete-product="${item.id}">Apagar</button>` : ''}${!canEdit && !canDelete ? '—' : ''}</div></td></tr>`).join('') || '<tr><td colspan="6" class="empty">Nenhum produto encontrado.</td></tr>';
  document.querySelectorAll('[data-edit-product]').forEach(button => button.onclick = () => openProductEditor(button.dataset.editProduct));
  document.querySelectorAll('[data-delete-product]').forEach(button => button.onclick = () => deleteProduct(button.dataset.deleteProduct));
}

function renderMovement() {
  const select = $('#movement-product'), selected = select.value;
  const canDelete = currentUser?.role === 'admin';
  select.innerHTML = state.products.map(item => `<option value="${item.id}">${esc(item.name)} (${stockLabel(item)})</option>`).join('');
  select.value = selected || state.products[0]?.id;
  const movements = getFilteredMovements();
  $('#movement-history').innerHTML = movements.map(item => `<div class="history-item"><span class="history-icon ${item.type === 'saida' ? 'out' : ''}">${item.type === 'entrada' ? '↓' : '↑'}</span><div><b>${movementName(item)} de ${quantity(item.quantity)} ${unitName(product(item.productId)?.unit_of_measure)} — ${esc(product(item.productId)?.name || 'Produto')}</b><small>${holderTypeName(item.holderType)}: ${esc(item.person)} · ${item.date}${item.workOrder ? ' · OS: ' + esc(item.workOrder) : ''}${item.note ? ' · ' + esc(item.note) : ''}</small></div>${canDelete ? `<button class="danger-button" data-delete-movement="${item.id}">Apagar</button>` : ''}</div>`).join('') || '<p class="empty">Nenhuma movimentação encontrada.</p>';
  document.querySelectorAll('[data-delete-movement]').forEach(button => button.onclick = () => deleteMovement(button.dataset.deleteMovement));
}

function renderFieldStock() {
  const items = getFieldStockItems();
  $('#field-stock-list').innerHTML = items.length ? items.map(item => `<div class="compact-row"><div><b>${esc(item.person)} · ${esc(product(item.productId)?.name || 'Produto')}</b><small>${holderTypeName(item.holderType)} · código: ${esc(product(item.productId)?.code || '—')}</small></div><span class="badge entrada">${quantity(item.balance)} ${unitName(product(item.productId)?.unit_of_measure)}</span></div>`).join('') : '<p class="empty">Nenhum material está registrado com técnicos ou veículos.</p>';
}

function renderRegistry() {
  const collaboratorsTable = $('#collaborators-table'), vehiclesTable = $('#vehicles-table'), locationsTable = $('#locations-table');
  if (!collaboratorsTable || !vehiclesTable || !locationsTable) return;
  const collaborators = state.collaborators;
  collaboratorsTable.innerHTML = collaborators.map(item => `<tr><td><b>${esc(item.name)}</b><small>${esc(item.job_title || 'Sem cargo informado')}</small></td><td>${esc(item.department || '—')}</td><td>${esc(item.phone || '—')}</td><td>${item.active ? '<span class="badge ok">Ativo</span>' : '<span class="badge out">Inativo</span>'}</td><td><div class="table-actions"><button class="secondary-button" data-toggle-collaborator="${item.id}">${item.active ? 'Desativar' : 'Reativar'}</button><button class="danger-button" data-delete-collaborator="${item.id}">Remover</button></div></td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nenhum colaborador cadastrado.</td></tr>';
  vehiclesTable.innerHTML = state.vehicles.map(item => `<tr><td><b>${esc(item.name)}</b><small>${esc(item.plate || 'Sem placa informada')}</small></td><td>${esc(state.collaborators.find(collaborator => collaborator.id === item.responsible_id)?.name || '—')}</td><td>${item.active ? '<span class="badge ok">Ativo</span>' : '<span class="badge out">Inativo</span>'}</td><td><div class="table-actions"><button class="secondary-button" data-toggle-vehicle="${item.id}">${item.active ? 'Desativar' : 'Reativar'}</button><button class="danger-button" data-delete-vehicle="${item.id}">Remover</button></div></td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nenhum veículo cadastrado.</td></tr>';
  locationsTable.innerHTML = state.locations.map(item => `<tr><td><b>${esc(item.name)}</b></td><td>${esc(({ central:'Almoxarifado central', laboratorio:'Laboratório', outro:'Outro', colaborador:'Colaborador', veiculo:'Veículo', cliente:'Cliente' })[item.location_type] || item.location_type)}</td><td>${item.active ? '<span class="badge ok">Ativo</span>' : '<span class="badge out">Inativo</span>'}</td><td>${item.location_type === 'central' ? '—' : `<button class="secondary-button" data-toggle-location="${item.id}">${item.active ? 'Desativar' : 'Reativar'}</button>`}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nenhum local cadastrado.</td></tr>';
  $('#collaborator-options').innerHTML = collaborators.filter(item => item.active).map(item => `<option value="${esc(item.name)}"></option>`).join('');
  $('#vehicle-options').innerHTML = state.vehicles.filter(item => item.active).map(item => `<option value="${esc(item.name)}">${esc(item.plate || '')}</option>`).join('');
  $('#vehicle-responsible').innerHTML = '<option value="">Sem responsável definido</option>' + collaborators.filter(item => item.active).map(item => `<option value="${item.id}">${esc(item.name)}</option>`).join('');
  document.querySelectorAll('[data-toggle-collaborator]').forEach(button => button.onclick = () => toggleCollaborator(button.dataset.toggleCollaborator));
  document.querySelectorAll('[data-toggle-vehicle]').forEach(button => button.onclick = () => toggleVehicle(button.dataset.toggleVehicle));
  document.querySelectorAll('[data-delete-collaborator]').forEach(button => button.onclick = () => deleteCollaborator(button.dataset.deleteCollaborator));
  document.querySelectorAll('[data-delete-vehicle]').forEach(button => button.onclick = () => deleteVehicle(button.dataset.deleteVehicle));
  document.querySelectorAll('[data-toggle-location]').forEach(button => button.onclick = () => toggleLocation(button.dataset.toggleLocation));
}

function renderSerials() {
  const table = $('#serials-table'), select = $('#serial-product');
  if (!table || !select) return;
  const selected = select.value;
  const serialProducts = state.products.filter(item => item.tracking_mode === 'serializado');
  select.innerHTML = serialProducts.map(item => `<option value="${item.id}">${esc(item.name)} (${esc(item.code)})</option>`).join('');
  select.value = serialProducts.some(item => item.id === selected) ? selected : serialProducts[0]?.id || '';
  const search = $('#serial-search').value.trim().toLowerCase();
  const serials = state.serialItems.filter(item => {
    const itemProduct = product(item.product_id);
    const text = `${itemProduct?.name || ''} ${itemProduct?.code || ''} ${item.serial_number || ''} ${item.mac_address || ''} ${item.asset_tag || ''} ${item.customer_name || ''}`.toLowerCase();
    return !search || text.includes(search);
  });
  table.innerHTML = serials.map(item => {
    const itemProduct = product(item.product_id), location = state.locations.find(entry => entry.id === item.current_location_id);
    return `<tr><td><b>${esc(itemProduct?.name || 'Item removido')}</b><small>${esc(itemProduct?.code || '—')}</small></td><td>${esc(item.serial_number || '—')}</td><td>${esc(item.mac_address || '—')}</td><td>${esc(item.asset_tag || '—')}</td><td>${esc(location?.name || item.customer_name || '—')}</td><td><span class="badge ${serialStatusClass(item.status)}">${esc(serialStatusName(item.status))}</span></td><td><div class="table-actions">${item.status !== 'baixado' ? `<button class="secondary-button" data-move-serial="${item.id}">Mover</button>` : ''}<button class="text-button" data-history-serial="${item.id}">Histórico</button></div></td></tr>`;
  }).join('') || '<tr><td colspan="7" class="empty">Nenhuma unidade rastreável encontrada.</td></tr>';
  const locations = state.locations.filter(item => item.active);
  $('#serial-location').innerHTML = '<option value="">Almoxarifado central</option>' + locations.map(item => `<option value="${item.id}">${esc(item.name)}</option>`).join('');
  document.querySelectorAll('[data-move-serial]').forEach(button => button.onclick = () => openSerialTransfer(button.dataset.moveSerial));
  document.querySelectorAll('[data-history-serial]').forEach(button => button.onclick = () => openSerialHistory(button.dataset.historySerial));
}

function populateSerialTransferOptions() {
  $('#transfer-collaborator').innerHTML = '<option value="">Selecione</option>' + state.collaborators.filter(item => item.active).map(item => `<option value="${item.id}">${esc(item.name)}</option>`).join('');
  $('#transfer-vehicle').innerHTML = '<option value="">Selecione</option>' + state.vehicles.filter(item => item.active).map(item => `<option value="${item.id}">${esc(item.name)}${item.plate ? ` · ${esc(item.plate)}` : ''}</option>`).join('');
  $('#transfer-lab').innerHTML = '<option value="">Selecione</option>' + state.locations.filter(item => item.active && item.location_type === 'laboratorio').map(item => `<option value="${item.id}">${esc(item.name)}</option>`).join('');
}

function openSerialTransfer(id) {
  const item = state.serialItems.find(entry => entry.id === id), itemProduct = item && product(item.product_id);
  if (!item) return;
  $('#serial-transfer-form').reset();
  $('#serial-transfer-id').value = item.id;
  $('#serial-transfer-item').innerHTML = `<b>${esc(itemProduct?.name || 'Item')}</b><span>Serial: ${esc(item.serial_number || '—')} · MAC: ${esc(item.mac_address || '—')} · Status atual: ${esc(serialStatusName(item.status))}</span>`;
  const actions = item.status === 'disponivel'
    ? [['colaborador', 'Entregar para colaborador'], ['veiculo', 'Carregar em veículo'], ['instalar', 'Instalar no cliente'], ['laboratorio', 'Enviar ao laboratório'], ['baixar', 'Baixar / sucata']]
    : [ ...(item.status !== 'laboratorio' ? [['laboratorio', 'Enviar ao laboratório']] : []), ['retornar', 'Retornar ao almoxarifado'], ['baixar', 'Baixar / sucata'] ];
  $('#serial-transfer-action').innerHTML = actions.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  populateSerialTransferOptions();
  updateSerialTransferForm();
  $('#serial-transfer-dialog').showModal();
}

function updateSerialTransferForm() {
  const action = $('#serial-transfer-action').value;
  const groups = { collaborator: $('#transfer-collaborator-group'), vehicle: $('#transfer-vehicle-group'), customer: $('#transfer-customer-group'), lab: $('#transfer-lab-group') };
  Object.values(groups).forEach(group => { group.hidden = true; });
  $('#transfer-collaborator').required = false;
  $('#transfer-vehicle').required = false;
  $('#transfer-customer').required = false;
  $('#transfer-lab').required = false;
  const messages = {
    colaborador: 'A unidade sairá do almoxarifado e ficará vinculada ao colaborador selecionado.',
    veiculo: 'A unidade sairá do almoxarifado e ficará na carga do veículo selecionado.',
    instalar: 'A unidade será marcada como instalada no cliente. Informe a OS quando disponível.',
    laboratorio: 'A unidade deixará o saldo disponível e ficará em laboratório.',
    retornar: 'A unidade voltará ao Almoxarifado Central e entrará novamente no saldo disponível.',
    baixar: 'A unidade será baixada como sucata/indisponível e não poderá mais ser movimentada.'
  };
  if (action === 'colaborador') { groups.collaborator.hidden = false; $('#transfer-collaborator').required = true; }
  if (action === 'veiculo') { groups.vehicle.hidden = false; $('#transfer-vehicle').required = true; }
  if (action === 'instalar') { groups.customer.hidden = false; $('#transfer-customer').required = true; }
  if (action === 'laboratorio') { groups.lab.hidden = false; $('#transfer-lab').required = true; }
  $('#transfer-help').textContent = messages[action];
}

function openSerialHistory(id) {
  const item = state.serialItems.find(entry => entry.id === id), itemProduct = item && product(item.product_id);
  if (!item) return;
  const movements = state.serialMovements.filter(entry => entry.serial_item_id === id);
  $('#serial-history-title').textContent = itemProduct?.name || 'Histórico do equipamento';
  $('#serial-history-subtitle').textContent = `Serial: ${item.serial_number || '—'} · MAC: ${item.mac_address || '—'} · Patrimônio: ${item.asset_tag || '—'}`;
  $('#serial-history-list').innerHTML = movements.map(entry => {
    const from = state.locations.find(location => location.id === entry.from_location_id)?.name || '—';
    const to = state.locations.find(location => location.id === entry.to_location_id)?.name || entry.customer_name || entry.recipient || '—';
    return `<div class="serial-history-item"><div><b>${esc(serialActionName(entry.action))}</b><small>${esc(serialStatusName(entry.previous_status))} → ${esc(serialStatusName(entry.new_status))} · ${date(entry.created_at)}</small><small>${esc(from)} → ${esc(to)}${entry.work_order ? ` · OS: ${esc(entry.work_order)}` : ''}${entry.note ? ` · ${esc(entry.note)}` : ''}</small></div></div>`;
  }).join('') || '<p class="empty">Ainda não há movimentações para esta unidade.</p>';
  $('#serial-history-dialog').showModal();
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
  const [products, movements, collaborators, vehicles, locations, serialItems, serialMovements] = await Promise.all([
    supabase.from('products').select('*').order('name'),
    supabase.from('movements').select('*').order('created_at', { ascending: false }),
    supabase.from('collaborators').select('*').order('name'),
    supabase.from('vehicles').select('*').order('name'),
    supabase.from('stock_locations').select('*').order('name'),
    supabase.from('serial_items').select('*').order('created_at', { ascending: false }),
    supabase.from('serial_movements').select('*').order('created_at', { ascending: false })
  ]);
  if (products.error || movements.error || collaborators.error || vehicles.error || locations.error || serialItems.error || serialMovements.error) throw products.error || movements.error || collaborators.error || vehicles.error || locations.error || serialItems.error || serialMovements.error;
  state.products = products.data.map(item => ({ ...item, minimum: item.minimum_stock }));
  state.movements = movements.data.map(item => ({ id:item.id, type:item.movement_type, productId:item.product_id, quantity:item.quantity, person:item.recipient, holderType:item.holder_type || 'cliente', workOrder:item.work_order, fieldUsage:item.field_usage || false, note:item.note, createdAt:item.created_at, date:date(item.created_at) }));
  state.collaborators = collaborators.data;
  state.vehicles = vehicles.data;
  state.locations = locations.data;
  state.serialItems = serialItems.data;
  state.serialMovements = serialMovements.data;
  try {
    await loadUsers();
  } catch (error) {
    console.warn('Não foi possível carregar a lista de usuários:', error.message);
    state.users = [];
  }
  render();
}

async function toggleCollaborator(id) {
  const collaborator = state.collaborators.find(item => item.id === id);
  if (!collaborator) return;
  const action = collaborator.active ? 'desativar' : 'reativar';
  if (!confirm(`${action[0].toUpperCase() + action.slice(1)} ${collaborator.name}? O histórico será preservado.`)) return;
  const { error } = await supabase.from('collaborators').update({ active: !collaborator.active, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) return alert(error.message);
  await load();
}

async function toggleVehicle(id) {
  const vehicle = state.vehicles.find(item => item.id === id);
  if (!vehicle) return;
  const action = vehicle.active ? 'desativar' : 'reativar';
  if (!confirm(`${action[0].toUpperCase() + action.slice(1)} ${vehicle.name}? O histórico será preservado.`)) return;
  const { error } = await supabase.from('vehicles').update({ active: !vehicle.active, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) return alert(error.message);
  await load();
}

async function deleteCollaborator(id) {
  const collaborator = state.collaborators.find(item => item.id === id);
  if (!collaborator || !confirm(`Remover definitivamente ${collaborator.name}? Os registros anteriores serão preservados, mas o cadastro não poderá ser recuperado.`)) return;
  const { error } = await supabase.rpc('delete_collaborator', { p_collaborator_id: id });
  if (error) return alert(error.message);
  await load();
}

async function deleteVehicle(id) {
  const vehicle = state.vehicles.find(item => item.id === id);
  if (!vehicle || !confirm(`Remover definitivamente o veículo ${vehicle.name}? Os registros anteriores serão preservados, mas o cadastro não poderá ser recuperado.`)) return;
  const { error } = await supabase.rpc('delete_vehicle', { p_vehicle_id: id });
  if (error) return alert(error.message);
  await load();
}

async function toggleLocation(id) {
  const location = state.locations.find(item => item.id === id);
  if (!location) return;
  const action = location.active ? 'desativar' : 'reativar';
  if (!confirm(`${action[0].toUpperCase() + action.slice(1)} ${location.name}? O histórico será preservado.`)) return;
  const { error } = await supabase.from('stock_locations').update({ active: !location.active, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) return alert(error.message);
  await load();
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
  $('#page-title').textContent = ({ dashboard:'Visão geral', products:'Produtos', movement:'Movimentações', serials:'Serial / MAC', registry:'Cadastros', users:'Usuários' })[id];
  $('#header-action').hidden = id === 'users' || id === 'products' || id === 'serials' || id === 'registry';
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
  setSelectValue('#edit-category', item.category);
  $('#edit-brand').value = item.brand || '';
  $('#edit-model').value = item.model || '';
  $('#edit-unit').value = item.unit_of_measure || 'unidade';
  $('#edit-tracking').value = item.tracking_mode || 'quantidade';
  $('#edit-description').value = item.description || '';
  $('#edit-requires-ca').value = item.requires_ca ? 'true' : 'false';
  $('#edit-ca-number').value = item.ca_number || '';
  $('#edit-ca-expiry').value = item.ca_expiry_date || '';
  $('#edit-stock').value = item.stock;
  $('#edit-minimum').value = item.minimum;
  $('#edit-product-dialog').showModal();
}

function setSelectValue(selector, value) {
  const select = $(selector);
  if (![...select.options].some(option => option.value === value)) select.add(new Option(value, value));
  select.value = value;
}

async function start(session) {
  const { data: profile } = await supabase.from('profiles').select('full_name, role').eq('id', session.user.id).maybeSingle();
  currentUser = { id: session.user.id, email: session.user.email, role: profile?.role || 'tecnico' };
  const isAdmin = currentUser.role === 'admin';
  const canManage = ['admin', 'operador'].includes(currentUser.role);
  document.querySelectorAll('[data-admin-only]').forEach(element => { element.hidden = !isAdmin; });
  document.querySelectorAll('[data-manager-only]').forEach(element => { element.hidden = !canManage; });
  $('#users').hidden = !isAdmin;
  $('#serials').hidden = !canManage;
  $('#registry').hidden = !canManage;
  try { await load(); } catch (error) { alert(error.message); }
}

document.querySelectorAll('.nav-link').forEach(button => button.onclick = () => button.dataset.view === 'products' ? showProducts() : view(button.dataset.view));
document.querySelectorAll('[data-go]').forEach(button => button.onclick = () => button.dataset.go === 'products' ? showProducts() : view(button.dataset.go));
$('#header-action').onclick = () => $('.view.active').id === 'products' ? $('#product-dialog').showModal() : view('movement');
$('#add-product').onclick = () => $('#product-dialog').showModal();
$('#add-user').onclick = () => $('#user-dialog').showModal();
$('#add-serial').onclick = () => {
  if (!state.products.some(item => item.tracking_mode === 'serializado')) return alert('Cadastre ou edite um item e escolha o controle “Por serial / MAC” antes de registrar uma unidade.');
  $('#serial-dialog').showModal();
};
$('#add-collaborator').onclick = () => $('#collaborator-dialog').showModal();
$('#add-vehicle').onclick = () => $('#vehicle-dialog').showModal();
$('#add-location').onclick = () => $('#location-dialog').showModal();
$('#logout').onclick = async () => {
  if (!confirm('Deseja sair da conta?')) return;
  const { error } = await supabase.auth.signOut();
  if (error) return alert(error.message);
  currentUser = null;
  state = { products: [], movements: [], users: [], collaborators: [], vehicles: [], locations: [], serialItems: [], serialMovements: [], productFilter: 'all' };
  $('#login-form').reset();
  $('#auth-gate').hidden = false;
};
document.querySelectorAll('[data-close-dialog]').forEach(button => button.onclick = () => button.closest('dialog').close());
$('#low-stock-card').onclick = () => showProducts('low');
$('#product-search').oninput = () => { state.productFilter = 'all'; renderProducts(); };
$('#serial-search').oninput = renderSerials;
document.querySelectorAll('[data-history-filter]').forEach(element => { element.oninput = renderMovement; element.onchange = renderMovement; });
$('#clear-history-filters').onclick = () => { document.querySelectorAll('[data-history-filter]').forEach(element => { element.value = ''; }); renderMovement(); };
$('#export-excel').onclick = exportExcelReport;
function updateMovementRecipientPlaceholder() {
  const placeholders = { tecnico: 'Ex.: João Silva — Equipe externa', veiculo: 'Ex.: Carro 01 — Equipe Norte', cliente: 'Ex.: Cliente ou endereço', outro: 'Descreva o destino' };
  const holderType = $('#movement-holder-type').value, recipient = $('#movement-person');
  recipient.placeholder = placeholders[holderType];
  const list = holderType === 'tecnico' ? 'collaborator-options' : holderType === 'veiculo' ? 'vehicle-options' : '';
  if (list) recipient.setAttribute('list', list); else recipient.removeAttribute('list');
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

function updateSerialStockOption() {
  const available = $('#serial-status').value === 'disponivel', addToStock = $('#serial-add-stock');
  addToStock.disabled = !available;
  if (!available) addToStock.checked = false;
  $('#serial-stock-help').textContent = available ? 'Marque para dar entrada desta unidade no estoque. Desmarque apenas se ela já estiver incluída no saldo do produto.' : 'Unidades indisponíveis não entram no saldo disponível do almoxarifado.';
}

$('#serial-status').onchange = updateSerialStockOption;
updateSerialStockOption();
$('#serial-transfer-action').onchange = updateSerialTransferForm;

function productData(prefix) {
  return {
    name: $(`#${prefix}-name`).value.trim(),
    code: $(`#${prefix}-code`).value.trim(),
    category: $(`#${prefix}-category`).value,
    brand: $(`#${prefix}-brand`).value.trim() || null,
    model: $(`#${prefix}-model`).value.trim() || null,
    unit_of_measure: $(`#${prefix}-unit`).value,
    tracking_mode: $(`#${prefix}-tracking`).value,
    description: $(`#${prefix}-description`).value.trim() || null,
    requires_ca: $(`#${prefix}-requires-ca`).value === 'true',
    ca_number: $(`#${prefix}-ca-number`).value.trim() || null,
    ca_expiry_date: $(`#${prefix}-ca-expiry`).value || null
  };
}

$('#product-form').onsubmit = async event => {
  event.preventDefault();
  const productData = { ...productData('new'), stock:Number($('#new-stock').value), minimum_stock:Number($('#new-minimum').value) };
  const { error } = await supabase.from('products').insert(productData);
  if (error) return alert(error.message);
  event.target.reset(); $('#product-dialog').close(); await load(); view('products');
};

$('#edit-product-form').onsubmit = async event => {
  event.preventDefault();
  const id = $('#edit-product-id').value;
  try {
    const updatedProduct = { ...productData('edit'), minimum_stock:Number($('#edit-minimum').value) };
    const { error } = await supabase.from('products').update(updatedProduct).eq('id', id);
    if (error) throw error;
    $('#edit-product-dialog').close(); await load(); view('products');
  } catch (error) {
    alert(error.message);
  }
};

$('#movement-form').onsubmit = async event => {
  event.preventDefault(); const selectedProduct = product($('#movement-product').value), quantity = Number($('#movement-quantity').value), operation = $('#movement-type').value, fieldUsage = operation === 'uso_os', type = fieldUsage ? 'saida' : operation, workOrder = $('#movement-work-order').value.trim();
  if (fieldUsage && !workOrder) return alert('Informe o número da OS para registrar o uso do material.');
  if (!fieldUsage && type === 'saida' && quantity > selectedProduct.stock) return alert(`Estoque insuficiente. Disponível: ${stockLabel(selectedProduct)}.`);
  const movementData = { p_product_id:selectedProduct.id, p_type:type, p_quantity:quantity, p_recipient:$('#movement-person').value, p_note:$('#movement-note').value || null, p_holder_type:$('#movement-holder-type').value, p_work_order:workOrder || null };
  if (fieldUsage) movementData.p_field_usage = true;
  const { error } = await supabase.rpc('record_movement', movementData);
  if (error) return alert(error.message);
  event.target.reset(); $('#movement-quantity').value = 1; updateMovementMode(); await load(); view('dashboard');
};

$('#collaborator-form').onsubmit = async event => {
  event.preventDefault();
  const { error } = await supabase.from('collaborators').insert({
    name: $('#collaborator-name').value.trim(),
    job_title: $('#collaborator-job-title').value.trim() || null,
    department: $('#collaborator-department').value.trim() || null,
    phone: $('#collaborator-phone').value.trim() || null
  });
  if (error) return alert(error.message);
  event.target.reset(); $('#collaborator-dialog').close(); await load(); view('registry');
};

$('#vehicle-form').onsubmit = async event => {
  event.preventDefault();
  const { error } = await supabase.from('vehicles').insert({
    name: $('#vehicle-name').value.trim(),
    plate: $('#vehicle-plate').value.trim().toUpperCase() || null,
    responsible_id: $('#vehicle-responsible').value || null
  });
  if (error) return alert(error.message);
  event.target.reset(); $('#vehicle-dialog').close(); await load(); view('registry');
};

$('#location-form').onsubmit = async event => {
  event.preventDefault();
  const { error } = await supabase.from('stock_locations').insert({
    name: $('#location-name').value.trim(),
    location_type: $('#location-type').value
  });
  if (error) return alert(error.message);
  event.target.reset(); $('#location-dialog').close(); await load(); view('registry');
};

$('#serial-form').onsubmit = async event => {
  event.preventDefault();
  const { error } = await supabase.rpc('register_serial_item', {
    p_product_id: $('#serial-product').value,
    p_serial_number: $('#serial-number').value || null,
    p_mac_address: $('#serial-mac').value || null,
    p_asset_tag: $('#serial-asset-tag').value || null,
    p_status: $('#serial-status').value,
    p_location_id: $('#serial-location').value || null,
    p_customer_name: $('#serial-customer').value || null,
    p_customer_reference: $('#serial-customer-reference').value || null,
    p_notes: $('#serial-notes').value || null,
    p_add_to_stock: $('#serial-add-stock').checked
  });
  if (error) return alert(error.message);
  event.target.reset(); $('#serial-add-stock').checked = true; updateSerialStockOption(); $('#serial-dialog').close(); await load(); view('serials');
};

$('#serial-transfer-form').onsubmit = async event => {
  event.preventDefault();
  const action = $('#serial-transfer-action').value;
  const { error } = await supabase.rpc('move_serial_item', {
    p_serial_item_id: $('#serial-transfer-id').value,
    p_action: action,
    p_collaborator_id: action === 'colaborador' ? $('#transfer-collaborator').value || null : null,
    p_vehicle_id: action === 'veiculo' ? $('#transfer-vehicle').value || null : null,
    p_location_id: action === 'laboratorio' ? $('#transfer-lab').value || null : null,
    p_customer_name: action === 'instalar' ? $('#transfer-customer').value || null : null,
    p_customer_reference: action === 'instalar' ? $('#transfer-customer-reference').value || null : null,
    p_work_order: $('#transfer-work-order').value || null,
    p_note: $('#transfer-note').value || null
  });
  if (error) return alert(error.message);
  $('#serial-transfer-dialog').close(); await load(); view('serials');
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
