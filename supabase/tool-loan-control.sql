-- Controle completo de empréstimos temporários de ferramentas e patrimônios.
-- Execute este arquivo inteiro no SQL Editor do Supabase.
-- Preserva todos os empréstimos já cadastrados.

alter table public.tool_loans
  add column if not exists issued_by_name text,
  add column if not exists returned_by_name text;

update public.tool_loans loan
set issued_by_name = profile.full_name
from public.profiles profile
where loan.issued_by = profile.id and loan.issued_by_name is null;

update public.tool_loans loan
set returned_by_name = profile.full_name
from public.profiles profile
where loan.returned_by = profile.id and loan.returned_by_name is null;

drop function if exists public.create_tool_loan(uuid, uuid, text, timestamptz, text);
drop function if exists public.create_tool_loan(uuid, uuid, timestamptz, timestamptz, text);

create function public.create_tool_loan(
  p_serial_item_id uuid,
  p_collaborator_id uuid,
  p_issued_at timestamptz,
  p_due_at timestamptz,
  p_note text default null
) returns public.tool_loans
language plpgsql
security definer
set search_path = public
as $$
declare
  current_item public.serial_items;
  saved_loan public.tool_loans;
  responsible_name text;
  operator_name text;
  collaborator_location_id uuid;
  current_stock numeric;
  conflicting_name text;
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') not in ('admin', 'operador') then
    raise exception 'Apenas administradores e operadores podem registrar empréstimos';
  end if;
  if p_issued_at is null then raise exception 'Informe a data e hora da retirada'; end if;
  if p_due_at is null then raise exception 'Informe a data e hora limite para devolução'; end if;
  if p_due_at <= p_issued_at then raise exception 'O prazo deve ser posterior à retirada'; end if;

  select * into current_item from public.serial_items where id = p_serial_item_id for update;
  if not found then raise exception 'Equipamento patrimonial não encontrado'; end if;
  if current_item.status <> 'disponivel' then
    select collaborator_name into conflicting_name
    from public.tool_loans where serial_item_id = p_serial_item_id and returned_at is null
    order by issued_at desc limit 1;
    if conflicting_name is not null then
      raise exception 'Este equipamento já está emprestado para %.', conflicting_name;
    end if;
    raise exception 'Este equipamento não está disponível no almoxarifado';
  end if;

  select collaborator_name into conflicting_name
  from public.tool_loans where serial_item_id = p_serial_item_id and returned_at is null
  order by issued_at desc limit 1;
  if conflicting_name is not null then raise exception 'Este equipamento já está emprestado para %.', conflicting_name; end if;

  select name into responsible_name from public.collaborators where id = p_collaborator_id and active = true;
  if responsible_name is null then raise exception 'Técnico não encontrado ou inativo'; end if;
  select full_name into operator_name from public.profiles where id = auth.uid();

  select id into collaborator_location_id from public.stock_locations
  where location_type = 'colaborador' and collaborator_id = p_collaborator_id limit 1;
  if collaborator_location_id is null then
    insert into public.stock_locations (name, location_type, collaborator_id)
    values ('Colaborador: ' || responsible_name, 'colaborador', p_collaborator_id)
    returning id into collaborator_location_id;
  end if;

  select stock into current_stock from public.products where id = current_item.product_id for update;
  if coalesce(current_stock, 0) < 1 then raise exception 'O saldo do item não permite retirar este equipamento'; end if;
  update public.products set stock = stock - 1, updated_at = now() where id = current_item.product_id;

  insert into public.tool_loans (
    serial_item_id, collaborator_id, collaborator_name, loan_type, issued_at, due_at,
    note, issued_by, issued_by_name
  ) values (
    p_serial_item_id, p_collaborator_id, responsible_name, 'temporario', p_issued_at, p_due_at,
    nullif(trim(p_note), ''), auth.uid(), coalesce(nullif(trim(operator_name), ''), 'Usuário do sistema')
  ) returning * into saved_loan;

  insert into public.serial_movements (
    serial_item_id, action, previous_status, new_status, from_location_id, to_location_id,
    recipient, note, created_by
  ) values (
    current_item.id, 'transferencia', current_item.status, 'emprestado', current_item.current_location_id,
    collaborator_location_id, responsible_name,
    'Empréstimo patrimonial até ' || to_char(p_due_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') ||
      case when nullif(trim(p_note), '') is not null then ' · ' || trim(p_note) else '' end,
    auth.uid()
  );

  update public.serial_items set status = 'emprestado', current_location_id = collaborator_location_id,
    customer_name = null, customer_reference = null, updated_at = now() where id = current_item.id;
  return saved_loan;
end;
$$;

grant execute on function public.create_tool_loan(uuid, uuid, timestamptz, timestamptz, text) to authenticated;

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
  saved_loan public.tool_loans;
  current_item public.serial_items;
  central_location_id uuid;
  closed_loan public.tool_loans;
  operator_name text;
  target_status text;
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') not in ('admin', 'operador') then
    raise exception 'Apenas administradores e operadores podem registrar devoluções';
  end if;
  if p_return_condition not in ('bom', 'avaria', 'manutencao', 'danificado') then raise exception 'Estado de devolução inválido'; end if;

  select * into saved_loan from public.tool_loans where id = p_loan_id and returned_at is null for update;
  if not found then raise exception 'Empréstimo não encontrado ou já devolvido'; end if;
  select * into current_item from public.serial_items where id = saved_loan.serial_item_id for update;
  if not found then raise exception 'Equipamento patrimonial não encontrado'; end if;
  select id into central_location_id from public.stock_locations where location_type = 'central' and active = true order by created_at limit 1;
  if central_location_id is null then raise exception 'Almoxarifado central não encontrado'; end if;
  select full_name into operator_name from public.profiles where id = auth.uid();

  target_status := case when p_return_condition in ('avaria', 'manutencao') then 'manutencao' when p_return_condition = 'danificado' then 'defeito' else 'disponivel' end;
  update public.tool_loans set returned_at = now(), returned_by = auth.uid(),
    returned_by_name = coalesce(nullif(trim(operator_name), ''), 'Usuário do sistema'),
    return_condition = p_return_condition, return_note = nullif(trim(p_return_note), '')
  where id = saved_loan.id returning * into closed_loan;

  perform set_config('app.returning_tool_loan', 'true', true);
  update public.serial_items set status = target_status,
    current_location_id = case when target_status = 'disponivel' then central_location_id else null end,
    updated_at = now() where id = current_item.id;

  if target_status = 'disponivel' then
    update public.products set stock = stock + 1, updated_at = now() where id = current_item.product_id;
  end if;

  insert into public.serial_movements (
    serial_item_id, action, previous_status, new_status, from_location_id, to_location_id,
    recipient, note, created_by
  ) values (
    current_item.id, 'retorno', current_item.status, target_status, current_item.current_location_id,
    case when target_status = 'disponivel' then central_location_id else null end,
    'Devolução de empréstimo patrimonial', nullif(trim(p_return_note), ''), auth.uid()
  );
  return closed_loan;
end;
$$;

grant execute on function public.return_tool_loan(uuid, text, text) to authenticated;
