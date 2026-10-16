// Read-only preparation. Saving remains exclusively in the existing receipt flow.
export function validateNfeKey(raw) {
  const key = String(raw ?? '').replace(/\s/g, '');
  if (!/^\d{44}$/.test(key)) throw new Error('Informe uma chave com 44 dígitos numéricos.');
  if (/^(\d)\1{43}$/.test(key)) throw new Error('Chave de acesso inválida.');
  let sum = 0;
  for (let i = 42, weight = 2; i >= 0; i--, weight = weight === 9 ? 2 : weight + 1) sum += Number(key[i]) * weight;
  const remainder = sum % 11;
  if (Number(key[43]) !== (remainder < 2 ? 0 : 11 - remainder)) throw new Error('Dígito verificador inválido. Confira a leitura da chave.');
  if (key.slice(20, 22) !== '55') throw new Error('Esta chave não corresponde a uma NF-e modelo 55.');
  return key;
}

export async function assertNfeNotRegistered(client, key) {
  // Existing imports store the exact key in receipts.note; no new column needed.
  const { data, error } = await client.from('receipts').select('id,note').like('note', `%${key}%`).limit(1);
  if (error) throw new Error('Não foi possível verificar duplicidades. Tente novamente antes de continuar.');
  if (data?.length) throw new Error('Esta chave já consta em um recebimento. Nenhum dado foi alterado.');
}

export function setupNfeBarcode({ client, openReceipt }) {
  const anchor = document.getElementById('import-xml');
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'secondary-button';
  button.textContent = 'Ler código de barras'; button.dataset.managerOnly = ''; button.hidden = true;
  anchor.after(button);
  const dialog = document.createElement('dialog');
  dialog.innerHTML = `<div class="dialog-card product-dialog"><div class="panel-heading"><h2>Ler código de barras da NF-e</h2><button type="button" class="icon-button" aria-label="Fechar">×</button></div><p class="muted">Leia o DANFE com o leitor USB e pressione Enter, ou digite/cole a chave. Esta etapa não registra entradas no estoque.</p><form><label>Chave de acesso da NF-e<input type="text" inputmode="numeric" autocomplete="off" aria-label="Chave de acesso da NF-e" required /></label><button type="submit" class="secondary-button">Verificar chave</button></form><p role="status" aria-live="polite"></p><section hidden><p class="muted">Não há integração fiscal configurada. Consulte a NF-e no portal oficial e solicite o XML ao fornecedor. Nenhum produto ou valor será presumido.</p><p class="muted">Recebimentos antigos sem chave registrada não podem ser reconhecidos apenas pelo código. Confira também fornecedor e número da nota no XML.</p><a target="_blank" rel="noopener noreferrer">Consultar no portal oficial</a><button type="button" class="primary">Selecionar XML desta NF-e</button></section></div>`;
  document.body.append(dialog);
  const input = dialog.querySelector('input'), form = dialog.querySelector('form'), result = dialog.querySelector('[role="status"]'), section = dialog.querySelector('section');
  // No XML is required by this flow. The existing import button stays separate.
  sectionText();
  function sectionText() {
    dialog.querySelector('section .muted').textContent = 'Não há integração fiscal configurada. A chave não contém os produtos e valores. Consulte a nota no portal oficial e informe os materiais no recebimento manual.';
    dialog.querySelectorAll('section .muted')[1].textContent = 'Recebimentos antigos sem chave registrada não podem ser reconhecidos apenas pelo código. Confira também fornecedor e número da nota antes de confirmar.';
    dialog.querySelector('section button').textContent = 'Continuar com recebimento manual';
  }
  let expectedKey = null, verifiedKey = null, generation = 0;
  const clear = () => { generation++; verifiedKey = null; section.hidden = true; result.textContent = ''; };
  input.oninput = clear;
  dialog.querySelector('.icon-button').onclick = () => dialog.close();
  dialog.addEventListener('close', clear);
  button.onclick = () => { clear(); input.value = ''; dialog.showModal(); input.focus(); };
  form.onsubmit = async event => {
    event.preventDefault(); clear(); const request = generation;
    try {
      const key = validateNfeKey(input.value);
      result.textContent = 'Verificando recebimentos…';
      await assertNfeNotRegistered(client, key);
      if (request !== generation || !dialog.open) return;
      verifiedKey = key;
      result.textContent = `Chave identificada: ${key}. Validação estrutural concluída; não confirma autorização fiscal.`;
      section.querySelector('a').href = `https://www.nfe.fazenda.gov.br/portal/consultaRecaptcha.aspx?tipoConsulta=resumo&nfe=${key}`;
      section.hidden = false;
    } catch (error) { if (request === generation) result.textContent = error.message; }
  };
  section.querySelector('button').onclick = () => {
    if (!verifiedKey) return;
    const key = verifiedKey; dialog.close(); openReceipt(); expectedKey = key;
    document.getElementById('receipt-invoice').value = String(Number(key.slice(25, 34)));
    document.getElementById('receipt-note').value = `Chave NF-e: ${key}`;
    document.getElementById('receipt-supplier').focus();
  };
  document.getElementById('receipt-dialog').addEventListener('close', () => { expectedKey = null; });
  return {
    async verifyReceipt() {
      if (!expectedKey) return;
      if (document.getElementById('receipt-invoice').value.trim().replace(/^0+/, '') !== expectedKey.slice(25, 34).replace(/^0+/, '')) throw new Error('O número da nota foi alterado e não corresponde à chave lida. Confira antes de continuar.');
      await assertNfeNotRegistered(client, expectedKey);
      const note = document.getElementById('receipt-note');
      if (!note.value.includes(expectedKey)) note.value = [note.value.trim(), `Chave NF-e: ${expectedKey}`].filter(Boolean).join(' · ');
    },
    get active() { return expectedKey !== null; }
  };
}
