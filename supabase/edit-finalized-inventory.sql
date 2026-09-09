-- Edição segura e isolada de conferências de estoque já finalizadas.
-- Não altera produtos, saldos, movimentações ou qualquer outro módulo.

alter table public.inventory_sessions
  add column if not exists edited_at timestamptz,
  add column if not exists edited_by uuid references public.profiles(id) on delete set null;

create or replace function public.edit_finalized_inventory(
  p_inventory_id uuid,
  p_title text,
  p_category text,
  p_final_note text,
  p_counts jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  product_uuid uuid;
  counted_value numeric(12,3);
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') <> 'admin' then
    raise exception 'Apenas administradores podem editar conferências finalizadas';
  end if;

  if nullif(trim(coalesce(p_title, '')), '') is null then
    raise exception 'Informe o nome da conferência';
  end if;

  perform 1 from public.inventory_sessions
  where id = p_inventory_id and status = 'finalizado'
  for update;
  if not found then
    raise exception 'Conferência finalizada não encontrada';
  end if;

  if jsonb_typeof(p_counts) <> 'array' then
    raise exception 'Contagens inválidas';
  end if;

  if jsonb_array_length(p_counts) <> (
    select count(*) from public.inventory_counts where inventory_id = p_inventory_id
  ) then
    raise exception 'A edição deve preservar todos os itens da conferência';
  end if;

  if (select count(distinct value ->> 'product_id') from jsonb_array_elements(p_counts))
     <> jsonb_array_length(p_counts) then
    raise exception 'A lista da conferência contém itens repetidos';
  end if;

  for item in select value from jsonb_array_elements(p_counts)
  loop
    product_uuid := (item ->> 'product_id')::uuid;
    counted_value := (item ->> 'counted_stock')::numeric;
    if counted_value < 0 then
      raise exception 'A quantidade contada não pode ser negativa';
    end if;

    update public.inventory_counts
    set counted_stock = counted_value,
        note = nullif(trim(item ->> 'note'), '')
    where inventory_id = p_inventory_id and product_id = product_uuid;
    if not found then
      raise exception 'Um dos itens não pertence a esta conferência';
    end if;
  end loop;

  update public.inventory_sessions
  set title = trim(p_title),
      category = nullif(trim(coalesce(p_category, '')), ''),
      final_note = nullif(trim(coalesce(p_final_note, '')), ''),
      edited_at = now(),
      edited_by = auth.uid()
  where id = p_inventory_id;
end;
$$;

revoke all on function public.edit_finalized_inventory(uuid, text, text, text, jsonb) from public;
grant execute on function public.edit_finalized_inventory(uuid, text, text, text, jsonb) to authenticated;
