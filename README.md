# SmartLar

Aplicação web para gerir clientes, catálogo de produtos, orçamentos, pedidos e instalações técnicas. O frontend usa React, TypeScript e Vite; os dados e regras centrais de negócio ficam no Supabase (PostgreSQL e Auth).

## Login

User: rafaelcastro@gmail.com
Password: 123456

## Tecnologias e estrutura

- `src/`: aplicação web.
- `supabase/setup.sql`: script único para instalar o banco em um projeto Supabase novo.
- `n8n/workflows/`: exemplos importáveis de automações opcionais.
- `doc.docx`: documento-fonte do projeto; não é necessário para compilar o app.

## Requisitos

- Node.js 20.19+ ou 22.12+ e npm (requisitos do Vite 7).
- Um projeto Supabase.
- GitHub e Vercel para publicação automática (opcional).
- n8n somente se for usar as notificações automatizadas (opcional).

## Executar localmente

1. Clone o repositório e entre na pasta:

   ```bash
   git clone https://github.com/gabrielborralhogomes/SmartLar.git
   cd SmartLar
   ```

2. Configure seu projeto Supabase. Para uma instalação nova, execute o script único descrito na seção [Banco de dados](#banco-de-dados).
3. Copie `.env.example` para `.env.local` e preencha as duas variáveis com os dados públicos do projeto Supabase:

   ```dotenv
   VITE_SUPABASE_URL=https://seu-projeto.supabase.co
   VITE_SUPABASE_ANON_KEY=sua-chave-publicavel
   ```

   No painel Supabase, a URL fica em **Project Settings → API**; use a chave publicável (`anon` em projetos legados ou `publishable` nos projetos que já usam o novo formato). Nunca use `service_role`/`secret` no navegador.
4. Instale e inicie:

   ```bash
   npm install
   npm run dev
   ```

5. Para validar a compilação de produção:

   ```bash
   npm run build
   npm run preview
   ```

O app abre uma tela de configuração se as variáveis não estiverem definidas. `.env.local`, `node_modules/`, `dist/` e `.vercel/` são arquivos locais ignorados pelo Git.

## Banco de dados

### Instalação

Em um projeto Supabase **novo**, crie primeiro o usuário administrador em **Authentication → Users**. Depois, abra o **SQL Editor**, cole e execute uma única vez `supabase/setup.sql`. O arquivo configura o banco completo e insere dados de demonstração.

**Não execute `setup.sql` sobre um banco existente ou com dados que deseja preservar.** Ele não é uma atualização incremental. A instalação consolidada substitui os scripts SQL anteriores; se seu projeto já está conectado ao SmartLar, ele continua funcionando e não precisa executar nada. Para bancos existentes fora desse estado, não apague nem recrie tabelas: faça backup e consulte o histórico SQL do projeto antes de qualquer alteração.

### Primeiro acesso e autenticação

1. Crie em **Authentication → Users** o usuário que terá acesso ao painel antes de executar `supabase/setup.sql`; o banco será configurado para aceitar sessões autenticadas.
2. Em **Authentication → Settings**, desative novos cadastros públicos.
3. Acesse o app com o e-mail e a senha criados no Supabase. O app não possui fluxo de cadastro público.
4. Depois de publicar, configure o endereço do site e os URLs de redirecionamento conforme a seção [Publicar na Vercel](#publicar-na-vercel).

O menu do perfil permite sair e editar nome, telefone e endereço em `configuracao_loja`. Alterações no e-mail de login dependem da confirmação do Supabase Auth.

## Publicar na Vercel

O repositório já contém `vercel.json` para declarar o build do Vite e encaminhar URLs da aplicação de página única (SPA) ao `index.html`. Não é necessário adicionar servidor Node à hospedagem: a Vercel publica o conteúdo estático gerado em `dist/`.

### Configuração inicial

1. Confirme que o banco foi instalado no projeto Supabase de produção e que o usuário de acesso foi criado.
2. Entre na Vercel e escolha **Add New → Project**.
3. Importe `gabrielborralhogomes/SmartLar` do GitHub. Use a branch `main` para produção. A configuração versionada usa:
   - Build command: `npm run build`
   - Output directory: `dist`
   - Framework: Vite
4. Em **Environment Variables**, adicione para o ambiente **Production**:
   - `VITE_SUPABASE_URL`: URL do projeto Supabase.
   - `VITE_SUPABASE_ANON_KEY`: chave publicável (`anon`/`publishable`) do mesmo projeto.
5. Faça o primeiro deploy. Ao alterar variáveis na Vercel, faça um novo deploy para que o build do frontend as incorpore.
6. Na Vercel, associe um domínio próprio se desejar; caso contrário, use o endereço `*.vercel.app` fornecido.
7. No Supabase, em **Authentication → URL Configuration**, defina a **Site URL** como o endereço de produção completo (por exemplo, `https://seu-dominio.vercel.app`). Adicione esse endereço em **Redirect URLs**. Se for permitir autenticação em previews, adicione também um padrão restrito aos previews do seu projeto Vercel; não use um wildcard amplo para domínios não confiáveis.
8. Teste o login e o fluxo principal usando o endereço publicado.

Depois da integração GitHub–Vercel, cada push para `main` cria um deploy de produção e os pushes para outras branches/PRs podem criar previews. Confirme a branch de produção e as configurações de domínio na própria Vercel.

### Segurança de variáveis

As variáveis `VITE_*` são embutidas no JavaScript entregue ao navegador. A URL e a chave **publicável** do Supabase são esperadas no frontend; as permissões e políticas do banco devem limitar o acesso. Nunca coloque `service_role`, `secret`, senha de banco, token n8n ou credencial privada em variável `VITE_*`, `.env.example`, GitHub ou código do frontend. Guarde credenciais de automação somente no gerenciador de credenciais do n8n.

## Funcionalidades e regras operacionais

- Clientes, produtos, orçamentos, pedidos e agenda técnica são armazenados no Supabase.
- Um cliente tem vários pedidos; cada pedido possui itens e pode ter vários técnicos associados.
- O subtotal do item é quantidade × preço unitário registrado na venda. O banco calcula o total do pedido.
- O fluxo de status é `orcamento → aprovado → agendado → em_andamento → concluido`. Orçamentos e pedidos aprovados também podem ser cancelados. O histórico registra as mudanças.
- A tela **Pedidos** cria orçamentos; **Gestão de pedidos** permite consultar detalhes, filtrar e avançar status.
- O agendamento sugere técnicos que sabem instalar ao menos um produto do pedido e só permite salvar uma equipe que cubra todos os produtos. Não há limite fixo de técnicos. A data deve ser futura, a duração deve ficar entre 15 e 480 minutos (padrão: 60) e o banco impede conflitos de horário para os técnicos escolhidos.
- Na tela **Técnicos**, associe a cada profissional os produtos que sabe instalar. Apenas técnicos ativos podem ser atribuídos a novas instalações. Revise e complete as associações de produtos convertidas de especialidades antigas.
- Excluir um cliente ou produto desativa o registro (`ativo = false`) para preservar histórico. Clientes desativados podem ser consultados e restaurados.
- A **Agenda técnica** exibe as instalações do dia no fuso `America/Sao_Paulo`, em ordem de horário; instalações compartilhadas aparecem para os técnicos participantes.
- A agenda não depende de OpenRouteService. Migrations antigas relacionadas a rotas continuam no histórico para compatibilidade e não devem ser apagadas.

## Automações n8n (opcionais)

Os workflows importáveis estão em `n8n/workflows/`. Eles não são necessários para compilar ou publicar o frontend.

### Notificar um novo orçamento

1. Importe `n8n/workflows/notificar-novo-orcamento.json` no n8n.
2. Copie a URL de produção do nó Webhook.
3. No Supabase, crie um Database Webhook para `public.pedidos`, evento `INSERT`, método `POST`, usando essa URL.
4. Configure projeto, destino e credenciais nos nós/credenciais do n8n. O arquivo contém marcadores `SEU-PROJETO`, `SUA-CHAVE-SERVICE-ROLE` e `SEU-ID-WEBHOOK-SITE`; substitua-os na instância, não neste repositório. O destino `webhook.site` é útil para teste; use o destino de notificação real desejado antes de produção.
5. Guarde a chave `service_role` somente como credencial privada no n8n. Configure os cabeçalhos REST `apikey` e `Authorization: Bearer` com essa credencial.
6. Ative o workflow e crie um orçamento de teste; verifique a execução e os campos enviados ao destino.

### Resumo das instalações do dia seguinte

1. Importe `n8n/workflows/alertar-instalacoes-amanha.json`.
2. Configure URL do projeto, credenciais privadas e destino de notificação na instância n8n.
3. A consulta deve selecionar a relação `pedido_tecnicos(tecnico:tecnicos!pedido_tecnicos_tecnico_id_fkey(nome))` e `duracao_instalacao_minutos` para resumir a equipe e a duração. Não selecione `pedidos.tecnico_id`: essa coluna legada não existe no esquema atual.
4. O cron executa às 08:00 em `America/Sao_Paulo`. Execute manualmente o workflow para testar sem esperar o horário agendado.
5. Ative o workflow e acompanhe as execuções no histórico do n8n. Considere configurar um Error Workflow para alertar falhas.

## Verificações antes de usar em produção

- Build local sem erros: `npm run build`.
- Variáveis da Vercel apontam para o projeto Supabase correto e usam somente a chave publicável no frontend.
- Migrations aplicadas na ordem; usuário de acesso criado; cadastros públicos desativados.
- Site URL e Redirect URLs do Supabase incluem o domínio de produção.
- Login, leitura, gravação, orçamento com vários itens, aprovação, agendamento, início e conclusão testados no deploy.
- Workflows n8n testados e ativos somente se a automação for necessária; credenciais guardadas fora do Git.
- Backup do banco configurado conforme o plano Supabase antes de dados reais.

## Problemas comuns

- **Tela de configuração do Supabase:** verifique os nomes exatos das variáveis `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`, os valores e se um novo deploy foi feito após alterá-las.
- **Login falha ou retorna a URL errada:** confira usuário/senha e os campos **Site URL**/**Redirect URLs** em **Authentication → URL Configuration**.
- **Erro de permissão ao carregar dados:** confirme que o usuário está autenticado e que o banco foi instalado no projeto correspondente.
- **Rota da aplicação retorna 404 ao atualizar:** confirme que o deploy está usando o `vercel.json` do repositório e que o output é `dist`.
- **Notificação n8n não chega:** confira se o workflow está ativo, se o Database Webhook aponta para a URL de produção, se a credencial REST do n8n está válida e se o histórico de execução mostra erro.

## Documentos e configuração local

- `.env.example` contém somente nomes e exemplos fictícios das variáveis.
- `.env.local`, credenciais n8n, tokens, chaves privadas e backups não devem ser enviados ao Git.
- `doc.docx` é mantido como documento-fonte, mas não participa da build.
- O deploy e as contas externas (Supabase, GitHub, Vercel e n8n) precisam ser configurados nos respectivos serviços. Este repositório não contém credenciais nem publica o site por conta própria.
