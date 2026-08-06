-- Remoção segura de colaboradores e veículos.
-- Execute este arquivo inteiro no SQL Editor do Supabase.

create or replace function public.delete_collaborator(p_collaborator_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  collaborator_name text;
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') not in ('admin', 'operador') then
    raise exception 'Apenas administradores e operadores podem remover colaboradores';
  end if;

  select name into collaborator_name from public.collaborators where id = p_collaborator_id;
  if collaborator_name is null then raise exception 'Colaborador não encontrado'; end if;

  if exists (
    select 1
    from public.serial_items serial_item
    join public.stock_locations location on location.id = serial_item.current_location_id
    where location.location_type = 'colaborador' and location.collaborator_id = p_collaborator_id
  ) then
    raise exception 'Não é possível remover % enquanto houver equipamentos vinculados a ele. Transfira ou devolva os equipamentos primeiro.', collaborator_name;
  end if;

  delete from public.stock_locations
  where location_type = 'colaborador' and collaborator_id = p_collaborator_id;

  delete from public.collaborators where id = p_collaborator_id;
end;
$$;

grant execute on function public.delete_collaborator(uuid) to authenticated;

create or replace function public.delete_vehicle(p_vehicle_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  vehicle_name text;
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') not in ('admin', 'operador') then
    raise exception 'Apenas administradores e operadores podem remover veículos';
  end if;

  select name into vehicle_name from public.vehicles where id = p_vehicle_id;
  if vehicle_name is null then raise exception 'Veículo não encontrado'; end if;

  if exists (
    select 1
    from public.serial_items serial_item
    join public.stock_locations location on location.id = serial_item.current_location_id
    where location.location_type = 'veiculo' and location.vehicle_id = p_vehicle_id
  ) then
    raise exception 'Não é possível remover % enquanto houver equipamentos vinculados a ele. Transfira ou devolva os equipamentos primeiro.', vehicle_name;
  end if;

  delete from public.stock_locations
  where location_type = 'veiculo' and vehicle_id = p_vehicle_id;

  delete from public.vehicles where id = p_vehicle_id;
end;
$$;

grant execute on function public.delete_vehicle(uuid) to authenticated;
