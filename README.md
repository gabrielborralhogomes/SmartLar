# SmartLar

Gestão de pedidos e instalações

Aplicação web para acompanhar clientes, catálogo, orçamentos, pedidos e agenda dos técnicos. O frontend usa React + TypeScript e lê/grava dados no Supabase; as regras centrais de preço e avanço de status também são aplicadas no PostgreSQL.

## Rodar localmente

1. Crie um projeto Supabase e execute, em ordem, os arquivos `supabase/migrations/20261001000000_smartlar.sql`, `supabase/migrations/20261001140000_smartlar_improvements.sql`, `supabase/migrations/20261001141500_remove_legacy_endereco.sql`, `supabase/migrations/20261001142000_soft_delete_client.sql` e `supabase/migrations/20261001142500_require_basic_client_address.sql` no SQL Editor. Se o projeto já aplicou as migrations anteriores, execute somente as que ainda não aplicou.
2. Copie `.env.example` para `.env.local` e preencha `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` com as credenciais públicas do projeto.
3. Instale as dependências com `npm install`.
4. Inicie com `npm run dev`. Para validar a build de produção, execute `npm run build`.

A migration inicial cria e relaciona as tabelas, valida as transições de status, registra o histórico, calcula totais no banco e insere dados de demonstração: 5 clientes, Lucas e Pedro, 6 produtos e 8 pedidos. O primeiro pedido de exemplo contém 2 câmeras IP (R$ 450 cada) e 1 sensor (R$ 180), totalizando R$ 1.080. A migration incremental adiciona campos estruturados para endereço e impede novos agendamentos ou alterações de data para horários passados, sem alterar agendamentos históricos. A migration seguinte copia qualquer endereço legado ainda não estruturado para `rua`, depois remove a coluna antiga `endereco`.

## Estrutura e regras

- `clientes` 1:N `pedidos`; `tecnicos` 1:N `pedidos`.
- `pedidos` 1:N `itens_pedido`; cada item referencia um produto e guarda o preço praticado no momento da venda.
- `subtotal` é uma coluna gerada (`quantidade × preço unitário`); um trigger soma os subtotais em `pedidos.valor_total`.
- `criar_pedido_com_itens` insere o orçamento e seus itens dentro da mesma transação.
- Os status só avançam por `orcamento → aprovado → agendado → em_andamento → concluido`. Orçamentos e pedidos aprovados podem ser cancelados. A instalação exige técnico e data.
- `historico_status` guarda cada status, inclusive o inicial.
- Endereços são separados em rua, número, complemento opcional e bairro. Rua, número e bairro são obrigatórios para novos clientes e alterações de endereço; os campos opcionais cidade, estado e CEP não são armazenados. Registros antigos incompletos permanecem preservados até serem corrigidos.
- A tela **Pedidos** serve para criar orçamentos; **Gestão de pedidos** concentra filtros, detalhes e avanço de status. A data e o técnico são obrigatórios ao agendar.
- Produtos são excluídos do catálogo por desativação (`ativo = false`), preservando itens e preços dos pedidos históricos.
- Clientes também são excluídos por desativação (`ativo = false`), preservando os pedidos existentes. Clientes excluídos podem ser consultados e restaurados na tela de clientes.

## n8n

Os arquivos importáveis estão em `n8n/workflows/`.

### Novo orçamento

1. Importe `notificar-novo-orcamento.json` no n8n.
2. Copie a URL de produção do nó Webhook.
3. No Supabase, crie um Database Webhook para `public.pedidos`, evento `INSERT`, apontando para essa URL e usando `POST`.
4. Nos nós HTTP Request, substitua os marcadores `SEU-PROJETO`, `SUA-CHAVE-ANON` e `SEU-ID-WEBHOOK-SITE`. Para provar o recebimento, crie um endpoint gratuito em webhook.site e use a URL atribuída.
5. Ative o workflow. Crie um orçamento pelo app e confirme no webhook.site os campos do pedido, nome do cliente, valor e data.

### Instalações do dia seguinte

1. Importe `alertar-instalacoes-amanha.json`.
2. Substitua os mesmos marcadores de projeto/chave/destino.
3. O cron está configurado para as 08:00 (`America/Sao_Paulo`). O workflow consulta o endpoint REST do Supabase e envia um resumo se houver instalações no dia seguinte; sem instalações, não envia uma mensagem vazia.
4. Ative o workflow. Para testar sem esperar o cron, use **Execute workflow** e confira o histórico de execução.

Em ambos os workflows, configure o destino externo antes de ativar e considere associar um Error Workflow no n8n para notificar falhas de execução. Não use a chave `service_role` no frontend. Para este teste, as políticas RLS são abertas para `anon` e `authenticated`, identificadas como demonstração; substitua por políticas com autenticação antes de qualquer uso com dados reais.

## Próximos passos para a entrega do teste

- Configurar o projeto Supabase e as variáveis locais.
- Importar, configurar e ativar os workflows; guardar prints das telas e execuções.
- Rodar o fluxo completo: cliente → orçamento com múltiplos itens → aprovação → agendamento → início → conclusão.
- Publicar o frontend (por exemplo, Vercel/Netlify). O código fica no repositório GitHub configurado para este projeto.
- Preparar o documento final com links, evidências e explicações das decisões técnicas e do uso de IA.

Este diretório não inclui credenciais, nem cria contas ou deploys externos. O app abre uma tela de configuração quando as variáveis do Supabase ainda não estão definidas.
