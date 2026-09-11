# Otimização de leitura e renderização — 11/09/2026

Esta atualização modifica apenas JavaScript de leitura e apresentação. Não contém SQL,
migração, alteração de saldo, mudança de status ou alteração das chamadas de escrita/RPC.
HTML e folhas de estilo existentes permanecem intactos.

## Implementação

- Carregamento sob demanda de movimentos, históricos de unidades, Serial/MAC,
  recebimentos, conferências, kits e usuários. O Dashboard consulta o número de saídas
  com `count/head`, sem transferir o histórico de movimentos.
- Na abertura, itens de recebimentos são consultados somente quando possuem validade,
  pois alimentam os alertas existentes. As demais linhas são carregadas ao acessar
  Recebimentos, Histórico ou Extrato.
- Comodatos preserva paginação real de 50 registros, com contagem no banco. Busca
  somente as unidades relacionadas à página, em uma consulta adicional de até 50 IDs.
  O cadastro completo de unidades só é necessário ao abrir o formulário de inclusão,
  preservando a busca normalizada por identificadores já existente.
- Consultas de pesquisa substituídas são canceladas. Debounce de 300 ms nas buscas
  locais pesadas; pesquisa de comodatos mantém os 400 ms existentes.
- Cache de consultas compartilhadas evita requisições simultâneas duplicadas.
  Recarregamentos já executados pelos fluxos de gravação invalidam esse cache.
  Respostas antigas de leituras invalidadas são descartadas. Logout limpa o cache.
  Não existe cache persistente ou service worker novo.
- Histórico, Recebimentos, Produtos e Serial/MAC montam trechos próximos da área
  visível, preservando os registros, filtros, ações e rolagem. Detalhes expandidos
  dos cartões do Histórico são restaurados quando o trecho volta à tela.
- Índices em memória substituem buscas repetidas entre produtos, recebimentos,
  movimentos, unidades e pendências. A linha do tempo é reutilizada enquanto suas
  fontes não mudam; continuam valendo os critérios antigos de associação e ordenação.
- A biblioteca de Excel passa a ser transferida somente ao abrir uma importação.
- O temporizador das pendências não reconstrói mais todo o Histórico a cada minuto.
- O histórico de uma unidade consulta somente eventos daquela unidade e seu
  recebimento de origem.

## Limites desta implementação

A paginação de Comodatos é feita no banco. A virtualização de Histórico,
Recebimentos, Produtos e Serial/MAC limita o DOM, mas **não equivale à paginação
dessas consultas no banco**. Histórico e Extrato ainda precisam das fontes completas
quando abertos para preservar totais, busca global e associação/deduplicação atual
entre recebimentos e movimentos. Recebimentos precisa de suas linhas para os
indicadores globais de identificação. Esses conjuntos deixaram de ser carregados
na inicialização.

O filtro de localizações de Comodatos mantém a consulta existente de duas colunas,
com limite de 10.000 linhas. Os limites anteriores das pesquisas auxiliares de IDs
(500) também foram preservados. Sua mudança exigiria validar a equivalência das
consultas de busca, além desta otimização.

Para eliminar também a transferência integral das fontes do Histórico/Extrato,
uma próxima etapa precisa de uma consulta unificada de leitura no banco que
reproduza a deduplicação atual, os filtros, os indicadores e a ordenação global
antes de paginar. Essa consulta não foi criada nem aplicada nesta atualização.

Operações locais invalidam o cache e recarregam os dados. Ao navegar depois de
30 segundos sem revalidar, o sistema consulta novamente os dados operacionais e
as dependências da aba. Não recarrega formulários em segundo plano durante a
digitação. F5 também consulta novamente o banco. Não foi acrescentada sincronização
instantânea entre computadores enquanto o usuário permanece na mesma tela.

## Verificação

- `node --check app.js` e build de produção Vite.
- `node --test tests/read-performance.test.mjs`: concorrência, invalidação, resposta
  atrasada, recuperação de erro, debounce e comparação de resultados com `beda936`.
- Comparação integral da linha do tempo incluindo recebimentos, entradas, saídas,
  instalação, devolução, repasse, prorrogação e empates de timestamp.
- Teste Chrome local com CPU limitada em 4x, 6.823 comodatos, 6.823 unidades e 6.000
  movimentos fictícios. Navegação por todas as abas e abertura de histórico de unidade.
- Na simulação: 12 requisições no início, sem baixar os históricos nem Serial/MAC;
  Comodatos requisitou intervalos 0–49 e 50–99 e as respectivas 50 unidades;
  Histórico montou 20 cartões na região inicial, em vez de 6.000.
- Associação de 400 recebimentos: aproximadamente 5x mais rápida no teste local,
  com resultados iguais. Isso é uma medição sintética, não um benchmark do computador
  do almoxarifado.

O teste de navegador requer Playwright instalado no ambiente de testes e Chrome.
Execute `node tests/browser-performance.mjs`. Se o Playwright estiver em um runtime
externo, informe seu caminho de módulo em `PLAYWRIGHT_MODULE`.
O servidor do teste usa apenas fixtures locais, sem conexão com Supabase.
