# Almoxarifado Digitus Net

Sistema web para controle de estoque. Para desenvolvimento, instale as dependências e use `npm run dev`.

## Configuração do Supabase

1. No painel do Supabase, abra o **SQL Editor**, cole o conteúdo de `supabase/schema.sql` e clique em **Run**.
2. Copie `.env.example` para `.env.local`.
3. Em **Project Settings > API**, preencha a URL do projeto e a chave **publishable** em `.env.local`. Nunca use uma chave `service_role` no navegador.

O banco foi preparado com usuários, perfis e permissões. O primeiro usuário administrador é criado manualmente pela instrução no fim do arquivo SQL.

## Administração de usuários

Para permitir que administradores criem e removam usuários dentro do site, publique as Edge Functions `admin-users` e `admin-products` no Supabase. Elas usam as chaves seguras já fornecidas pelo servidor do Supabase e nunca enviam nenhuma chave secreta ao navegador.

No painel do Supabase, abra **Edge Functions → Deploy a new function → Via Editor** e publique:

- `supabase/functions/admin-users/index.ts` como **admin-users**;
- `supabase/functions/admin-products/index.ts` como **admin-products**.

Mantenha a verificação de JWT ativada. As funções também validam se o usuário é administrador antes de executar qualquer ação.

## Recuperação de senha

No Supabase, abra **Authentication → URL Configuration** e adicione a URL pública do sistema em **Redirect URLs**. Assim, o link enviado por “Esqueci minha senha” volta para o sistema e permite definir a nova senha.
