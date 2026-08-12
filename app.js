import { createClient } from '@supabase/supabase-js';

const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);
let state = { products: [], movements: [], users: [], usersLoadNote: '', collaborators: [], vehicles: [], locations: [], suppliers: [], serialItems: [], serialMovements: [], toolLoans: [], receipts: [], receiptItems: [], inventorySessions: [], inventoryCounts: [], reminders: [], materialRequests: [], productFilter: 'all' };
let currentUser = null;
let passwordRecoveryMode = false;
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;' }[char]));
const accountAvatarKey = () => currentUser ? `digitus-account-avatar-${currentUser.id}` : '';

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

function setLoginMessage(message = '', type = 'error') {
  const errorText = $('#login-error');
  errorText.textContent = message;
  errorText.hidden = !message;
  errorText.classList.toggle('success', type === 'success');
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
const low = item => item.stock <= item.minimum;
const date = value => new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const status = item => item.stock === 0 ? '<span class="badge out">Sem estoque</span>' : low(item) ? '<span class="badge low">Estoque baixo</span>' : '<span class="badge ok">Disponível</span>';
const roleName = role => ({ admin: 'Administrador', operador: 'Operador', tecnico: 'Técnico' }[role] || 'Técnico');
const holderTypeName = type => ({ tecnico: 'Técnico', veiculo: 'Veículo', cliente: 'Cliente', outro: 'Outro' }[type] || 'Outro');
const movementName = item => item.fieldUsage ? 'Uso em OS' : item.type === 'entrada' ? 'Entrada' : 'Saída';
const unitName = unit => ({ unidade: 'un.', metro: 'm', par: 'par', caixa: 'cx.' }[unit] || 'un.');
const quantity = value => Number(value || 0).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const currency = value => Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const stockLabel = item => `${quantity(item.stock)} ${unitName(item.unit_of_measure)}`;

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
        addToStockRequested: spreadsheetYes(spreadsheetCell(row, serialSpreadsheetColumns.addToStock))
      });
    });
    if (errors.length) throw new Error(`${errors.slice(0, 3).join(' ')}${errors.length > 3 ? ` E mais ${errors.length - 3} erro(s).` : ''}`);
    if (!prepared.length) throw new Error('Nenhuma unidade válida foi encontrada nesta planilha.');

    const incomingByCode = new Map();
    prepared.forEach(item => {
      const key = normalizedScanCode(item.productCode);
      if (!incomingByCode.has(key)) incomingByCode.set(key, []);
      incomingByCode.get(key).push(item);
    });
    incomingByCode.forEach((items, code) => {
      const existing = productsByCode.get(code);
      const available = items.filter(item => item.status === 'disponivel' && item.addToStockRequested);
      const required = Math.max(0, available.length - Number(existing.stock || 0));
      let remaining = required;
      items.forEach(item => {
        item.addToStock = item.status === 'disponivel' && item.addToStockRequested && remaining-- > 0;
      });
    });
    pendingSerialImport = prepared;
    const stockEntries = prepared.filter(item => item.addToStock).length;
    const summary = $('#serial-import-summary');
    summary.hidden = false;
    summary.innerHTML = `<b>${prepared.length} unidade${prepared.length === 1 ? '' : 's'} pronta${prepared.length === 1 ? '' : 's'} para importar.</b><span>${stockEntries ? `${stockEntries} unidade(s) completarão o saldo atual; as demais já estão contempladas no estoque da planilha.` : 'O saldo atual dos produtos será preservado; as unidades não serão somadas novamente.'}</span>`;
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
const serialStatusName = status => ({ disponivel:'Disponível', com_colaborador:'Com colaborador', com_veiculo:'Com veículo', instalado_cliente:'Instalado no cliente', emprestado:'Emprestado', aguardando_triagem:'Aguardando triagem', laboratorio:'Oficina', manutencao:'Em manutenção', defeito:'Defeito', baixado:'Baixado' })[status] || status;
const serialStatusClass = status => ({ disponivel:'ok', com_colaborador:'saida', com_veiculo:'saida', instalado_cliente:'saida', emprestado:'saida', aguardando_triagem:'low', laboratorio:'low', manutencao:'low', defeito:'out', baixado:'out' })[status] || 'low';
const serialActionName = action => ({ transferencia:'Transferência', instalacao:'Instalação em cliente', laboratorio:'Envio à oficina', retorno:'Retorno ao almoxarifado', baixa:'Baixa / sucata' })[action] || action;
const loanTypeName = type => type === 'cautela' ? 'Empréstimo sem prazo' : 'Empréstimo temporário';
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
  const availableProducts = activeProducts();
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
  renderDashboardStockValue(availableProducts);
  renderDashboardOperations();
  renderProducts(); renderMovement(); renderUsers(); renderRegistry(); renderReceipts(); renderSerials(); renderLaboratory(); renderLoans(); renderInventory(); renderStatement();
}

function renderDashboardOperations() {
  const overdue = state.toolLoans.filter(loanOverdue).sort((a, b) => new Date(a.due_at) - new Date(b.due_at));
  const openReminders = state.reminders.filter(item => item.status === 'aberto').sort((a, b) => new Date(a.due_date) - new Date(b.due_date));
  const expired = activeProducts().filter(caExpired).sort((a, b) => new Date(a.ca_expiry_date) - new Date(b.ca_expiry_date));
  const openRequests = state.materialRequests.filter(item => item.status === 'aberta').sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const canCompleteRequests = ['admin', 'operador'].includes(currentUser?.role);
  const canDeleteRequests = currentUser?.role === 'admin';
  $('#dashboard-overdue-loan-list-count').textContent = overdue.length;
  $('#dashboard-reminder-count').textContent = openReminders.length;
  $('#dashboard-expiry-count').textContent = expired.length;
  $('#dashboard-request-count').textContent = openRequests.length;
  $('#dashboard-overdue-loans-table').innerHTML = overdue.map((loan, index) => `<tr><td>${index + 1}</td><td>${esc(loan.collaborator_name || 'Não informado')}</td><td>${date(loan.due_at)}</td><td><button class="dashboard-icon-action" data-dashboard-loan="${loan.id}" type="button" aria-label="Ver empréstimo">◉</button></td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nenhum empréstimo em atraso.</td></tr>';
  $('#dashboard-reminders-table').innerHTML = openReminders.map(item => `<tr><td>${esc(item.recipient)}</td><td>${esc(item.description)}</td><td>${date(item.due_date)}</td><td><button class="dashboard-icon-action danger" data-close-reminder="${item.id}" type="button" aria-label="Concluir lembrete">×</button></td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nenhum lembrete registrado.</td></tr>';
  $('#dashboard-expiring-table').innerHTML = expired.map(item => `<tr><td>${esc(item.name)}</td><td>${esc(item.ca_number || 'CA não informado')}</td><td>${new Date(`${item.ca_expiry_date}T00:00:00`).toLocaleDateString('pt-BR')}</td><td><button class="dashboard-icon-action" data-dashboard-expiry="${item.id}" type="button" aria-label="Ver item">◉</button></td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nenhum material vencido.</td></tr>';
  $('#dashboard-requests-table').innerHTML = openRequests.map((item, index) => `<tr><td>${index + 1}</td><td>${esc(item.requester)}</td><td>${date(item.created_at)}</td><td><span class="dashboard-request-actions"><button class="dashboard-icon-action" data-dashboard-request="${item.id}" type="button" aria-label="Mostrar descrição da solicitação" aria-expanded="false">◉</button>${canCompleteRequests ? `<button class="dashboard-icon-action success" data-complete-request="${item.id}" type="button" aria-label="Concluir solicitação" title="Concluir solicitação">✓</button>` : ''}${canDeleteRequests ? `<button class="dashboard-icon-action danger" data-delete-request="${item.id}" type="button" aria-label="Apagar solicitação" title="Apagar solicitação">×</button>` : ''}</span></td></tr><tr id="dashboard-request-detail-${item.id}" class="dashboard-request-detail" hidden><td colspan="4"><b>Solicitação:</b> ${esc(item.description)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nenhuma solicitação de material.</td></tr>';
  document.querySelectorAll('[data-dashboard-loan]').forEach(button => button.onclick = () => view('loans'));
  document.querySelectorAll('[data-dashboard-expiry]').forEach(button => button.onclick = () => showProducts('expired'));
  document.querySelectorAll('[data-dashboard-request]').forEach(button => button.onclick = () => {
    const detail = $(`#dashboard-request-detail-${button.dataset.dashboardRequest}`);
    if (!detail) return;
    detail.hidden = !detail.hidden;
    button.setAttribute('aria-expanded', String(!detail.hidden));
  });
  document.querySelectorAll('[data-complete-request]').forEach(button => button.onclick = () => completeMaterialRequest(button.dataset.completeRequest));
  document.querySelectorAll('[data-delete-request]').forEach(button => button.onclick = () => deleteMaterialRequest(button.dataset.deleteRequest));
  document.querySelectorAll('[data-close-reminder]').forEach(button => button.onclick = () => closeReminder(button.dataset.closeReminder));
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
  const categories = [...new Set(activeProducts().map(item => item.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  categorySelect.innerHTML = '<option value="">Todas as categorias</option>' + categories.map(category => `<option value="${esc(category)}">${esc(category)}</option>`).join('');
  categorySelect.value = categories.includes(selectedCategory) ? selectedCategory : '';
  const category = categorySelect.value, statusFilter = statusSelect.value;
  const products = activeProducts().filter(item => {
    const matchesPreset = (state.productFilter !== 'low' || low(item)) && (state.productFilter !== 'ca' || caAlert(item)) && (state.productFilter !== 'expired' || caExpired(item));
    const matchesCategory = !category || item.category === category;
    const matchesStatus = !statusFilter
      || statusFilter === 'available' && Number(item.stock) > 0 && !low(item)
      || statusFilter === 'low' && low(item) && Number(item.stock) > 0
      || statusFilter === 'out' && Number(item.stock) === 0
      || statusFilter === 'ca' && Boolean(caAlert(item))
      || statusFilter === 'expired' && caExpired(item);
    return matchesPreset && matchesCategory && matchesStatus && `${item.name} ${item.code} ${item.category}`.toLowerCase().includes(query);
  });
  $('#products-table').innerHTML = products.map(item => {
    const ca = caAlert(item);
    const image = productImageUrl(item);
    return `<tr><td><div class="product-name-cell">${image ? `<span class="product-thumbnail"><img src="${esc(image)}" alt="Foto de ${esc(item.name)}" /></span>` : ''}<div><b>${esc(item.name)}</b><small>${esc([item.brand, item.model].filter(Boolean).join(' · ') || (item.tracking_mode === 'serializado' ? 'Rastreável por serial/MAC' : 'Controle por quantidade'))}</small></div></div></td><td>${esc(item.code)}</td><td>${esc(item.category)}</td>${canViewCosts ? `<td><b>${currency(item.average_cost)}</b><small>por ${unitName(item.unit_of_measure)}</small></td>` : ''}<td><b>${stockLabel(item)}</b><small>mínimo: ${quantity(item.minimum)} ${unitName(item.unit_of_measure)}</small></td><td>${status(item)}${ca ? `<small class="ca-status ${ca.type}">${esc(ca.label)} · validade: ${new Date(`${item.ca_expiry_date}T00:00:00`).toLocaleDateString('pt-BR')}</small>` : ''}</td><td><div class="table-actions">${canEdit ? `<button class="secondary-button" data-edit-product="${item.id}">Editar</button>` : ''}${canDelete ? `<button class="danger-button" data-delete-product="${item.id}">Apagar</button>` : ''}${!canEdit && !canDelete ? '—' : ''}</div></td></tr>`;
  }).join('') || `<tr><td colspan="${canViewCosts ? 7 : 6}" class="empty">Nenhum produto encontrado.</td></tr>`;
  document.querySelectorAll('[data-edit-product]').forEach(button => button.onclick = () => openProductEditor(button.dataset.editProduct));
  document.querySelectorAll('[data-delete-product]').forEach(button => button.onclick = () => deleteProduct(button.dataset.deleteProduct));
}

function renderMovement() {
  const select = $('#movement-product'), selected = select.value;
  const canDelete = currentUser?.role === 'admin';
  const products = activeProducts();
  select.innerHTML = products.map(item => `<option value="${item.id}">${esc(item.name)} (${stockLabel(item)})</option>`).join('');
  select.value = selected || products[0]?.id || '';
  const movements = getFilteredMovements();
  $('#movement-history').innerHTML = movements.map(item => `<div class="history-item"><span class="history-icon ${item.type === 'saida' ? 'out' : ''}">${item.type === 'entrada' ? '↓' : '↑'}</span><div><b>${movementName(item)} de ${quantity(item.quantity)} ${unitName(product(item.productId)?.unit_of_measure)} — ${esc(product(item.productId)?.name || 'Produto')}</b><small>${holderTypeName(item.holderType)}: ${esc(item.person)} · ${item.date}${item.workOrder ? ' · OS: ' + esc(item.workOrder) : ''}${item.note ? ' · ' + esc(item.note) : ''}</small></div>${canDelete ? `<button class="danger-button" data-delete-movement="${item.id}">Apagar</button>` : ''}</div>`).join('') || '<p class="empty">Nenhuma movimentação encontrada.</p>';
  document.querySelectorAll('[data-delete-movement]').forEach(button => button.onclick = () => deleteMovement(button.dataset.deleteMovement));
}

function receiptProducts() {
  return activeProducts().filter(item => item.tracking_mode !== 'serializado');
}

function receiptLineHtml(selected = '') {
  const products = receiptProducts();
  const selectedProduct = product(selected);
  const unitCost = Number(selectedProduct?.average_cost || 0).toFixed(2);
  return `<div class="receipt-line"><label>Material <select data-receipt-product required><option value="">Selecione</option><option value="__new__" ${selected === '__new__' ? 'selected' : ''}>+ Cadastrar novo material nesta entrega</option>${products.map(item => `<option value="${item.id}" ${item.id === selected ? 'selected' : ''}>${esc(item.name)} (${stockLabel(item)})</option>`).join('')}</select></label><label>Quantidade <input data-receipt-quantity type="number" min="0.001" step="0.001" required value="1" /></label><label>Valor unitário (R$) <input data-receipt-unit-cost type="number" min="0" step="0.01" required value="${unitCost}" /></label><button class="receipt-line-remove" data-remove-receipt-line type="button" aria-label="Remover material">×</button><div class="receipt-new-product" data-receipt-new-product ${selected === '__new__' ? '' : 'hidden'}><label>Nome do novo material <input data-receipt-new-name ${selected === '__new__' ? 'required' : ''} placeholder="Ex.: Cabo de rede CAT6" /></label><label>Código <input data-receipt-new-code ${selected === '__new__' ? 'required' : ''} placeholder="Ex.: CAB-CAT6" /></label><label>Categoria <select data-receipt-new-category><option value="Produtos">Produtos</option><option value="Equipamentos">Equipamentos</option><option value="Insumos">Insumos</option><option value="EPI">EPI</option><option value="Patrimônio">Patrimônio</option><option value="Ferramentas">Ferramentas</option></select></label><label>Unidade <select data-receipt-new-unit><option value="unidade">Unidade</option><option value="metro">Metro</option><option value="par">Par</option><option value="caixa">Caixa</option></select></label></div></div>`;
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

async function registerReceipt({ supplierName, invoiceNumber, note, lines }) {
  const name = String(supplierName || '').trim();
  if (!name) throw new Error('Informe o fornecedor.');
  if (!lines.length || lines.some(line => !line.product_id || !Number.isFinite(line.quantity) || line.quantity <= 0 || !Number.isFinite(line.unit_cost) || line.unit_cost < 0)) throw new Error('Preencha o material, a quantidade e o valor unitário em todas as linhas.');
  const savedSupplier = state.suppliers.find(item => item.active && item.name.trim().toLocaleLowerCase('pt-BR') === name.toLocaleLowerCase('pt-BR'));
  const receiptData = savedSupplier ? {
    p_supplier_id: savedSupplier.id,
    p_invoice_number: String(invoiceNumber || '').trim() || null,
    p_note: String(note || '').trim() || null,
    p_items: lines
  } : {
    p_supplier: name,
    p_invoice_number: String(invoiceNumber || '').trim() || null,
    p_note: String(note || '').trim() || null,
    p_items: lines
  };
  const { error } = await supabase.rpc('record_receipt', receiptData);
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
    return `<div class="serial-history-item"><b>${esc(item.product_name)}</b><small>${quantity(item.quantity)} ${unitName(item.unit_of_measure)} · Código: ${esc(item.product_code)}${unitCost ? ` · ${currency(unitCost)} cada · Total: ${currency(Number(item.quantity) * unitCost)}` : ''}</small></div>`;
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
  $('#registry-actions').hidden = false;
}

function renderSerials() {
  const table = $('#serials-table'), select = $('#serial-product');
  if (!table || !select) return;
  const selected = select.value;
  const serialProducts = activeProducts().filter(item => item.tracking_mode === 'serializado');
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
  const actions = item.status === 'disponivel'
    ? [['colaborador', 'Entregar para colaborador'], ['veiculo', 'Carregar em veículo'], ['instalar', 'Instalar no cliente'], ['laboratorio', 'Enviar à oficina'], ['baixar', 'Baixar / sucata']]
    : [ ...(item.status !== 'laboratorio' ? [['laboratorio', 'Enviar à oficina']] : []), ['retornar', 'Retornar ao almoxarifado'], ['baixar', 'Baixar / sucata'] ];
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
    return `<tr><td><b>${esc(itemProduct?.name || 'Item')}</b><small>Serial: ${esc(item?.serial_number || '—')} · Patrimônio: ${esc(item?.asset_tag || '—')}</small></td><td>${esc(loan.collaborator_name || state.collaborators.find(collaborator => collaborator.id === loan.collaborator_id)?.name || '—')}</td><td>${esc(loanTypeName(loan.loan_type))}</td><td>${date(loan.issued_at)}</td><td>${due}</td><td><span class="badge ${overdue ? 'out' : 'low'}">${overdue ? 'Atrasada' : 'Em aberto'}</span></td><td><div class="table-actions"><button class="secondary-button" data-print-loan="${loan.id}">Termo</button><button class="primary small-primary" data-return-loan="${loan.id}">Devolver</button></div></td></tr>`;
  }).join('') || '<tr><td colspan="7" class="empty">Nenhum empréstimo em aberto.</td></tr>';

  const loanableItems = state.serialItems.filter(item => item.status === 'disponivel');
  loanItem.innerHTML = loanableItems.map(item => {
    const itemProduct = product(item.product_id);
    return `<option value="${item.id}">${esc(itemProduct?.name || 'Item')} · ${esc(item.asset_tag || item.serial_number || item.mac_address || 'Sem identificador')}</option>`;
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
  const { data: { session } } = await supabase.auth.getSession();
  const response = await fetch('/api/users', { headers: { Authorization: `Bearer ${session.access_token}` } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Não foi possível carregar usuários.');
  state.users = Array.isArray(data) ? data : (data.users || []);
  state.usersLoadNote = data.partial ? 'Os perfis foram carregados. Para exibir todos os e-mails e administrar acessos, configure a chave segura do Supabase na Vercel.' : '';
}

async function load() {
  const [products, movements, collaborators, vehicles, locations, suppliers, serialItems, serialMovements, toolLoans, receipts, receiptItems, inventorySessions, inventoryCounts, reminders, materialRequests] = await Promise.all([
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
    supabase.from('inventory_counts').select('*').order('created_at', { ascending: false }),
    supabase.from('dashboard_reminders').select('*').order('due_date'),
    supabase.from('material_requests').select('*').order('created_at', { ascending: false })
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
  state.reminders = reminders.error ? [] : reminders.data;
  state.materialRequests = materialRequests.error ? [] : materialRequests.data;
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
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Sessão inválida. Entre novamente no sistema.');
    const response = await fetch(`/api/products?id=${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${session.access_token}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Não foi possível remover o produto.');
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
  $('#page-title').textContent = ({ dashboard:'Visão geral', products:'Produtos', movement:'Movimentações', receipts:'Recebimentos', serials:'Serial / MAC', laboratory:'Oficina', loans:'Empréstimos', inventory:'Conferência de estoque', registry:'Cadastros', users:'Usuários', statement:'Extrato financeiro' })[id];
}

document.querySelector('main').classList.add('dashboard-mode');
window.addEventListener('popstate', () => view('dashboard', { rememberReturn: false }));

function showProducts(filter = 'all') {
  state.productFilter = filter;
  $('#product-search').value = '';
  $('#product-category-filter').value = '';
  $('#product-status-filter').value = filter === 'low' ? 'low' : filter === 'ca' ? 'ca' : filter === 'expired' ? 'expired' : '';
  view('products');
  renderProducts();
}

function openProductEditor(id) {
  const item = product(id);
  if (!item) return;
  editingProductImagePath = item.image_path || null;
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
  $('#edit-average-cost').value = Number(item.average_cost || 0).toFixed(2);
  $('#edit-remove-image').dataset.removed = 'false';
  setProductImagePreview('edit', editingProductImagePath, true);
  $('#edit-product-dialog').showModal();
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
  ['users', 'receipts', 'serials', 'laboratory', 'loans', 'inventory', 'registry'].forEach(id => { $("#" + id).hidden = false; });
  $('#users').hidden = !isAdmin;
  $('#statement').hidden = !isAdmin;
  $('#add-user').hidden = !isAdmin;
  document.querySelectorAll('[data-view="users"]').forEach(button => { button.hidden = !isAdmin; });
  document.querySelectorAll('[data-view="statement"]').forEach(button => { button.hidden = !isAdmin; });
  renderAccountMenu();
  if (isAdmin) {
    renderDashboardStockValue([], true);
    void preloadDashboardStockValue();
  }
  try { await load(); } catch (error) { alert(error.message); }
}

document.querySelectorAll('.nav-link').forEach(button => button.onclick = () => button.dataset.view === 'products' ? showProducts() : view(button.dataset.view));
document.querySelectorAll('[data-go]').forEach(button => button.onclick = () => button.dataset.go === 'products' ? showProducts() : button.dataset.go === 'products-expired' ? showProducts('expired') : view(button.dataset.go));
document.querySelectorAll('[data-registry-filter]').forEach(button => button.onclick = () => setRegistryFilter(button.dataset.registryFilter));
setRegistryFilter('collaborators');
$('#add-product').onclick = () => $('#product-dialog').showModal();
$('#import-products').onclick = openProductImport;
$('#product-import-file').onchange = readProductSpreadsheet;
$('#confirm-product-import').onclick = confirmProductImport;
$('#serial-import-file').onchange = readSerialSpreadsheet;
$('#confirm-serial-import').onclick = confirmSerialImport;
$('#scan-product-code').onclick = () => openCodeScanner('products');
$('#scan-movement-code').onclick = () => openCodeScanner('movement');
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
  if (!state.serialItems.some(item => item.status === 'disponivel')) return alert('Cadastre uma unidade rastreável e disponível antes de registrar um empréstimo.');
  $('#loan-dialog').showModal();
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
$('#add-material-request').onclick = () => $('#material-request-dialog').showModal();
async function logout() {
  if (!confirm('Deseja sair da conta?')) return;
  const { error } = await supabase.auth.signOut();
  if (error) return alert(error.message);
  setAccountMenu(false);
  currentUser = null;
  state = { products: [], movements: [], users: [], usersLoadNote: '', collaborators: [], vehicles: [], locations: [], suppliers: [], serialItems: [], serialMovements: [], toolLoans: [], receipts: [], receiptItems: [], inventorySessions: [], inventoryCounts: [], reminders: [], materialRequests: [], productFilter: 'all' };
  $('#login-form').reset();
  $('#auth-gate').hidden = false;
}

$('#account-button').onclick = event => {
  event.stopPropagation();
  setAccountMenu($('#account-popover').hidden);
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
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') setAccountMenu(false); });
document.querySelectorAll('[data-close-dialog]').forEach(button => button.onclick = () => button.closest('dialog').close());
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
$('#serial-search').oninput = renderSerials;
$('#lab-search').oninput = renderLaboratory;
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
function updateMovementMode() {
  const isFieldUsage = $('#movement-type').value === 'uso_os';
  const holder = $('#movement-holder-type'), workOrder = $('#movement-work-order');
  if (isFieldUsage) holder.value = 'tecnico';
  holder.disabled = isFieldUsage;
  workOrder.required = isFieldUsage;
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
    average_cost: Number($(`#${prefix}-average-cost`).value || 0),
    requires_ca: $(`#${prefix}-requires-ca`).value === 'true',
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
    event.target.reset(); setProductImagePreview('new'); $('#product-dialog').close(); await load(); view('products');
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
    const updatedProduct = { ...collectProductData('edit'), minimum_stock:Number($('#edit-minimum').value) };
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
    $('#edit-product-dialog').close(); await load(); view('products');
  } catch (error) {
    if (uploadedImagePath) {
      try { await removeProductImage(uploadedImagePath); } catch (removeError) { console.warn('Não foi possível remover a foto enviada:', removeError.message); }
    }
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
      product_id: line.querySelector('[data-receipt-product]').value === '__new__' ? '' : line.querySelector('[data-receipt-product]').value,
      isNewProduct: line.querySelector('[data-receipt-product]').value === '__new__',
      product_name: line.querySelector('[data-receipt-new-name]').value,
      product_code: line.querySelector('[data-receipt-new-code]').value,
      category: line.querySelector('[data-receipt-new-category]').value,
      unit_of_measure: line.querySelector('[data-receipt-new-unit]').value,
      quantity: Number(line.querySelector('[data-receipt-quantity]').value),
      unit_cost: Number(line.querySelector('[data-receipt-unit-cost]').value)
    }));
    await createProductsForReceipt(lines);
    await registerReceipt({
      supplierName: $('#receipt-supplier').value,
      invoiceNumber: $('#receipt-invoice').value,
      note: $('#receipt-note').value,
      lines
    });
    $('#receipt-dialog').close();
    await load();
    view('receipts');
    alert('Recebimento registrado e estoque atualizado.');
  } catch (error) {
    alert(error.message);
  }
};

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
  event.preventDefault(); setLoginMessage();
  const { data, error } = await supabase.auth.signInWithPassword({ email:$('#login-email').value, password:$('#login-password').value });
  if (error) { setLoginMessage(error.message); return; }
  passwordRecoveryMode = false;
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
  passwordRecoveryMode = false;
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
  passwordRecoveryMode = true;
  openPasswordReset();
});
const { data:{ session } } = await supabase.auth.getSession();
const recoveryInUrl = window.location.hash.includes('type=recovery') || new URLSearchParams(window.location.search).get('type') === 'recovery';
if (session && (passwordRecoveryMode || recoveryInUrl)) {
  passwordRecoveryMode = true;
  openPasswordReset();
} else if (session) start(session); else $('#auth-gate').hidden = false;
