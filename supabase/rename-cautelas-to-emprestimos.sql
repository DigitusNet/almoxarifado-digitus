-- Atualiza mensagens já instaladas no banco de dados.
-- Execute este arquivo uma única vez no SQL Editor do Supabase.
-- Os identificadores internos (tool_loans e o valor "cautela") permanecem para preservar os registros existentes.

create or replace function public.prevent_open_loan_serial_move()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status = 'emprestado'
    and new.status <> 'emprestado'
    and exists (select 1 from public.tool_loans where serial_item_id = old.id and returned_at is null)
    and coalesce(current_setting('app.returning_tool_loan', true), '') <> 'true' then
    raise exception 'Este equipamento possui um empréstimo em aberto. Use a devolução do empréstimo antes de movimentá-lo.';
  end if;
  return new;
end;
$$;

create or replace function public.create_tool_loan(
  p_serial_item_id uuid,
  p_collaborator_id uuid,
  p_loan_type text,
  p_due_at timestamptz default null,
  p_note text default null
) returns public.tool_loans
language plpgsql
security definer
set search_path = public
as $$
declare
  current_item public.serial_items;
  loan public.tool_loans;
  collaborator_name text;
  collaborator_location_id uuid;
  current_stock numeric;
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') not in ('admin', 'operador') then
    raise exception 'Apenas administradores e operadores podem registrar empréstimos';
  end if;
  if p_loan_type not in ('cautela', 'temporario') then raise exception 'Tipo de empréstimo inválido'; end if;
  if p_loan_type = 'temporario' and (p_due_at is null or p_due_at <= now()) then raise exception 'Informe uma data futura para a devolução prevista'; end if;

  select * into current_item from public.serial_items where id = p_serial_item_id for update;
  if not found then raise exception 'Ferramenta não encontrada'; end if;
  if current_item.status <> 'disponivel' then raise exception 'A ferramenta não está disponível para empréstimo'; end if;
  if exists (select 1 from public.tool_loans where serial_item_id = p_serial_item_id and returned_at is null) then raise exception 'Esta ferramenta já possui um empréstimo em aberto'; end if;

  select name into collaborator_name from public.collaborators where id = p_collaborator_id and active = true;
  if collaborator_name is null then raise exception 'Colaborador não encontrado ou inativo'; end if;

  select id into collaborator_location_id
  from public.stock_locations
  where location_type = 'colaborador' and collaborator_id = p_collaborator_id
  limit 1;
  if collaborator_location_id is null then
    insert into public.stock_locations (name, location_type, collaborator_id)
    values ('Colaborador: ' || collaborator_name, 'colaborador', p_collaborator_id)
    returning id into collaborator_location_id;
  end if;

  select stock into current_stock from public.products where id = current_item.product_id for update;
  if current_stock < 1 then raise exception 'O saldo do item não permite retirar esta ferramenta'; end if;
  update public.products set stock = stock - 1, updated_at = now() where id = current_item.product_id;

  insert into public.tool_loans (serial_item_id, collaborator_id, collaborator_name, loan_type, due_at, note, issued_by)
  values (p_serial_item_id, p_collaborator_id, collaborator_name, p_loan_type, p_due_at, nullif(trim(p_note), ''), auth.uid())
  returning * into loan;

  insert into public.serial_movements (
    serial_item_id, action, previous_status, new_status, from_location_id, to_location_id,
    recipient, note, created_by
  ) values (
    current_item.id, 'transferencia', current_item.status, 'emprestado', current_item.current_location_id, collaborator_location_id,
    collaborator_name, 'Empréstimo registrado' || case when nullif(trim(p_note), '') is not null then ': ' || trim(p_note) else '' end, auth.uid()
  );

  update public.serial_items
  set status = 'emprestado', current_location_id = collaborator_location_id, customer_name = null, customer_reference = null, updated_at = now()
  where id = current_item.id;

  return loan;
end;
$$;

grant execute on function public.create_tool_loan(uuid, uuid, text, timestamptz, text) to authenticated;

create or replace function public.return_tool_loan(
  p_loan_id uuid,
  p_return_condition text,
  p_return_note text default null
) returns public.tool_loans
language plpgsql
security definer
set search_path = public
as $$
declare
  loan public.tool_loans;
  current_item public.serial_items;
  central_location_id uuid;
  closed_loan public.tool_loans;
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') not in ('admin', 'operador') then
    raise exception 'Apenas administradores e operadores podem registrar devoluções';
  end if;
  if p_return_condition not in ('bom', 'avaria', 'manutencao', 'danificado') then raise exception 'Estado de devolução inválido'; end if;

  select * into loan from public.tool_loans where id = p_loan_id and returned_at is null for update;
  if not found then raise exception 'Empréstimo não encontrado ou já devolvido'; end if;
  select * into current_item from public.serial_items where id = loan.serial_item_id for update;
  if not found then raise exception 'Ferramenta não encontrada'; end if;

  select id into central_location_id from public.stock_locations where location_type = 'central' and active = true order by created_at limit 1;
  if central_location_id is null then raise exception 'Almoxarifado central não encontrado'; end if;

  update public.tool_loans
  set returned_at = now(), returned_by = auth.uid(), return_condition = p_return_condition, return_note = nullif(trim(p_return_note), '')
  where id = loan.id
  returning * into closed_loan;

  perform set_config('app.returning_tool_loan', 'true', true);
  update public.serial_items
  set status = case when p_return_condition in ('avaria', 'manutencao') then 'manutencao' when p_return_condition = 'danificado' then 'defeito' else 'disponivel' end,
      current_location_id = case when p_return_condition = 'bom' then central_location_id else null end,
      updated_at = now()
  where id = current_item.id;

  if p_return_condition = 'bom' then
    update public.products set stock = stock + 1, updated_at = now() where id = current_item.product_id;
  end if;

  insert into public.serial_movements (
    serial_item_id, action, previous_status, new_status, from_location_id, to_location_id,
    recipient, note, created_by
  ) values (
    current_item.id, 'retorno', current_item.status,
    case when p_return_condition in ('avaria', 'manutencao') then 'manutencao' when p_return_condition = 'danificado' then 'defeito' else 'disponivel' end,
    current_item.current_location_id, case when p_return_condition = 'bom' then central_location_id else null end,
    'Devolução de empréstimo', nullif(trim(p_return_note), ''), auth.uid()
  );

  return closed_loan;
end;
$$;

grant execute on function public.return_tool_loan(uuid, text, text) to authenticated;

-- Ajusta também o texto exibido em registros já criados.
update public.serial_movements
set note = regexp_replace(note, '^Cautela registrada', 'Empréstimo registrado')
where note like 'Cautela registrada%';

update public.serial_movements
set recipient = 'Devolução de empréstimo'
where recipient = 'Devolução de cautela';
