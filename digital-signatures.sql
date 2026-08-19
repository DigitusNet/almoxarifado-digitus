-- TESTE: Assinatura digital de comodatos
-- Execute este arquivo no SQL Editor do Supabase APÓS client-equipment-loans.sql.
-- Ele não altera os comodatos existentes e pode ser removido posteriormente.

create table if not exists public.digital_signatures (
  id uuid primary key default gen_random_uuid(),
  client_loan_id uuid not null references public.client_loans(id) on delete restrict,
  signer_name text not null,
  signer_document text,
  signature_data text not null,
  signed_at timestamptz not null default now(),
  signed_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Um termo assinado para cada comodato. Se for necessário assinar novamente,
-- crie uma nova saída/comodato após a devolução do equipamento.
create unique index if not exists digital_signatures_client_loan_unique
  on public.digital_signatures(client_loan_id);

alter table public.digital_signatures enable row level security;

drop policy if exists "Authenticated users can view digital signatures" on public.digital_signatures;
create policy "Authenticated users can view digital signatures"
  on public.digital_signatures for select to authenticated using (true);

drop policy if exists "Authenticated users can create digital signatures" on public.digital_signatures;
create policy "Authenticated users can create digital signatures"
  on public.digital_signatures for insert to authenticated
  with check (auth.uid() is not null and signed_by = auth.uid());

comment on table public.digital_signatures is
  'Registro operacional de assinatura desenhada em tela para comodatos. Não substitui assinatura qualificada ICP-Brasil quando ela for legalmente exigida.';
