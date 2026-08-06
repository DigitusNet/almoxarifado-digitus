-- Execute esta consulta uma única vez no Supabase: SQL Editor > New query > Run.
-- Permite que administradores apaguem uma movimentação e ajusta o estoque automaticamente.

create or replace function public.delete_movement(p_movement_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  movement public.movements;
  current_stock integer;
  adjusted_stock integer;
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') <> 'admin' then
    raise exception 'Apenas administradores podem apagar movimentações';
  end if;

  select * into movement
  from public.movements
  where id = p_movement_id
  for update;
  if not found then raise exception 'Movimentação não encontrada'; end if;

  select stock into current_stock
  from public.products
  where id = movement.product_id
  for update;
  if not found then raise exception 'Produto não encontrado'; end if;

  adjusted_stock := current_stock + case when movement.movement_type = 'saida' then movement.quantity else -movement.quantity end;
  if adjusted_stock < 0 then
    raise exception 'Não é possível apagar esta entrada porque o estoque atual ficaria negativo';
  end if;

  update public.products
  set stock = adjusted_stock,
      updated_at = now()
  where id = movement.product_id;

  delete from public.movements where id = p_movement_id;
end;
$$;

grant execute on function public.delete_movement(uuid) to authenticated;
