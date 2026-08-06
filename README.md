# Almoxarifado Digitus Net

Sistema web para controle de estoque. Para desenvolvimento, instale as dependências e use `npm run dev`.

## Configuração do Supabase

1. No painel do Supabase, abra o **SQL Editor**, cole o conteúdo de `supabase/schema.sql` e clique em **Run**.
2. Copie `.env.example` para `.env.local`.
3. Em **Project Settings > API**, preencha a URL do projeto e a chave **publishable** em `.env.local`. Nunca use uma chave `service_role` no navegador.

O banco foi preparado com usuários, perfis e permissões. O primeiro usuário administrador é criado manualmente pela instrução no fim do arquivo SQL.
