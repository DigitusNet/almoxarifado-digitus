-- Reverte SOMENTE os ajustes indevidos da conferência abaixo.
-- Conferência: f4f95ee1-589f-41d7-9b41-1a7265cd5a5a (Roteadores)
-- Assinatura confirmada: 101 itens corretos, 0 divergências, +22 e -104 indevidos.
-- Mantém os lançamentos originais no histórico e cria contralançamentos auditáveis.
-- É idempotente: uma segunda execução aborta antes de alterar qualquer saldo.

begin;

do $$
declare
  v_inventory public.inventory_sessions;
  v_correct integer;
  v_divergent integer;
  v_added numeric(12,3);
  v_removed numeric(12,3);
  v_movement public.movements;
  v_current numeric(12,3);
  v_original_impact numeric(12,3);
  v_next numeric(12,3);
  v_marker text := 'REVERSAO-CONFERENCIA:f4f95ee1-589f-41d7-9b41-1a7265cd5a5a';
begin
  select * into v_inventory
  from public.inventory_sessions
  where id = 'f4f95ee1-589f-41d7-9b41-1a7265cd5a5a'::uuid
    and status = 'finalizado'
  for update;

  if not found then
    raise exception 'Conferência alvo não encontrada ou não finalizada. Nada foi alterado.';
  end if;

  select
    count(*) filter (where counted_stock = expected_stock),
    count(*) filter (where counted_stock <> expected_stock)
  into v_correct, v_divergent
  from public.inventory_counts
  where inventory_id = v_inventory.id;

  if v_correct <> 101 or v_divergent <> 0 then
    raise exception 'A conferência não corresponde à assinatura 101 corretos / 0 divergências. Nada foi alterado.';
  end if;

  if exists (select 1 from public.movements where note like '%' || v_marker || '%') then
    raise exception 'Esta conferência já foi revertida anteriormente. Nada foi alterado.';
  end if;

  select
    coalesce(sum(case when movement_type = 'entrada' then quantity else 0 end), 0),
    coalesce(sum(case when movement_type = 'saida' then quantity else 0 end), 0)
  into v_added, v_removed
  from public.movements
  where recipient = 'Inventário: ' || v_inventory.title
    and created_at between v_inventory.closed_at - interval '2 minutes'
                       and v_inventory.closed_at + interval '2 minutes';

  if v_added <> 22 or v_removed <> 104 then
    raise exception 'Os ajustes localizados não correspondem a +22 / -104. Nada foi alterado.';
  end if;

  for v_movement in
    select * from public.movements
    where recipient = 'Inventário: ' || v_inventory.title
      and created_at between v_inventory.closed_at - interval '2 minutes'
                         and v_inventory.closed_at + interval '2 minutes'
    order by created_at, id
    for update
  loop
    select stock into v_current
    from public.products
    where id = v_movement.product_id
    for update;

    if not found then
      raise exception 'Produto % não encontrado. Toda a reversão foi cancelada.', v_movement.product_id;
    end if;

    v_original_impact := coalesce(
      v_movement.stock_impact,
      case when v_movement.movement_type = 'entrada' then v_movement.quantity else -v_movement.quantity end
    );
    v_next := v_current - v_original_impact;

    if v_next < 0 then
      raise exception 'A reversão deixaria o produto % com saldo negativo. Toda a reversão foi cancelada.', v_movement.product_id;
    end if;

    update public.products
    set stock = v_next,
        updated_at = now()
    where id = v_movement.product_id;

    insert into public.movements (
      product_id, movement_type, quantity, recipient, note, holder_type,
      field_usage, stock_impact, stock_before, stock_after, created_by
    ) values (
      v_movement.product_id,
      case when v_original_impact > 0 then 'saida'::public.movement_type else 'entrada'::public.movement_type end,
      abs(v_original_impact),
      'Correção da conferência: ' || v_inventory.title,
      v_marker || ' | Reversão do ajuste indevido ' || v_movement.id::text || '. Lançamento original preservado.',
      'outro', false, -v_original_impact, v_current, v_next, auth.uid()
    );
  end loop;
end;
$$;

commit;

-- Resultado somente leitura após a reversão.
select
  p.name as produto,
  m.stock_before as estoque_antes_da_reversao,
  m.stock_after as estoque_depois_da_reversao,
  m.stock_impact as impacto_da_correcao,
  m.created_at as horario,
  m.id as id_movimentacao_corretiva
from public.movements m
join public.products p on p.id = m.product_id
where m.note like '%REVERSAO-CONFERENCIA:f4f95ee1-589f-41d7-9b41-1a7265cd5a5a%'
order by p.name, m.created_at;
