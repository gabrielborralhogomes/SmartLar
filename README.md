# SmartLar

Gestão de pedidos e instalações

Aplicação web para acompanhar clientes, catálogo, orçamentos, pedidos e agenda dos técnicos. O frontend usa React + TypeScript e lê/grava dados no Supabase; as regras centrais de preço e avanço de status também são aplicadas no PostgreSQL.

## Rodar localmente

1. Crie um projeto Supabase e execute, em ordem, os arquivos `supabase/migrations/20261001000000_smartlar.sql`, `supabase/migrations/20261001140000_smartlar_improvements.sql`, `supabase/migrations/20261001141500_remove_legacy_endereco.sql`, `supabase/migrations/20261001142000_soft_delete_client.sql`, `supabase/migrations/20261001142500_require_basic_client_address.sql`, `supabase/migrations/20261001143000_auth_and_store_profile.sql`, `supabase/migrations/20261001144500_route_optimization.sql`, `supabase/migrations/20261001144600_technician_skills_and_fixed_routes.sql`, `supabase/migrations/20261001144700_manage_technicians.sql`, `supabase/migrations/20261001144800_remove_legacy_technician_column.sql`, `supabase/migrations/20261002100000_prevent_schedule_conflicts_and_add_technician_categories.sql`, `supabase/migrations/20261002110000_technician_product_expertise.sql` e `supabase/migrations/20261002120000_remove_technician_assignment_limit.sql` no SQL Editor. Em um projeto existente, execute somente as migrations ainda não aplicadas.
2. Copie `.env.example` para `.env.local` e preencha `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` com as credenciais públicas do projeto.
3. Instale as dependências com `npm install`.
4. Inicie com `npm run dev`. Para validar a build de produção, execute `npm run build`.

A migration inicial cria e relaciona as tabelas, valida as transições de status, registra o histórico, calcula totais no banco e insere dados de demonstração: 5 clientes, Lucas e Pedro, 6 produtos e 8 pedidos. O primeiro pedido de exemplo contém 2 câmeras IP (R$ 450 cada) e 1 sensor (R$ 180), totalizando R$ 1.080. A migration incremental adiciona campos estruturados para endereço e impede novos agendamentos ou alterações de data para horários passados, sem alterar agendamentos históricos. A migration seguinte copia qualquer endereço legado ainda não estruturado para `rua`, depois remove a coluna antiga `endereco`.

## Estrutura e regras

- `clientes` 1:N `pedidos`; `pedido_tecnicos` associa um ou mais técnicos a cada instalação.
- `pedidos` 1:N `itens_pedido`; cada item referencia um produto e guarda o preço praticado no momento da venda. Uma instalação pode ser atribuída a qualquer número de técnicos.
- `subtotal` é uma coluna gerada (`quantidade × preço unitário`); um trigger soma os subtotais em `pedidos.valor_total`.
- `criar_pedido_com_itens` insere o orçamento e seus itens dentro da mesma transação.
- Os status só avançam por `orcamento → aprovado → agendado → em_andamento → concluido`. Orçamentos e pedidos aprovados podem ser cancelados. A instalação exige equipe em `pedido_tecnicos` e data.
- `historico_status` guarda cada status, inclusive o inicial.
- Endereços são separados em rua, número, complemento opcional e bairro. Rua, número e bairro são obrigatórios para novos clientes e alterações de endereço; os campos opcionais cidade, estado e CEP não são armazenados. Registros antigos incompletos permanecem preservados até serem corrigidos.
- A tela **Pedidos** serve para criar orçamentos; **Gestão de pedidos** concentra filtros, detalhes e avanço de status. O agendamento sugere técnicos que sabem instalar ao menos um dos produtos do pedido e exige que a equipe escolhida cubra todos eles, sem limite de quantidade, uma data/hora futura e duração entre 15 e 480 minutos (padrão: 60). O sistema impede conflitos de horário para os técnicos selecionados, inclusive em tentativas simultâneas.
- A tela **Técnicos** permite cadastrar técnicos ativos e selecionar ou editar os produtos que sabem instalar. Os produtos associados aparecem no cadastro do técnico e determinam quais instalações podem ser atribuídas a cada profissional. A migration converte as associações antigas de especialidades sempre que elas identificam produtos; revise os vínculos convertidos e complete os que faltarem na edição do técnico. Apenas técnicos ativos podem ser atribuídos a novas instalações.
- Produtos são excluídos do catálogo por desativação (`ativo = false`), preservando itens e preços dos pedidos históricos.
- Clientes também são excluídos por desativação (`ativo = false`), preservando os pedidos existentes. Clientes excluídos podem ser consultados e restaurados na tela de clientes.
- O painel exige login por e-mail e senha via Supabase Auth. Crie o usuário do Rafael em **Authentication → Users → Add user** antes de aplicar a migration que restringe o banco e desative novos cadastros em **Authentication → Settings**. Não há cadastro público no app.
- O menu do perfil permite sair e abrir as configurações da loja. O nome, telefone e endereço ficam em `configuracao_loja`; a troca do e-mail de login usa confirmação do Supabase Auth.
- A Agenda técnica lista as instalações de hoje, no fuso de São Paulo, em ordem crescente de horário. É possível alternar entre Lucas e Pedro; instalações compartilhadas aparecem na agenda de ambos. A tela permite iniciar e concluir cada instalação.
- Não é necessário configurar OpenRouteService para consultar a Agenda. As migrations históricas de rota permanecem para compatibilidade com bancos que já as aplicaram; seus campos de cidade/UF e valores existentes no perfil da loja são preservados, embora não sejam mais usados pelo app.
- Para substituir explicitamente os dados de demonstração atuais pelos cenários de rota de São Paulo, execute `supabase/demo/reset_route_demo.sql` no SQL Editor **depois das migrations**. O script apaga clientes, pedidos, itens, vínculos de técnicos e histórico, além de recriar produtos e técnicos. Ele preserva usuários do Supabase Auth e as configurações/endereço da loja; não execute em um banco que contenha dados reais que deseja manter. Os nomes/telefones/e-mails dos fixtures são fictícios, e os endereços são apenas referências para teste de geocodificação.
- A migration de autenticação remove o acesso `anon` às tabelas operacionais. Para os workflows n8n continuarem consultando o REST do Supabase, configure uma credencial HTTP segura no n8n com a chave `service_role` do projeto (somente no n8n, nunca no frontend); atualize `apikey` e `Authorization: Bearer` dos nós de consulta. Revise também os workflows já configurados na instância.
- Depois de aplicar a migration, entre no painel com o e-mail e a senha da conta criada no Supabase.

## n8n

Os arquivos importáveis estão em `n8n/workflows/`.

### Novo orçamento

1. Importe `notificar-novo-orcamento.json` no n8n.
2. Copie a URL de produção do nó Webhook.
3. No Supabase, crie um Database Webhook para `public.pedidos`, evento `INSERT`, apontando para essa URL e usando `POST`.
4. Nos nós HTTP Request, substitua `SEU-PROJETO`, `SUA-CHAVE-SERVICE-ROLE` e `SEU-ID-WEBHOOK-SITE`. Configure a chave de serviço somente nos cabeçalhos `apikey` e `Authorization: Bearer` do n8n; não a grave no repositório nem no frontend.
5. Ative o workflow. Crie um orçamento pelo app e confirme no webhook.site os campos do pedido, nome do cliente, valor e data.

### Instalações do dia seguinte

1. Importe `alertar-instalacoes-amanha.json`.
2. Substitua os mesmos marcadores de projeto/chave/destino. Se o workflow já estiver configurado na sua instância, atualize a consulta para incluir a relação `pedido_tecnicos(tecnico:tecnicos!pedido_tecnicos_tecnico_id_fkey(nome))` e o campo `duracao_instalacao_minutos`, para incluir toda a equipe no resumo. Não selecione `pedidos.tecnico_id`: a migration final remove essa coluna legada.
3. O cron está configurado para as 08:00 (`America/Sao_Paulo`). O workflow consulta o endpoint REST do Supabase e envia um resumo se houver instalações no dia seguinte; sem instalações, não envia uma mensagem vazia.
4. Ative o workflow. Para testar sem esperar o cron, use **Execute workflow** e confira o histórico de execução.

Em ambos os workflows, configure o destino externo antes de ativar e considere associar um Error Workflow no n8n para notificar falhas de execução. Nunca use a chave `service_role` no frontend. A migration de autenticação restringe o banco a sessões autenticadas; a chave de serviço só deve ficar guardada como credencial privada no n8n. Em bancos existentes, atualize primeiro a consulta do workflow ativo de instalações para remover a relação legada `pedidos_tecnico_id_fkey`; depois aplique a migration `20261001144800_remove_legacy_technician_column.sql`.

## Próximos passos para a entrega do teste

- Configurar o projeto Supabase e as variáveis locais.
- Importar, configurar e ativar os workflows; guardar prints das telas e execuções.
- Rodar o fluxo completo: cliente → orçamento com múltiplos itens → aprovação → agendamento → início → conclusão.
- Publicar o frontend (por exemplo, Vercel/Netlify). O código fica no repositório GitHub configurado para este projeto.
- Preparar o documento final com links, evidências e explicações das decisões técnicas e do uso de IA.

Este diretório não inclui credenciais, nem cria contas ou deploys externos. O app abre uma tela de configuração quando as variáveis do Supabase ainda não estão definidas.
