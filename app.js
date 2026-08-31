import { createClient } from '@supabase/supabase-js';
import { readSheet as readXlsxSheet } from 'read-excel-file/browser';

const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);
let state = { products: [], movements: [], users: [], usersLoadNote: '', collaborators: [], vehicles: [], locations: [], suppliers: [], serialItems: [], serialMovements: [], toolLoans: [], clientLoans: [], clientLoansLoadError: '', receipts: [], receiptItems: [], inventorySessions: [], inventoryCounts: [], reminders: [], materialRequests: [], technicianPendencies: [], technicianPendingEvents: [], technicianPendingItems: [], technicianPendenciesLoadError: '', productFilter: 'all', clientLoanImport: null };
let movementSubmitting = false;
let receiptSubmitting = false;
let movementOperationId = null;
let receiptOperationId = null;
let currentUser = null;
let passwordRecoveryMode = false;
const passwordRecoveryStorageKey = 'digitus-password-recovery';
const $ = selector => document.querySelector(selector);

function addPackageUnitOption(root = document) {
  root.querySelectorAll('select#new-unit, select#edit-unit, select[data-receipt-new-unit]').forEach(select => {
    if ([...select.options].some(option => option.value === 'pacote')) return;
    const option = document.createElement('option');
    option.value = 'pacote';
    option.textContent = 'Pacote';
    select.append(option);
  });
}
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;' }[char]));
const accountAvatarKey = () => currentUser ? `digitus-account-avatar-${currentUser.id}` : '';

async function invokeAdminFunction(name, method, body) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Sessão inválida. Entre novamente no sistema.');

  const { data, error } = await supabase.functions.invoke(name, {
    method,
    headers: { Authorization: `Bearer ${session.access_token}` },
    body,
  });
  if (!error) return data;

  let message = error.message || 'Não foi possível concluir a operação.';
  try {
    const payload = await error.context?.json();
    message = payload?.error || message;
  } catch (_) {
    // Mantém a mensagem padrão quando a resposta da função não puder ser lida.
  }
  throw new Error(message);
}

function accountInitials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  return (words.slice(0, 2).map(word => word[0]).join('') || 'DN').toUpperCase();
}

function drawAccountAvatar(element, image, name) {
  if (!element) return;
  element.replaceChildren();
  if (image) {
    const avatarImage = document.createElement('img');
    avatarImage.src = image;
    avatarImage.alt = '';
    element.append(avatarImage);
  } else {
    element.textContent = accountInitials(name);
  }
}

function renderAccountMenu() {
  if (!currentUser) return;
  const name = currentUser.name || currentUser.email?.split('@')[0] || 'Minha conta';
  const image = localStorage.getItem(accountAvatarKey());
  $('#account-button-name').textContent = name;
  $('#account-button').title = name;
  $('#account-menu-name').textContent = name;
  $('#account-menu-role').textContent = roleName(currentUser.role);
  drawAccountAvatar($('#account-avatar'), image, name);
  drawAccountAvatar($('#account-menu-avatar'), image, name);
}

function setAccountMenu(open) {
  const popover = $('#account-popover');
  popover.hidden = !open;
  $('#account-button').setAttribute('aria-expanded', String(open));
}

function setNotificationsOpen(open) {
  const popover = $('#notifications-popover');
  popover.hidden = !open;
  $('#notifications-button').setAttribute('aria-expanded', String(open));
}

function setLoginMessage(message = '', type = 'error') {
  const errorText = $('#login-error');
  errorText.textContent = message;
  errorText.hidden = !message;
  errorText.classList.toggle('success', type === 'success');
}

function setPasswordRecoveryMode(enabled) {
  passwordRecoveryMode = enabled;
  if (enabled) sessionStorage.setItem(passwordRecoveryStorageKey, '1');
  else sessionStorage.removeItem(passwordRecoveryStorageKey);
}

function togglePasswordVisibility(inputSelector, button) {
  const input = $(inputSelector);
  const visible = input.type === 'password';
  input.type = visible ? 'text' : 'password';
  button.textContent = visible ? 'Ocultar' : 'Ver';
  button.setAttribute('aria-label', visible ? 'Ocultar senha' : 'Mostrar senha');
  button.setAttribute('aria-pressed', String(visible));
}

function openPasswordReset() {
  $('#auth-gate').hidden = false;
  const dialog = $('#reset-password-dialog');
  if (!dialog.open) dialog.showModal();
}
const product = id => state.products.find(item => String(item.id) === String(id));
const activeProducts = () => state.products.filter(item => item.is_active !== false);
const isEpiProduct = item => item?.category === 'EPI';
const low = item => item.stock <= item.minimum;
const date = value => new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const status = item => item.stock === 0 ? '<span class="badge out">Sem estoque</span>' : low(item) ? '<span class="badge low">Estoque baixo</span>' : '<span class="badge ok">Disponível</span>';
const roleName = role => ({ admin: 'Administrador', operador: 'Operador', tecnico: 'Técnico' }[role] || 'Técnico');
const holderTypeName = type => ({ tecnico: 'Técnico', veiculo: 'Veículo', cliente: 'Cliente', outro: 'Outro' }[type] || 'Outro');
const movementName = item => item.fieldUsage ? 'Uso em OS' : item.type === 'entrada' ? 'Entrada' : 'Saída';
const unitName = unit => ({ unidade: 'un.', metro: 'm', par: 'par', caixa: 'cx.' }[unit] || 'un.');
const quantity = value => Number(value || 0).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const currency = value => Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dateOnly = value => value ? new Date(`${value}T00:00:00`).toLocaleDateString('pt-BR') : '—';
const stockLabel = item => `${quantity(item.stock)} ${unitName(item.unit_of_measure)}`;
function pendingDeadlineState(item) {
  if (item.resolution !== 'aberta') return { key:'done', label:'⚪ Finalizado' };
  const remaining = new Date(item.due_at).getTime() - Date.now();
  if (remaining < 0) return { key:'overdue', label:'🔴 Atrasado' };
  if (remaining <= 24 * 60 * 60 * 1000) return { key:'warning', label:'🟡 Vence em breve' };
  return { key:'ok', label:'🟢 No prazo' };
}

function renderDashboardStockValue(products = state.products, loading = false) {
  const valueCard = $('#dashboard-value-card');
  const canViewStockValue = currentUser?.role === 'admin';
  valueCard.hidden = !canViewStockValue;
  if (!canViewStockValue) return;
  $('#dashboard-value-count').textContent = loading ? 'Carregando…' : currency(products.filter(item => item.is_active !== false).reduce((total, item) => total + Number(item.stock || 0) * Number(item.average_cost || 0), 0));
}

async function preloadDashboardStockValue() {
  if (currentUser?.role !== 'admin') return;
  try {
    const { data, error } = await supabase.from('products').select('stock, average_cost, is_active');
    if (error || currentUser?.role !== 'admin') return;
    renderDashboardStockValue(data || []);
  } catch (error) {
    console.warn('Não foi possível antecipar o valor do estoque:', error.message);
  }
}

let scannerStream = null;
let scannerFrame = null;
let scannerSession = 0;
let scannerTarget = 'products';
let barcodeDetector = null;
let importedXmlInvoice = null;
let editingProductImagePath = null;
let pendingProductImport = [];
let pendingSerialImport = [];
const normalizedScanCode = value => String(value || '').trim().replace(/[^a-z0-9]/gi, '').toLocaleLowerCase('pt-BR');
const normalizedSpreadsheetText = value => String(value ?? '').trim();
const normalizedSpreadsheetHeader = value => normalizedSpreadsheetText(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const spreadsheetColumns = {
  name: ['nome', 'nome do item', 'nome do produto', 'produto', 'produtos', 'item', 'material', 'descricao', 'descrição'],
  code: ['codigo', 'código', 'codigo do produto', 'código do produto', 'cod', 'cod produto', 'sku', 'referencia', 'referência'],
  category: ['categoria', 'grupo', 'tipo de produto', 'tipo'],
  stock: ['estoque', 'estoque atual', 'saldo', 'quantidade', 'qtd', 'quantidade atual'],
  minimum: ['estoque minimo', 'estoque mínimo', 'minimo', 'mínimo', 'saldo minimo', 'saldo mínimo'],
  brand: ['marca'],
  model: ['modelo'],
  unit: ['unidade', 'unidade de medida', 'medida', 'und'],
  tracking: ['controle', 'tipo de controle', 'rastreamento'],
  description: ['descricao', 'descrição', 'observacao', 'observação'],
  averageCost: ['custo unitario', 'custo unitário', 'preco de custo', 'preço de custo', 'valor unitario', 'valor unitário', 'custo'],
  requiresCa: ['exige ca', 'controle de ca', 'tem ca'],
  caNumber: ['numero do ca', 'número do ca', 'ca'],
  caExpiry: ['validade do ca', 'vencimento do ca', 'data de validade do ca']
};

const serialSpreadsheetColumns = {
  item: ['item', 'produto', 'nome do item', 'nome do produto'],
  serial: ['numero de serie', 'número de série', 'serial'],
  mac: ['mac address', 'mac'],
  asset: ['codigo patrimonial', 'código patrimonial', 'patrimonio', 'patrimônio'],
  status: ['status inicial', 'status'],
  location: ['local atual', 'local', 'localizacao', 'localização'],
  customer: ['cliente se ja instalado', 'cliente (se já instalado)', 'cliente'],
  customerReference: ['referencia do cliente contrato', 'referência do cliente / contrato', 'contrato', 'referencia', 'referência'],
  notes: ['observacao', 'observação', 'nota', 'notas'],
  addToStock: ['adicionar esta unidade ao saldo do estoque', 'adicionar ao saldo do estoque', 'adicionar ao estoque']
};

function spreadsheetCell(row, aliases) {
  for (const alias of aliases) {
    const match = Object.entries(row).find(([header, value]) => normalizedSpreadsheetHeader(header) === normalizedSpreadsheetHeader(alias) && normalizedSpreadsheetText(value));
    if (match) return match[1];
  }
  return '';
}

function hasSpreadsheetColumn(rows, aliases) {
  return Object.keys(rows[0] || {}).some(header => aliases.some(alias => normalizedSpreadsheetHeader(header) === normalizedSpreadsheetHeader(alias)));
}

function spreadsheetNumber(value, fallback = 0) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : fallback;
  const raw = normalizedSpreadsheetText(value).replace(/\s/g, '');
  if (!raw) return fallback;
  let normalized = raw;
  if (raw.includes('.') && raw.includes(',')) normalized = raw.lastIndexOf(',') > raw.lastIndexOf('.') ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '');
  else if (raw.includes(',')) normalized = raw.replace(/\./g, '').replace(',', '.');
  const number = Number(normalized.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function spreadsheetUnit(value) {
  const unit = normalizedSpreadsheetHeader(value);
  if (['m', 'metro', 'metros'].includes(unit)) return 'metro';
  if (['par', 'pares'].includes(unit)) return 'par';
  if (['caixa', 'caixas', 'cx'].includes(unit)) return 'caixa';
  return 'unidade';
}

function spreadsheetTracking(value) {
  const tracking = normalizedSpreadsheetHeader(value);
  return tracking.includes('serial') || tracking.includes('mac') || tracking.includes('rastre') ? 'serializado' : 'quantidade';
}

function spreadsheetDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const text = normalizedSpreadsheetText(value);
  if (!text) return null;
  const brDate = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (brDate) return `${brDate[3]}-${brDate[2].padStart(2, '0')}-${brDate[1].padStart(2, '0')}`;
  const isoDate = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return isoDate ? isoDate[0] : null;
}

function spreadsheetYes(value) {
  return ['sim', 's', 'true', '1', 'yes'].includes(normalizedSpreadsheetHeader(value));
}

function serialStatusFromSpreadsheet(value) {
  const text = normalizedSpreadsheetHeader(value);
  if (!text || text.includes('dispon')) return 'disponivel';
  if (text.includes('instal') || text.includes('cliente')) return 'instalado_cliente';
  if (text.includes('manutenc')) return 'manutencao';
  if (text.includes('defeito')) return 'defeito';
  if (text.includes('triagem') || text.includes('oficina') || text.includes('laboratorio')) return 'laboratorio';
  if (text.includes('baix') || text.includes('sucat')) return 'baixado';
  return null;
}

function serialProductCode(value) {
  const text = normalizedSpreadsheetText(value);
  const match = text.match(/\(([^()]+)\)\s*$/);
  return normalizedSpreadsheetText(match?.[1] || text);
}

function cleanSpreadsheetPlaceholder(value) {
  const text = normalizedSpreadsheetText(value);
  const normalized = normalizedSpreadsheetHeader(text);
  return !text || ['nao instalado', 'sem contrato', 'na', 'n a', 'none', 'null', 'nenhum', 'sem cliente', '-'].includes(normalized) ? null : text;
}

function productPayloadFromSpreadsheet(row, { serialTracking = false } = {}) {
  const caNumber = normalizedSpreadsheetText(spreadsheetCell(row, spreadsheetColumns.caNumber));
  const caExpiry = spreadsheetDate(spreadsheetCell(row, spreadsheetColumns.caExpiry));
  const caValue = normalizedSpreadsheetHeader(spreadsheetCell(row, spreadsheetColumns.requiresCa));
  return {
    name: normalizedSpreadsheetText(spreadsheetCell(row, spreadsheetColumns.name)),
    code: normalizedSpreadsheetText(spreadsheetCell(row, spreadsheetColumns.code)),
    category: normalizedSpreadsheetText(spreadsheetCell(row, spreadsheetColumns.category)) || 'Produtos',
    stock: spreadsheetNumber(spreadsheetCell(row, spreadsheetColumns.stock)),
    minimum_stock: spreadsheetNumber(spreadsheetCell(row, spreadsheetColumns.minimum)),
    brand: normalizedSpreadsheetText(spreadsheetCell(row, spreadsheetColumns.brand)) || null,
    model: normalizedSpreadsheetText(spreadsheetCell(row, spreadsheetColumns.model)) || null,
    unit_of_measure: spreadsheetUnit(spreadsheetCell(row, spreadsheetColumns.unit)),
    tracking_mode: serialTracking ? 'serializado' : spreadsheetTracking(spreadsheetCell(row, spreadsheetColumns.tracking)),
    description: normalizedSpreadsheetText(spreadsheetCell(row, spreadsheetColumns.description)) || null,
    average_cost: spreadsheetNumber(spreadsheetCell(row, spreadsheetColumns.averageCost)),
    requires_ca: ['sim', 's', 'true', '1'].includes(caValue) || Boolean(caNumber || caExpiry),
    ca_number: caNumber || null,
    ca_expiry_date: caExpiry
  };
}

function resetProductImportPreview() {
  pendingProductImport = [];
  $('#product-import-error').hidden = true;
  $('#product-import-error').textContent = '';
  $('#product-import-summary').hidden = true;
  $('#product-import-summary').innerHTML = '';
  $('#product-import-preview').hidden = true;
  $('#product-import-preview').innerHTML = '';
  $('#confirm-product-import').hidden = true;
  $('#confirm-product-import').disabled = false;
}

function openProductImport() {
  if (!['admin', 'operador'].includes(currentUser?.role)) return alert('Apenas administradores e operadores podem importar produtos.');
  $('#product-import-file').value = '';
  resetProductImportPreview();
  $('#product-import-dialog').showModal();
}

function spreadsheetRows(data) {
  const [headerRow, ...dataRows] = data || [];
  const headers = (headerRow || []).map(value => normalizedSpreadsheetText(value));
  if (!headers.some(Boolean)) return [];
  return dataRows
    .filter(row => (row || []).some(value => normalizedSpreadsheetText(value)))
    .map(row => Object.fromEntries(headers.map((header, index) => [header, row?.[index] ?? ''])));
}

async function readSpreadsheetSheets(file) {
  if (!file.name.toLowerCase().endsWith('.xlsx')) throw new Error('Use uma planilha no formato .xlsx.');
  if (file.size > 10 * 1024 * 1024) throw new Error('A planilha é muito grande. Selecione um arquivo de até 10 MB.');
  const { default: readExcelFile } = await import('read-excel-file/browser');
  const sheets = await readExcelFile(file);
  const parsedSheets = sheets.map(sheet => ({ name: sheet.sheet, rows: spreadsheetRows(sheet.data) }));
  const totalRows = parsedSheets.reduce((total, sheet) => total + sheet.rows.length, 0);
  if (totalRows > 20000) throw new Error('A planilha tem mais de 20.000 linhas. Divida o arquivo antes de importar.');
  return parsedSheets;
}

async function readProductSpreadsheet(event) {
  resetProductImportPreview();
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const sheets = await readSpreadsheetSheets(file);
    const rows = sheets.find(sheet => sheet.rows.length)?.rows || [];
    if (!rows.length) throw new Error('A planilha não possui linhas para importar.');
    if (!hasSpreadsheetColumn(rows, spreadsheetColumns.name) || !hasSpreadsheetColumn(rows, spreadsheetColumns.code)) throw new Error('Não encontrei as colunas Nome e Código. Use esses nomes no cabeçalho da planilha.');

    const usedCodes = new Set(state.products.map(item => normalizedScanCode(item.code)));
    const ignored = [];
    const prepared = [];
    rows.forEach((row, index) => {
      const line = index + 2;
      const name = normalizedSpreadsheetText(spreadsheetCell(row, spreadsheetColumns.name));
      const code = normalizedSpreadsheetText(spreadsheetCell(row, spreadsheetColumns.code));
      const normalizedCode = normalizedScanCode(code);
      if (!name || !code) return ignored.push(`Linha ${line}: informe nome e código.`);
      if (usedCodes.has(normalizedCode)) return ignored.push(`Linha ${line}: código ${code} já existe.`);
      usedCodes.add(normalizedCode);
      prepared.push(productPayloadFromSpreadsheet(row));
    });

    pendingProductImport = prepared;
    const summary = $('#product-import-summary');
    summary.hidden = false;
    summary.innerHTML = `<b>${prepared.length} produto${prepared.length === 1 ? '' : 's'} pronto${prepared.length === 1 ? '' : 's'} para importar.</b>${ignored.length ? `<span>${ignored.length} linha${ignored.length === 1 ? '' : 's'} ignorada${ignored.length === 1 ? '' : 's'} por dados ausentes ou código duplicado.</span>` : ''}`;
    if (prepared.length) {
      const preview = $('#product-import-preview');
      const visibleProducts = prepared.slice(0, 8);
      preview.hidden = false;
      preview.innerHTML = `<b>Prévia</b>${visibleProducts.map(item => `<div><span>${esc(item.name)}</span><small>${esc(item.code)} · ${esc(item.category)} · ${quantity(item.stock)} ${unitName(item.unit_of_measure)}</small></div>`).join('')}${prepared.length > visibleProducts.length ? `<small>e mais ${prepared.length - visibleProducts.length} produto(s).</small>` : ''}`;
      $('#confirm-product-import').hidden = false;
    }
    if (!prepared.length) {
      $('#product-import-error').textContent = ignored[0] || 'Nenhum produto válido foi encontrado na planilha.';
      $('#product-import-error').hidden = false;
    }
  } catch (error) {
    $('#product-import-error').textContent = error.message || 'Não foi possível ler esta planilha.';
    $('#product-import-error').hidden = false;
  }
}

function resetSerialImportPreview() {
  pendingSerialImport = [];
  $('#serial-import-error').hidden = true;
  $('#serial-import-error').textContent = '';
  $('#serial-import-summary').hidden = true;
  $('#serial-import-summary').innerHTML = '';
  $('#serial-import-preview').hidden = true;
  $('#serial-import-preview').innerHTML = '';
  $('#confirm-serial-import').hidden = true;
  $('#confirm-serial-import').disabled = false;
  $('#confirm-serial-import').textContent = 'Importar unidades';
}

function openSerialImport() {
  if (currentUser?.role !== 'admin') return alert('Apenas administradores podem importar unidades em lote.');
  $('#serial-import-file').value = '';
  resetSerialImportPreview();
  $('#serial-import-dialog').showModal();
}

async function readSerialSpreadsheet(event) {
  resetSerialImportPreview();
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const unitSheet = (await readSpreadsheetSheets(file))
      .find(({ rows }) => rows.length && hasSpreadsheetColumn(rows, serialSpreadsheetColumns.item) && hasSpreadsheetColumn(rows, serialSpreadsheetColumns.serial) && hasSpreadsheetColumn(rows, serialSpreadsheetColumns.mac));
    if (!unitSheet) throw new Error('Não encontrei a aba de unidades. Ela precisa ter Item, Número de série e MAC Address.');
    const productsByCode = new Map(activeProducts().map(item => [normalizedScanCode(item.code), item]));
    const locationByName = new Map(state.locations.filter(item => item.active).map(item => [normalizedSpreadsheetHeader(item.name), item]));
    const centralLocation = state.locations.find(item => item.active && item.location_type === 'central');
    const usedSerials = new Set(state.serialItems.map(item => normalizedScanCode(item.serial_number)).filter(Boolean));
    const usedMacs = new Set(state.serialItems.map(item => normalizedScanCode(item.mac_address)).filter(Boolean));
    const usedAssets = new Set(state.serialItems.map(item => normalizedScanCode(item.asset_tag)).filter(Boolean));
    const errors = [];
    const prepared = [];
    unitSheet.rows.forEach((row, index) => {
      const line = index + 2;
      const itemName = normalizedSpreadsheetText(spreadsheetCell(row, serialSpreadsheetColumns.item));
      const productCode = serialProductCode(itemName);
      const serialNumber = normalizedSpreadsheetText(spreadsheetCell(row, serialSpreadsheetColumns.serial)) || null;
      const macAddress = normalizedSpreadsheetText(spreadsheetCell(row, serialSpreadsheetColumns.mac)) || null;
      const assetTag = normalizedSpreadsheetText(spreadsheetCell(row, serialSpreadsheetColumns.asset)) || null;
      const itemStatus = serialStatusFromSpreadsheet(spreadsheetCell(row, serialSpreadsheetColumns.status));
      if (!productCode || (!serialNumber && !macAddress && !assetTag)) return errors.push(`Linha ${line}: informe o código do item e ao menos um identificador.`);
      if (!itemStatus) return errors.push(`Linha ${line}: status inicial não reconhecido.`);
      if (!productsByCode.has(normalizedScanCode(productCode))) return errors.push(`Linha ${line}: o código ${productCode} não foi encontrado entre os produtos cadastrados.`);
      const identifiers = [[serialNumber, usedSerials, 'serial'], [macAddress, usedMacs, 'MAC'], [assetTag, usedAssets, 'patrimônio']];
      const duplicated = identifiers.find(([value, values]) => value && values.has(normalizedScanCode(value)));
      if (duplicated) return errors.push(`Linha ${line}: ${duplicated[2]} já está cadastrado ou se repete na planilha.`);
      identifiers.forEach(([value, values]) => { if (value) values.add(normalizedScanCode(value)); });
      const rawLocation = normalizedSpreadsheetText(spreadsheetCell(row, serialSpreadsheetColumns.location));
      const matchedLocation = locationByName.get(normalizedSpreadsheetHeader(rawLocation));
      prepared.push({
        productCode,
        serialNumber,
        macAddress,
        assetTag,
        status: itemStatus,
        locationId: matchedLocation?.id || (itemStatus === 'disponivel' ? centralLocation?.id || null : null),
        customerName: cleanSpreadsheetPlaceholder(spreadsheetCell(row, serialSpreadsheetColumns.customer)),
        customerReference: cleanSpreadsheetPlaceholder(spreadsheetCell(row, serialSpreadsheetColumns.customerReference)),
        notes: cleanSpreadsheetPlaceholder(spreadsheetCell(row, serialSpreadsheetColumns.notes)),
        addToStock: false
      });
    });
    if (errors.length) throw new Error(`${errors.slice(0, 3).join(' ')}${errors.length > 3 ? ` E mais ${errors.length - 3} erro(s).` : ''}`);
    if (!prepared.length) throw new Error('Nenhuma unidade válida foi encontrada nesta planilha.');

    pendingSerialImport = prepared;
    const summary = $('#serial-import-summary');
    summary.hidden = false;
    summary.innerHTML = `<b>${prepared.length} unidade${prepared.length === 1 ? '' : 's'} pronta${prepared.length === 1 ? '' : 's'} para importar.</b><span>Os identificadores serão cadastrados sem alterar o saldo atual dos produtos.</span>`;
    const preview = $('#serial-import-preview');
    preview.hidden = false;
    const visible = prepared.slice(0, 8);
    preview.innerHTML = `<b>Prévia da aba ${esc(unitSheet.name)}</b>${visible.map(item => `<div><span>${esc(item.productCode)}</span><small>${esc(item.serialNumber || item.macAddress || item.assetTag)} · ${esc(serialStatusName(item.status))}</small></div>`).join('')}${prepared.length > visible.length ? `<small>e mais ${prepared.length - visible.length} unidade(s).</small>` : ''}`;
    $('#confirm-serial-import').hidden = false;
  } catch (error) {
    $('#serial-import-error').textContent = error.message || 'Não foi possível ler esta planilha.';
    $('#serial-import-error').hidden = false;
  }
}

async function confirmSerialImport() {
  if (!pendingSerialImport.length) return;
  const button = $('#confirm-serial-import');
  button.disabled = true;
  try {
    button.textContent = 'Conferindo produtos…';
    const { data: allProducts, error: productsError } = await supabase.from('products').select('*');
    if (productsError) throw productsError;
    const productsByCode = new Map((allProducts || []).map(item => [normalizedScanCode(item.code), item]));
    const serialProductIds = [...new Set(pendingSerialImport.map(item => productsByCode.get(normalizedScanCode(item.productCode))?.id).filter(Boolean))];
    for (const productId of serialProductIds) {
      const item = allProducts.find(productItem => productItem.id === productId);
      if (item?.tracking_mode !== 'serializado') {
        const { error } = await supabase.from('products').update({ tracking_mode: 'serializado' }).eq('id', productId);
        if (error) throw error;
      }
    }
    const batchSize = 10;
    let imported = 0;
    for (let index = 0; index < pendingSerialImport.length; index += batchSize) {
      const batch = pendingSerialImport.slice(index, index + batchSize);
      button.textContent = `Importando ${Math.min(index + batch.length, pendingSerialImport.length)} de ${pendingSerialImport.length}…`;
      const results = await Promise.all(batch.map(item => {
        const itemProduct = productsByCode.get(normalizedScanCode(item.productCode));
        return supabase.rpc('register_serial_item', {
          p_product_id: itemProduct?.id,
          p_serial_number: item.serialNumber,
          p_mac_address: item.macAddress,
          p_asset_tag: item.assetTag,
          p_status: item.status,
          p_location_id: item.locationId,
          p_customer_name: item.customerName,
          p_customer_reference: item.customerReference,
          p_notes: item.notes,
          p_add_to_stock: item.addToStock
        });
      }));
      const failed = results.find(result => result.error);
      if (failed) throw failed.error;
      imported += batch.length;
    }
    $('#serial-import-dialog').close();
    resetSerialImportPreview();
    await load();
    view('serials');
    alert(`${imported} unidade${imported === 1 ? '' : 's'} rastreável${imported === 1 ? '' : 'eis'} importada${imported === 1 ? '' : 's'} com sucesso.`);
  } catch (error) {
    await load();
    $('#serial-import-error').textContent = error.message || 'A importação foi interrompida. Confira as unidades já registradas antes de tentar novamente.';
    $('#serial-import-error').hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = 'Importar unidades';
  }
}

async function confirmProductImport() {
  if (!pendingProductImport.length) return;
  const button = $('#confirm-product-import');
  if (!confirm(`Importar ${pendingProductImport.length} produto(s) para o sistema?`)) return;
  button.disabled = true;
  button.textContent = 'Importando…';
  try {
    const { error } = await supabase.from('products').insert(pendingProductImport);
    if (error) throw error;
    const count = pendingProductImport.length;
    $('#product-import-dialog').close();
    pendingProductImport = [];
    await load();
    showProducts();
    alert(`${count} produto${count === 1 ? '' : 's'} importado${count === 1 ? '' : 's'} com sucesso.`);
  } catch (error) {
    $('#product-import-error').textContent = error.message || 'Não foi possível importar os produtos.';
    $('#product-import-error').hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = 'Importar produtos';
  }
}

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
  const serialItem = state.serialItems.find(item => serialIdentifiers(item).some(value => normalizedScanCode(value) === normalized));
  return serialItem ? { type: 'serial', item: serialItem } : null;
}

// MAC, serial e patrimônio identificam a mesma unidade rastreável.
// Mantemos essa lista em um único lugar para o leitor e as buscas não ficarem diferentes.
const serialIdentifiers = item => [item?.mac_address, item?.serial_number, item?.asset_tag].filter(Boolean);

function matchesSerialIdentifier(item, query) {
  const search = String(query || '').trim().toLocaleLowerCase('pt-BR');
  const normalizedSearch = normalizedScanCode(search);
  if (!search) return true;
  return serialIdentifiers(item).some(value => {
    const identifier = String(value).toLocaleLowerCase('pt-BR');
    return identifier.includes(search) || normalizedScanCode(identifier).includes(normalizedSearch);
  });
}

function matchesSerialSearch(item, query) {
  const search = String(query || '').trim().toLocaleLowerCase('pt-BR');
  if (!search) return true;
  const itemProduct = product(item.product_id);
  const productText = `${itemProduct?.name || ''} ${itemProduct?.code || ''} ${item.customer_name || ''}`.toLocaleLowerCase('pt-BR');
  return productText.includes(search) || matchesSerialIdentifier(item, search);
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
    if (scannerTarget === 'movement') {
      view('movement');
      $('#movement-type').value = 'saida';
      $('#movement-holder-type').value = 'tecnico';
      $('#movement-product').value = result.item.product_id;
      $('#movement-quantity').value = 1;
      updateMovementMode();
      const firstUnit = document.querySelector('.movement-unit-row');
      if (firstUnit) {
        firstUnit.querySelector('[data-unit-mac]').value = result.item.mac_address || '';
        firstUnit.querySelector('[data-unit-serial]').value = result.item.serial_number || '';
        firstUnit.querySelector('[data-unit-asset]').value = result.item.asset_tag || '';
      }
      $('#movement-person').focus();
      return;
    }
    $('#serial-search').value = code;
    view('serials');
    renderSerials();
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
    updateMovementMode();
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

function openCodeScanner(target) {
  scannerTarget = target;
  stopCodeScanner();
  const dialog = $('#code-scanner-dialog');
  $('#scanner-manual-code').value = '';
  $('#scanner-viewport').hidden = true;
  $('#scanner-use-camera').disabled = false;
  scannerMessage('Leitor USB pronto. Aponte para o código; a leitura será enviada automaticamente ao sistema.');
  dialog.showModal();
  $('#scanner-manual-code').focus();
}

async function startCameraCodeScanner() {
  stopCodeScanner();
  const session = ++scannerSession;
  $('#scanner-viewport').hidden = false;
  $('#scanner-use-camera').disabled = true;
  scannerMessage('Solicitando acesso à câmera…');

  if (!navigator.mediaDevices?.getUserMedia) {
    scannerMessage('A câmera não está disponível neste dispositivo. Use o leitor USB ou digite o código abaixo.');
    return;
  }
  if (!('BarcodeDetector' in window)) {
    scannerMessage('A leitura pela câmera é compatível com Chrome e Edge atualizados. Você ainda pode usar o leitor USB ou digitar o código abaixo.');
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

function productImageUrl(item) {
  if (!item?.image_path) return '';
  return supabase.storage.from('product-images').getPublicUrl(item.image_path).data.publicUrl;
}

function setProductImagePreview(prefix, source = '', isStoredPath = false) {
  const wrap = $(`#${prefix}-image-preview-wrap`), image = $(`#${prefix}-image-preview`);
  if (!source) {
    wrap.hidden = true;
    image.removeAttribute('src');
    return;
  }
  image.src = isStoredPath ? productImageUrl({ image_path: source }) : source;
  wrap.hidden = false;
}

function validateProductImage(file) {
  if (!file) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Use uma imagem JPG, PNG ou WebP.');
  if (file.size > 5 * 1024 * 1024) throw new Error('A foto deve ter no máximo 5 MB.');
}

async function uploadProductImage(file) {
  validateProductImage(file);
  const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' })[file.type];
  const fileId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const path = `products/${fileId}.${extension}`;
  const { error } = await supabase.storage.from('product-images').upload(path, file, { cacheControl: '31536000', contentType: file.type, upsert: false });
  if (error) throw error;
  return path;
}

async function removeProductImage(path) {
  if (!path) return;
  const { error } = await supabase.storage.from('product-images').remove([path]);
  if (error) throw error;
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
function caExpired(item) {
  if (!item.requires_ca || !item.ca_expiry_date) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(`${item.ca_expiry_date}T00:00:00`) < today;
}

function expiryAlert(value) {
  if (!value) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(`${value}T00:00:00`);
  if (Number.isNaN(expiry.getTime())) return null;
  const days = Math.ceil((expiry - today) / 86400000);
  if (days < 0) return { type: 'expired', label: 'Vencido', days };
  if (days === 0) return { type: 'expired', label: 'Vence hoje', days };
  if (days <= 30) return { type: 'warning', label: `Vence em ${days} dia${days === 1 ? '' : 's'}`, days };
  return null;
}

function expiredMaterialLots() {
  return state.receiptItems
    .filter(item => {
      const material = product(item.product_id);
      return material && !isEpiProduct(material) && Number(material.stock || 0) > 0 && expiryAlert(item.expiry_date)?.type === 'expired';
    })
    .sort((a, b) => new Date(`${a.expiry_date}T00:00:00`) - new Date(`${b.expiry_date}T00:00:00`));
}

function expiryNotifications() {
  const epiNotifications = activeProducts()
    .filter(isEpiProduct)
    .map(item => ({ kind: 'epi', item, alert: caAlert(item), expiry: item.ca_expiry_date }))
    .filter(item => item.alert);
  const materialNotifications = state.receiptItems
    .map(item => ({ kind: 'material', item, product: product(item.product_id), alert: expiryAlert(item.expiry_date), expiry: item.expiry_date }))
    .filter(item => item.product && !isEpiProduct(item.product) && Number(item.product.stock || 0) > 0 && item.alert);
  return [...epiNotifications, ...materialNotifications]
    .sort((a, b) => new Date(`${a.expiry}T00:00:00`) - new Date(`${b.expiry}T00:00:00`));
}
const serialStatusName = status => ({ disponivel:'Em estoque', com_colaborador:'Com técnico', com_veiculo:'Com veículo', instalado_cliente:'Instalado no cliente', emprestado:'Emprestado', aguardando_triagem:'Aguardando triagem', laboratorio:'Oficina', manutencao:'Em manutenção', defeito:'Defeito', baixado:'Baixado' })[status] || status;
const serialStatusClass = status => ({ disponivel:'ok', com_colaborador:'saida', com_veiculo:'saida', instalado_cliente:'saida', emprestado:'saida', aguardando_triagem:'low', laboratorio:'low', manutencao:'low', defeito:'out', baixado:'out' })[status] || 'low';
const serialActionName = action => ({ transferencia:'Transferência', instalacao:'Instalação em cliente', laboratorio:'Envio à oficina', retorno:'Retorno ao almoxarifado', baixa:'Baixa / sucata', emprestimo_cliente:'Comodato a cliente', devolucao_cliente:'Devolução de comodato' })[action] || action;
const isLaboratorySerial = item => ['laboratorio', 'manutencao', 'defeito', 'aguardando_triagem'].includes(item.status);
const loanTypeName = type => type === 'cautela' ? 'Empréstimo sem prazo' : 'Empréstimo temporário';
const loanOverdue = loan => !loan.returned_at && loan.due_at && new Date() >= new Date(loan.due_at);
const localDateKey = value => {
  const target = value ? new Date(value) : new Date();
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(target);
};
const loanStatus = loan => {
  if (loan.returned_at) {
    if (!loan.due_at) return { key: 'devolvido', label: 'Devolvido', badge: 'ok' };
    const returned = new Date(loan.returned_at).getTime(), due = new Date(loan.due_at).getTime();
    if (returned > due) return { key: 'devolvido_atraso', label: 'Devolvido com atraso', badge: 'out' };
    if (due - returned > 15 * 60 * 1000) return { key: 'devolvido_antecipado', label: 'Devolvido antecipadamente', badge: 'ok' };
    return { key: 'devolvido_prazo', label: 'Devolvido no prazo', badge: 'ok' };
  }
  if (loanOverdue(loan)) return { key: 'atrasado', label: 'Atrasado', badge: 'out' };
  if (loan.due_at && localDateKey(loan.due_at) === localDateKey()) return { key: 'hoje', label: 'Vencendo hoje', badge: 'low' };
  return { key: 'aberto', label: 'Em andamento', badge: 'saida' };
};
const isLoanEquipment = item => {
  const itemProduct = item && product(item.product_id);
  if (!itemProduct || isEpiProduct(itemProduct)) return false;
  const networkEquipment = /\b(onu|ont|roteador|router|modem|switch|olt|access point)\b/i.test(`${itemProduct.name} ${itemProduct.model || ''}`);
  return !networkEquipment;
};

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

function getFilteredSerialMovements() {
  const query = $('#history-search').value.trim().toLowerCase();
  const typeFilter = $('#history-type').value;
  const holderFilter = $('#history-holder').value;
  const from = $('#history-from').value, to = $('#history-to').value;
  return state.serialMovements.filter(item => {
    const serialItem = state.serialItems.find(entry => entry.id === item.serial_item_id);
    const itemProduct = serialItem && product(serialItem.product_id);
    const impact = Number(item.stock_impact ?? (item.previous_status === 'disponivel' && item.new_status !== 'disponivel' ? -1 : item.previous_status !== 'disponivel' && item.new_status === 'disponivel' ? 1 : 0));
    const text = `${itemProduct?.name || ''} ${serialItem?.serial_number || ''} ${serialItem?.mac_address || ''} ${serialItem?.asset_tag || ''} ${item.recipient || ''} ${item.customer_name || ''} ${item.work_order || ''} ${item.note || ''}`.toLowerCase();
    const day = item.created_at?.slice(0, 10) || '';
    const matchesType = !typeFilter || typeFilter === 'entrada' && impact === 1 || typeFilter === 'saida' && impact === -1 || typeFilter === 'uso_os' && false;
    return (!query || text.includes(query)) && matchesType && !holderFilter && (!from || day >= from) && (!to || day <= to);
  });
}

function getFilteredTechnicianEvents() {
  const query = $('#history-search').value.trim().toLowerCase();
  const typeFilter = $('#history-type').value, holderFilter = $('#history-holder').value;
  const from = $('#history-from').value, to = $('#history-to').value;
  const typeMap = { retirada:'saida', utilizacao:'instalacao', devolucao:'devolucao', transferencia:'transferencia', prorrogacao:'prorrogacao' };
  const holderMap = { retirada:'tecnico', utilizacao:'cliente', devolucao:'outro', transferencia:'tecnico', prorrogacao:'tecnico' };
  return state.technicianPendingEvents.filter(event => {
    const pending = state.technicianPendencies.find(item => item.id === event.pending_id);
    if (!pending) return false;
    const linkedUnits = state.technicianPendingItems.filter(link => link.pending_id === pending.id).map(link => state.serialItems.find(item => item.id === link.serial_item_id)).filter(Boolean);
    const identifiers = linkedUnits.flatMap(item => [item.mac_address,item.serial_number,item.asset_tag]).filter(Boolean).join(' ');
    const text = `${product(pending.product_id)?.name || ''} ${pending.technician_name || ''} ${event.from_technician || ''} ${event.to_technician || ''} ${event.customer_name || ''} ${event.work_order || pending.work_order || ''} ${event.note || ''} ${identifiers}`.toLowerCase();
    const timestamp = event.occurred_at || event.created_at;
    const day = timestamp?.slice(0,10) || '';
    return (!query || text.includes(query)) && (!typeFilter || typeMap[event.event_type] === typeFilter) && (!holderFilter || holderMap[event.event_type] === holderFilter) && (!from || day >= from) && (!to || day <= to);
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
  const availableProducts = activeProducts().filter(item => !isEpiProduct(item));
  const exits = state.movements.filter(item => item.type === 'saida' && !item.fieldUsage).length;
  const openLoans = state.toolLoans.filter(item => !item.returned_at).length;
  const returns = state.toolLoans.filter(item => item.returned_at).length;
  const outOfStock = availableProducts.filter(item => Number(item.stock) === 0).length;
  const reorder = availableProducts.filter(item => Number(item.stock) > 0 && low(item)).length;
  $('#dashboard-items-count').textContent = availableProducts.length;
  $('#dashboard-exits-count').textContent = exits;
  $('#dashboard-loans-count').textContent = openLoans;
  $('#dashboard-returns-count').textContent = returns;
  $('#dashboard-minimum-count').textContent = outOfStock;
  $('#dashboard-reorder-count').textContent = reorder;
  // O painel de Produtos separa os EPIs, mas o valor total do estoque
  // continua considerando todo o patrimônio da empresa.
  renderDashboardStockValue(activeProducts());
  renderDashboardOperations();
  renderNotifications();
  renderProducts(); renderEpis(); renderMovement(); renderUsers(); renderRegistry(); renderReceipts(); renderSerials(); renderLaboratory(); renderLoans(); renderClientLoans(); renderInventory(); renderStatement();
  addPackageUnitOption();
}

function renderDashboardOperations() {
  const overdue = state.toolLoans.filter(loanOverdue).sort((a, b) => new Date(a.due_at) - new Date(b.due_at));
  const openReminders = state.reminders.filter(item => item.status === 'aberto').sort((a, b) => new Date(a.due_date) - new Date(b.due_date));
  const expired = expiredMaterialLots();
  const openPendencies = state.technicianPendencies.filter(item => item.resolution === 'aberta').sort((a, b) => new Date(a.due_at) - new Date(b.due_at));
  const overduePendencies = openPendencies.filter(item => pendingDeadlineState(item).key === 'overdue');
  $('#dashboard-overdue-loan-list-count').textContent = overdue.length;
  $('#dashboard-loan-alert').hidden = false;
  $('#dashboard-loan-alert').classList.toggle('success', overduePendencies.length === 0);
  $('#dashboard-loan-alert-text').textContent = overduePendencies.length ? `${overduePendencies.length} pendência${overduePendencies.length === 1 ? '' : 's'} de técnico${overduePendencies.length === 1 ? ' está' : 's estão'} atrasada${overduePendencies.length === 1 ? '' : 's'}` : 'Nenhuma pendência de técnico atrasada';
  $('#dashboard-loan-alert').firstChild.textContent = overduePendencies.length ? '⚠️ ' : '✓ ';
  $('#dashboard-reminder-count').textContent = openReminders.length;
  $('#dashboard-expiry-count').textContent = expired.length;
  $('#dashboard-request-count').textContent = openPendencies.length;
  $('#dashboard-overdue-loans-table').innerHTML = overdue.map((loan, index) => `<tr><td>${index + 1}</td><td>${esc(loan.collaborator_name || 'Não informado')}</td><td>${date(loan.due_at)}</td><td><button class="dashboard-icon-action" data-dashboard-loan="${loan.id}" type="button" aria-label="Ver empréstimo">◉</button></td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nenhum empréstimo em atraso.</td></tr>';
  $('#dashboard-reminders-table').innerHTML = openReminders.map(item => `<tr><td>${esc(item.recipient)}</td><td>${esc(item.description)}</td><td>${date(item.due_date)}</td><td><button class="dashboard-icon-action danger" data-close-reminder="${item.id}" type="button" aria-label="Concluir lembrete">×</button></td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nenhum lembrete registrado.</td></tr>';
  $('#dashboard-expiring-table').innerHTML = expired.map(item => `<tr><td>${esc(item.product_name || product(item.product_id)?.name || 'Material')}</td><td>${esc(item.batch_number || 'Não informado')}</td><td>${dateOnly(item.expiry_date)}</td><td><button class="dashboard-icon-action" data-dashboard-expiry="${item.receipt_id}" type="button" aria-label="Ver recebimento">◉</button></td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nenhum material vencido.</td></tr>';
  $('#dashboard-requests-table').innerHTML = openPendencies.map(item => { const deadline = pendingDeadlineState(item); return `<tr><td>${esc(item.technician_name)}</td><td>${esc(product(item.product_id)?.name || 'Material')}</td><td>${quantity(item.quantity)}</td><td>${date(item.withdrawn_at)}</td><td>${date(item.due_at)}</td><td><span class="pending-status ${deadline.key}">${deadline.label}</span></td><td><button class="secondary-button" data-view-pending="${item.id}" type="button">Ver</button></td></tr>`; }).join('') || '<tr><td colspan="7" class="empty">Nenhuma pendência de técnico aberta.</td></tr>';
  document.querySelectorAll('[data-dashboard-loan]').forEach(button => button.onclick = () => {
    view('loans');
    $('#loan-status-filter').value = 'atrasado';
    renderLoans();
  });
  $('#dashboard-loan-alert').onclick = () => overduePendencies[0] && openTechnicianPending(overduePendencies[0].id);
  $('#dashboard-expiry-action').onclick = () => view('receipts');
  document.querySelectorAll('[data-dashboard-expiry]').forEach(button => button.onclick = () => {
    view('receipts');
    openReceiptDetails(button.dataset.dashboardExpiry);
  });
  document.querySelectorAll('[data-view-pending]').forEach(button => button.onclick = () => openTechnicianPending(button.dataset.viewPending));
  document.querySelectorAll('[data-close-reminder]').forEach(button => button.onclick = () => closeReminder(button.dataset.closeReminder));
}

function renderNotifications() {
  const notices = expiryNotifications();
  const badge = $('#notification-badge');
  const total = $('#notifications-total');
  const list = $('#notifications-list');
  badge.hidden = notices.length === 0;
  badge.textContent = notices.length > 99 ? '99+' : notices.length;
  total.textContent = notices.length ? `${notices.length} aviso${notices.length === 1 ? '' : 's'}` : 'Sem avisos';
  list.innerHTML = notices.map((notice, index) => {
    const isEpi = notice.kind === 'epi';
    const name = isEpi ? notice.item.name : (notice.item.product_name || notice.product.name);
    const details = isEpi
      ? `${notice.alert.label} · CA: ${notice.item.ca_number || 'não informado'} · ${dateOnly(notice.expiry)}`
      : `${notice.alert.label} · Lote: ${notice.item.batch_number || 'não informado'} · ${dateOnly(notice.expiry)}`;
    return `<button class="notification-item ${notice.alert.type}" data-expiry-notification="${index}" type="button"><strong>${esc(name)}</strong><small>${esc(details)}</small></button>`;
  }).join('') || '<p class="notifications-empty">Nenhum aviso de vencimento no momento.</p>';
  document.querySelectorAll('[data-expiry-notification]').forEach(button => button.onclick = () => {
    const notice = notices[Number(button.dataset.expiryNotification)];
    if (!notice) return;
    setNotificationsOpen(false);
    if (notice.kind === 'epi') return showEpis(notice.alert.type === 'expired' ? 'expired' : 'ca');
    view('receipts');
    openReceiptDetails(notice.item.receipt_id);
  });
}

async function completeMaterialRequest(id) {
  if (!['admin', 'operador'].includes(currentUser?.role)) return alert('Apenas administradores e operadores podem concluir solicitações.');
  const { error } = await supabase.from('material_requests').update({ status: 'atendida', updated_at: new Date().toISOString() }).eq('id', id);
  if (error) return alert('Não foi possível concluir a solicitação.');
  await load();
}

async function deleteMaterialRequest(id) {
  if (currentUser?.role !== 'admin') return alert('Apenas administradores podem apagar solicitações.');
  if (!confirm('Apagar esta solicitação definitivamente?')) return;
  const { error } = await supabase.from('material_requests').delete().eq('id', id);
  if (error) return alert('Não foi possível apagar a solicitação. Execute o SQL desta atualização no Supabase.');
  await load();
}

async function closeReminder(id) {
  if (!confirm('Marcar este lembrete como concluído?')) return;
  const { error } = await supabase.from('dashboard_reminders').update({ status: 'concluido', closed_at: new Date().toISOString() }).eq('id', id);
  if (error) return alert('Não foi possível concluir o lembrete. Execute primeiro o SQL desta atualização no Supabase.');
  await load();
}

function renderProducts() {
  const query = $('#product-search').value.toLowerCase();
  const canDelete = currentUser?.role === 'admin';
  const canEdit = ['admin', 'operador'].includes(currentUser?.role);
  const canViewCosts = currentUser?.role === 'admin';
  $('#products-cost-heading').hidden = !canViewCosts;
  const categorySelect = $('#product-category-filter'), statusSelect = $('#product-status-filter');
  const selectedCategory = categorySelect.value;
  const categories = [...new Set(activeProducts().filter(item => !isEpiProduct(item)).map(item => item.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  categorySelect.innerHTML = '<option value="">Todas as categorias</option>' + categories.map(category => `<option value="${esc(category)}">${esc(category)}</option>`).join('');
  categorySelect.value = categories.includes(selectedCategory) ? selectedCategory : '';
  const category = categorySelect.value, statusFilter = statusSelect.value;
  const products = activeProducts().filter(item => {
    if (isEpiProduct(item)) return false;
    const matchesPreset = state.productFilter !== 'low' || low(item);
    const matchesCategory = !category || item.category === category;
    const matchesStatus = !statusFilter
      || statusFilter === 'available' && Number(item.stock) > 0 && !low(item)
      || statusFilter === 'low' && low(item) && Number(item.stock) > 0
      || statusFilter === 'out' && Number(item.stock) === 0;
    return matchesPreset && matchesCategory && matchesStatus && `${item.name} ${item.code} ${item.category}`.toLowerCase().includes(query);
  });
  $('#products-table').innerHTML = products.map(item => {
    const image = productImageUrl(item);
    return `<tr><td><div class="product-name-cell">${image ? `<span class="product-thumbnail"><img src="${esc(image)}" alt="Foto de ${esc(item.name)}" /></span>` : ''}<div><b>${esc(item.name)}</b><small>${esc([item.brand, item.model].filter(Boolean).join(' · ') || (item.tracking_mode === 'serializado' ? 'Rastreável por serial/MAC' : 'Controle por quantidade'))}</small></div></div></td><td>${esc(item.code)}</td><td>${esc(item.category)}</td>${canViewCosts ? `<td><b>${currency(item.average_cost)}</b><small>por ${unitName(item.unit_of_measure)}</small></td>` : ''}<td><b>${stockLabel(item)}</b><small>mínimo: ${quantity(item.minimum)} ${unitName(item.unit_of_measure)}</small></td><td>${status(item)}</td><td><div class="table-actions">${canEdit ? `<button class="secondary-button" data-edit-product="${item.id}">Editar</button>` : ''}${canDelete ? `<button class="danger-button" data-delete-product="${item.id}">Apagar</button>` : ''}${!canEdit && !canDelete ? '—' : ''}</div></td></tr>`;
  }).join('') || `<tr><td colspan="${canViewCosts ? 7 : 6}" class="empty">Nenhum produto encontrado.</td></tr>`;
  document.querySelectorAll('[data-edit-product]').forEach(button => button.onclick = () => openProductEditor(button.dataset.editProduct));
  document.querySelectorAll('[data-delete-product]').forEach(button => button.onclick = () => deleteProduct(button.dataset.deleteProduct));
}

function renderEpis() {
  const table = $('#epis-table');
  if (!table) return;
  const filter = $('#epi-status-filter').value;
  const canManage = ['admin', 'operador'].includes(currentUser?.role);
  const canDelete = currentUser?.role === 'admin';
  const epis = activeProducts().filter(isEpiProduct);
  const caAttention = epis.filter(item => Boolean(caAlert(item)));
  const expired = epis.filter(caExpired);
  const filtered = epis.filter(item => !filter || filter === 'ca' && Boolean(caAlert(item)) || filter === 'expired' && caExpired(item));
  const deliveries = state.movements
    .filter(item => item.type === 'saida' && !item.fieldUsage && isEpiProduct(product(item.productId)))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 8);

  $('#epi-items-count').textContent = epis.length;
  $('#epi-stock-count').textContent = quantity(epis.reduce((total, item) => total + Number(item.stock || 0), 0));
  $('#epi-ca-attention-count').textContent = caAttention.length;
  $('#epi-ca-expired-count').textContent = expired.length;
  table.innerHTML = filtered.map(item => {
    const alert = caAlert(item);
    const image = productImageUrl(item);
    const caNumber = item.requires_ca ? (item.ca_number || 'Não informado') : 'Não se aplica';
    const caExpiry = item.requires_ca ? (item.ca_expiry_date ? new Date(`${item.ca_expiry_date}T00:00:00`).toLocaleDateString('pt-BR') : 'Não informada') : '—';
    return `<tr><td><div class="product-name-cell">${image ? `<span class="product-thumbnail"><img src="${esc(image)}" alt="Foto de ${esc(item.name)}" /></span>` : ''}<div><b>${esc(item.name)}</b><small>${esc([item.brand, item.model].filter(Boolean).join(' · ') || 'EPI')}</small></div></div></td><td>${esc(item.code)}</td><td>${esc(caNumber)}</td><td>${esc(caExpiry)}</td><td><b>${stockLabel(item)}</b><small>mínimo: ${quantity(item.minimum)} ${unitName(item.unit_of_measure)}</small></td><td>${status(item)}${alert ? `<small class="ca-status ${alert.type}">${esc(alert.label)}</small>` : ''}</td><td><div class="table-actions">${canManage ? `<button class="secondary-button" data-deliver-epi="${item.id}">Entregar</button><button class="secondary-button" data-edit-epi="${item.id}">Editar</button>` : ''}${canDelete ? `<button class="danger-button" data-delete-epi="${item.id}">Apagar</button>` : ''}${!canManage && !canDelete ? '—' : ''}</div></td></tr>`;
  }).join('') || '<tr><td colspan="7" class="empty">Nenhum EPI encontrado para este filtro.</td></tr>';
  $('#epi-deliveries-table').innerHTML = deliveries.map(item => `<tr><td>${date(item.createdAt)}</td><td><b>${esc(product(item.productId)?.name || 'EPI')}</b></td><td>${quantity(item.quantity)} ${unitName(product(item.productId)?.unit_of_measure)}</td><td>${esc(item.person || 'Não informado')}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nenhuma entrega de EPI registrada.</td></tr>';
  document.querySelectorAll('[data-deliver-epi]').forEach(button => button.onclick = () => openEpiDelivery(button.dataset.deliverEpi));
  document.querySelectorAll('[data-edit-epi]').forEach(button => button.onclick = () => openProductEditor(button.dataset.editEpi));
  document.querySelectorAll('[data-delete-epi]').forEach(button => button.onclick = () => deleteProduct(button.dataset.deleteEpi));
}

function renderMovement() {
  const select = $('#movement-product'), selected = select.value;
  const canDelete = currentUser?.role === 'admin';
  const products = activeProducts();
  select.innerHTML = products.map(item => `<option value="${item.id}">${esc(item.name)} (${stockLabel(item)})</option>`).join('');
  select.value = selected || products[0]?.id || '';
  renderMovementSerialUnits();
  const movements = getFilteredMovements().filter(item => !item.pendingId);
  const serialMovements = getFilteredSerialMovements().filter(item => !item.pending_id);
  const pendingEvents = getFilteredTechnicianEvents();
  const timeline = movements.map(item => {
    const balance = item.stockBefore != null && item.stockAfter != null ? ` · Estoque: ${quantity(item.stockBefore)} → ${quantity(item.stockAfter)}` : '';
    return { at:item.createdAt, id:item.id, html:`<div class="history-item"><span class="history-icon ${item.type === 'saida' ? 'out' : ''}">${item.type === 'entrada' ? '↓' : '↑'}</span><div><b>${movementName(item)} de ${quantity(item.quantity)} ${unitName(product(item.productId)?.unit_of_measure)} — ${esc(product(item.productId)?.name || 'Produto')}</b><small>${holderTypeName(item.holderType)}: ${esc(item.person)} · ${item.date}${balance}${item.workOrder ? ' · OS: ' + esc(item.workOrder) : ''}${item.note ? ' · ' + esc(item.note) : ''}</small></div>${canDelete ? `<button class="danger-button" data-delete-movement="${item.id}">Apagar</button>` : ''}</div>` };
  });
  timeline.push(...serialMovements.map(item => {
    const serialItem = state.serialItems.find(entry => entry.id === item.serial_item_id), itemProduct = serialItem && product(serialItem.product_id);
    const from = state.locations.find(location => location.id === item.from_location_id)?.name || serialStatusName(item.previous_status);
    const to = state.locations.find(location => location.id === item.to_location_id)?.name || item.customer_name || item.recipient || serialStatusName(item.new_status);
    const impact = Number(item.stock_impact ?? (item.previous_status === 'disponivel' && item.new_status !== 'disponivel' ? -1 : item.previous_status !== 'disponivel' && item.new_status === 'disponivel' ? 1 : 0));
    const impactLabel = impact > 0 ? '+1 no estoque' : impact < 0 ? '-1 no estoque' : 'sem alteração no estoque';
    const identifier = serialItem?.asset_tag || serialItem?.mac_address || serialItem?.serial_number || 'sem identificador';
    return { at:item.created_at, id:item.id, html:`<div class="history-item"><span class="history-icon ${impact < 0 ? 'out' : ''}">${impact > 0 ? '↓' : impact < 0 ? '↑' : '⇄'}</span><div><b>${esc(serialActionName(item.action))} — ${esc(itemProduct?.name || 'Equipamento')} (${esc(identifier)})</b><small>${esc(from)} → ${esc(to)} · ${date(item.created_at)} · <b>${esc(impactLabel)}</b>${item.work_order ? ' · OS: ' + esc(item.work_order) : ''}${item.note ? ' · ' + esc(item.note) : ''}</small></div></div>` };
  }));
  timeline.push(...pendingEvents.map(event => {
    const pending = state.technicianPendencies.find(item => item.id === event.pending_id);
    const eventName = {retirada:'Retirada do almoxarifado',transferencia:'Repasse para outro técnico',prorrogacao:'Prorrogação de prazo',devolucao:'Devolução ao almoxarifado',utilizacao:'Instalação / utilização'}[event.event_type] || event.event_type;
    const stockText = event.event_type === 'retirada' ? `Estoque: -${quantity(pending?.quantity)}` : event.event_type === 'devolucao' ? `Estoque: +${quantity(pending?.quantity)}` : 'Estoque: sem alteração';
    const linkedUnits = state.technicianPendingItems.filter(link => link.pending_id === event.pending_id).map(link => state.serialItems.find(item => item.id === link.serial_item_id)).filter(Boolean);
    const identifiers = linkedUnits.map(item => item.asset_tag || item.mac_address || item.serial_number).filter(Boolean).join(', ');
    const details = [event.from_technician, event.to_technician && `→ ${event.to_technician}`, event.customer_name && `Cliente: ${event.customer_name}`, (event.work_order || pending?.work_order) && `OS: ${event.work_order || pending.work_order}`, event.previous_due_at && `Prazo anterior: ${date(event.previous_due_at)}`, event.new_due_at && `Prazo: ${date(event.new_due_at)}`, identifiers && `Unidades: ${identifiers}`, stockText, event.note].filter(Boolean).map(esc).join(' · ');
    const occurredAt = event.occurred_at || event.created_at;
    return { at:occurredAt, id:event.id, html:`<div class="history-item"><span class="history-icon ${event.event_type === 'retirada' ? 'out' : ''}">${event.event_type === 'retirada' ? '↑' : event.event_type === 'devolucao' ? '↓' : '⇄'}</span><div><b>${esc(eventName)} — ${esc(product(pending?.product_id)?.name || 'Material')}</b><small>${date(occurredAt)} · ${details}</small></div></div>` };
  }));
  timeline.sort((a,b) => new Date(b.at)-new Date(a.at) || String(b.id).localeCompare(String(a.id)));
  $('#movement-history').innerHTML = timeline.map(item => item.html).join('') || '<p class="empty">Nenhuma movimentação encontrada.</p>';
  document.querySelectorAll('[data-delete-movement]').forEach(button => button.onclick = () => deleteMovement(button.dataset.deleteMovement));
}

function updateTechnicianPendingAction() {
  const action = $('#technician-pending-action').value;
  $('#technician-pending-install-group').hidden = action !== 'utilizado';
  $('#technician-pending-technician-group').hidden = action !== 'transferir';
  $('#technician-pending-due-group').hidden = !['transferir','prorrogar'].includes(action);
}

function openTechnicianPending(id) {
  const item = state.technicianPendencies.find(entry => entry.id === id);
  if (!item) return;
  const deadline = pendingDeadlineState(item);
  $('#technician-pending-id').value = item.id;
  $('#technician-pending-action').value = 'utilizado';
  $('#technician-pending-technician').value = '';
  $('#technician-pending-due').value = localDateTimeInputValue(item.due_at);
  $('#technician-pending-note').value = '';
  $('#technician-pending-customer').value = '';
  $('#technician-pending-work-order').value = item.work_order || '';
  $('#technician-pending-installed-at').value = localDateTimeInputValue(new Date());
  const linkedUnits = state.technicianPendingItems.filter(link => link.pending_id === item.id).map(link => state.serialItems.find(unit => unit.id === link.serial_item_id)).filter(Boolean);
  const identifiers = linkedUnits.map((unit, index) => `<span><b>Unidade ${index + 1}:</b> MAC ${esc(unit.mac_address || '—')} · Serial ${esc(unit.serial_number || '—')} · Patrimônio ${esc(unit.asset_tag || '—')}</span>`).join('');
  $('#technician-pending-details').innerHTML = `<b>${esc(product(item.product_id)?.name || 'Material')}</b><span>Quantidade: ${quantity(item.quantity)} · Técnico atual: ${esc(item.technician_name)}</span><span>Retirada: ${date(item.withdrawn_at)} · Prazo: ${date(item.due_at)}</span><span class="pending-status ${deadline.key}">${deadline.label}</span><span>OS: ${esc(item.work_order || '—')}</span>${identifiers}${item.note ? `<span>Observação: ${esc(item.note)}</span>` : ''}`;
  const events = state.technicianPendingEvents.filter(entry => entry.pending_id === item.id).sort((a,b) => new Date(b.occurred_at || b.created_at)-new Date(a.occurred_at || a.created_at));
  $('#technician-pending-events').innerHTML = events.map(event => `<div class="serial-history-item"><b>${esc({retirada:'Retirada',transferencia:'Repasse',prorrogacao:'Prorrogação',devolucao:'Devolução',utilizacao:'Instalação / utilização'}[event.event_type] || event.event_type)}</b><small>${date(event.occurred_at || event.created_at)}${event.from_technician ? ` · De: ${esc(event.from_technician)}` : ''}${event.to_technician ? ` · Para: ${esc(event.to_technician)}` : ''}${event.customer_name ? ` · Cliente: ${esc(event.customer_name)}` : ''}${event.work_order ? ` · OS: ${esc(event.work_order)}` : ''}${event.previous_due_at ? ` · Prazo anterior: ${date(event.previous_due_at)}` : ''}${event.new_due_at ? ` · Novo prazo: ${date(event.new_due_at)}` : ''}${event.note ? ` · ${esc(event.note)}` : ''}</small></div>`).join('') || '<p class="empty">Nenhum evento registrado.</p>';
  updateTechnicianPendingAction();
  $('#technician-pending-dialog').showModal();
}

async function submitTechnicianPending(event) {
  event.preventDefault();
  const submitButton = event.submitter || event.currentTarget.querySelector('button[type="submit"]');
  if (submitButton?.disabled) return;
  const action = $('#technician-pending-action').value;
  const needsDue = ['transferir','prorrogar'].includes(action);
  const pendingId = $('#technician-pending-id').value;
  const hasIdentifiedUnits = state.technicianPendingItems.some(link => link.pending_id === pendingId);
  if (action === 'transferir' && !$('#technician-pending-technician').value.trim()) return alert('Informe o novo técnico.');
  if (needsDue && !$('#technician-pending-due').value) return alert('Informe o novo prazo.');
  if (action === 'utilizado' && hasIdentifiedUnits && !$('#technician-pending-customer').value.trim()) return alert('Informe o nome do cliente para instalar este equipamento.');
  const label = {utilizado:'marcar como utilizado/instalado',devolvido:'devolver ao almoxarifado',transferir:'repassar para outro técnico',prorrogar:'prorrogar o prazo'}[action];
  if (!confirm(`Confirma que deseja ${label}?`)) return;
  if (submitButton) { submitButton.disabled = true; submitButton.textContent = 'Processando…'; }
  try {
    const { error } = await supabase.rpc('resolve_integrated_technician_pending', {
      p_pending_id: pendingId,
      p_action: action,
      p_technician: $('#technician-pending-technician').value.trim() || null,
      p_due_at: needsDue ? new Date($('#technician-pending-due').value).toISOString() : null,
      p_customer_name: action === 'utilizado' ? $('#technician-pending-customer').value.trim() || null : null,
      p_work_order: action === 'utilizado' ? $('#technician-pending-work-order').value.trim() || null : null,
      p_occurred_at: action === 'utilizado' && $('#technician-pending-installed-at').value ? new Date($('#technician-pending-installed-at').value).toISOString() : new Date().toISOString(),
      p_note: $('#technician-pending-note').value.trim() || null
    });
    if (error) return alert(error.message);
    $('#technician-pending-dialog').close();
    await load();
  } finally {
    if (submitButton) { submitButton.disabled = false; submitButton.textContent = 'Confirmar ação'; }
  }
}

function receiptProducts() {
  return activeProducts().filter(item => item.tracking_mode !== 'serializado');
}

function receiptLineHtml(selected = '') {
  const products = receiptProducts();
  const selectedProduct = product(selected);
  const unitCost = Number(selectedProduct?.average_cost || 0).toFixed(2);
  return `<div class="receipt-line"><label>Material <select data-receipt-product required><option value="">Selecione</option><option value="__new__" ${selected === '__new__' ? 'selected' : ''}>+ Cadastrar novo material nesta entrega</option>${products.map(item => `<option value="${item.id}" ${item.id === selected ? 'selected' : ''}>${esc(item.name)} (${stockLabel(item)})</option>`).join('')}</select></label><label>Quantidade <input data-receipt-quantity type="number" min="0.001" step="0.001" required value="1" /></label><label>Valor unitário (R$) <input data-receipt-unit-cost type="number" min="0" step="0.01" required value="${unitCost}" /></label><label>Lote <input data-receipt-batch maxlength="80" placeholder="Opcional" /></label><label>Validade <input data-receipt-expiry type="date" /></label><button class="receipt-line-remove" data-remove-receipt-line type="button" aria-label="Remover material">×</button><div class="receipt-new-product" data-receipt-new-product ${selected === '__new__' ? '' : 'hidden'}><label>Nome do novo material <input data-receipt-new-name ${selected === '__new__' ? 'required' : ''} placeholder="Ex.: Cabo de rede CAT6" /></label><label>Código <input data-receipt-new-code ${selected === '__new__' ? 'required' : ''} placeholder="Ex.: CAB-CAT6" /></label><label>Categoria <select data-receipt-new-category><option value="Produtos">Produtos</option><option value="Equipamentos">Equipamentos</option><option value="Insumos">Insumos</option><option value="Patrimônio">Patrimônio</option><option value="Ferramentas">Ferramentas</option></select></label><label>Unidade <select data-receipt-new-unit><option value="unidade">Unidade</option><option value="metro">Metro</option><option value="par">Par</option><option value="caixa">Caixa</option></select></label></div></div>`;
}

function toggleReceiptNewProductFields(line) {
  const isNewProduct = line.querySelector('[data-receipt-product]').value === '__new__';
  const newProductFields = line.querySelector('[data-receipt-new-product]');
  newProductFields.hidden = !isNewProduct;
  newProductFields.querySelectorAll('[data-receipt-new-name], [data-receipt-new-code]').forEach(input => { input.required = isNewProduct; });
}

function bindReceiptLineEvents() {
  document.querySelectorAll('[data-remove-receipt-line]').forEach(button => button.onclick = () => button.closest('.receipt-line').remove());
  document.querySelectorAll('[data-receipt-product]').forEach(select => select.onchange = () => {
    const item = product(select.value);
    const line = select.closest('.receipt-line');
    if (item) line.querySelector('[data-receipt-unit-cost]').value = Number(item.average_cost || 0).toFixed(2);
    toggleReceiptNewProductFields(line);
  });
  document.querySelectorAll('.receipt-line').forEach(toggleReceiptNewProductFields);
}

function addReceiptLine(selected = '') {
  $('#receipt-lines').insertAdjacentHTML('beforeend', receiptLineHtml(selected));
  bindReceiptLineEvents();
}

function openReceiptDialog() {
  receiptOperationId = null;
  $('#receipt-form').reset();
  populateReceiptSuppliers();
  $('#receipt-lines').innerHTML = '';
  addReceiptLine();
  $('#receipt-dialog').showModal();
}

async function createProductsForReceipt(lines) {
  const pendingByCode = new Map();
  for (const line of lines.filter(item => item.isNewProduct)) {
    const code = line.product_code.trim();
    const existing = state.products.find(item => String(item.code || '').trim().toLocaleLowerCase('pt-BR') === code.toLocaleLowerCase('pt-BR'));
    if (existing?.is_active === false) throw new Error(`O código ${code} pertence ao produto arquivado “${existing.name}”. Reative-o pela tela Produtos antes de receber novamente.`);
    if (existing) {
      line.product_id = existing.id;
      continue;
    }
    const previous = pendingByCode.get(code.toLocaleLowerCase('pt-BR'));
    if (previous && previous.name !== line.product_name.trim()) throw new Error(`O código ${code} foi informado para dois materiais diferentes.`);
    pendingByCode.set(code.toLocaleLowerCase('pt-BR'), {
      name: line.product_name.trim(), code, category: line.category, unit_of_measure: line.unit_of_measure,
      tracking_mode: 'quantidade', stock: 0, minimum_stock: 0, average_cost: line.unit_cost,
      description: 'Cadastrado automaticamente junto com o recebimento.'
    });
  }
  if (!pendingByCode.size) return lines;
  const { data, error } = await supabase.from('products').insert([...pendingByCode.values()]).select('*');
  if (error) throw new Error(`Não foi possível cadastrar os novos materiais: ${error.message}`);
  const createdByCode = new Map(data.map(item => [String(item.code).trim().toLocaleLowerCase('pt-BR'), item]));
  lines.filter(item => item.isNewProduct && !item.product_id).forEach(line => { line.product_id = createdByCode.get(line.product_code.trim().toLocaleLowerCase('pt-BR'))?.id; });
  if (lines.some(item => !item.product_id)) throw new Error('Não foi possível identificar um dos produtos criados para o recebimento.');
  return lines;
}

async function registerReceipt({ supplierName, invoiceNumber, note, lines, operationId }) {
  const name = String(supplierName || '').trim();
  if (!name) throw new Error('Informe o fornecedor.');
  if (!lines.length || lines.some(line => !line.product_id || !Number.isFinite(line.quantity) || line.quantity <= 0 || !Number.isFinite(line.unit_cost) || line.unit_cost < 0)) throw new Error('Preencha o material, a quantidade e o valor unitário em todas as linhas.');
  const savedSupplier = state.suppliers.find(item => item.active && item.name.trim().toLocaleLowerCase('pt-BR') === name.toLocaleLowerCase('pt-BR'));
  const receiptData = savedSupplier ? {
    p_operation_id: operationId,
    p_supplier_id: savedSupplier.id,
    p_invoice_number: String(invoiceNumber || '').trim() || null,
    p_note: String(note || '').trim() || null,
    p_items: lines
  } : {
    p_operation_id: operationId,
    p_supplier: name,
    p_invoice_number: String(invoiceNumber || '').trim() || null,
    p_note: String(note || '').trim() || null,
    p_items: lines
  };
  const { error } = await supabase.rpc('record_receipt_idempotent', receiptData);
  if (error) throw error;
}

function xmlNodes(parent, tagName) {
  return [...parent.getElementsByTagNameNS('*', tagName)];
}

function xmlText(parent, tagName) {
  return xmlNodes(parent, tagName)[0]?.textContent?.trim() || '';
}

function parseInvoiceXml(xmlContent) {
  const documentXml = new DOMParser().parseFromString(xmlContent, 'application/xml');
  if (documentXml.querySelector('parsererror')) throw new Error('O arquivo selecionado não é um XML de nota fiscal válido.');
  const invoice = xmlNodes(documentXml, 'infNFe')[0];
  if (!invoice) throw new Error('Não encontrei os dados da NF-e neste XML. Selecione o XML da nota fiscal, e não o PDF.');
  const emitter = xmlNodes(invoice, 'emit')[0];
  const issuerName = xmlText(emitter || invoice, 'xNome') || 'Fornecedor não informado';
  const issuerCnpj = xmlText(emitter || invoice, 'CNPJ');
  const invoiceNumber = xmlText(xmlNodes(invoice, 'ide')[0] || invoice, 'nNF') || invoice.getAttribute('Id')?.replace(/^NFe/, '') || '';
  const accessKey = invoice.getAttribute('Id')?.replace(/^NFe/, '') || '';
  const items = xmlNodes(invoice, 'det').map(detail => {
    const productNode = xmlNodes(detail, 'prod')[0];
    const importedQuantity = Number(xmlText(productNode || detail, 'qCom').replace(',', '.'));
    const unitCostText = xmlText(productNode || detail, 'vUnCom');
    const unitCost = unitCostText ? Number(unitCostText.replace(',', '.')) : null;
    return {
      code: xmlText(productNode || detail, 'cProd'),
      name: xmlText(productNode || detail, 'xProd') || 'Item sem descrição',
      quantity: importedQuantity,
      unit: xmlText(productNode || detail, 'uCom') || 'un.',
      unitCost: Number.isFinite(unitCost) && unitCost >= 0 ? unitCost : null,
      productId: ''
    };
  }).filter(item => Number.isFinite(item.quantity) && item.quantity > 0);
  if (!items.length) throw new Error('A nota não possui itens com quantidade válida para importar.');
  return { supplier: issuerName, cnpj: issuerCnpj, invoiceNumber, accessKey, items };
}

function findImportedProduct(item) {
  const code = normalizedScanCode(item.code);
  const name = normalizedScanCode(item.name);
  return activeProducts().find(productItem => productItem.tracking_mode !== 'serializado' && (
    code && normalizedScanCode(productItem.code) === code ||
    name && normalizedScanCode(productItem.name) === name
  ));
}

function xmlAutoProductId(index) {
  return `auto-create-${index}`;
}

function xmlUnitOfMeasure(value) {
  return spreadsheetUnit(value);
}

function xmlGeneratedProductCode(item, index) {
  const code = String(item.code || '').trim();
  if (code) return code;
  const invoiceReference = String(importedXmlInvoice?.accessKey || importedXmlInvoice?.invoiceNumber || Date.now()).replace(/[^a-zA-Z0-9]/g, '').slice(-16);
  return `XML-${invoiceReference || 'NF'}-${index + 1}`;
}

async function registerXmlReceipt({ supplierName, invoiceNumber, note, items }) {
  const { error } = await supabase.rpc('import_xml_receipt', {
    p_supplier: String(supplierName || '').trim(),
    p_invoice_number: String(invoiceNumber || '').trim(),
    p_note: String(note || '').trim() || null,
    p_items: items
  });
  if (error) throw error;
}

function renderImportedXmlItems() {
  const list = $('#xml-import-items');
  if (!importedXmlInvoice) {
    list.innerHTML = '';
    return;
  }
  const selectableProducts = receiptProducts();
  list.innerHTML = importedXmlInvoice.items.map((item, index) => {
    const autoId = xmlAutoProductId(index);
    const willCreate = item.productId === autoId;
    return `<div class="xml-import-item"><div><b>${esc(item.name)}</b><small>Código XML: ${esc(item.code || 'não informado')} · ${quantity(item.quantity)} ${esc(item.unit)}${item.unitCost !== null ? ` · ${currency(item.unitCost)}` : ''}</small></div><label>Produto no sistema <select data-xml-item-product="${index}"><option value="">Não importar este item</option><option value="${autoId}" ${willCreate ? 'selected' : ''}>Cadastrar automaticamente este produto</option>${selectableProducts.map(productItem => `<option value="${productItem.id}" ${productItem.id === item.productId ? 'selected' : ''}>${esc(productItem.name)} (${esc(productItem.code)})</option>`).join('')}</select></label></div>`;
  }).join('');
  document.querySelectorAll('[data-xml-item-product]').forEach(select => select.onchange = () => {
    importedXmlInvoice.items[Number(select.dataset.xmlItemProduct)].productId = select.value;
  });
}

function showXmlImportError(message = '') {
  const error = $('#xml-import-error');
  error.hidden = !message;
  error.textContent = message;
}

function openXmlImportDialog() {
  importedXmlInvoice = null;
  $('#xml-file-form').reset();
  $('#xml-auto-create-products').checked = true;
  $('#xml-import-preview').hidden = true;
  showXmlImportError();
  populateReceiptSuppliers();
  $('#xml-import-dialog').showModal();
}

function openReceiptDetails(id) {
  const receipt = state.receipts.find(item => item.id === id);
  if (!receipt) return;
  const items = state.receiptItems.filter(item => item.receipt_id === id);
  $('#receipt-details-title').textContent = receipt.supplier;
  $('#receipt-details-subtitle').textContent = `${receipt.invoice_number ? `NF: ${receipt.invoice_number} · ` : ''}${date(receipt.received_at)}${receipt.note ? ` · ${receipt.note}` : ''}`;
  $('#receipt-details-list').innerHTML = items.map(item => {
    const unitCost = Number(item.unit_cost || 0);
    const lot = [item.batch_number ? `Lote: ${esc(item.batch_number)}` : '', item.expiry_date ? `Validade: ${dateOnly(item.expiry_date)}` : ''].filter(Boolean).join(' · ');
    return `<div class="serial-history-item"><b>${esc(item.product_name)}</b><small>${quantity(item.quantity)} ${unitName(item.unit_of_measure)} · Código: ${esc(item.product_code)}${unitCost ? ` · ${currency(unitCost)} cada · Total: ${currency(Number(item.quantity) * unitCost)}` : ''}${lot ? ` · ${lot}` : ''}</small></div>`;
  }).join('') || '<p class="empty">Nenhum material encontrado neste recebimento.</p>';
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

function financialEntries() {
  const receiptsById = new Map(state.receipts.map(item => [String(item.id), item]));
  const receiptEntries = state.receiptItems.map(item => {
    const receipt = receiptsById.get(String(item.receipt_id));
    const unitCost = Number(item.unit_cost || 0);
    const itemName = item.product_name || product(item.product_id)?.name || 'Produto removido';
    return {
      id: `receipt-${item.id}`,
      date: receipt?.received_at || item.created_at,
      type: 'entrada',
      description: `Recebimento${receipt?.supplier ? ` · ${receipt.supplier}` : ''}${receipt?.invoice_number ? ` · NF ${receipt.invoice_number}` : ''}`,
      item: itemName,
      code: item.product_code || product(item.product_id)?.code || '',
      quantity: Number(item.quantity || 0),
      unitCost,
      total: Number(item.quantity || 0) * unitCost
    };
  });
  const movementEntries = state.movements
    .filter(item => !(item.type === 'entrada' && String(item.person || '').startsWith('Recebimento:')))
    .map(item => {
      const itemProduct = product(item.productId);
      const unitCost = Number(itemProduct?.average_cost || 0);
      return {
        id: `movement-${item.id}`,
        date: item.createdAt,
        type: item.type === 'entrada' ? 'entrada' : 'saida',
        description: `${movementName(item)}${item.person ? ` · ${item.person}` : ''}${item.workOrder ? ` · ${item.workOrder}` : ''}`,
        item: itemProduct?.name || 'Produto removido',
        code: itemProduct?.code || '',
        quantity: Number(item.quantity || 0),
        unitCost,
        total: Number(item.quantity || 0) * unitCost
      };
    });
  return [...receiptEntries, ...movementEntries].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
}

function renderStatement() {
  const table = $('#statement-table');
  if (!table || currentUser?.role !== 'admin') return;
  const entries = financialEntries();
  const stockValue = activeProducts().reduce((total, item) => total + Number(item.stock || 0) * Number(item.average_cost || 0), 0);
  const entryEntries = entries.filter(item => item.type === 'entrada');
  const outputEntries = entries.filter(item => item.type === 'saida');
  $('#statement-stock-value').textContent = currency(stockValue);
  $('#statement-entry-value').textContent = currency(entryEntries.reduce((total, item) => total + item.total, 0));
  $('#statement-output-value').textContent = currency(outputEntries.reduce((total, item) => total + item.total, 0));
  $('#statement-entry-count').textContent = `${entryEntries.length} lançamento${entryEntries.length === 1 ? '' : 's'}`;
  $('#statement-output-count').textContent = `${outputEntries.length} lançamento${outputEntries.length === 1 ? '' : 's'}`;

  const search = $('#statement-search').value.trim().toLocaleLowerCase('pt-BR');
  const type = $('#statement-type').value;
  const from = $('#statement-from').value;
  const to = $('#statement-to').value;
  const filtered = entries.filter(item => {
    const itemDate = item.date ? new Date(item.date).toISOString().slice(0, 10) : '';
    const text = `${item.description} ${item.item} ${item.code}`.toLocaleLowerCase('pt-BR');
    return (!search || text.includes(search))
      && (!type || item.type === type)
      && (!from || itemDate >= from)
      && (!to || itemDate <= to);
  });
  const periodBalance = filtered.reduce((total, item) => total + (item.type === 'entrada' ? item.total : -item.total), 0);
  $('#statement-period-total').textContent = `Saldo do período: ${currency(periodBalance)}`;
  table.innerHTML = filtered.map(item => `<tr><td>${date(item.date)}</td><td><span class="badge ${item.type === 'entrada' ? 'ok' : 'saida'}">${item.type === 'entrada' ? 'Entrada' : 'Saída'}</span></td><td>${esc(item.description)}</td><td><b>${esc(item.item)}</b><small>${esc(item.code || 'Sem código')}</small></td><td>${quantity(item.quantity)}</td><td>${currency(item.unitCost)}</td><td><b class="statement-total ${item.type}">${item.type === 'entrada' ? '+' : '-'} ${currency(item.total)}</b></td></tr>`).join('') || '<tr><td colspan="7" class="empty">Nenhum lançamento encontrado para este filtro.</td></tr>';
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
  const canEditCollaborators = currentUser?.role === 'admin';
  collaboratorsTable.innerHTML = collaborators.map(item => `<tr><td><b>${esc(item.name)}</b><small>${esc(item.job_title || 'Sem cargo informado')}</small></td><td>${esc(item.department || '—')}</td><td>${esc(item.phone || '—')}</td><td>${item.active ? '<span class="badge ok">Ativo</span>' : '<span class="badge out">Inativo</span>'}</td><td><div class="table-actions">${canEditCollaborators ? `<button class="secondary-button" data-edit-collaborator="${item.id}">Editar</button>` : ''}<button class="secondary-button" data-toggle-collaborator="${item.id}">${item.active ? 'Desativar' : 'Reativar'}</button><button class="danger-button" data-delete-collaborator="${item.id}">Remover</button></div></td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nenhum colaborador cadastrado.</td></tr>';
  vehiclesTable.innerHTML = state.vehicles.map(item => `<tr><td><b>${esc(item.name)}</b><small>${esc(item.plate || 'Sem placa informada')}</small></td><td>${esc(state.collaborators.find(collaborator => collaborator.id === item.responsible_id)?.name || '—')}</td><td>${item.active ? '<span class="badge ok">Ativo</span>' : '<span class="badge out">Inativo</span>'}</td><td><div class="table-actions"><button class="secondary-button" data-toggle-vehicle="${item.id}">${item.active ? 'Desativar' : 'Reativar'}</button><button class="danger-button" data-delete-vehicle="${item.id}">Remover</button></div></td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nenhum veículo cadastrado.</td></tr>';
  locationsTable.innerHTML = state.locations.map(item => `<tr><td><b>${esc(item.name)}</b></td><td>${esc(({ central:'Almoxarifado central', laboratorio:'Oficina', outro:'Outro', colaborador:'Colaborador', veiculo:'Veículo', cliente:'Cliente' })[item.location_type] || item.location_type)}</td><td>${item.active ? '<span class="badge ok">Ativo</span>' : '<span class="badge out">Inativo</span>'}</td><td>${item.location_type === 'central' ? '—' : `<button class="secondary-button" data-toggle-location="${item.id}">${item.active ? 'Desativar' : 'Reativar'}</button>`}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nenhum local cadastrado.</td></tr>';
  suppliersTable.innerHTML = state.suppliers.map(item => `<tr><td><b>${esc(item.name)}</b><small>${esc(item.email || 'Sem e-mail informado')}</small></td><td>${esc(item.cnpj || '—')}</td><td>${esc([item.contact_name, item.phone].filter(Boolean).join(' · ') || '—')}</td><td>${item.active ? '<span class="badge ok">Ativo</span>' : '<span class="badge out">Inativo</span>'}</td><td><div class="table-actions"><button class="secondary-button" data-toggle-supplier="${item.id}">${item.active ? 'Desativar' : 'Reativar'}</button><button class="danger-button" data-delete-supplier="${item.id}">Remover</button></div></td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nenhum fornecedor cadastrado.</td></tr>';
  $('#collaborator-options').innerHTML = collaborators.filter(item => item.active).map(item => `<option value="${esc(item.name)}"></option>`).join('');
  $('#vehicle-options').innerHTML = state.vehicles.filter(item => item.active).map(item => `<option value="${esc(item.name)}">${esc(item.plate || '')}</option>`).join('');
  $('#vehicle-responsible').innerHTML = '<option value="">Sem responsável definido</option>' + collaborators.filter(item => item.active).map(item => `<option value="${item.id}">${esc(item.name)}</option>`).join('');
  document.querySelectorAll('[data-edit-collaborator]').forEach(button => button.onclick = () => openCollaboratorEditor(button.dataset.editCollaborator));
  document.querySelectorAll('[data-toggle-collaborator]').forEach(button => button.onclick = () => toggleCollaborator(button.dataset.toggleCollaborator));
  document.querySelectorAll('[data-toggle-vehicle]').forEach(button => button.onclick = () => toggleVehicle(button.dataset.toggleVehicle));
  document.querySelectorAll('[data-delete-collaborator]').forEach(button => button.onclick = () => deleteCollaborator(button.dataset.deleteCollaborator));
  document.querySelectorAll('[data-delete-vehicle]').forEach(button => button.onclick = () => deleteVehicle(button.dataset.deleteVehicle));
  document.querySelectorAll('[data-toggle-location]').forEach(button => button.onclick = () => toggleLocation(button.dataset.toggleLocation));
  document.querySelectorAll('[data-toggle-supplier]').forEach(button => button.onclick = () => toggleSupplier(button.dataset.toggleSupplier));
  document.querySelectorAll('[data-delete-supplier]').forEach(button => button.onclick = () => deleteSupplier(button.dataset.deleteSupplier));
}

function openCollaboratorEditor(id) {
  if (currentUser?.role !== 'admin') return alert('Apenas administradores podem editar colaboradores.');
  const collaborator = state.collaborators.find(item => item.id === id);
  if (!collaborator) return;
  $('#edit-collaborator-id').value = collaborator.id;
  $('#edit-collaborator-name').value = collaborator.name || '';
  $('#edit-collaborator-job-title').value = collaborator.job_title || '';
  $('#edit-collaborator-department').value = collaborator.department || '';
  $('#edit-collaborator-phone').value = collaborator.phone || '';
  $('#edit-collaborator-dialog').showModal();
}

function setRegistryFilter(filter = 'collaborators') {
  const allowed = ['collaborators', 'vehicles', 'locations', 'suppliers'];
  const selected = allowed.includes(filter) ? filter : 'collaborators';
  const grid = $('#registry-grid');
  document.querySelectorAll('[data-registry-filter]').forEach(button => {
    const active = button.dataset.registryFilter === selected;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('[data-registry-section]').forEach(section => {
    const visible = section.dataset.registrySection === selected;
    section.hidden = !visible;
    section.classList.toggle('registry-filtered-section', visible);
  });
  grid.hidden = !['collaborators', 'vehicles'].includes(selected);
  grid.classList.toggle('registry-single-section', true);
  document.querySelectorAll('[data-registry-action]').forEach(button => {
    button.hidden = button.dataset.registryAction !== selected;
  });
  $('#registry-actions').hidden = !['admin', 'operador'].includes(currentUser?.role);
}

function renderSerials() {
  const table = $('#serials-table'), select = $('#serial-product');
  if (!table || !select) return;
  const selected = select.value;
  const serialProducts = activeProducts().filter(item => item.tracking_mode === 'serializado');
  select.innerHTML = serialProducts.map(item => `<option value="${item.id}">${esc(item.name)} (${esc(item.code)})</option>`).join('');
  select.value = serialProducts.some(item => item.id === selected) ? selected : serialProducts[0]?.id || '';
  const search = $('#serial-search').value;
  const serials = state.serialItems.filter(item => {
    return matchesSerialSearch(item, search);
  });
  table.innerHTML = serials.map(item => {
    const itemProduct = product(item.product_id), location = state.locations.find(entry => entry.id === item.current_location_id);
    const canManageSerial = ['admin', 'operador'].includes(currentUser?.role);
    return `<tr><td><b>${esc(itemProduct?.name || 'Item removido')}</b><small>${esc(itemProduct?.code || '—')}</small></td><td>${esc(item.serial_number || '—')}</td><td>${esc(item.mac_address || '—')}</td><td>${esc(item.asset_tag || '—')}</td><td>${esc(item.current_technician || location?.name || item.customer_name || '—')}</td><td><span class="badge ${serialStatusClass(item.status)}">${esc(serialStatusName(item.status))}</span></td><td><div class="table-actions">${item.status !== 'baixado' ? `<button class="secondary-button" data-move-serial="${item.id}">Mover</button>` : ''}${canManageSerial ? `<button class="secondary-button" data-edit-serial="${item.id}">Editar</button>` : ''}<button class="text-button" data-history-serial="${item.id}">Histórico</button><button class="danger-button" data-admin-only hidden data-delete-serial="${item.id}">Excluir</button></div></td></tr>`;
  }).join('') || '<tr><td colspan="7" class="empty">Nenhuma unidade rastreável encontrada.</td></tr>';
  const locations = state.locations.filter(item => item.active);
  $('#serial-location').innerHTML = '<option value="">Almoxarifado central</option>' + locations.map(item => `<option value="${item.id}">${esc(item.name)}</option>`).join('');
  document.querySelectorAll('[data-move-serial]').forEach(button => button.onclick = () => openSerialTransfer(button.dataset.moveSerial));
  document.querySelectorAll('[data-history-serial]').forEach(button => button.onclick = () => openSerialHistory(button.dataset.historySerial));
  document.querySelectorAll('[data-delete-serial]').forEach(button => button.onclick = () => deleteSerialItem(button.dataset.deleteSerial));
  document.querySelectorAll('[data-edit-serial]').forEach(button => button.onclick = () => openSerialEdit(button.dataset.editSerial));
}

function renderLaboratory() {
  const table = $('#laboratory-table');
  if (!table) return;
  const search = $('#lab-search').value;
  const items = state.serialItems.filter(item => {
    return isLaboratorySerial(item) && matchesSerialSearch(item, search);
  });
  const allLaboratoryItems = state.serialItems.filter(isLaboratorySerial);
  $('#lab-total').textContent = allLaboratoryItems.length;
  $('#lab-pending-total').textContent = allLaboratoryItems.filter(item => ['manutencao', 'defeito'].includes(item.status)).length;
  table.innerHTML = items.map(item => {
    const itemProduct = product(item.product_id), location = state.locations.find(entry => entry.id === item.current_location_id);
    const identifiers = [item.serial_number && `Serial: ${item.serial_number}`, item.mac_address && `MAC: ${item.mac_address}`, item.asset_tag && `Patrimônio: ${item.asset_tag}`].filter(Boolean).join(' · ');
    return `<tr><td><b>${esc(itemProduct?.name || 'Item removido')}</b><small>${esc(itemProduct?.code || '—')}</small></td><td>${esc(identifiers || 'Sem identificador')}</td><td>${esc(location?.name || 'Oficina')}</td><td><span class="badge ${serialStatusClass(item.status)}">${esc(serialStatusName(item.status))}</span></td><td><div class="table-actions"><button class="primary small-primary" data-process-laboratory="${item.id}">Processar</button><button class="text-button" data-history-serial="${item.id}">Histórico</button></div></td></tr>`;
  }).join('') || '<tr><td colspan="5" class="empty">Nenhum equipamento aguardando avaliação na oficina.</td></tr>';
  document.querySelectorAll('[data-process-laboratory]').forEach(button => button.onclick = () => openLaboratoryDialog(button.dataset.processLaboratory));
  document.querySelectorAll('[data-history-serial]').forEach(button => button.onclick = () => openSerialHistory(button.dataset.historySerial));
}

function updateLaboratoryForm() {
  const action = $('#laboratory-action').value;
  const requiresNote = ['manutencao', 'defeito', 'baixar'].includes(action);
  $('#laboratory-note').required = requiresNote;
  $('#laboratory-help').textContent = ({
    aprovar: 'O item será devolvido ao Almoxarifado Central e voltará ao saldo disponível.',
    manutencao: 'O item continuará na oficina, marcado como em manutenção.',
    defeito: 'O item continuará na oficina, marcado como defeito e fora do saldo disponível.',
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
  const canInstallAtCustomer = ['disponivel', 'com_colaborador', 'com_veiculo'].includes(item.status);
  const actions = item.status === 'disponivel'
    ? [['colaborador', 'Entregar para colaborador'], ['veiculo', 'Carregar em veículo'], ['instalar', 'Instalar no cliente'], ['laboratorio', 'Enviar à oficina'], ['baixar', 'Baixar / sucata']]
    : [ ...(canInstallAtCustomer ? [['instalar', 'Instalar no cliente']] : []), ...(item.status !== 'laboratorio' ? [['laboratorio', 'Enviar à oficina']] : []), ['retornar', 'Retornar ao almoxarifado'], ['baixar', 'Baixar / sucata'] ];
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
    instalar: 'A unidade será marcada como instalada no cliente. Ela pode sair diretamente do colaborador ou veículo, sem retornar ao almoxarifado. Informe a OS quando disponível.',
    laboratorio: 'A unidade deixará o saldo disponível e ficará na oficina.',
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
  $('#delete-serial-history').dataset.serialItemId = id;
  $('#delete-serial-item').dataset.serialItemId = id;
  const movements = state.serialMovements.filter(entry => entry.serial_item_id === id);
  $('#serial-history-title').textContent = itemProduct?.name || 'Histórico do equipamento';
  $('#serial-history-subtitle').textContent = `Serial: ${item.serial_number || '—'} · MAC: ${item.mac_address || '—'} · Patrimônio: ${item.asset_tag || '—'}`;
  $('#serial-history-list').innerHTML = movements.map(entry => {
    const from = state.locations.find(location => location.id === entry.from_location_id)?.name || '—';
    const to = state.locations.find(location => location.id === entry.to_location_id)?.name || entry.customer_name || entry.recipient || '—';
    const impact = Number(entry.stock_impact ?? (entry.previous_status === 'disponivel' && entry.new_status !== 'disponivel' ? -1 : entry.previous_status !== 'disponivel' && entry.new_status === 'disponivel' ? 1 : 0));
    const impactLabel = impact > 0 ? '+1 no estoque' : impact < 0 ? '-1 no estoque' : 'sem alteração no estoque';
    return `<div class="serial-history-item"><div><b>${esc(serialActionName(entry.action))}</b><small>${esc(serialStatusName(entry.previous_status))} → ${esc(serialStatusName(entry.new_status))} · ${date(entry.created_at)} · ${esc(impactLabel)}</small><small>${esc(from)} → ${esc(to)}${entry.work_order ? ` · OS: ${esc(entry.work_order)}` : ''}${entry.note ? ` · ${esc(entry.note)}` : ''}</small></div></div>`;
  }).join('') || '<p class="empty">Ainda não há movimentações para esta unidade.</p>';
  $('#serial-history-dialog').showModal();
}

async function deleteSerialHistory(id) {
  if (currentUser?.role !== 'admin') return alert('Apenas administradores podem apagar históricos.');
  const item = state.serialItems.find(entry => entry.id === id), itemProduct = item && product(item.product_id);
  if (!item) return;
  const identifier = item.mac_address || item.serial_number || item.asset_tag || itemProduct?.name || 'esta unidade';
  if (!confirm(`Apagar todo o histórico de ${identifier}? A unidade e seus dados atuais serão preservados. Esta ação não pode ser desfeita.`)) return;
  const { error } = await supabase.rpc('delete_serial_history', { p_serial_item_id: id });
  if (error) return alert(error.message);
  state.serialMovements = state.serialMovements.filter(entry => entry.serial_item_id !== id);
  $('#serial-history-list').innerHTML = '<p class="empty">Ainda não há movimentações para esta unidade.</p>';
  alert('Histórico apagado com sucesso.');
}

async function deleteSerialItem(id) {
  if (currentUser?.role !== 'admin') return alert('Apenas administradores podem excluir unidades.');
  const item = state.serialItems.find(entry => entry.id === id);
  if (!item) return;
  const itemProduct = product(item.product_id);
  const identifier = item.mac_address || item.serial_number || item.asset_tag || itemProduct?.name || 'esta unidade';
  if (!confirm(`Excluir definitivamente ${identifier}? Isso removerá a unidade, empréstimos e todo o histórico dela. Esta ação não pode ser desfeita.`)) return;
  const { error } = await supabase.rpc('delete_serial_item', { p_serial_item_id: id });
  if (error) return alert(error.message);
  state.serialItems = state.serialItems.filter(entry => entry.id !== id);
  state.serialMovements = state.serialMovements.filter(entry => entry.serial_item_id !== id);
  $('#serial-history-dialog').close();
  renderSerialPage();
  alert('Unidade excluída com sucesso.');
}

function openSerialEdit(id) {
  if (!['admin', 'operador'].includes(currentUser?.role)) return alert('Apenas administradores e operadores podem editar unidades.');
  const item = state.serialItems.find(entry => entry.id === id);
  if (!item) return;
  const products = activeProducts().filter(entry => entry.tracking_mode === 'serializado');
  $('#edit-serial-product').innerHTML = products.map(entry => `<option value="${entry.id}">${esc(entry.name)} (${esc(entry.code)})</option>`).join('');
  $('#edit-serial-product').value = item.product_id;
  $('#edit-serial-id').value = item.id;
  $('#edit-serial-number').value = item.serial_number || '';
  $('#edit-serial-mac').value = item.mac_address || '';
  $('#edit-serial-asset-tag').value = item.asset_tag || '';
  $('#edit-serial-notes').value = item.notes || '';
  $('#edit-serial-dialog').showModal();
}

function renderLoans() {
  const table = $('#loans-table'), loanItem = $('#loan-item');
  if (!table || !loanItem) return;
  const activeLoans = state.toolLoans.filter(loan => !loan.returned_at);
  const returnedLoans = state.toolLoans.filter(loan => loan.returned_at);
  const todayLoans = activeLoans.filter(loan => loanStatus(loan).key === 'hoje');
  const overdueLoans = activeLoans.filter(loanOverdue);
  $('#open-loan-count').textContent = activeLoans.length;
  $('#today-loan-count').textContent = todayLoans.length;
  $('#overdue-loan-count').textContent = overdueLoans.length;
  $('#returned-loan-count').textContent = returnedLoans.length;

  const technicianFilter = $('#loan-technician-filter'), equipmentFilter = $('#loan-equipment-filter');
  const selectedTechnician = technicianFilter.value, selectedEquipment = equipmentFilter.value;
  const technicianNames = [...new Set(state.toolLoans.map(loan => loan.collaborator_name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const equipmentIds = [...new Set(state.toolLoans.map(loan => state.serialItems.find(item => item.id === loan.serial_item_id)?.product_id).filter(Boolean))];
  technicianFilter.innerHTML = '<option value="">Todos os técnicos</option>' + technicianNames.map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join('');
  technicianFilter.value = technicianNames.includes(selectedTechnician) ? selectedTechnician : '';
  equipmentFilter.innerHTML = '<option value="">Todos os equipamentos</option>' + equipmentIds.map(id => `<option value="${id}">${esc(product(id)?.name || 'Equipamento')}</option>`).join('');
  equipmentFilter.value = equipmentIds.includes(selectedEquipment) ? selectedEquipment : '';

  const query = $('#loan-search').value.trim().toLowerCase(), statusFilter = $('#loan-status-filter').value;
  const from = $('#loan-period-from').value, to = $('#loan-period-to').value;
  const filteredLoans = state.toolLoans.filter(loan => {
    const item = state.serialItems.find(entry => entry.id === loan.serial_item_id), itemProduct = item && product(item.product_id), currentStatus = loanStatus(loan);
    const text = `${itemProduct?.name || ''} ${item?.asset_tag || ''} ${item?.serial_number || ''} ${loan.collaborator_name || ''}`.toLowerCase();
    const statusMatch = !statusFilter || statusFilter === 'emprestado' && !loan.returned_at || statusFilter === 'devolvido' && Boolean(loan.returned_at) || statusFilter === 'aberto' && !loan.returned_at && !['hoje', 'atrasado'].includes(currentStatus.key) || currentStatus.key === statusFilter;
    const day = loan.issued_at?.slice(0, 10) || '';
    return (!query || text.includes(query)) && statusMatch
      && (!technicianFilter.value || loan.collaborator_name === technicianFilter.value)
      && (!equipmentFilter.value || item?.product_id === equipmentFilter.value)
      && (!from || day >= from) && (!to || day <= to);
  });

  table.innerHTML = filteredLoans.map(loan => {
    const item = state.serialItems.find(entry => entry.id === loan.serial_item_id), itemProduct = item && product(item.product_id);
    const currentStatus = loanStatus(loan), issuer = loan.issued_by_name || state.users.find(user => user.id === loan.issued_by)?.name || 'Não informado';
    const returner = loan.returned_by_name || state.users.find(user => user.id === loan.returned_by)?.name || '—';
    return `<tr><td><b>${esc(itemProduct?.name || 'Item')}</b><small>Patrimônio: ${esc(item?.asset_tag || '—')} · Serial: ${esc(item?.serial_number || '—')}</small></td><td>${esc(loan.collaborator_name || '—')}</td><td>${date(loan.issued_at)}</td><td>${loan.due_at ? date(loan.due_at) : 'Prazo não informado'}</td><td>${loan.returned_at ? date(loan.returned_at) : '—'}</td><td><span class="badge ${currentStatus.badge}">${esc(currentStatus.label)}</span></td><td><small>${loan.note ? `Retirada: ${esc(loan.note)}<br>` : ''}${loan.return_note ? `Devolução: ${esc(loan.return_note)}<br>` : ''}Registrado por: ${esc(issuer)}${loan.returned_at ? `<br>Devolvido por: ${esc(returner)}` : ''}</small></td><td><div class="table-actions"><button class="text-button" data-loan-item-history="${item?.id || ''}">Histórico</button><button class="secondary-button" data-print-loan="${loan.id}">Termo</button>${!loan.returned_at ? `<button class="primary small-primary" data-return-loan="${loan.id}">Registrar devolução</button>` : ''}</div></td></tr>`;
  }).join('') || '<tr><td colspan="8" class="empty">Nenhum empréstimo encontrado para os filtros selecionados.</td></tr>';

  const loanableItems = state.serialItems.filter(item => item.status === 'disponivel' && isLoanEquipment(item));
  loanItem.innerHTML = loanableItems.map(item => {
    const itemProduct = product(item.product_id);
    return `<option value="${item.id}">${esc(itemProduct?.name || 'Item')} · Patrimônio: ${esc(item.asset_tag || 'não informado')}</option>`;
  }).join('');
  $('#loan-collaborator').innerHTML = '<option value="">Selecione</option>' + state.collaborators.filter(item => item.active).map(item => `<option value="${item.id}">${esc(item.name)}</option>`).join('');
  document.querySelectorAll('[data-return-loan]').forEach(button => button.onclick = () => openLoanReturn(button.dataset.returnLoan));
  document.querySelectorAll('[data-print-loan]').forEach(button => button.onclick = () => printLoanTerm(button.dataset.printLoan));
  document.querySelectorAll('[data-loan-item-history]').forEach(button => button.onclick = () => {
    const item = state.serialItems.find(entry => entry.id === button.dataset.loanItemHistory);
    $('#loan-search').value = item?.asset_tag || item?.serial_number || '';
    $('#loan-status-filter').value = '';
    renderLoans();
  });
  updateLoanItemDetails();
}

function setClientLoanError(message = '') {
  const error = $('#client-loan-error');
  if (!error) return;
  error.textContent = message;
  error.hidden = !message;
}

function renderClientLoanFormSummary() {
  const selected = state.serialItems.find(item => item.id === $('#client-loan-item')?.value);
  const selectedItem = $('#client-loan-selected-item');
  const summary = $('#client-loan-summary');
  const itemProduct = selected && product(selected.product_id);
  const clientName = $('#client-loan-customer-name')?.value.trim();
  const reference = $('#client-loan-reference')?.value.trim();

  if (selectedItem && selected) {
    selectedItem.innerHTML = `<div><b>${esc(itemProduct?.name || 'Equipamento')}</b><span>${esc(itemProduct?.category || 'Equipamento rastreável')}</span></div><small>MAC: ${esc(selected.mac_address || '—')} · Serial: ${esc(selected.serial_number || '—')} · Patrimônio: ${esc(selected.asset_tag || '—')}</small><span class="badge ${serialStatusClass(selected.status)}">${esc(serialStatusName(selected.status))}</span>`;
  } else if (selectedItem) {
    selectedItem.textContent = 'Localize uma unidade no almoxarifado, com técnico ou em veículo para conferir os dados.';
  }

  if (summary) {
    summary.innerHTML = selected && clientName
      ? `<h3>Resumo do comodato</h3><dl><div><dt>Equipamento</dt><dd>${esc(itemProduct?.name || 'Equipamento')}</dd></div><div><dt>Cliente</dt><dd>${esc(clientName)}</dd></div><div><dt>Identificação</dt><dd>${esc(selected.mac_address || selected.serial_number || selected.asset_tag || '—')}</dd></div><div><dt>Contrato / OS</dt><dd>${esc(reference || 'Não informado')}</dd></div></dl>`
      : '<h3>Resumo do comodato</h3><p>Selecione o equipamento e informe o cliente para revisar o registro.</p>';
  }
}
function renderClientLoans() {
  const table = $('#client-loans-table'), clientLoanItem = $('#client-loan-item'), clientLoanSearch = $('#client-loan-search');
  if (!table || !clientLoanItem) return;
  const statusOf = loan => loan.record_status || (loan.returned_at ? 'encerrado' : 'ativo');
  const activeLoans = state.clientLoans.filter(loan => statusOf(loan) === 'ativo' && !loan.returned_at);
  const returnedLoans = state.clientLoans.filter(loan => statusOf(loan) === 'encerrado' || loan.returned_at);
  const availableItems = state.serialItems.filter(item => ['disponivel', 'com_colaborador', 'com_veiculo'].includes(item.status));
  const tableSearch = $('#client-loan-list-search')?.value.trim().toLocaleLowerCase('pt-BR') || '';
  const statusFilter = $('#client-loan-status-filter')?.value || '';
  const locationFilter = $('#client-loan-location-filter')?.value || '';
  const locations = [...new Set(state.clientLoans.map(loan => loan.city || loan.location_original).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const locationSelect = $('#client-loan-location-filter');
  if (locationSelect) {
    const selected = locationSelect.value;
    locationSelect.innerHTML = '<option value="">Todas as localizações</option>' + locations.map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join('');
    locationSelect.value = selected;
  }
  const filteredLoans = state.clientLoans.filter(loan => {
    const item = state.serialItems.find(entry => entry.id === loan.serial_item_id);
    const itemProduct = item && product(item.product_id);
    if (statusFilter && statusOf(loan) !== statusFilter) return false;
    if (locationFilter && (loan.city || loan.location_original) !== locationFilter) return false;
    if (!tableSearch) return true;
    return [itemProduct?.name, itemProduct?.model, item?.mac_address, item?.serial_number, item?.asset_tag, loan.customer_name, loan.customer_reference, loan.asset_tag_original, loan.equipment_name_original, loan.model_original, loan.mac_original, loan.serial_original, loan.location_original, loan.city]
      .filter(Boolean)
      .some(value => String(value).toLocaleLowerCase('pt-BR').includes(tableSearch));
  });

  const openCount = $('#open-client-loan-count');
  const availableCount = $('#client-loan-available-count');
  const activeCount = $('#client-loan-active-count');
  const returnedCount = $('#client-loan-returned-count');
  if (openCount) openCount.textContent = activeLoans.length;
  if (availableCount) availableCount.textContent = availableItems.length;
  if (activeCount) activeCount.textContent = activeLoans.length;
  if (returnedCount) returnedCount.textContent = returnedLoans.length;

  if (state.clientLoansLoadError) {
    table.innerHTML = '<tr><td colspan="9" class="empty">O controle de comodatos ainda precisa ser ativado no banco de dados.</td></tr>';
  } else if (filteredLoans.length) {
    table.innerHTML = filteredLoans.map(loan => {
      const item = state.serialItems.find(entry => entry.id === loan.serial_item_id), itemProduct = item && product(item.product_id);
      const status = statusOf(loan);
      const statusLabel = status === 'ativo' ? 'Instalado no cliente' : status === 'encerrado' ? 'Devolvido / em estoque' : 'Pendente de análise';
      const statusClass = status === 'ativo' ? 'saida' : status === 'encerrado' ? 'entrada' : 'low';
      const customer = loan.customer_name || 'Não associado';
      const originalLocation = loan.location_original && loan.location_original !== loan.customer_name ? loan.location_original : '';
      const canReturn = status === 'ativo' && loan.serial_item_id && !loan.returned_at;
      return `<tr><td><b>${esc(item?.asset_tag || loan.asset_tag_original || '—')}</b>${loan.source_type === 'excel' ? '<small>Origem: Excel</small>' : ''}</td><td><b>${esc(itemProduct?.name || loan.equipment_name_original || 'Equipamento não informado')}</b><small>${esc(itemProduct?.model || loan.model_original || loan.brand_original || '—')}</small></td><td>${esc(item?.mac_address || loan.mac_original || '—')}</td><td>${esc(item?.serial_number || loan.serial_original || '—')}</td><td><b>${esc(customer)}</b>${originalLocation ? `<small>Original: ${esc(originalLocation)}</small>` : ''}</td><td>${esc(loan.city || '—')}</td><td>${date(loan.installed_at || loan.issued_at)}</td><td><span class="badge ${statusClass}">${statusLabel}</span>${loan.match_status && loan.match_status !== 'associado' ? `<small>${esc(loan.match_status === 'ambiguo' ? 'Associação ambígua' : 'Sem associação automática')}</small>` : ''}</td><td><div class="table-actions">${canReturn ? `<button class="primary small-primary" data-return-client-loan="${loan.id}">Devolver</button>` : ''}<button class="danger-button" data-admin-only hidden data-delete-client-loan="${loan.id}">Excluir</button></div></td></tr>`;
    }).join('');
  } else if (tableSearch || statusFilter || locationFilter) {
    table.innerHTML = '<tr><td colspan="9" class="empty">Nenhum comodato corresponde aos filtros.</td></tr>';
  } else {
    table.innerHTML = '<tr><td colspan="9" class="empty client-loans-empty"><div><span class="client-loans-empty-icon" aria-hidden="true">⌁</span><strong>Nenhum comodato registrado</strong><p>Instalações com MAC ou serial e importações confirmadas aparecerão aqui.</p></div></td></tr>';
  }

  const selectedItem = clientLoanItem.value;
  const search = clientLoanSearch?.value || '';
  const normalizedSearch = normalizedScanCode(search);
  const loanableItems = availableItems.filter(item => search && matchesSerialIdentifier(item, search));
  const placeholder = !search
    ? 'Digite ou leia MAC, serial ou patrimônio acima'
    : loanableItems.length
      ? 'Selecione a unidade encontrada'
      : 'Nenhuma unidade apta para comodato encontrada';
  clientLoanItem.innerHTML = `<option value="">${placeholder}</option>` + loanableItems.map(item => {
    const itemProduct = product(item.product_id);
    return `<option value="${item.id}">${esc(itemProduct?.name || 'Equipamento')} · MAC: ${esc(item.mac_address || '—')} · Serial: ${esc(item.serial_number || '—')} · Patrimônio: ${esc(item.asset_tag || '—')}</option>`;
  }).join('');
  const exactMatch = normalizedSearch && loanableItems.find(item => serialIdentifiers(item).some(value => normalizedScanCode(value) === normalizedSearch));
  if (exactMatch) clientLoanItem.value = exactMatch.id;
  else if (loanableItems.some(item => item.id === selectedItem)) clientLoanItem.value = selectedItem;
  renderClientLoanFormSummary();
  document.querySelectorAll('[data-return-client-loan]').forEach(button => button.onclick = () => openClientLoanReturn(button.dataset.returnClientLoan));
  document.querySelectorAll('[data-delete-client-loan]').forEach(button => button.onclick = () => deleteClientLoan(button.dataset.deleteClientLoan));
  document.querySelectorAll('[data-open-client-loan]').forEach(button => button.onclick = () => $('#add-client-loan')?.click());
  document.querySelectorAll('[data-delete-client-loan]').forEach(button => { button.hidden = currentUser?.role !== 'admin'; });
}

async function deleteClientLoan(id) {
  if (currentUser?.role !== 'admin') return alert('Apenas administradores podem excluir comodatos.');
  const loan = state.clientLoans.find(item => item.id === id);
  if (!loan) return;
  const serialItem = state.serialItems.find(item => item.id === loan.serial_item_id);
  const identifier = serialItem?.asset_tag || loan.asset_tag_original || serialItem?.mac_address || loan.mac_original || serialItem?.serial_number || loan.serial_original || 'sem identificação';
  if (!confirm(`Excluir definitivamente o comodato ${identifier}?\n\nO registro e o histórico deste comodato serão apagados. O equipamento, o estoque e o histórico de movimentações não serão alterados.`)) return;
  const { error } = await supabase.rpc('delete_client_loan', { p_loan_id: id });
  if (error) return alert(error.message);
  await load();
  view('client-loans');
}

const excelOriginalValue = value => {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
};

async function prepareClientLoanExcelImport(file) {
  if (!file?.name?.toLowerCase().endsWith('.xlsx')) throw new Error('Selecione o arquivo Excel no formato .xlsx.');
  const rows = await readXlsxSheet(file, 'Planilha');
  if (!Array.isArray(rows) || rows.length < 4) throw new Error('A aba “Planilha” não contém registros para importar.');
  const header = rows[2].slice(0, 12).map(value => String(value || '').trim().toLocaleLowerCase('pt-BR'));
  if (!header[0].includes('pib') || !header[1].includes('descrição') || !header[4].includes('série') || !header[11].includes('localização')) {
    throw new Error('A estrutura da aba “Planilha” não corresponde ao arquivo Controle de bens analisado.');
  }
  const payload = rows.slice(3).map((row, index) => ({
    source_row: index + 4,
    asset_tag: typeof row[0] === 'number' ? String(row[0]).padStart(4, '0') : excelOriginalValue(row[0]),
    equipment_name: excelOriginalValue(row[1]),
    brand: excelOriginalValue(row[2]),
    invoice_number: excelOriginalValue(row[3]),
    serial: excelOriginalValue(row[4]),
    purchase_date: excelOriginalValue(row[5]),
    implementation_date: excelOriginalValue(row[6]),
    value: excelOriginalValue(row[7]),
    supplier: excelOriginalValue(row[8]),
    asset_condition: excelOriginalValue(row[9]),
    situation: excelOriginalValue(row[10]),
    location: excelOriginalValue(row[11]),
    model: null,
    mac: null,
    city: null
  })).filter(row => Object.entries(row).some(([key, value]) => key !== 'source_row' && value != null && value !== ''));
  const assetCounts = new Map();
  const serialCounts = new Map();
  payload.forEach(row => {
    if (row.asset_tag) assetCounts.set(normalizedScanCode(row.asset_tag), (assetCounts.get(normalizedScanCode(row.asset_tag)) || 0) + 1);
    if (row.serial) serialCounts.set(normalizedScanCode(row.serial), (serialCounts.get(normalizedScanCode(row.serial)) || 0) + 1);
  });
  const duplicateAssets = [...assetCounts.values()].filter(count => count > 1).length;
  const duplicateSerials = [...serialCounts.values()].filter(count => count > 1).length;
  payload.forEach(row => {
    const repeatedAsset = row.asset_tag && (assetCounts.get(normalizedScanCode(row.asset_tag)) || 0) > 1;
    const repeatedSerial = row.serial && (serialCounts.get(normalizedScanCode(row.serial)) || 0) > 1;
    row.duplicate_identifier = Boolean(repeatedAsset || repeatedSerial);
  });
  state.clientLoanImport = { fileName: file.name, sheet: 'Planilha', rows: payload };
  $('#client-loan-import-summary').innerHTML = `<b>${payload.length.toLocaleString('pt-BR')} linhas prontas para importação aditiva.</b><br>As colunas PIB, descrição, marca, série e localização serão preservadas como vieram do Excel. O arquivo não contém MAC nem cidade; esses campos ficarão vazios, sem suposição.`;
  const warnings = $('#client-loan-import-warnings');
  warnings.hidden = false;
  warnings.textContent = `${duplicateAssets} grupos de patrimônio e ${duplicateSerials} grupos de serial repetidos serão mantidos, identificados e enviados para análise. “Localização” não será convertida automaticamente em cliente.`;
  $('#client-loan-import-dialog').showModal();
}

async function importClientLoanExcelRows() {
  const pending = state.clientLoanImport;
  if (!pending) throw new Error('Selecione novamente a planilha.');
  const submit = $('#client-loan-import-form button[type="submit"]');
  submit.disabled = true;
  const totals = { importados: 0, ignorados: 0, associados: 0, ambiguos: 0 };
  try {
    for (let index = 0; index < pending.rows.length; index += 200) {
      const { data, error } = await supabase.rpc('import_client_loans_from_excel', {
        p_source_file: pending.fileName,
        p_source_sheet: pending.sheet,
        p_rows: pending.rows.slice(index, index + 200)
      });
      if (error) throw error;
      Object.keys(totals).forEach(key => { totals[key] += Number(data?.[key] || 0); });
    }
    $('#client-loan-import-dialog').close();
    state.clientLoanImport = null;
    await load();
    view('client-loans');
    alert(`Importação concluída com segurança. Importados: ${totals.importados}. Já existentes ignorados: ${totals.ignorados}. Associados: ${totals.associados}. Ambíguos: ${totals.ambiguos}.`);
  } finally {
    submit.disabled = false;
  }
}

function updateLoanItemDetails() {
  const item = state.serialItems.find(entry => entry.id === $('#loan-item')?.value), itemProduct = item && product(item.product_id);
  const details = $('#loan-item-details');
  if (!details) return;
  details.innerHTML = item
    ? `<b>${esc(itemProduct?.name || 'Equipamento')}</b><span>Patrimônio: ${esc(item.asset_tag || 'Não informado')} · Serial: ${esc(item.serial_number || '—')}</span>`
    : '<span>Nenhum equipamento patrimonial disponível.</span>';
}

function localDateTimeInputValue(value = new Date()) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '';
  const target = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60000);
  return target.toISOString().slice(0, 16);
}

function openLoanReturn(id) {
  const loan = state.toolLoans.find(item => item.id === id), serialItem = loan && state.serialItems.find(item => item.id === loan.serial_item_id), itemProduct = serialItem && product(serialItem.product_id);
  if (!loan) return;
  $('#return-loan-form').reset();
  $('#return-loan-id').value = loan.id;
  $('#return-loan-item').innerHTML = `<b>${esc(itemProduct?.name || 'Ferramenta')}</b><span>Responsável: ${esc(loan.collaborator_name || '—')} · Serial: ${esc(serialItem?.serial_number || '—')}</span>`;
  $('#return-loan-dialog').showModal();
}

function openClientLoanReturn(id) {
  const loan = state.clientLoans.find(item => item.id === id), serialItem = loan && state.serialItems.find(item => item.id === loan.serial_item_id), itemProduct = serialItem && product(serialItem.product_id);
  if (!loan) return;
  $('#return-client-loan-form').reset();
  $('#return-client-loan-id').value = loan.id;
  $('#return-client-loan-item').innerHTML = `<b>${esc(itemProduct?.name || 'Equipamento')}</b><span>Cliente: ${esc(loan.customer_name)} · MAC: ${esc(serialItem?.mac_address || '—')} · Serial: ${esc(serialItem?.serial_number || '—')}</span>`;
  $('#return-client-loan-dialog').showModal();
}

function printLoanTerm(id) {
  const loan = state.toolLoans.find(item => item.id === id);
  const serialItem = loan && state.serialItems.find(item => item.id === loan.serial_item_id);
  const itemProduct = serialItem && product(serialItem.product_id);
  if (!loan) return;
  const responsible = loan.collaborator_name || state.collaborators.find(item => item.id === loan.collaborator_id)?.name || 'Não informado';
  const shortDate = value => value ? new Date(value).toLocaleDateString('pt-BR') : 'Sem prazo definido';
  const due = loan.loan_type === 'temporario' ? shortDate(loan.due_at) : 'Sem prazo definido';
  const assetId = serialItem?.asset_tag || serialItem?.serial_number || serialItem?.mac_address || itemProduct?.code || '—';
  const itemValue = Number(itemProduct?.average_cost || 0) > 0 ? currency(itemProduct.average_cost) : '—';
  const termWindow = window.open('', '_blank', 'width=900,height=1000');
  if (!termWindow) return alert('Não foi possível abrir o termo. Verifique se o navegador bloqueou a nova janela.');
  termWindow.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8" /><title>Termo de Empréstimo - Digitus Net</title><style>@page{size:A4;margin:0}*{box-sizing:border-box}body{margin:0;background:#eef2f5;color:#111;font-family:Arial,sans-serif}.sheet{width:210mm;min-height:297mm;margin:12px auto;padding:16mm 15mm 14mm;background:#fff;box-shadow:0 3px 16px #0002}.letterhead{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding-bottom:11mm}.brand{display:flex;align-items:center;gap:8px}.brand img{width:43px;height:43px;object-fit:contain}.brand-name{font-size:31px;font-weight:800;line-height:.78;letter-spacing:-2px;color:#d87733}.brand-name b{color:#29668a;font-size:19px;letter-spacing:-1px}.brand-name small{display:block;margin:7px 0 0 4px;color:#6b7882;font-size:10px;font-weight:400;letter-spacing:1px}.contact{padding-right:10px;border-right:3px solid #d87733;color:#486586;text-align:right;font-size:10.5px;line-height:1.35}.contact strong{font-size:13px}.title{margin:11mm 0 15mm;text-align:center;font-size:22px}.intro{margin:0;font-size:12.3px;line-height:1.55;text-align:justify}.intro b{font-weight:700}.loan-meta{margin:5mm 0 5mm;font-size:10.5px;line-height:1.5}.loan-meta b{color:#152f4c}.assets{width:100%;margin-top:6mm;border-collapse:collapse;font-size:11px}.assets th,.assets td{border:1px solid #111;padding:7px 8px}.assets .table-title{padding:4px;background:#ffd7b7;text-align:center;font-size:14px}.assets th{background:#ffd7b7;font-size:12px}.assets th:first-child,.assets td:first-child{width:18%;text-align:center}.assets th:last-child,.assets td:last-child{width:18%;text-align:center}.assets td{height:27px}.date-line{margin:13mm 0 22mm;font-size:13px}.signatures{display:grid;grid-template-columns:1fr;gap:20mm;max-width:115mm;margin:0 auto}.signature{padding-top:3px;border-top:1px solid #111;text-align:left;font-size:12px}.signature span{display:block;margin-top:5px}.signature small{display:block;margin-top:5px;font-size:10px}.footer{margin-top:29mm;border-bottom:5px solid #6d91bd;color:#476e9d;font-size:13px;font-weight:700;text-align:right}.print{display:block;margin:18px auto;padding:9px 15px;border:0;border-radius:4px;background:#29668a;color:#fff;font-weight:700;cursor:pointer}@media print{body{background:#fff}.sheet{margin:0;box-shadow:none}.print{display:none}}</style></head><body><main class="sheet"><header class="letterhead"><div class="brand"><img src="/digitus-logo.png" alt="Digitus Net" /><div class="brand-name">digitus<b>net</b><small>telecom</small></div></div><div class="contact">Rua Cônego Serrão, 19 - Sala 201 - 2º andar<br />CEP: 58735-000 - Teixeira - Paraíba<br /><strong>(83) 3472-2517 / 0800 083 2517</strong><br />contato@digitusnet.com.br</div></header><h1 class="title">Termo de Empréstimo</h1><p class="intro">Ao assinar este documento declaro que recebi o bem descrito abaixo e assumo inteira responsabilidade pela sua guarda, conservação e devolução ao almoxarifado nas condições em que foi entregue. Em caso de perda, avaria, adulteração ou não devolução, comprometo-me a comunicar imediatamente a Digitus Net para que seja feita a devida avaliação.</p><p class="loan-meta"><b>Responsável:</b> ${esc(responsible)} &nbsp; | &nbsp; <b>Tipo:</b> ${esc(loanTypeName(loan.loan_type))}<br /><b>Data da retirada:</b> ${shortDate(loan.issued_at)} &nbsp; | &nbsp; <b>Devolução prevista:</b> ${esc(due)}${loan.note ? `<br /><b>Observação:</b> ${esc(loan.note)}` : ''}</p><table class="assets"><thead><tr><th class="table-title" colspan="3">BENS EMPRESTADOS</th></tr><tr><th>PIB</th><th>DESCRIÇÃO</th><th>VALOR</th></tr></thead><tbody><tr><td>${esc(assetId)}</td><td>${esc(itemProduct?.name || 'Item emprestado')}</td><td>${esc(itemValue)}</td></tr><tr><td></td><td></td><td></td></tr></tbody></table><p class="date-line">Teixeira-PB, ${new Date().toLocaleDateString('pt-BR')}.</p><section class="signatures"><div class="signature"><span>RESPONSÁVEL: ${esc(responsible)}</span><small>Documento/CPF: __________________________________________</small></div><div class="signature"><span>ALMOXARIFE</span><small>Digitus Net Telecom</small></div></section><footer class="footer">www.digitusnet.com.br</footer><button class="print" onclick="window.print()">Imprimir termo</button></main></body></html>`);
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
  $('#inventory-history-table').innerHTML = history.map(item => `<tr><td><b>${esc(item.title)}</b><small>${esc(item.final_note || 'Sem observação')}</small></td><td>${esc(item.category || 'Todo o almoxarifado')}</td><td>${date(item.started_at)}</td><td>${item.closed_at ? date(item.closed_at) : '—'}</td><td><span class="badge ok">Finalizado</span></td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nenhuma conferência finalizada ainda.</td></tr>';
}

async function saveInventoryCounts(silent = false) {
  const session = activeInventory();
  if (!session) throw new Error('Não há conferência em aberto.');
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
    if (!confirm('Finalizar a conferência? Os ajustes serão registrados como movimentações e não poderão ser desfeitos por esta tela.')) return;
    const { error } = await supabase.rpc('finish_inventory', { p_inventory_id: session.id, p_final_note: note || null });
    if (error) throw error;
    $('#inventory-final-note').value = '';
    await load();
    alert('Conferência finalizada e estoque ajustado com sucesso.');
  } catch (error) {
    alert(error.message);
  }
}

function renderUsers() {
  const table = $('#users-table');
  if (!table) return;
  const note = $('#users-load-note');
  note.hidden = !state.usersLoadNote;
  note.textContent = state.usersLoadNote;
  table.innerHTML = state.users.map(user => `<tr><td><b>${esc(user.name || 'Sem nome')}</b></td><td>${esc(user.email)}</td><td><span class="badge ok">${roleName(user.role)}</span></td><td>${user.active ? '<span class="badge ok">Ativo</span>' : '<span class="badge out">Desativado</span>'}</td><td>${user.id === currentUser?.id ? '—' : `<button class="danger-button" data-delete-user="${user.id}">Remover</button>`}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nenhum usuário cadastrado.</td></tr>';
  document.querySelectorAll('[data-delete-user]').forEach(button => button.onclick = () => deleteUser(button.dataset.deleteUser));
}

async function loadUsers() {
  if (currentUser?.role !== 'admin') return;
  const data = await invokeAdminFunction('admin-users', 'GET');
  state.users = Array.isArray(data) ? data : (data.users || []);
  state.usersLoadNote = '';
}

async function load() {
  const [products, movements, collaborators, vehicles, locations, suppliers, serialItems, serialMovements, toolLoans, clientLoans, receipts, receiptItems, inventorySessions, inventoryCounts, reminders, materialRequests, technicianPendencies, technicianPendingEvents, technicianPendingItems] = await Promise.all([
    supabase.from('products').select('*').order('name'),
    supabase.from('movements').select('*').order('created_at', { ascending: false }),
    supabase.from('collaborators').select('*').order('name'),
    supabase.from('vehicles').select('*').order('name'),
    supabase.from('stock_locations').select('*').order('name'),
    supabase.from('suppliers').select('*').order('name'),
    supabase.from('serial_items').select('*').order('created_at', { ascending: false }),
    supabase.from('serial_movements').select('*').order('created_at', { ascending: false }),
    supabase.from('tool_loans').select('*').order('issued_at', { ascending: false }),
    supabase.from('client_loans').select('*').order('issued_at', { ascending: false }),
    supabase.from('receipts').select('*').order('received_at', { ascending: false }),
    supabase.from('receipt_items').select('*').order('created_at', { ascending: false }),
    supabase.from('inventory_sessions').select('*').order('started_at', { ascending: false }),
    supabase.from('inventory_counts').select('*').order('created_at', { ascending: false }),
    supabase.from('dashboard_reminders').select('*').order('due_date'),
    supabase.from('material_requests').select('*').order('created_at', { ascending: false }),
    supabase.from('technician_pendencies').select('*').order('withdrawn_at', { ascending: false }),
    supabase.from('technician_pending_events').select('*').order('created_at', { ascending: false }),
    supabase.from('technician_pending_items').select('*')
  ]);
  if (products.error || movements.error || collaborators.error || vehicles.error || locations.error || suppliers.error || serialItems.error || serialMovements.error || toolLoans.error || receipts.error || receiptItems.error || inventorySessions.error || inventoryCounts.error) throw products.error || movements.error || collaborators.error || vehicles.error || locations.error || suppliers.error || serialItems.error || serialMovements.error || toolLoans.error || receipts.error || receiptItems.error || inventorySessions.error || inventoryCounts.error;
  state.products = products.data.map(item => ({ ...item, minimum: item.minimum_stock }));
  state.movements = movements.data.map(item => ({ id:item.id, type:item.movement_type, productId:item.product_id, quantity:item.quantity, person:item.recipient, holderType:item.holder_type || 'cliente', workOrder:item.work_order, fieldUsage:item.field_usage || false, stockImpact:item.stock_impact, stockBefore:item.stock_before, stockAfter:item.stock_after, pendingId:item.pending_id, note:item.note, createdAt:item.created_at, date:date(item.created_at) }));
  state.collaborators = collaborators.data;
  state.vehicles = vehicles.data;
  state.locations = locations.data;
  state.suppliers = suppliers.data;
  state.serialItems = serialItems.data;
  state.serialMovements = serialMovements.data;
  state.toolLoans = toolLoans.data;
  state.clientLoans = clientLoans.error ? [] : clientLoans.data;
  state.clientLoansLoadError = clientLoans.error ? clientLoans.error.message : '';
  state.receipts = receipts.data;
  state.receiptItems = receiptItems.data;
  state.inventorySessions = inventorySessions.data;
  state.inventoryCounts = inventoryCounts.data;
  state.reminders = reminders.error ? [] : reminders.data;
  state.materialRequests = materialRequests.error ? [] : materialRequests.data;
  state.technicianPendencies = technicianPendencies.error ? [] : technicianPendencies.data;
  state.technicianPendingEvents = technicianPendingEvents.error ? [] : technicianPendingEvents.data;
  state.technicianPendingItems = technicianPendingItems.error ? [] : technicianPendingItems.data;
  state.technicianPendenciesLoadError = technicianPendencies.error || technicianPendingItems.error ? (technicianPendencies.error || technicianPendingItems.error).message : '';
  try {
    await loadUsers();
  } catch (error) {
    console.warn('Não foi possível carregar a lista de usuários:', error.message);
    state.users = [];
    state.usersLoadNote = `Não foi possível carregar os usuários: ${error.message}`;
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
  if (!item || !confirm(`Remover o produto “${item.name}”? Se ele tiver histórico, será arquivado para preservar os registros.`)) return;
  try {
    const data = await invokeAdminFunction('admin-products', 'DELETE', { id });
    await load();
    alert(data.action === 'archived' ? 'Produto arquivado. O histórico foi preservado.' : 'Produto removido.');
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
    await invokeAdminFunction('admin-users', 'DELETE', { id });
    await loadUsers(); renderUsers();
  } catch (error) {
    alert(error.message);
  }
}

function view(id, options = {}) {
  const { rememberReturn = true } = options;
  if (['users', 'statement'].includes(id) && currentUser?.role !== 'admin') id = 'dashboard';
  const activeView = document.querySelector('.view.active')?.id;
  if (rememberReturn && id !== 'dashboard' && activeView !== id) {
    window.history.pushState({ digitusReturn: 'dashboard' }, '', window.location.href);
  }
  document.querySelectorAll('.view').forEach(element => element.classList.toggle('active', element.id === id));
  document.querySelectorAll('.nav-link').forEach(button => button.classList.toggle('active', button.dataset.view === id));
  document.querySelector('main').classList.toggle('dashboard-mode', id === 'dashboard');
  $('#page-title').textContent = ({ dashboard:'Visão geral', products:'Produtos', epis:'Controle de EPIs', movement:'Movimentações', receipts:'Recebimentos', serials:'Serial / MAC', laboratory:'Oficina', loans:'Empréstimos', 'client-loans':'Comodatos', inventory:'Conferência de estoque', registry:'Cadastros', users:'Usuários', statement:'Extrato financeiro' })[id];
}

document.querySelector('main').classList.add('dashboard-mode');
window.addEventListener('popstate', () => view('dashboard', { rememberReturn: false }));

function showProducts(filter = 'all') {
  state.productFilter = filter;
  $('#product-search').value = '';
  $('#product-category-filter').value = '';
  $('#product-status-filter').value = filter === 'low' ? 'low' : '';
  view('products');
  renderProducts();
}

function showEpis(filter = 'all') {
  $('#epi-status-filter').value = filter === 'ca' ? 'ca' : filter === 'expired' ? 'expired' : '';
  view('epis');
  renderEpis();
}

function ensureEpiCategory(select) {
  if (![...select.options].some(option => option.value === 'EPI')) {
    const option = new Option('EPI', 'EPI');
    option.dataset.temporaryEpiOption = 'true';
    select.add(option);
  }
}

function removeTemporaryEpiCategory(select) {
  select.querySelector('option[data-temporary-epi-option="true"]')?.remove();
}

function setProductDialogEpiMode(prefix, epiMode) {
  const form = $(`#${prefix === 'new' ? 'product' : 'edit-product'}-form`);
  const title = $(`#${prefix === 'new' ? 'product' : 'edit-product'}-dialog-title`);
  const category = $(`#${prefix}-category`);
  const caFields = $(`#${prefix}-epi-ca-fields`);
  form.classList.toggle('epi-mode', epiMode);
  caFields.hidden = !epiMode;
  if (epiMode) {
    ensureEpiCategory(category);
    category.value = 'EPI';
    $(`#${prefix}-requires-ca`).value = 'true';
    $(`#${prefix}-unit`).value = 'unidade';
    $(`#${prefix}-tracking`).value = 'quantidade';
    $(`#${prefix}-ca-number`).required = true;
    $(`#${prefix}-ca-expiry`).required = true;
  } else {
    removeTemporaryEpiCategory(category);
    $(`#${prefix}-ca-number`).required = false;
    $(`#${prefix}-ca-expiry`).required = false;
  }
  if (title) title.textContent = epiMode ? (prefix === 'new' ? 'Cadastrar EPI' : 'Editar EPI') : (prefix === 'new' ? 'Cadastrar item' : 'Editar item');
  $(`#${prefix}-name-label`).textContent = epiMode ? 'Nome do EPI' : 'Nome do item';
  if (prefix === 'new') {
    $('#product-dialog-description').textContent = epiMode
      ? 'Informe apenas os dados necessários para identificar e controlar o EPI.'
      : 'Cadastre consumíveis, equipamentos, ferramentas ou patrimônios.';
  }
}

function openNewProductDialog(epiMode = false) {
  $('#product-form').reset();
  setProductImagePreview('new');
  setProductDialogEpiMode('new', epiMode);
  $('#product-dialog').showModal();
}

function openEpiDelivery(id) {
  const item = product(id);
  if (!item || !isEpiProduct(item)) return;
  view('movement');
  renderMovement();
  $('#movement-type').value = 'saida';
  $('#movement-holder-type').value = 'tecnico';
  $('#movement-product').value = item.id;
  updateMovementMode();
  $('#movement-person').focus();
}

function openProductEditor(id) {
  const item = product(id);
  if (!item) return;
  editingProductImagePath = item.image_path || null;
  $('#edit-product-form').reset();
  setProductDialogEpiMode('edit', isEpiProduct(item));
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
  $('#edit-average-cost').value = Number(item.average_cost || 0).toFixed(2);
  updateEditStockControl(item.tracking_mode || 'quantidade');
  $('#edit-remove-image').dataset.removed = 'false';
  setProductImagePreview('edit', editingProductImagePath, true);
  $('#edit-product-dialog').showModal();
}

function updateEditStockControl(trackingMode = $('#edit-tracking').value) {
  const serializado = trackingMode === 'serializado';
  $('#edit-stock-help').textContent = serializado
    ? 'Este saldo é o total físico do item, inclusive unidades que ainda não possuem Serial/MAC cadastrado. Ao registrar um MAC que já está neste total, desmarque a opção para não somar novamente.'
    : 'Use este campo para corrigir o saldo físico do item quando necessário.';
}

function setSelectValue(selector, value) {
  const select = $(selector);
  if (![...select.options].some(option => option.value === value)) select.add(new Option(value, value));
  select.value = value;
}

async function start(session) {
  const { data: profile } = await supabase.from('profiles').select('full_name, role').eq('id', session.user.id).maybeSingle();
  currentUser = { id: session.user.id, email: session.user.email, name: profile?.full_name || '', role: profile?.role || 'tecnico' };
  const isAdmin = currentUser.role === 'admin';
  const canManage = ['admin', 'operador'].includes(currentUser.role);
  document.querySelectorAll('[data-admin-only]').forEach(element => { element.hidden = !isAdmin; });
  document.querySelectorAll('[data-manager-only]').forEach(element => { element.hidden = !canManage; });
  // As telas continuam acessíveis no computador compartilhado do almoxarifado.
  // As ações administrativas ainda obedecem às permissões dos botões e do banco.
  ['users', 'receipts', 'serials', 'laboratory', 'loans', 'client-loans', 'inventory', 'registry', 'epis'].forEach(id => { $("#" + id).hidden = false; });
  $('#users').hidden = !isAdmin;
  $('#statement').hidden = !isAdmin;
  $('#add-user').hidden = !isAdmin;
  document.querySelectorAll('[data-view="users"]').forEach(button => { button.hidden = !isAdmin; });
  document.querySelectorAll('[data-view="statement"]').forEach(button => { button.hidden = !isAdmin; });
  setRegistryFilter(document.querySelector('[data-registry-filter].active')?.dataset.registryFilter || 'collaborators');
  renderAccountMenu();
  if (isAdmin) {
    renderDashboardStockValue([], true);
    void preloadDashboardStockValue();
  }
  try { await load(); } catch (error) { alert(error.message); }
}

document.querySelectorAll('.nav-link').forEach(button => button.onclick = () => button.dataset.view === 'products' ? showProducts() : button.dataset.view === 'epis' ? showEpis() : view(button.dataset.view));
document.querySelectorAll('[data-go]').forEach(button => button.onclick = () => button.dataset.go === 'products' ? showProducts() : button.dataset.go === 'epis' ? showEpis() : button.dataset.go === 'epis-expired' ? showEpis('expired') : view(button.dataset.go));
document.querySelectorAll('[data-registry-filter]').forEach(button => button.onclick = () => setRegistryFilter(button.dataset.registryFilter));
setRegistryFilter('collaborators');
$('#add-product').onclick = () => openNewProductDialog(false);
$('#add-epi').onclick = () => openNewProductDialog(true);
$('#import-products').onclick = openProductImport;
$('#product-import-file').onchange = readProductSpreadsheet;
$('#confirm-product-import').onclick = confirmProductImport;
$('#serial-import-file').onchange = readSerialSpreadsheet;
$('#confirm-serial-import').onclick = confirmSerialImport;
$('#scan-product-code').onclick = () => openCodeScanner('products');
$('#scan-movement-code').onclick = () => openCodeScanner('movement');
$('#scanner-use-camera').onclick = startCameraCodeScanner;
$('#add-receipt').onclick = openReceiptDialog;
$('#import-xml').onclick = openXmlImportDialog;
$('#add-receipt-line').onclick = () => addReceiptLine();
$('#add-user').onclick = () => $('#user-dialog').showModal();
$('#import-serials').onclick = openSerialImport;
$('#add-serial').onclick = () => {
  if (!state.products.some(item => item.tracking_mode === 'serializado')) return alert('Cadastre ou edite um item e escolha o controle “Por serial / MAC” antes de registrar uma unidade.');
  $('#serial-dialog').showModal();
};
$('#add-loan').onclick = () => {
  if (!state.serialItems.some(item => item.status === 'disponivel' && isLoanEquipment(item))) return alert('Cadastre uma ferramenta ou equipamento patrimonial disponível antes de registrar um empréstimo.');
  $('#loan-form').reset();
  renderLoans();
  const now = new Date(), defaultDue = new Date(now.getTime() + 14 * 60 * 60 * 1000);
  $('#loan-issued-at').value = localDateTimeInputValue(now);
  $('#loan-issued-at').readOnly = currentUser?.role !== 'admin';
  $('#loan-due').value = localDateTimeInputValue(defaultDue);
  updateLoanItemDetails();
  $('#loan-dialog').showModal();
};
$('#add-client-loan').onclick = () => {
  if (state.clientLoansLoadError) return alert('O controle de comodatos ainda não foi ativado no banco de dados. Execute o arquivo client-equipment-loans.sql no SQL Editor do Supabase.');
  if (!state.serialItems.some(item => item.status === 'disponivel')) return alert('Cadastre uma ONU, roteador ou outra unidade rastreável disponível antes de registrar um comodato.');
  $('#client-loan-form').reset();
  setClientLoanError('');
  const issuedAt = $('#client-loan-issued-at');
  if (issuedAt) issuedAt.value = new Date().toISOString().slice(0, 10);
  renderClientLoans();
  renderClientLoanFormSummary();
  $('#client-loan-dialog').showModal();
  $('#client-loan-search')?.focus();
};
$('#import-client-loans').onclick = () => $('#client-loans-file').click();
$('#client-loans-file').onchange = async event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  try { await prepareClientLoanExcelImport(file); } catch (error) { alert(error.message); }
};
$('#start-inventory').onclick = () => {
  if (activeInventory()) return alert('Já existe uma conferência em aberto. Finalize-a antes de iniciar outra.');
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
$('#add-dashboard-reminder').onclick = () => $('#reminder-dialog').showModal();
if ($('#add-material-request')) $('#add-material-request').onclick = () => $('#material-request-dialog').showModal();
$('#technician-pending-action').onchange = updateTechnicianPendingAction;
$('#technician-pending-form').onsubmit = submitTechnicianPending;
$('#delete-serial-history').onclick = () => deleteSerialHistory($('#delete-serial-history').dataset.serialItemId);
$('#delete-serial-item').onclick = () => deleteSerialItem($('#delete-serial-item').dataset.serialItemId);
async function logout() {
  if (!confirm('Deseja sair da conta?')) return;
  const { error } = await supabase.auth.signOut();
  if (error) return alert(error.message);
  setAccountMenu(false);
  currentUser = null;
  state = { products: [], movements: [], users: [], usersLoadNote: '', collaborators: [], vehicles: [], locations: [], suppliers: [], serialItems: [], serialMovements: [], toolLoans: [], clientLoans: [], clientLoansLoadError: '', receipts: [], receiptItems: [], inventorySessions: [], inventoryCounts: [], reminders: [], materialRequests: [], technicianPendencies: [], technicianPendingEvents: [], technicianPendingItems: [], technicianPendenciesLoadError: '', productFilter: 'all', clientLoanImport: null };
  $('#login-form').reset();
  $('#auth-gate').hidden = false;
}

$('#account-button').onclick = event => {
  event.stopPropagation();
  setAccountMenu($('#account-popover').hidden);
  setNotificationsOpen(false);
};
$('#notifications-button').onclick = event => {
  event.stopPropagation();
  setNotificationsOpen($('#notifications-popover').hidden);
  setAccountMenu(false);
};
$('#change-account-avatar').onclick = () => $('#account-avatar-input').click();
$('#account-avatar-input').onchange = event => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 1024 * 1024) {
    event.target.value = '';
    return alert('Escolha uma imagem JPG, PNG ou WebP de até 1 MB.');
  }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      localStorage.setItem(accountAvatarKey(), String(reader.result));
      renderAccountMenu();
    } catch {
      alert('Não foi possível salvar este ícone neste navegador. Escolha uma imagem menor.');
    }
  };
  reader.readAsDataURL(file);
  event.target.value = '';
};
$('#account-logout').onclick = logout;
document.addEventListener('click', event => {
  const account = $('.account-menu-wrap');
  if (account && !account.contains(event.target)) setAccountMenu(false);
  const notifications = $('.notifications-wrap');
  if (notifications && !notifications.contains(event.target)) setNotificationsOpen(false);
});

// Leitores USB se comportam como teclado e normalmente enviam caracteres em
// intervalos muito curtos, seguidos de Enter. O valor continua no campo, mas
// somente esse Enter automático é suprimido; um Enter manual posterior funciona.
const scannerTyping = { target:null, count:0, firstAt:0, lastAt:0, resetTimer:null };
document.addEventListener('keydown', event => {
  const target = event.target;
  const acceptsText = target instanceof HTMLInputElement && !['button','submit','checkbox','radio','date','datetime-local','number','password','file'].includes(target.type) || target instanceof HTMLTextAreaElement;
  if (!acceptsText) return;
  const now = performance.now();
  if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
    if (scannerTyping.target !== target || now - scannerTyping.lastAt > 120) {
      scannerTyping.target = target; scannerTyping.count = 0; scannerTyping.firstAt = now;
    }
    scannerTyping.count += 1; scannerTyping.lastAt = now;
    clearTimeout(scannerTyping.resetTimer);
    scannerTyping.resetTimer = setTimeout(() => { scannerTyping.target=null; scannerTyping.count=0; }, 280);
    return;
  }
  if (event.key === 'Enter' && scannerTyping.target === target && scannerTyping.count >= 4) {
    const averageInterval = (now - scannerTyping.firstAt) / Math.max(1, scannerTyping.count - 1);
    if (now - scannerTyping.lastAt < 80 && averageInterval < 35) {
      event.preventDefault(); event.stopImmediatePropagation();
      clearTimeout(scannerTyping.resetTimer); scannerTyping.target=null; scannerTyping.count=0;
    }
  }
}, true);
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  setAccountMenu(false);
  setNotificationsOpen(false);
});
document.querySelectorAll('[data-close-dialog]').forEach(button => button.onclick = () => button.closest('dialog').close());
setInterval(() => {
  if (!currentUser || !state.technicianPendencies.length) return;
  renderDashboardOperations();
  renderMovement();
}, 60 * 1000);
$('#product-dialog').addEventListener('close', () => setProductDialogEpiMode('new', false));
$('#edit-product-dialog').addEventListener('close', () => setProductDialogEpiMode('edit', false));
$('#code-scanner-dialog').addEventListener('close', stopCodeScanner);
$('#scanner-manual-form').onsubmit = event => {
  event.preventDefault();
  const code = $('#scanner-manual-code').value.trim();
  if (!code) return scannerMessage('Informe ou leia um código para localizar o item.');
  useScannedCode(code);
};
document.querySelectorAll('#new-image, #edit-image').forEach(input => input.onchange = event => {
  const file = event.target.files?.[0];
  const prefix = event.target.id.startsWith('new-') ? 'new' : 'edit';
  try {
    validateProductImage(file);
    setProductImagePreview(prefix, file ? URL.createObjectURL(file) : '', false);
    if (prefix === 'edit' && file) $('#edit-remove-image').dataset.removed = 'false';
  } catch (error) {
    event.target.value = '';
    setProductImagePreview(prefix, prefix === 'edit' ? editingProductImagePath : '', prefix === 'edit');
    alert(error.message);
  }
});
$('#edit-remove-image').onclick = () => {
  $('#edit-image').value = '';
  $('#edit-remove-image').dataset.removed = 'true';
  setProductImagePreview('edit');
};
$('#dashboard-items-card').onclick = () => showProducts('all');
$('#dashboard-exits-card').onclick = () => { $('#history-type').value = 'saida'; view('movement'); renderMovement(); };
$('#dashboard-loans-card').onclick = () => view('loans');
$('#dashboard-returns-card').onclick = () => view('loans');
$('#dashboard-minimum-card').onclick = () => { state.productFilter = 'all'; $('#product-status-filter').value = 'out'; view('products'); renderProducts(); };
$('#dashboard-reorder-card').onclick = () => showProducts('low');
$('#dashboard-value-card').onclick = () => { if (currentUser?.role === 'admin') view('statement'); };
$('#product-search').oninput = () => { state.productFilter = 'all'; renderProducts(); };
$('#product-category-filter').onchange = () => { state.productFilter = 'all'; renderProducts(); };
$('#product-status-filter').onchange = () => { state.productFilter = 'all'; renderProducts(); };
$('#epi-status-filter').onchange = renderEpis;
$('#serial-search').oninput = renderSerials;
$('#lab-search').oninput = renderLaboratory;
document.querySelectorAll('#loan-search, #loan-status-filter, #loan-technician-filter, #loan-equipment-filter, #loan-period-from, #loan-period-to').forEach(input => input.addEventListener(input.tagName === 'INPUT' ? 'input' : 'change', renderLoans));
document.querySelectorAll('[data-loan-card-filter]').forEach(button => button.onclick = () => { $('#loan-status-filter').value = button.dataset.loanCardFilter; renderLoans(); });
$('#clear-loan-filters').onclick = () => { $('#loan-search').value = ''; $('#loan-status-filter').value = ''; $('#loan-technician-filter').value = ''; $('#loan-equipment-filter').value = ''; $('#loan-period-from').value = ''; $('#loan-period-to').value = ''; renderLoans(); };
$('#loan-item').onchange = updateLoanItemDetails;
$('#client-loan-search').oninput = renderClientLoans;
const clientLoanListSearch = $('#client-loan-list-search');
if (clientLoanListSearch) clientLoanListSearch.oninput = renderClientLoans;
const clientLoanStatusFilter = $('#client-loan-status-filter');
if (clientLoanStatusFilter) clientLoanStatusFilter.onchange = renderClientLoans;
const clientLoanLocationFilter = $('#client-loan-location-filter');
if (clientLoanLocationFilter) clientLoanLocationFilter.onchange = renderClientLoans;
const clientLoanItem = $('#client-loan-item');
if (clientLoanItem) clientLoanItem.onchange = renderClientLoanFormSummary;
const clientLoanCustomerName = $('#client-loan-customer-name');
if (clientLoanCustomerName) clientLoanCustomerName.oninput = renderClientLoanFormSummary;
const clientLoanReference = $('#client-loan-reference');
if (clientLoanReference) clientLoanReference.oninput = renderClientLoanFormSummary;
document.querySelectorAll('[data-history-filter]').forEach(element => { element.oninput = renderMovement; element.onchange = renderMovement; });
$('#clear-history-filters').onclick = () => { document.querySelectorAll('[data-history-filter]').forEach(element => { element.value = ''; }); renderMovement(); };
document.querySelectorAll('[data-statement-filter]').forEach(element => { element.oninput = renderStatement; element.onchange = renderStatement; });
$('#clear-statement-filters').onclick = () => { document.querySelectorAll('[data-statement-filter]').forEach(element => { element.value = ''; }); renderStatement(); };
function updateMovementRecipientPlaceholder() {
  const placeholders = { tecnico: 'Ex.: João Silva — Equipe externa', veiculo: 'Ex.: Carro 01 — Equipe Norte', cliente: 'Ex.: Cliente ou endereço', outro: 'Descreva o destino' };
  const holderType = $('#movement-holder-type').value, recipient = $('#movement-person');
  recipient.placeholder = placeholders[holderType];
  const list = holderType === 'tecnico' ? 'collaborator-options' : holderType === 'veiculo' ? 'vehicle-options' : '';
  if (list) recipient.setAttribute('list', list); else recipient.removeAttribute('list');
}
function movementUnitValues() {
  return [...document.querySelectorAll('.movement-unit-row')].map(row => ({
    mac: row.querySelector('[data-unit-mac]')?.value.trim() || '',
    serial_number: row.querySelector('[data-unit-serial]')?.value.trim() || '',
    asset_tag: row.querySelector('[data-unit-asset]')?.value.trim() || ''
  }));
}
const movementUnitIsIdentified = unit => Boolean(unit.mac || unit.serial_number || unit.asset_tag);
function updateMovementDeadlineVisibility(clearWhenHidden = false) {
  const hasTrackedProduct = $('#movement-type').value === 'saida'
    && $('#movement-holder-type').value === 'tecnico'
    && product($('#movement-product').value)?.tracking_mode === 'serializado';
  $('#movement-deadline-section').hidden = !hasTrackedProduct;
  $('#movement-withdrawn-at').required = hasTrackedProduct;
  $('#movement-due-at').required = hasTrackedProduct;
  if (hasTrackedProduct) {
    if (!$('#movement-withdrawn-at').value) {
      const now = new Date();
      $('#movement-withdrawn-at').value = localDateTimeInputValue(now);
      $('#movement-due-at').value = localDateTimeInputValue(new Date(now.getTime() + 24 * 60 * 60 * 1000));
    }
  } else if (clearWhenHidden) {
    $('#movement-withdrawn-at').value = '';
    $('#movement-due-at').value = '';
  }
}
function renderMovementSerialUnits() {
  const container = $('#movement-serial-units');
  const selectedProduct = product($('#movement-product').value);
  const serialized = $('#movement-type').value === 'saida' && $('#movement-holder-type').value === 'tecnico' && selectedProduct?.tracking_mode === 'serializado';
  container.hidden = !serialized;
  if (!serialized) { container.innerHTML = ''; updateMovementDeadlineVisibility(true); return; }
  const rawQuantity = Number($('#movement-quantity').value);
  const count = Number.isInteger(rawQuantity) && rawQuantity > 0 ? Math.min(rawQuantity, 100) : 0;
  const previous = movementUnitValues();
  container.innerHTML = count ? Array.from({ length: count }, (_, index) => {
    const saved = previous[index] || {};
    return `<section class="movement-unit-row"><h4>Unidade ${index + 1}</h4><div class="movement-unit-fields"><label>MAC <input data-unit-mac value="${esc(saved.mac || '')}" placeholder="MAC exato" /></label><label>Serial <input data-unit-serial value="${esc(saved.serial_number || '')}" placeholder="Serial exato" /></label><label>Patrimônio <input data-unit-asset value="${esc(saved.asset_tag || '')}" placeholder="Patrimônio exato" /></label></div><small>Informe pelo menos um identificador desta unidade.</small></section>`;
  }).join('') : '<p class="form-error">Para produtos individualizados, informe uma quantidade inteira.</p>';
  updateMovementDeadlineVisibility(true);
}
function updateMovementMode() {
  const isFieldUsage = $('#movement-type').value === 'uso_os';
  const technicianExit = $('#movement-type').value === 'saida' && $('#movement-holder-type').value === 'tecnico';
  const holder = $('#movement-holder-type'), workOrder = $('#movement-work-order'), quantityInput = $('#movement-quantity');
  if (isFieldUsage) holder.value = 'tecnico';
  holder.disabled = isFieldUsage;
  workOrder.required = isFieldUsage;
  $('#movement-destination-label').textContent = isFieldUsage ? 'Destino (técnico)' : 'Destino';
  $('#movement-person-label').textContent = isFieldUsage ? 'Técnico responsável' : 'Responsável / destino';
  $('#movement-os-label').textContent = isFieldUsage ? 'Número da OS *' : 'Número da OS';
  const serializedExit = technicianExit && product($('#movement-product').value)?.tracking_mode === 'serializado';
  quantityInput.step = serializedExit ? '1' : '0.001';
  quantityInput.min = serializedExit ? '1' : '0.001';
  renderMovementSerialUnits();
  updateMovementRecipientPlaceholder();
}
$('#movement-type').onchange = updateMovementMode;
$('#movement-holder-type').onchange = updateMovementMode;
$('#movement-product').onchange = () => {
  $('#movement-serial-units').innerHTML = '';
  $('#movement-withdrawn-at').value = '';
  $('#movement-due-at').value = '';
  updateMovementMode();
};
$('#movement-quantity').oninput = renderMovementSerialUnits;
document.querySelectorAll('[data-deadline-hours]').forEach(button => button.onclick = () => {
  const withdrawn = new Date($('#movement-withdrawn-at').value || Date.now());
  $('#movement-due-at').value = localDateTimeInputValue(new Date(withdrawn.getTime() + Number(button.dataset.deadlineHours) * 60 * 60 * 1000));
});
$('[data-deadline-custom]').onclick = () => $('#movement-due-at').focus();
updateMovementMode();

$('#serial-transfer-action').onchange = updateSerialTransferForm;
$('#laboratory-action').onchange = updateLaboratoryForm;
$('#edit-tracking').onchange = () => updateEditStockControl();
updateLaboratoryForm();

function collectProductData(prefix) {
  const epiMode = $(`#${prefix === 'new' ? 'product' : 'edit-product'}-form`).classList.contains('epi-mode');
  return {
    name: $(`#${prefix}-name`).value.trim(),
    code: $(`#${prefix}-code`).value.trim(),
    category: $(`#${prefix}-category`).value,
    brand: $(`#${prefix}-brand`).value.trim() || null,
    model: $(`#${prefix}-model`).value.trim() || null,
    unit_of_measure: $(`#${prefix}-unit`).value,
    tracking_mode: $(`#${prefix}-tracking`).value,
    description: $(`#${prefix}-description`).value.trim() || null,
    average_cost: Number($(`#${prefix}-average-cost`).value || 0),
    requires_ca: epiMode || $(`#${prefix}-requires-ca`).value === 'true',
    ca_number: $(`#${prefix}-ca-number`).value.trim() || null,
    ca_expiry_date: $(`#${prefix}-ca-expiry`).value || null
  };
}

$('#product-form').onsubmit = async event => {
  event.preventDefault();
  let uploadedImagePath = null;
  let productSaved = false;
  try {
    const newProduct = { ...collectProductData('new'), stock:Number($('#new-stock').value), minimum_stock:Number($('#new-minimum').value) };
    const imageFile = $('#new-image').files?.[0];
    if (imageFile) {
      uploadedImagePath = await uploadProductImage(imageFile);
      newProduct.image_path = uploadedImagePath;
    }
    const { error } = await supabase.from('products').insert(newProduct);
    if (error) throw error;
    productSaved = true;
    const nextView = isEpiProduct(newProduct) ? 'epis' : 'products';
    event.target.reset(); setProductImagePreview('new'); $('#product-dialog').close(); await load();
    nextView === 'epis' ? showEpis() : view('products');
  } catch (error) {
    if (uploadedImagePath && !productSaved) {
      try { await removeProductImage(uploadedImagePath); } catch (removeError) { console.warn('Não foi possível remover a foto enviada:', removeError.message); }
    }
    alert(`Não foi possível cadastrar o item: ${error.message}`);
  }
};

$('#edit-product-form').onsubmit = async event => {
  event.preventDefault();
  const id = $('#edit-product-id').value;
  const previousImagePath = editingProductImagePath;
  let uploadedImagePath = null;
  try {
    const previousProduct = product(id);
    const updatedProduct = {
      ...collectProductData('edit'),
      stock: Number($('#edit-stock').value),
      minimum_stock: Number($('#edit-minimum').value)
    };
    const imageFile = $('#edit-image').files?.[0];
    let nextImagePath = previousImagePath;
    if (imageFile) {
      uploadedImagePath = await uploadProductImage(imageFile);
      nextImagePath = uploadedImagePath;
    } else if ($('#edit-remove-image').dataset.removed === 'true') {
      nextImagePath = null;
    }
    if (nextImagePath !== previousImagePath) updatedProduct.image_path = nextImagePath;
    const { error } = await supabase.from('products').update(updatedProduct).eq('id', id);
    if (error) throw error;
    if (previousImagePath && previousImagePath !== nextImagePath) {
      try { await removeProductImage(previousImagePath); } catch (removeError) { console.warn('Não foi possível remover a foto anterior:', removeError.message); }
    }
    editingProductImagePath = null;
    const nextView = isEpiProduct(updatedProduct) ? 'epis' : 'products';
    $('#edit-product-dialog').close(); await load();
    nextView === 'epis' ? showEpis() : view('products');
  } catch (error) {
    if (uploadedImagePath) {
      try { await removeProductImage(uploadedImagePath); } catch (removeError) { console.warn('Não foi possível remover a foto enviada:', removeError.message); }
    }
    alert(error.message);
  }
};

$('#movement-form').onsubmit = async event => {
  event.preventDefault();
  if (movementSubmitting) return;
  const selectedProduct = product($('#movement-product').value), itemQuantity = Number($('#movement-quantity').value), operation = $('#movement-type').value, fieldUsage = operation === 'uso_os', type = fieldUsage ? 'saida' : operation, workOrder = $('#movement-work-order').value.trim();
  if (!selectedProduct) return alert('Selecione um produto.');
  if (fieldUsage && !workOrder) return alert('Informe o número da OS para registrar o uso do material.');
  if (!fieldUsage && type === 'saida' && itemQuantity > selectedProduct.stock) return alert('Estoque insuficiente.');
  const units = selectedProduct.tracking_mode === 'serializado' ? movementUnitValues() : [];
  const serializedTechnicianExit = operation === 'saida' && $('#movement-holder-type').value === 'tecnico' && selectedProduct.tracking_mode === 'serializado';
  if (serializedTechnicianExit) {
    if (!Number.isInteger(itemQuantity) || units.length !== itemQuantity) return alert('Informe uma quantidade inteira e os identificadores de cada unidade.');
    if (units.some(unit => !movementUnitIsIdentified(unit))) return alert('Informe MAC, serial ou patrimônio para cada unidade.');
  }
  const timedTechnicianExit = serializedTechnicianExit && units.some(movementUnitIsIdentified);
  if (timedTechnicianExit && state.technicianPendenciesLoadError) return alert('Execute primeiro o arquivo integrated-technician-serial-flow.sql no Supabase.');
  const withdrawnAt = timedTechnicianExit ? new Date($('#movement-withdrawn-at').value) : null;
  const dueAt = timedTechnicianExit ? new Date($('#movement-due-at').value) : null;
  if (timedTechnicianExit && (!Number.isFinite(withdrawnAt.getTime()) || !Number.isFinite(dueAt.getTime()) || dueAt <= withdrawnAt)) return alert('Informe um prazo limite posterior à retirada.');

  const submitButton = event.submitter || event.currentTarget.querySelector('button[type="submit"]');
  const originalButtonText = submitButton?.textContent;
  movementSubmitting = true;
  if (submitButton) { submitButton.disabled = true; submitButton.textContent = 'Processando...'; }
  try {
    let result;
    if (timedTechnicianExit) {
      result = await supabase.rpc('record_integrated_technician_movement', { p_product_id:selectedProduct.id, p_quantity:itemQuantity, p_technician:$('#movement-person').value.trim(), p_withdrawn_at:withdrawnAt.toISOString(), p_due_at:dueAt.toISOString(), p_work_order:workOrder || null, p_note:$('#movement-note').value || null, p_units:units });
    } else {
      movementOperationId ||= crypto.randomUUID();
      const movementData = { p_operation_id:movementOperationId, p_product_id:selectedProduct.id, p_type:type, p_quantity:itemQuantity, p_recipient:$('#movement-person').value.trim(), p_note:$('#movement-note').value || null, p_holder_type:$('#movement-holder-type').value, p_work_order:workOrder || null, p_field_usage:fieldUsage };
      result = await supabase.rpc('record_movement_idempotent', movementData);
    }
    const { error } = result;
    if (error) return alert(error.message);
    movementOperationId = null;
    event.target.reset(); $('#movement-quantity').value = 1; updateMovementMode(); await load(); view('dashboard');
  } finally {
    movementSubmitting = false;
    if (submitButton) { submitButton.disabled = false; submitButton.textContent = originalButtonText; }
  }
};

$('#receipt-form').onsubmit = async event => {
  event.preventDefault();
  if (receiptSubmitting) return;
  const submitButton = event.submitter || event.currentTarget.querySelector('button[type="submit"]');
  const originalButtonText = submitButton?.textContent;
  receiptSubmitting = true;
  if (submitButton) { submitButton.disabled = true; submitButton.textContent = 'Processando...'; }
  try {
    const lines = [...document.querySelectorAll('.receipt-line')].map(line => ({
      product_id: line.querySelector('[data-receipt-product]').value === '__new__' ? '' : line.querySelector('[data-receipt-product]').value,
      isNewProduct: line.querySelector('[data-receipt-product]').value === '__new__',
      product_name: line.querySelector('[data-receipt-new-name]').value,
      product_code: line.querySelector('[data-receipt-new-code]').value,
      category: line.querySelector('[data-receipt-new-category]').value,
      unit_of_measure: line.querySelector('[data-receipt-new-unit]').value,
      quantity: Number(line.querySelector('[data-receipt-quantity]').value),
      unit_cost: Number(line.querySelector('[data-receipt-unit-cost]').value),
      batch_number: line.querySelector('[data-receipt-batch]').value.trim() || null,
      expiry_date: line.querySelector('[data-receipt-expiry]').value || null
    }));
    await createProductsForReceipt(lines);
    receiptOperationId ||= crypto.randomUUID();
    await registerReceipt({
      supplierName: $('#receipt-supplier').value,
      invoiceNumber: $('#receipt-invoice').value,
      note: $('#receipt-note').value,
      lines,
      operationId: receiptOperationId
    });
    receiptOperationId = null;
    $('#receipt-dialog').close();
    await load();
    view('receipts');
    alert('Recebimento registrado e estoque atualizado.');
  } catch (error) {
    alert(error.message);
  } finally {
    receiptSubmitting = false;
    if (submitButton) { submitButton.disabled = false; submitButton.textContent = originalButtonText; }
  }
};

$('#movement-form').addEventListener('input', () => { if (!movementSubmitting) movementOperationId = null; });
$('#movement-form').addEventListener('change', () => { if (!movementSubmitting) movementOperationId = null; });
$('#receipt-form').addEventListener('input', () => { if (!receiptSubmitting) receiptOperationId = null; });
$('#receipt-form').addEventListener('change', () => { if (!receiptSubmitting) receiptOperationId = null; });

$('#xml-file-form').onsubmit = async event => {
  event.preventDefault();
  try {
    const file = $('#xml-file').files?.[0];
    if (!file) throw new Error('Selecione o arquivo XML da nota fiscal.');
    if (file.size > 8 * 1024 * 1024) throw new Error('O XML é muito grande. Selecione um arquivo de até 8 MB.');
    importedXmlInvoice = parseInvoiceXml(await file.text());
    const autoCreate = $('#xml-auto-create-products').checked;
    importedXmlInvoice.items.forEach((item, index) => {
      item.productId = findImportedProduct(item)?.id || (autoCreate ? xmlAutoProductId(index) : '');
    });
    $('#xml-import-supplier').value = importedXmlInvoice.supplier;
    $('#xml-import-invoice').value = importedXmlInvoice.invoiceNumber;
    $('#xml-import-note').value = '';
    $('#xml-import-summary').textContent = `Fornecedor: ${importedXmlInvoice.supplier}${importedXmlInvoice.cnpj ? ` · CNPJ: ${importedXmlInvoice.cnpj}` : ''} · NF: ${importedXmlInvoice.invoiceNumber || 'não informada'} · ${importedXmlInvoice.items.length} item(ns) encontrado(s).`;
    $('#xml-import-preview').hidden = false;
    showXmlImportError();
    renderImportedXmlItems();
  } catch (error) {
    importedXmlInvoice = null;
    $('#xml-import-preview').hidden = true;
    showXmlImportError(error.message);
  }
};

$('#xml-auto-create-products').onchange = event => {
  if (!importedXmlInvoice) return;
  importedXmlInvoice.items.forEach((item, index) => {
    const autoId = xmlAutoProductId(index);
    if (event.target.checked && !item.productId) item.productId = autoId;
    if (!event.target.checked && item.productId === autoId) item.productId = '';
  });
  renderImportedXmlItems();
};

$('#confirm-xml-import').onclick = async () => {
  try {
    if (!importedXmlInvoice) throw new Error('Selecione e leia um XML antes de confirmar.');
    const supplierName = $('#xml-import-supplier').value.trim();
    const invoiceNumber = $('#xml-import-invoice').value.trim();
    if (!supplierName) throw new Error('Informe o fornecedor para registrar o recebimento.');
    if (!invoiceNumber) throw new Error('Informe o número da nota fiscal.');
    const lines = importedXmlInvoice.items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.productId)
      .map(({ item, index }) => ({
        product_id: item.productId === xmlAutoProductId(index) ? null : item.productId,
        product_name: item.name,
        product_code: xmlGeneratedProductCode(item, index),
        unit_of_measure: xmlUnitOfMeasure(item.unit),
        quantity: item.quantity,
        unit_cost: item.unitCost ?? Number(product(item.productId)?.average_cost || 0)
      }));
    if (!lines.length) throw new Error('Escolha ao menos um item para importar.');
    const importNote = importedXmlInvoice.accessKey ? `Importado do XML da NF-e · chave ${importedXmlInvoice.accessKey}` : 'Importado do XML da NF-e';
    const note = [$('#xml-import-note').value.trim(), importNote].filter(Boolean).join(' · ');
    await registerXmlReceipt({ supplierName, invoiceNumber, note, items: lines });
    $('#xml-import-dialog').close();
    importedXmlInvoice = null;
    await load();
    view('receipts');
    alert('Recebimento importado e estoque atualizado.');
  } catch (error) {
    showXmlImportError(error.message);
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

$('#edit-collaborator-form').onsubmit = async event => {
  event.preventDefault();
  if (currentUser?.role !== 'admin') return alert('Apenas administradores podem editar colaboradores.');
  const { error } = await supabase.from('collaborators').update({
    name: $('#edit-collaborator-name').value.trim(),
    job_title: $('#edit-collaborator-job-title').value.trim() || null,
    department: $('#edit-collaborator-department').value.trim() || null,
    phone: $('#edit-collaborator-phone').value.trim() || null,
    updated_at: new Date().toISOString()
  }).eq('id', $('#edit-collaborator-id').value);
  if (error) return alert(error.message);
  $('#edit-collaborator-dialog').close();
  await load();
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

$('#reminder-form').onsubmit = async event => {
  event.preventDefault();
  const { error } = await supabase.from('dashboard_reminders').insert({
    recipient: $('#reminder-recipient').value.trim(),
    description: $('#reminder-description').value.trim(),
    due_date: $('#reminder-due-date').value,
    created_by: currentUser.id
  });
  if (error) return alert('Não foi possível criar o lembrete. Execute primeiro o SQL desta atualização no Supabase.');
  event.target.reset(); $('#reminder-dialog').close(); await load(); view('dashboard');
};

$('#material-request-form').onsubmit = async event => {
  event.preventDefault();
  const { error } = await supabase.from('material_requests').insert({
    requester: $('#request-requester').value.trim(),
    description: $('#request-description').value.trim(),
    created_by: currentUser.id
  });
  if (error) return alert('Não foi possível registrar a solicitação. Execute primeiro o SQL desta atualização no Supabase.');
  event.target.reset(); $('#material-request-dialog').close(); await load(); view('dashboard');
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
    p_add_to_stock: false
  });
  if (error) return alert(error.message);
  event.target.reset(); $('#serial-dialog').close(); await load(); view('serials');
};

$('#edit-serial-form').onsubmit = async event => {
  event.preventDefault();
  if (!['admin', 'operador'].includes(currentUser?.role)) return alert('Apenas administradores e operadores podem editar unidades.');
  const id = $('#edit-serial-id').value;
  const { error } = await supabase.rpc('edit_serial_item', {
    p_serial_item_id: id,
    p_product_id: $('#edit-serial-product').value,
    p_serial_number: $('#edit-serial-number').value.trim() || null,
    p_mac_address: $('#edit-serial-mac').value.trim() || null,
    p_asset_tag: $('#edit-serial-asset-tag').value.trim() || null,
    p_notes: $('#edit-serial-notes').value.trim() || null
  });
  if (error) return alert(error.message);
  $('#edit-serial-dialog').close();
  await load();
  view('serials');
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
  const issuedAt = $('#loan-issued-at').value, due = $('#loan-due').value;
  if (!issuedAt || !due) return alert('Informe a retirada e o prazo de devolução com data e hora.');
  if (new Date(due) <= new Date(issuedAt)) return alert('O prazo de devolução deve ser posterior à retirada.');
  const { error } = await supabase.rpc('create_tool_loan', {
    p_serial_item_id: $('#loan-item').value,
    p_collaborator_id: $('#loan-collaborator').value,
    p_issued_at: new Date(issuedAt).toISOString(),
    p_due_at: new Date(due).toISOString(),
    p_note: $('#loan-note').value || null
  });
  if (error) return alert(error.message);
  $('#loan-dialog').close(); await load(); view('loans');
};

$('#return-loan-form').onsubmit = async event => {
  event.preventDefault();
  const { error } = await supabase.rpc('return_tool_loan', {
    p_loan_id: $('#return-loan-id').value,
    p_return_condition: 'bom',
    p_return_note: $('#return-loan-note').value || null
  });
  if (error) return alert(error.message);
  $('#return-loan-dialog').close(); await load(); view('loans');
};

$('#client-loan-form').onsubmit = async event => {
  event.preventDefault();
  const itemId = $('#client-loan-item').value;
  const customerName = $('#client-loan-customer-name').value.trim();
  const serialItem = state.serialItems.find(item => item.id === itemId);

  if (!serialItem) return setClientLoanError('Localize e selecione um equipamento disponível para registrar o comodato.');
  if (!['disponivel', 'com_colaborador', 'com_veiculo'].includes(serialItem.status)) return setClientLoanError('O equipamento precisa estar no almoxarifado, com um técnico ou em um veículo.');
  if (!customerName) return setClientLoanError('Informe o nome do cliente antes de registrar o comodato.');

  setClientLoanError('');
  const submitButton = $('#client-loan-form button[type="submit"]');
  submitButton.disabled = true;
  try {
    const { error } = await supabase.rpc('create_client_loan', {
      p_serial_item_id: itemId,
      p_customer_name: customerName,
      p_customer_document: $('#client-loan-document').value.trim() || null,
      p_customer_phone: $('#client-loan-phone').value.trim() || null,
      p_customer_address: $('#client-loan-address').value.trim() || null,
      p_customer_reference: $('#client-loan-reference').value.trim() || null,
      p_note: $('#client-loan-note').value.trim() || null
    });
    if (error) throw error;
    $('#client-loan-dialog').close();
    await load();
    view('client-loans');
  } catch (error) {
    setClientLoanError(error?.message || 'Não foi possível registrar o comodato. Tente novamente.');
  } finally {
    submitButton.disabled = false;
  }
};

$('#client-loan-import-form').onsubmit = async event => {
  event.preventDefault();
  try { await importClientLoanExcelRows(); } catch (error) { alert(error.message); }
};

$('#return-client-loan-form').onsubmit = async event => {
  event.preventDefault();
  const { error } = await supabase.rpc('return_client_loan', {
    p_loan_id: $('#return-client-loan-id').value,
    p_return_note: $('#return-client-loan-note').value.trim() || null
  });
  if (error) return alert(error.message);
  $('#return-client-loan-dialog').close();
  await load();
  view('client-loans');
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
    await invokeAdminFunction('admin-users', 'POST', { name:$('#user-name').value, email:$('#user-email').value, password:$('#user-password').value, role:$('#user-role').value });
    event.target.reset(); $('#user-dialog').close(); await loadUsers(); renderUsers(); alert('Usuário criado com sucesso.');
  } catch (error) { errorText.textContent = error.message; errorText.hidden = false; }
};

$('#login-form').onsubmit = async event => {
  event.preventDefault(); setLoginMessage();
  const { data, error } = await supabase.auth.signInWithPassword({ email:$('#login-email').value, password:$('#login-password').value });
  if (error) { setLoginMessage(error.message); return; }
  setPasswordRecoveryMode(false);
  $('#auth-gate').hidden = true; await start(data.session);
};

$('#toggle-login-password').onclick = event => togglePasswordVisibility('#login-password', event.currentTarget);
$('#toggle-reset-password').onclick = event => togglePasswordVisibility('#reset-password', event.currentTarget);
$('#forgot-password').onclick = async () => {
  const email = $('#login-email').value.trim();
  if (!email) {
    setLoginMessage('Informe seu e-mail para receber o link de recuperação.');
    return $('#login-email').focus();
  }
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/` });
  if (error) return setLoginMessage(error.message);
  setLoginMessage('Se este e-mail estiver cadastrado, enviaremos um link para criar uma nova senha.', 'success');
};

$('#reset-password-form').onsubmit = async event => {
  event.preventDefault();
  const errorText = $('#reset-password-error');
  errorText.hidden = true;
  const password = $('#reset-password').value;
  if (password !== $('#reset-password-confirmation').value) {
    errorText.textContent = 'As senhas não são iguais.';
    errorText.hidden = false;
    return;
  }
  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    errorText.textContent = error.message;
    errorText.hidden = false;
    return;
  }
  setPasswordRecoveryMode(false);
  event.target.reset();
  $('#reset-password-dialog').close();
  window.history.replaceState({}, document.title, window.location.pathname);
  const { data: { session } } = await supabase.auth.getSession();
  $('#auth-gate').hidden = true;
  if (session) await start(session);
};

$('#reset-password-dialog').addEventListener('cancel', event => event.preventDefault());

const todayLabel = $('#today');
if (todayLabel) todayLabel.textContent = new Date().toLocaleDateString('pt-BR', { weekday:'long', day:'2-digit', month:'long', year:'numeric' });
render();
supabase.auth.onAuthStateChange(event => {
  if (event !== 'PASSWORD_RECOVERY') return;
  setPasswordRecoveryMode(true);
  openPasswordReset();
});

async function initializeAuthentication() {
  const url = new URL(window.location.href);
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const recoveryInUrl = hashParams.get('type') === 'recovery' || url.searchParams.get('type') === 'recovery';
  const code = url.searchParams.get('code');
  const tokenHash = url.searchParams.get('token_hash');
  const accessToken = hashParams.get('access_token');
  const refreshToken = hashParams.get('refresh_token');
  let session = null;

  // Links mais novos do Supabase usam "code" (PKCE); alguns modelos de e-mail
  // ainda usam token_hash ou tokens na âncora da URL. Todos precisam ser
  // convertidos em uma sessão antes de abrir o formulário de nova senha.
  if (accessToken && refreshToken) {
    const { data, error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    if (error) {
      $('#auth-gate').hidden = false;
      setLoginMessage('Este link de recuperação expirou ou já foi utilizado. Solicite um novo link.');
      return;
    }
    session = data.session;
    setPasswordRecoveryMode(true);
    window.history.replaceState({}, document.title, window.location.pathname);
  } else if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      $('#auth-gate').hidden = false;
      setLoginMessage('Este link de recuperação expirou ou já foi utilizado. Solicite um novo link.');
      return;
    }
    session = data.session;
    setPasswordRecoveryMode(true);
    window.history.replaceState({}, document.title, window.location.pathname);
  } else if (tokenHash && recoveryInUrl) {
    const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'recovery' });
    if (error) {
      $('#auth-gate').hidden = false;
      setLoginMessage('Este link de recuperação expirou ou já foi utilizado. Solicite um novo link.');
      return;
    }
    session = data.session;
    setPasswordRecoveryMode(true);
    window.history.replaceState({}, document.title, window.location.pathname);
  } else {
    ({ data: { session } } = await supabase.auth.getSession());
  }

  if (session && (passwordRecoveryMode || recoveryInUrl || sessionStorage.getItem(passwordRecoveryStorageKey) === '1')) {
    setPasswordRecoveryMode(true);
    openPasswordReset();
  } else if (session) {
    await start(session);
  } else {
    $('#auth-gate').hidden = false;
  }
}

await initializeAuthentication();
