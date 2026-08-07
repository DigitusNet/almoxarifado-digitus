import { createClient } from '@supabase/supabase-js';

const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);
let state = { products: [], movements: [], users: [], collaborators: [], vehicles: [], locations: [], suppliers: [], serialItems: [], serialMovements: [], toolLoans: [], receipts: [], receiptItems: [], inventorySessions: [], inventoryCounts: [], productFilter: 'all' };
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
let scannerStream = null;
let scannerFrame = null;
let scannerSession = 0;
let scannerTarget = 'products';
let barcodeDetector = null;
const normalizedScanCode = value => String(value || '').trim().replace(/[^a-z0-9]/gi, '').toLocaleLowerCase('pt-BR');

function scannerMessage(message) {
  const messageElement = $('#scanner-message');
  if (messageElement) messageElement.textContent = message;
}

function stopCodeScanner() {
  scannerSession += 1;
  if (scannerFrame) cancelAnimationFrame(scannerFrame);
  scannerFrame = null;
  if (scannerStream) scannerStream.getTracks().forEach(track => track.stop());
  scannerStream = null;
  const video = $('#scanner-video');
  if (video) video.srcObject = null;
}

function findScannedItem(code) {
  const normalized = normalizedScanCode(code);
  if (!normalized) return null;
  const itemProduct = state.products.find(item => normalizedScanCode(item.code) === normalized);
  if (itemProduct) return { type: 'product', item: itemProduct };
  const serialItem = state.serialItems.find(item => [item.serial_number, item.mac_address, item.asset_tag].some(value => normalizedScanCode(value) === normalized));
  return serialItem ? { type: 'serial', item: serialItem } : null;
}

function useScannedCode(rawCode) {
  const code = String(rawCode || '').trim();
  const result = findScannedItem(code);
  if (!result) {
    scannerMessage(`O código “${code}” não foi encontrado. Confira o cadastro ou digite outro código.`);
    $('#scanner-manual-code').focus();
    return;
  }

  if (result.type === 'serial') {
    stopCodeScanner();
    $('#code-scanner-dialog').close();
    $('#serial-search').value = code;
    view('serials');
    renderSerials();
    if (scannerTarget === 'movement') openSerialTransfer(result.item.id);
    return;
  }

  if (scannerTarget === 'movement' && result.item.tracking_mode === 'serializado') {
    scannerMessage('Este item é controlado por Serial/MAC. Leia o serial, MAC ou patrimônio da unidade específica para movimentá-la.');
    $('#scanner-manual-code').focus();
    return;
  }

  stopCodeScanner();
  $('#code-scanner-dialog').close();
  if (scannerTarget === 'movement') {
    view('movement');
    $('#movement-product').value = result.item.id;
    $('#movement-quantity').focus();
    return;
  }
  showProducts();
  $('#product-search').value = result.item.code;
  renderProducts();
}

function scanCameraFrame(session) {
  if (session !== scannerSession || !scannerStream || !barcodeDetector) return;
  const video = $('#scanner-video');
  barcodeDetector.detect(video)
    .then(codes => {
      if (session !== scannerSession || !codes.length) return;
      const code = codes[0].rawValue;
      $('#scanner-manual-code').value = code;
      stopCodeScanner();
      useScannedCode(code);
    })
    .catch(() => {})
    .finally(() => {
      if (session === scannerSession && scannerStream) scannerFrame = requestAnimationFrame(() => scanCameraFrame(session));
    });
}

async function openCodeScanner(target) {
  scannerTarget = target;
  stopCodeScanner();
  const session = ++scannerSession;
  const dialog = $('#code-scanner-dialog');
  $('#scanner-manual-code').value = '';
  scannerMessage('Solicitando acesso à câmera…');
  dialog.showModal();
  $('#scanner-manual-code').focus();

  if (!navigator.mediaDevices?.getUserMedia) {
    scannerMessage('A câmera não está disponível neste dispositivo. Digite o código ou use um leitor USB abaixo.');
    return;
  }
  if (!('BarcodeDetector' in window)) {
    scannerMessage('A leitura pela câmera é compatível com Chrome e Edge atualizados. Você ainda pode usar leitor USB ou digitar o código abaixo.');
    return;
  }

  try {
    try {
      barcodeDetector = new window.BarcodeDetector({ formats: ['qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf', 'codabar', 'data_matrix', 'pdf417'] });
    } catch (detectorError) {
      barcodeDetector = new window.BarcodeDetector();
    }
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    if (session !== scannerSession) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    scannerStream = stream;
    const video = $('#scanner-video');
    video.srcObject = stream;
    await video.play();
    scannerMessage('Câmera pronta. Centralize o código dentro da marcação.');
    scanCameraFrame(session);
  } catch (error) {
    if (session === scannerSession) scannerMessage('Não foi possível abrir a câmera. Verifique a permissão do navegador ou use o leitor USB/campo manual.');
  }
}

function caAlert(item) {
  if (!item.requires_ca || !item.ca_expiry_date) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(`${item.ca_expiry_date}T00:00:00`);
  const days = Math.ceil((expiry - today) / 86400000);
  if (days < 0) return { type: 'expired', label: 'CA vencido' };
  if (days === 0) return { type: 'expired', label: 'CA vence hoje' };
  if (days <= 30) return { type: 'warning', label: `CA vence em ${days} dia${days === 1 ? '' : 's'}` };
  return null;
}
const serialStatusName = status => ({ disponivel:'Disponível', com_colaborador:'Com colaborador', com_veiculo:'Com veículo', instalado_cliente:'Instalado no cliente', emprestado:'Emprestado', aguardando_triagem:'Aguardando triagem', laboratorio:'Laboratório', manutencao:'Em manutenção', defeito:'Defeito', baixado:'Baixado' })[status] || status;
const serialStatusClass = status => ({ disponivel:'ok', com_colaborador:'saida', com_veiculo:'saida', instalado_cliente:'saida', emprestado:'saida', aguardando_triagem:'low', laboratorio:'low', manutencao:'low', defeito:'out', baixado:'out' })[status] || 'low';
const serialActionName = action => ({ transferencia:'Transferência', instalacao:'Instalação em cliente', laboratorio:'Envio ao laboratório', retorno:'Retorno ao almoxarifado', baixa:'Baixa / sucata' })[action] || action;
const loanTypeName = type => type === 'cautela' ? 'Cautela fixa' : 'Empréstimo temporário';
const loanOverdue = loan => !loan.returned_at && loan.loan_type === 'temporario' && loan.due_at && new Date(loan.due_at) < new Date();

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

function render() {
  const lows = state.products.filter(low), total = state.products.filter(item => Number(item.stock) > 0).length, caAlerts = state.products.filter(caAlert);
  const overdueLoans = state.toolLoans.filter(loanOverdue).length;
  const laboratoryItems = state.serialItems.filter(item => {
    const location = state.locations.find(entry => entry.id === item.current_location_id);
    return location?.location_type === 'laboratorio' && ['laboratorio', 'manutencao', 'defeito', 'aguardando_triagem'].includes(item.status);
  }).length;
  $('#product-count').textContent = state.products.length;
  $('#stock-total').textContent = total.toLocaleString('pt-BR');
  $('#low-stock').textContent = lows.length;
  $('#ca-alert-total').textContent = caAlerts.length;
  $('#dashboard-overdue-loans').textContent = overdueLoans;
  $('#dashboard-lab-total').textContent = laboratoryItems;
  $('#low-stock-list').innerHTML = lows.length ? lows.map(item => `<div class="compact-row"><div><b>${esc(item.name)}</b><small>${esc(item.code)} · mínimo: ${stockLabel({ ...item, stock: item.minimum })}</small></div><span class="badge low">${stockLabel(item)}</span></div>`).join('') : '<p class="empty">Nenhum item precisa de reposição.</p>';
  $('#recent-movements').innerHTML = state.movements.slice(0, 5).map(item => `<div class="compact-row"><div><b>${movementName(item)} · ${esc(product(item.productId)?.name || 'Produto')}</b><small>${esc(item.person)} · ${item.date}</small></div><span class="badge ${item.type}">${item.type === 'entrada' ? '+' : '-'}${quantity(item.quantity)} ${unitName(product(item.productId)?.unit_of_measure)}</span></div>`).join('') || '<p class="empty">Sem movimentações.</p>';
  renderProducts(); renderMovement(); renderFieldStock(); renderUsers(); renderRegistry(); renderReceipts(); renderSerials(); renderLaboratory(); renderLoans(); renderInventory();
}

function renderProducts() {
  const query = $('#product-search').value.toLowerCase();
  const canDelete = currentUser?.role === 'admin';
  const canEdit = ['admin', 'operador'].includes(currentUser?.role);
  const categorySelect = $('#product-category-filter'), statusSelect = $('#product-status-filter');
  const selectedCategory = categorySelect.value;
  const categories = [...new Set(state.products.map(item => item.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  categorySelect.innerHTML = '<option value="">Todas as categorias</option>' + categories.map(category => `<option value="${esc(category)}">${esc(category)}</option>`).join('');
  categorySelect.value = categories.includes(selectedCategory) ? selectedCategory : '';
  const category = categorySelect.value, statusFilter = statusSelect.value;
  const products = state.products.filter(item => {
    const matchesPreset = (state.productFilter !== 'low' || low(item)) && (state.productFilter !== 'ca' || caAlert(item));
    const matchesCategory = !category || item.category === category;
    const matchesStatus = !statusFilter
      || statusFilter === 'available' && Number(item.stock) > 0 && !low(item)
      || statusFilter === 'low' && low(item) && Number(item.stock) > 0
      || statusFilter === 'out' && Number(item.stock) === 0
      || statusFilter === 'ca' && Boolean(caAlert(item));
    return matchesPreset && matchesCategory && matchesStatus && `${item.name} ${item.code} ${item.category}`.toLowerCase().includes(query);
  });
  $('#products-table').innerHTML = products.map(item => {
    const ca = caAlert(item);
    return `<tr><td><b>${esc(item.name)}</b><small>${esc([item.brand, item.model].filter(Boolean).join(' · ') || (item.tracking_mode === 'serializado' ? 'Rastreável por serial/MAC' : 'Controle por quantidade'))}</small></td><td>${esc(item.code)}</td><td>${esc(item.category)}</td><td><b>${stockLabel(item)}</b><small>mínimo: ${quantity(item.minimum)} ${unitName(item.unit_of_measure)}</small></td><td>${status(item)}${ca ? `<small class="ca-status ${ca.type}">${esc(ca.label)} · validade: ${new Date(`${item.ca_expiry_date}T00:00:00`).toLocaleDateString('pt-BR')}</small>` : ''}</td><td><div class="table-actions">${canEdit ? `<button class="secondary-button" data-edit-product="${item.id}">Editar</button>` : ''}${canDelete ? `<button class="danger-button" data-delete-product="${item.id}">Apagar</button>` : ''}${!canEdit && !canDelete ? '—' : ''}</div></td></tr>`;
  }).join('') || '<tr><td colspan="6" class="empty">Nenhum produto encontrado.</td></tr>';
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

function receiptProducts() {
  return state.products.filter(item => item.tracking_mode !== 'serializado');
}

function receiptLineHtml(selected = '') {
  const products = receiptProducts();
  return `<div class="receipt-line"><label>Material <select data-receipt-product required><option value="">Selecione</option>${products.map(item => `<option value="${item.id}" ${item.id === selected ? 'selected' : ''}>${esc(item.name)} (${stockLabel(item)})</option>`).join('')}</select></label><label>Quantidade <input data-receipt-quantity type="number" min="0.001" step="0.001" required value="1" /></label><button class="receipt-line-remove" data-remove-receipt-line type="button" aria-label="Remover material">×</button></div>`;
}

function bindReceiptLineEvents() {
  document.querySelectorAll('[data-remove-receipt-line]').forEach(button => button.onclick = () => button.closest('.receipt-line').remove());
}

function addReceiptLine(selected = '') {
  $('#receipt-lines').insertAdjacentHTML('beforeend', receiptLineHtml(selected));
  bindReceiptLineEvents();
}

function openReceiptDialog() {
  if (!receiptProducts().length) return alert('Cadastre um material controlado por quantidade antes de registrar um recebimento. Itens por Serial/MAC devem ser cadastrados na tela Serial / MAC.');
  $('#receipt-form').reset();
  populateReceiptSuppliers();
  $('#receipt-lines').innerHTML = '';
  addReceiptLine();
  $('#receipt-dialog').showModal();
}

function openReceiptDetails(id) {
  const receipt = state.receipts.find(item => item.id === id);
  if (!receipt) return;
  const items = state.receiptItems.filter(item => item.receipt_id === id);
  $('#receipt-details-title').textContent = receipt.supplier;
  $('#receipt-details-subtitle').textContent = `${receipt.invoice_number ? `NF: ${receipt.invoice_number} · ` : ''}${date(receipt.received_at)}${receipt.note ? ` · ${receipt.note}` : ''}`;
  $('#receipt-details-list').innerHTML = items.map(item => `<div class="serial-history-item"><b>${esc(item.product_name)}</b><small>${quantity(item.quantity)} ${unitName(item.unit_of_measure)} · Código: ${esc(item.product_code)}</small></div>`).join('') || '<p class="empty">Nenhum material encontrado neste recebimento.</p>';
  $('#receipt-details-dialog').showModal();
}

function renderReceipts() {
  const table = $('#receipts-table');
  if (!table) return;
  populateReceiptSuppliers();
  table.innerHTML = state.receipts.map(receipt => {
    const items = state.receiptItems.filter(item => item.receipt_id === receipt.id);
    const summary = items.length ? `${items.slice(0, 2).map(item => esc(item.product_name)).join(', ')}${items.length > 2 ? ` +${items.length - 2}` : ''}` : 'Sem materiais';
    return `<tr><td><b>${esc(receipt.supplier)}</b><small>${esc(receipt.note || 'Sem observação')}</small></td><td>${esc(receipt.invoice_number || '—')}</td><td>${summary}</td><td>${date(receipt.received_at)}</td><td><button class="secondary-button" data-receipt-details="${receipt.id}">Detalhes</button></td></tr>`;
  }).join('') || '<tr><td colspan="5" class="empty">Nenhum recebimento registrado.</td></tr>';
  document.querySelectorAll('[data-receipt-details]').forEach(button => button.onclick = () => openReceiptDetails(button.dataset.receiptDetails));
}

function populateReceiptSuppliers() {
  const options = $('#receipt-supplier-options');
  if (!options) return;
  options.innerHTML = state.suppliers
    .filter(item => item.active)
    .map(item => `<option value="${esc(item.name)}"></option>`)
    .join('');
}

function renderFieldStock() {
  const items = getFieldStockItems();
  $('#field-stock-list').innerHTML = items.length ? items.map(item => `<div class="compact-row"><div><b>${esc(item.person)} · ${esc(product(item.productId)?.name || 'Produto')}</b><small>${holderTypeName(item.holderType)} · código: ${esc(product(item.productId)?.code || '—')}</small></div><span class="badge entrada">${quantity(item.balance)} ${unitName(product(item.productId)?.unit_of_measure)}</span></div>`).join('') : '<p class="empty">Nenhum material está registrado com técnicos ou veículos.</p>';
}

function renderRegistry() {
  const collaboratorsTable = $('#collaborators-table'), vehiclesTable = $('#vehicles-table'), locationsTable = $('#locations-table'), suppliersTable = $('#suppliers-table');
  if (!collaboratorsTable || !vehiclesTable || !locationsTable || !suppliersTable) return;
  const collaborators = state.collaborators;
  collaboratorsTable.innerHTML = collaborators.map(item => `<tr><td><b>${esc(item.name)}</b><small>${esc(item.job_title || 'Sem cargo informado')}</small></td><td>${esc(item.department || '—')}</td><td>${esc(item.phone || '—')}</td><td>${item.active ? '<span class="badge ok">Ativo</span>' : '<span class="badge out">Inativo</span>'}</td><td><div class="table-actions"><button class="secondary-button" data-toggle-collaborator="${item.id}">${item.active ? 'Desativar' : 'Reativar'}</button><button class="danger-button" data-delete-collaborator="${item.id}">Remover</button></div></td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nenhum colaborador cadastrado.</td></tr>';
  vehiclesTable.innerHTML = state.vehicles.map(item => `<tr><td><b>${esc(item.name)}</b><small>${esc(item.plate || 'Sem placa informada')}</small></td><td>${esc(state.collaborators.find(collaborator => collaborator.id === item.responsible_id)?.name || '—')}</td><td>${item.active ? '<span class="badge ok">Ativo</span>' : '<span class="badge out">Inativo</span>'}</td><td><div class="table-actions"><button class="secondary-button" data-toggle-vehicle="${item.id}">${item.active ? 'Desativar' : 'Reativar'}</button><button class="danger-button" data-delete-vehicle="${item.id}">Remover</button></div></td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nenhum veículo cadastrado.</td></tr>';
  locationsTable.innerHTML = state.locations.map(item => `<tr><td><b>${esc(item.name)}</b></td><td>${esc(({ central:'Almoxarifado central', laboratorio:'Laboratório', outro:'Outro', colaborador:'Colaborador', veiculo:'Veículo', cliente:'Cliente' })[item.location_type] || item.location_type)}</td><td>${item.active ? '<span class="badge ok">Ativo</span>' : '<span class="badge out">Inativo</span>'}</td><td>${item.location_type === 'central' ? '—' : `<button class="secondary-button" data-toggle-location="${item.id}">${item.active ? 'Desativar' : 'Reativar'}</button>`}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nenhum local cadastrado.</td></tr>';
  suppliersTable.innerHTML = state.suppliers.map(item => `<tr><td><b>${esc(item.name)}</b><small>${esc(item.email || 'Sem e-mail informado')}</small></td><td>${esc(item.cnpj || '—')}</td><td>${esc([item.contact_name, item.phone].filter(Boolean).join(' · ') || '—')}</td><td>${item.active ? '<span class="badge ok">Ativo</span>' : '<span class="badge out">Inativo</span>'}</td><td><div class="table-actions"><button class="secondary-button" data-toggle-supplier="${item.id}">${item.active ? 'Desativar' : 'Reativar'}</button><button class="danger-button" data-delete-supplier="${item.id}">Remover</button></div></td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nenhum fornecedor cadastrado.</td></tr>';
  $('#collaborator-options').innerHTML = collaborators.filter(item => item.active).map(item => `<option value="${esc(item.name)}"></option>`).join('');
  $('#vehicle-options').innerHTML = state.vehicles.filter(item => item.active).map(item => `<option value="${esc(item.name)}">${esc(item.plate || '')}</option>`).join('');
  $('#vehicle-responsible').innerHTML = '<option value="">Sem responsável definido</option>' + collaborators.filter(item => item.active).map(item => `<option value="${item.id}">${esc(item.name)}</option>`).join('');
  document.querySelectorAll('[data-toggle-collaborator]').forEach(button => button.onclick = () => toggleCollaborator(button.dataset.toggleCollaborator));
  document.querySelectorAll('[data-toggle-vehicle]').forEach(button => button.onclick = () => toggleVehicle(button.dataset.toggleVehicle));
  document.querySelectorAll('[data-delete-collaborator]').forEach(button => button.onclick = () => deleteCollaborator(button.dataset.deleteCollaborator));
  document.querySelectorAll('[data-delete-vehicle]').forEach(button => button.onclick = () => deleteVehicle(button.dataset.deleteVehicle));
  document.querySelectorAll('[data-toggle-location]').forEach(button => button.onclick = () => toggleLocation(button.dataset.toggleLocation));
  document.querySelectorAll('[data-toggle-supplier]').forEach(button => button.onclick = () => toggleSupplier(button.dataset.toggleSupplier));
  document.querySelectorAll('[data-delete-supplier]').forEach(button => button.onclick = () => deleteSupplier(button.dataset.deleteSupplier));
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

function renderLaboratory() {
  const table = $('#laboratory-table');
  if (!table) return;
  const search = $('#lab-search').value.trim().toLowerCase();
  const items = state.serialItems.filter(item => {
    const location = state.locations.find(entry => entry.id === item.current_location_id);
    const itemProduct = product(item.product_id);
    const isLaboratoryItem = location?.location_type === 'laboratorio' && ['laboratorio', 'manutencao', 'defeito', 'aguardando_triagem'].includes(item.status);
    const text = `${itemProduct?.name || ''} ${itemProduct?.code || ''} ${item.serial_number || ''} ${item.mac_address || ''} ${item.asset_tag || ''}`.toLowerCase();
    return isLaboratoryItem && (!search || text.includes(search));
  });
  const allLaboratoryItems = state.serialItems.filter(item => {
    const location = state.locations.find(entry => entry.id === item.current_location_id);
    return location?.location_type === 'laboratorio' && ['laboratorio', 'manutencao', 'defeito', 'aguardando_triagem'].includes(item.status);
  });
  $('#lab-total').textContent = allLaboratoryItems.length;
  $('#lab-pending-total').textContent = allLaboratoryItems.filter(item => ['manutencao', 'defeito'].includes(item.status)).length;
  table.innerHTML = items.map(item => {
    const itemProduct = product(item.product_id), location = state.locations.find(entry => entry.id === item.current_location_id);
    const identifiers = [item.serial_number && `Serial: ${item.serial_number}`, item.mac_address && `MAC: ${item.mac_address}`, item.asset_tag && `Patrimônio: ${item.asset_tag}`].filter(Boolean).join(' · ');
    return `<tr><td><b>${esc(itemProduct?.name || 'Item removido')}</b><small>${esc(itemProduct?.code || '—')}</small></td><td>${esc(identifiers || 'Sem identificador')}</td><td>${esc(location?.name || 'Laboratório')}</td><td><span class="badge ${serialStatusClass(item.status)}">${esc(serialStatusName(item.status))}</span></td><td><div class="table-actions"><button class="primary small-primary" data-process-laboratory="${item.id}">Processar</button><button class="text-button" data-history-serial="${item.id}">Histórico</button></div></td></tr>`;
  }).join('') || '<tr><td colspan="5" class="empty">Nenhum equipamento aguardando avaliação no laboratório.</td></tr>';
  document.querySelectorAll('[data-process-laboratory]').forEach(button => button.onclick = () => openLaboratoryDialog(button.dataset.processLaboratory));
  document.querySelectorAll('[data-history-serial]').forEach(button => button.onclick = () => openSerialHistory(button.dataset.historySerial));
}

function updateLaboratoryForm() {
  const action = $('#laboratory-action').value;
  const requiresNote = ['manutencao', 'defeito', 'baixar'].includes(action);
  $('#laboratory-note').required = requiresNote;
  $('#laboratory-help').textContent = ({
    aprovar: 'O item será devolvido ao Almoxarifado Central e voltará ao saldo disponível.',
    manutencao: 'O item continuará no laboratório, marcado como em manutenção.',
    defeito: 'O item continuará no laboratório, marcado como defeito e fora do saldo disponível.',
    baixar: 'O item será baixado definitivamente como sucata e não poderá mais ser movimentado.'
  })[action];
}

function openLaboratoryDialog(id) {
  const item = state.serialItems.find(entry => entry.id === id), itemProduct = item && product(item.product_id);
  if (!item) return;
  $('#laboratory-form').reset();
  $('#laboratory-item-id').value = item.id;
  $('#laboratory-item').innerHTML = `<b>${esc(itemProduct?.name || 'Equipamento')}</b><span>Serial: ${esc(item.serial_number || '—')} · MAC: ${esc(item.mac_address || '—')} · Patrimônio: ${esc(item.asset_tag || '—')}</span>`;
  updateLaboratoryForm();
  $('#laboratory-dialog').showModal();
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

function renderLoans() {
  const table = $('#loans-table'), loanItem = $('#loan-item');
  if (!table || !loanItem) return;
  const activeLoans = state.toolLoans.filter(loan => !loan.returned_at);
  $('#open-loan-count').textContent = activeLoans.length;
  $('#overdue-loan-count').textContent = activeLoans.filter(loanOverdue).length;
  table.innerHTML = activeLoans.map(loan => {
    const item = state.serialItems.find(entry => entry.id === loan.serial_item_id), itemProduct = item && product(item.product_id);
    const overdue = loanOverdue(loan), due = loan.loan_type === 'temporario' ? (loan.due_at ? date(loan.due_at) : 'Sem prazo') : 'Sem prazo';
    return `<tr><td><b>${esc(itemProduct?.name || 'Ferramenta')}</b><small>Serial: ${esc(item?.serial_number || '—')} · Patrimônio: ${esc(item?.asset_tag || '—')}</small></td><td>${esc(loan.collaborator_name || state.collaborators.find(collaborator => collaborator.id === loan.collaborator_id)?.name || '—')}</td><td>${esc(loanTypeName(loan.loan_type))}</td><td>${date(loan.issued_at)}</td><td>${due}</td><td><span class="badge ${overdue ? 'out' : 'low'}">${overdue ? 'Atrasada' : 'Em aberto'}</span></td><td><div class="table-actions"><button class="secondary-button" data-print-loan="${loan.id}">Termo</button><button class="primary small-primary" data-return-loan="${loan.id}">Devolver</button></div></td></tr>`;
  }).join('') || '<tr><td colspan="7" class="empty">Nenhuma cautela em aberto.</td></tr>';

  const loanableItems = state.serialItems.filter(item => {
    const itemProduct = product(item.product_id), category = String(itemProduct?.category || '').toLowerCase();
    return item.status === 'disponivel' && ['ferramentas', 'patrimônio', 'patrimonio'].includes(category);
  });
  loanItem.innerHTML = loanableItems.map(item => {
    const itemProduct = product(item.product_id);
    return `<option value="${item.id}">${esc(itemProduct?.name || 'Ferramenta')} · ${esc(item.asset_tag || item.serial_number || item.mac_address || 'Sem identificador')}</option>`;
  }).join('');
  $('#loan-collaborator').innerHTML = '<option value="">Selecione</option>' + state.collaborators.filter(item => item.active).map(item => `<option value="${item.id}">${esc(item.name)}</option>`).join('');
  document.querySelectorAll('[data-return-loan]').forEach(button => button.onclick = () => openLoanReturn(button.dataset.returnLoan));
  document.querySelectorAll('[data-print-loan]').forEach(button => button.onclick = () => printLoanTerm(button.dataset.printLoan));
}

function updateLoanTypeForm() {
  const temporary = $('#loan-type').value === 'temporario';
  $('#loan-due-group').hidden = !temporary;
  $('#loan-due').required = temporary;
  if (!temporary) $('#loan-due').value = '';
}

function openLoanReturn(id) {
  const loan = state.toolLoans.find(item => item.id === id), serialItem = loan && state.serialItems.find(item => item.id === loan.serial_item_id), itemProduct = serialItem && product(serialItem.product_id);
  if (!loan) return;
  $('#return-loan-form').reset();
  $('#return-loan-id').value = loan.id;
  $('#return-loan-item').innerHTML = `<b>${esc(itemProduct?.name || 'Ferramenta')}</b><span>Responsável: ${esc(loan.collaborator_name || '—')} · Serial: ${esc(serialItem?.serial_number || '—')}</span>`;
  $('#return-loan-dialog').showModal();
}

function printLoanTerm(id) {
  const loan = state.toolLoans.find(item => item.id === id);
  const serialItem = loan && state.serialItems.find(item => item.id === loan.serial_item_id);
  const itemProduct = serialItem && product(serialItem.product_id);
  if (!loan) return;
  const responsible = loan.collaborator_name || state.collaborators.find(item => item.id === loan.collaborator_id)?.name || 'Não informado';
  const due = loan.loan_type === 'temporario' && loan.due_at ? date(loan.due_at) : 'Sem prazo definido';
  const termWindow = window.open('', '_blank', 'width=820,height=900');
  if (!termWindow) return alert('Não foi possível abrir o termo. Verifique se o navegador bloqueou a nova janela.');
  termWindow.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8" /><title>Termo de Cautela — Digitus Net</title><style>body{margin:0;background:#eef2f5;font:14px Arial,sans-serif;color:#172738}.sheet{width:720px;min-height:960px;margin:24px auto;padding:56px;background:#fff;box-sizing:border-box;box-shadow:0 3px 16px #0002}.brand{color:#29668a;font-size:22px;font-weight:800}.brand span{color:#d87733}.subtitle{margin:5px 0 36px;color:#65798b;font-size:11px;text-transform:uppercase;letter-spacing:1px}.title{text-align:center;font-size:20px;font-weight:800;margin-bottom:28px}.intro{line-height:1.65}.box{margin:24px 0;border:1px solid #d5e1e8;border-radius:8px;overflow:hidden}.row{display:grid;grid-template-columns:180px 1fr;border-bottom:1px solid #e5edf2}.row:last-child{border:0}.label{padding:12px 14px;background:#f7fafc;color:#587084;font-weight:700}.value{padding:12px 14px}.note{margin-top:26px;padding:14px;border-radius:8px;background:#f8fbfd;line-height:1.55}.signatures{display:grid;grid-template-columns:1fr 1fr;gap:52px;margin-top:100px}.signature{border-top:1px solid #1d3143;padding-top:9px;text-align:center;font-size:12px}.date{margin-top:36px;text-align:right}@media print{body{background:#fff}.sheet{margin:0;box-shadow:none;width:auto;min-height:0}.no-print{display:none}}</style></head><body><main class="sheet"><div class="brand">Digitus<span>net</span></div><div class="subtitle">Almoxarifado</div><h1 class="title">TERMO DE CAUTELA DE FERRAMENTA / PATRIMÔNIO</h1><p class="intro">Declaro que recebi o item abaixo relacionado e assumo a responsabilidade pela sua guarda, conservação e devolução nas condições informadas pelo almoxarifado.</p><section class="box"><div class="row"><div class="label">Responsável</div><div class="value">${esc(responsible)}</div></div><div class="row"><div class="label">Item</div><div class="value">${esc(itemProduct?.name || 'Ferramenta')}</div></div><div class="row"><div class="label">Código</div><div class="value">${esc(itemProduct?.code || '—')}</div></div><div class="row"><div class="label">Número de série</div><div class="value">${esc(serialItem?.serial_number || '—')}</div></div><div class="row"><div class="label">MAC Address</div><div class="value">${esc(serialItem?.mac_address || '—')}</div></div><div class="row"><div class="label">Patrimônio</div><div class="value">${esc(serialItem?.asset_tag || '—')}</div></div><div class="row"><div class="label">Tipo de cautela</div><div class="value">${esc(loanTypeName(loan.loan_type))}</div></div><div class="row"><div class="label">Data da retirada</div><div class="value">${date(loan.issued_at)}</div></div><div class="row"><div class="label">Devolução prevista</div><div class="value">${esc(due)}</div></div></section><div class="note"><b>Observação:</b> ${esc(loan.note || 'Sem observações registradas.')}</div><p class="intro">Em caso de perda, dano ou necessidade de manutenção, o responsável deverá comunicar imediatamente o almoxarifado.</p><div class="date">Em ____/____/________.</div><div class="signatures"><div class="signature">Assinatura do responsável</div><div class="signature">Assinatura do almoxarife</div></div><p class="no-print" style="margin-top:60px;text-align:center"><button onclick="window.print()">Imprimir termo</button></p></main></body></html>`);
  termWindow.document.close();
  termWindow.focus();
}

const activeInventory = () => state.inventorySessions.find(item => item.status === 'aberto');
const inventoryDifference = item => item.counted_stock === null || item.counted_stock === undefined ? null : Number(item.counted_stock) - Number(item.expected_stock);

function updateInventoryMetrics() {
  const active = activeInventory();
  if (!active) return;
  const rows = state.inventoryCounts.filter(item => item.inventory_id === active.id);
  const inputs = [...document.querySelectorAll('[data-inventory-count]')];
  const values = new Map(inputs.filter(input => input.value !== '').map(input => [input.dataset.inventoryCount, Number(input.value)]));
  const counted = rows.filter(item => values.has(item.product_id) || item.counted_stock !== null && item.counted_stock !== undefined).length;
  const differences = rows.filter(item => {
    const value = values.has(item.product_id) ? values.get(item.product_id) : item.counted_stock;
    return value !== null && value !== undefined && Number(value) !== Number(item.expected_stock);
  }).length;
  $('#inventory-counted-total').textContent = `${counted} / ${rows.length}`;
  $('#inventory-difference-total').textContent = differences;
}

function renderInventory() {
  const table = $('#inventory-counts-table');
  if (!table) return;

  const categorySelect = $('#inventory-category');
  const selectedCategory = categorySelect.value;
  const categories = [...new Set(state.products.map(item => item.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  categorySelect.innerHTML = '<option value="">Todo o almoxarifado</option>' + categories.map(category => `<option value="${esc(category)}">${esc(category)}</option>`).join('');
  categorySelect.value = categories.includes(selectedCategory) ? selectedCategory : '';

  const session = activeInventory();
  $('#inventory-empty').hidden = Boolean(session);
  $('#inventory-session').hidden = !session;
  $('#start-inventory').disabled = Boolean(session);

  if (session) {
    const counts = state.inventoryCounts.filter(item => item.inventory_id === session.id).sort((a, b) => a.product_name.localeCompare(b.product_name, 'pt-BR'));
    $('#inventory-title').textContent = session.title;
    $('#inventory-subtitle').textContent = `${session.category ? `Categoria: ${session.category} · ` : 'Todo o almoxarifado · '}iniciado em ${date(session.started_at)}`;
    table.innerHTML = counts.map(item => {
      const difference = inventoryDifference(item);
      const differenceText = difference === null ? '—' : `${difference > 0 ? '+' : ''}${quantity(difference)} ${unitName(item.unit_of_measure)}`;
      const differenceClass = difference === null || difference === 0 ? '' : difference > 0 ? 'positive' : 'negative';
      return `<tr><td><b>${esc(item.product_name)}</b><small>${esc(item.product_code)}</small></td><td>${quantity(item.expected_stock)} ${unitName(item.unit_of_measure)}</td><td><input class="inventory-count-input" data-inventory-count="${item.product_id}" type="number" min="0" step="0.001" value="${item.counted_stock ?? ''}" aria-label="Quantidade física de ${esc(item.product_name)}" /></td><td class="inventory-difference ${differenceClass}" data-inventory-difference="${item.product_id}">${differenceText}</td><td><input class="inventory-count-note" data-inventory-note="${item.product_id}" value="${esc(item.note || '')}" placeholder="Opcional" aria-label="Observação de ${esc(item.product_name)}" /></td></tr>`;
    }).join('') || '<tr><td colspan="5" class="empty">Nenhum item nesta conferência.</td></tr>';
    document.querySelectorAll('[data-inventory-count]').forEach(input => input.oninput = () => {
      const line = state.inventoryCounts.find(item => item.product_id === input.dataset.inventoryCount && item.inventory_id === session.id);
      const difference = line && input.value !== '' ? Number(input.value) - Number(line.expected_stock) : null;
      const target = document.querySelector(`[data-inventory-difference="${input.dataset.inventoryCount}"]`);
      if (target) {
        target.textContent = difference === null ? '—' : `${difference > 0 ? '+' : ''}${quantity(difference)} ${unitName(line.unit_of_measure)}`;
        target.className = `inventory-difference ${difference === null || difference === 0 ? '' : difference > 0 ? 'positive' : 'negative'}`;
      }
      updateInventoryMetrics();
    });
    updateInventoryMetrics();
  }

  const history = state.inventorySessions.filter(item => item.status === 'finalizado').slice(0, 8);
  $('#inventory-history-table').innerHTML = history.map(item => `<tr><td><b>${esc(item.title)}</b><small>${esc(item.final_note || 'Sem observação')}</small></td><td>${esc(item.category || 'Todo o almoxarifado')}</td><td>${date(item.started_at)}</td><td>${item.closed_at ? date(item.closed_at) : '—'}</td><td><span class="badge ok">Finalizado</span></td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nenhum inventário finalizado ainda.</td></tr>';
}

async function saveInventoryCounts(silent = false) {
  const session = activeInventory();
  if (!session) throw new Error('Não há inventário em aberto.');
  const counts = [...document.querySelectorAll('[data-inventory-count]')].filter(input => input.value !== '').map(input => ({
    product_id: input.dataset.inventoryCount,
    counted_stock: Number(input.value),
    note: document.querySelector(`[data-inventory-note="${input.dataset.inventoryCount}"]`)?.value.trim() || null
  }));
  if (!counts.length) throw new Error('Informe pelo menos uma quantidade física antes de salvar.');
  const { error } = await supabase.rpc('save_inventory_counts', { p_inventory_id: session.id, p_counts: counts });
  if (error) throw error;
  await load();
  if (!silent) alert('Contagens salvas. Você pode continuar a conferência depois.');
}

async function finishInventory() {
  try {
    await saveInventoryCounts(true);
    const session = activeInventory();
    const counts = state.inventoryCounts.filter(item => item.inventory_id === session?.id);
    if (counts.some(item => item.counted_stock === null || item.counted_stock === undefined)) throw new Error('Informe a quantidade física de todos os itens antes de finalizar.');
    const hasDifferences = counts.some(item => inventoryDifference(item) !== 0);
    const note = $('#inventory-final-note').value.trim();
    if (hasDifferences && !note) throw new Error('Informe uma justificativa para os ajustes encontrados.');
    if (!confirm('Finalizar o inventário? Os ajustes serão registrados como movimentações e não poderão ser desfeitos por esta tela.')) return;
    const { error } = await supabase.rpc('finish_inventory', { p_inventory_id: session.id, p_final_note: note || null });
    if (error) throw error;
    $('#inventory-final-note').value = '';
    await load();
    alert('Inventário finalizado e estoque ajustado com sucesso.');
  } catch (error) {
    alert(error.message);
  }
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
  const [products, movements, collaborators, vehicles, locations, suppliers, serialItems, serialMovements, toolLoans, receipts, receiptItems, inventorySessions, inventoryCounts] = await Promise.all([
    supabase.from('products').select('*').order('name'),
    supabase.from('movements').select('*').order('created_at', { ascending: false }),
    supabase.from('collaborators').select('*').order('name'),
    supabase.from('vehicles').select('*').order('name'),
    supabase.from('stock_locations').select('*').order('name'),
    supabase.from('suppliers').select('*').order('name'),
    supabase.from('serial_items').select('*').order('created_at', { ascending: false }),
    supabase.from('serial_movements').select('*').order('created_at', { ascending: false }),
    supabase.from('tool_loans').select('*').order('issued_at', { ascending: false }),
    supabase.from('receipts').select('*').order('received_at', { ascending: false }),
    supabase.from('receipt_items').select('*').order('created_at', { ascending: false }),
    supabase.from('inventory_sessions').select('*').order('started_at', { ascending: false }),
    supabase.from('inventory_counts').select('*').order('created_at', { ascending: false })
  ]);
  if (products.error || movements.error || collaborators.error || vehicles.error || locations.error || suppliers.error || serialItems.error || serialMovements.error || toolLoans.error || receipts.error || receiptItems.error || inventorySessions.error || inventoryCounts.error) throw products.error || movements.error || collaborators.error || vehicles.error || locations.error || suppliers.error || serialItems.error || serialMovements.error || toolLoans.error || receipts.error || receiptItems.error || inventorySessions.error || inventoryCounts.error;
  state.products = products.data.map(item => ({ ...item, minimum: item.minimum_stock }));
  state.movements = movements.data.map(item => ({ id:item.id, type:item.movement_type, productId:item.product_id, quantity:item.quantity, person:item.recipient, holderType:item.holder_type || 'cliente', workOrder:item.work_order, fieldUsage:item.field_usage || false, note:item.note, createdAt:item.created_at, date:date(item.created_at) }));
  state.collaborators = collaborators.data;
  state.vehicles = vehicles.data;
  state.locations = locations.data;
  state.suppliers = suppliers.data;
  state.serialItems = serialItems.data;
  state.serialMovements = serialMovements.data;
  state.toolLoans = toolLoans.data;
  state.receipts = receipts.data;
  state.receiptItems = receiptItems.data;
  state.inventorySessions = inventorySessions.data;
  state.inventoryCounts = inventoryCounts.data;
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

async function toggleSupplier(id) {
  const supplier = state.suppliers.find(item => item.id === id);
  if (!supplier) return;
  const action = supplier.active ? 'desativar' : 'reativar';
  if (!confirm(`${action[0].toUpperCase() + action.slice(1)} ${supplier.name}? Os recebimentos anteriores serão preservados.`)) return;
  const { error } = await supabase.from('suppliers').update({ active: !supplier.active, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) return alert(error.message);
  await load();
}

async function deleteSupplier(id) {
  const supplier = state.suppliers.find(item => item.id === id);
  if (!supplier || !confirm(`Remover definitivamente ${supplier.name}? Os recebimentos anteriores continuarão mostrando o nome do fornecedor.`)) return;
  const { error } = await supabase.from('suppliers').delete().eq('id', id);
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
  $('#page-title').textContent = ({ dashboard:'Visão geral', products:'Produtos', movement:'Movimentações', receipts:'Recebimentos', serials:'Serial / MAC', laboratory:'Laboratório', loans:'Cautelas', inventory:'Inventário', registry:'Cadastros', users:'Usuários' })[id];
  $('#header-action').hidden = id === 'users' || id === 'products' || id === 'receipts' || id === 'serials' || id === 'laboratory' || id === 'loans' || id === 'inventory' || id === 'registry';
  $('#header-action').textContent = id === 'products' ? '+ Cadastrar produto' : '+ Nova movimentação';
}

document.querySelector('main').classList.add('dashboard-mode');

function showProducts(filter = 'all') {
  state.productFilter = filter;
  $('#product-search').value = '';
  $('#product-category-filter').value = '';
  $('#product-status-filter').value = filter === 'low' ? 'low' : filter === 'ca' ? 'ca' : '';
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
  $('#receipts').hidden = !canManage;
  $('#serials').hidden = !canManage;
  $('#laboratory').hidden = !canManage;
  $('#loans').hidden = !canManage;
  $('#inventory').hidden = !isAdmin;
  $('#registry').hidden = !canManage;
  try { await load(); } catch (error) { alert(error.message); }
}

document.querySelectorAll('.nav-link').forEach(button => button.onclick = () => button.dataset.view === 'products' ? showProducts() : view(button.dataset.view));
document.querySelectorAll('[data-go]').forEach(button => button.onclick = () => button.dataset.go === 'products' ? showProducts() : view(button.dataset.go));
$('#header-action').onclick = () => $('.view.active').id === 'products' ? $('#product-dialog').showModal() : view('movement');
$('#add-product').onclick = () => $('#product-dialog').showModal();
$('#scan-product-code').onclick = () => openCodeScanner('products');
$('#scan-movement-code').onclick = () => openCodeScanner('movement');
$('#add-receipt').onclick = openReceiptDialog;
$('#add-receipt-line').onclick = () => addReceiptLine();
$('#add-user').onclick = () => $('#user-dialog').showModal();
$('#add-serial').onclick = () => {
  if (!state.products.some(item => item.tracking_mode === 'serializado')) return alert('Cadastre ou edite um item e escolha o controle “Por serial / MAC” antes de registrar uma unidade.');
  $('#serial-dialog').showModal();
};
$('#add-loan').onclick = () => {
  if (!state.serialItems.some(item => item.status === 'disponivel' && ['ferramentas', 'patrimônio', 'patrimonio'].includes(String(product(item.product_id)?.category || '').toLowerCase()))) return alert('Cadastre uma ferramenta ou patrimônio rastreável e disponível antes de registrar uma cautela.');
  $('#loan-dialog').showModal();
};
$('#start-inventory').onclick = () => {
  if (activeInventory()) return alert('Já existe um inventário em aberto. Finalize-o antes de iniciar outro.');
  $('#inventory-start-form').reset();
  renderInventory();
  $('#inventory-start-dialog').showModal();
};
$('#save-inventory-counts').onclick = async () => {
  try { await saveInventoryCounts(); } catch (error) { alert(error.message); }
};
$('#finish-inventory').onclick = finishInventory;
$('#add-collaborator').onclick = () => $('#collaborator-dialog').showModal();
$('#add-vehicle').onclick = () => $('#vehicle-dialog').showModal();
$('#add-location').onclick = () => $('#location-dialog').showModal();
$('#add-supplier').onclick = () => $('#supplier-dialog').showModal();
$('#logout').onclick = async () => {
  if (!confirm('Deseja sair da conta?')) return;
  const { error } = await supabase.auth.signOut();
  if (error) return alert(error.message);
  currentUser = null;
  state = { products: [], movements: [], users: [], collaborators: [], vehicles: [], locations: [], suppliers: [], serialItems: [], serialMovements: [], toolLoans: [], receipts: [], receiptItems: [], inventorySessions: [], inventoryCounts: [], productFilter: 'all' };
  $('#login-form').reset();
  $('#auth-gate').hidden = false;
};
document.querySelectorAll('[data-close-dialog]').forEach(button => button.onclick = () => button.closest('dialog').close());
$('#code-scanner-dialog').addEventListener('close', stopCodeScanner);
$('#scanner-manual-form').onsubmit = event => {
  event.preventDefault();
  const code = $('#scanner-manual-code').value.trim();
  if (!code) return scannerMessage('Informe ou leia um código para localizar o item.');
  useScannedCode(code);
};
$('#low-stock-card').onclick = () => showProducts('low');
$('#ca-alert-card').onclick = () => showProducts('ca');
$('#overdue-loans-card').onclick = () => view('loans');
$('#laboratory-card').onclick = () => view('laboratory');
$('#product-search').oninput = () => { state.productFilter = 'all'; renderProducts(); };
$('#product-category-filter').onchange = () => { state.productFilter = 'all'; renderProducts(); };
$('#product-status-filter').onchange = () => { state.productFilter = 'all'; renderProducts(); };
$('#serial-search').oninput = renderSerials;
$('#lab-search').oninput = renderLaboratory;
document.querySelectorAll('[data-history-filter]').forEach(element => { element.oninput = renderMovement; element.onchange = renderMovement; });
$('#clear-history-filters').onclick = () => { document.querySelectorAll('[data-history-filter]').forEach(element => { element.value = ''; }); renderMovement(); };
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
$('#loan-type').onchange = updateLoanTypeForm;
$('#laboratory-action').onchange = updateLaboratoryForm;
updateLoanTypeForm();
updateLaboratoryForm();

function collectProductData(prefix) {
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
  try {
    const newProduct = { ...collectProductData('new'), stock:Number($('#new-stock').value), minimum_stock:Number($('#new-minimum').value) };
    const { error } = await supabase.from('products').insert(newProduct);
    if (error) throw error;
    event.target.reset(); $('#product-dialog').close(); await load(); view('products');
  } catch (error) {
    alert(`Não foi possível cadastrar o item: ${error.message}`);
  }
};

$('#edit-product-form').onsubmit = async event => {
  event.preventDefault();
  const id = $('#edit-product-id').value;
  try {
    const updatedProduct = { ...collectProductData('edit'), minimum_stock:Number($('#edit-minimum').value) };
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

$('#receipt-form').onsubmit = async event => {
  event.preventDefault();
  try {
    const lines = [...document.querySelectorAll('.receipt-line')].map(line => ({
      product_id: line.querySelector('[data-receipt-product]').value,
      quantity: Number(line.querySelector('[data-receipt-quantity]').value)
    }));
    if (!lines.length || lines.some(line => !line.product_id || !Number.isFinite(line.quantity) || line.quantity <= 0)) throw new Error('Preencha o material e a quantidade em todas as linhas.');
    const supplierName = $('#receipt-supplier').value.trim();
    if (!supplierName) throw new Error('Informe o fornecedor.');
    const savedSupplier = state.suppliers.find(item => item.active && item.name.trim().toLocaleLowerCase('pt-BR') === supplierName.toLocaleLowerCase('pt-BR'));
    const receiptData = savedSupplier ? {
      p_supplier_id: savedSupplier.id,
      p_invoice_number: $('#receipt-invoice').value.trim() || null,
      p_note: $('#receipt-note').value.trim() || null,
      p_items: lines
    } : {
      p_supplier: supplierName,
      p_invoice_number: $('#receipt-invoice').value.trim() || null,
      p_note: $('#receipt-note').value.trim() || null,
      p_items: lines
    };
    const { error } = await supabase.rpc('record_receipt', receiptData);
    if (error) throw error;
    $('#receipt-dialog').close();
    await load();
    view('receipts');
    alert('Recebimento registrado e estoque atualizado.');
  } catch (error) {
    alert(error.message);
  }
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

$('#supplier-form').onsubmit = async event => {
  event.preventDefault();
  try {
    const { error } = await supabase.from('suppliers').insert({
      name: $('#supplier-name').value.trim(),
      cnpj: $('#supplier-cnpj').value.trim() || null,
      contact_name: $('#supplier-contact').value.trim() || null,
      phone: $('#supplier-phone').value.trim() || null,
      email: $('#supplier-email').value.trim() || null
    });
    if (error) throw error;
    event.target.reset();
    $('#supplier-dialog').close();
    await load();
    view('registry');
  } catch (error) {
    alert(`Não foi possível cadastrar o fornecedor: ${error.message}`);
  }
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

$('#laboratory-form').onsubmit = async event => {
  event.preventDefault();
  const { error } = await supabase.rpc('process_laboratory_item', {
    p_serial_item_id: $('#laboratory-item-id').value,
    p_action: $('#laboratory-action').value,
    p_note: $('#laboratory-note').value.trim() || null
  });
  if (error) return alert(error.message);
  $('#laboratory-dialog').close();
  await load();
  view('laboratory');
};

$('#loan-form').onsubmit = async event => {
  event.preventDefault();
  const due = $('#loan-due').value;
  const { error } = await supabase.rpc('create_tool_loan', {
    p_serial_item_id: $('#loan-item').value,
    p_collaborator_id: $('#loan-collaborator').value,
    p_loan_type: $('#loan-type').value,
    p_due_at: due ? new Date(due).toISOString() : null,
    p_note: $('#loan-note').value || null
  });
  if (error) return alert(error.message);
  $('#loan-dialog').close(); await load(); view('loans');
};

$('#return-loan-form').onsubmit = async event => {
  event.preventDefault();
  const { error } = await supabase.rpc('return_tool_loan', {
    p_loan_id: $('#return-loan-id').value,
    p_return_condition: $('#return-loan-condition').value,
    p_return_note: $('#return-loan-note').value || null
  });
  if (error) return alert(error.message);
  $('#return-loan-dialog').close(); await load(); view('loans');
};

$('#inventory-start-form').onsubmit = async event => {
  event.preventDefault();
  try {
    const { error } = await supabase.rpc('start_inventory', {
      p_title: $('#inventory-name').value.trim(),
      p_category: $('#inventory-category').value || null
    });
    if (error) throw error;
    $('#inventory-start-dialog').close();
    await load();
    view('inventory');
  } catch (error) {
    alert(error.message);
  }
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
