create extension if not exists pgcrypto;

create type public.pedido_status as enum (
  'orcamento',
  'aprovado',
  'agendado',
  'em_andamento',
  'concluido',
  'cancelado'
);

create table public.clientes (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (length(trim(nome)) > 0),
  telefone text not null check (length(trim(telefone)) > 0),
  email text unique,
  endereco text not null check (length(trim(endereco)) > 0),
  created_at timestamptz not null default now()
);

create table public.tecnicos (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (length(trim(nome)) > 0),
  telefone text not null,
  especialidade text not null,
  created_at timestamptz not null default now()
);

create table public.produtos (
  id uuid primary key default gen_random_uuid(),
  nome text not null unique,
  categoria text not null,
  preco_unitario numeric(12, 2) not null check (preco_unitario >= 0),
  descricao text not null default '',
  ativo boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.pedidos (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references public.clientes(id) on delete restrict,
  tecnico_id uuid references public.tecnicos(id) on delete restrict,
  status public.pedido_status not null default 'orcamento',
  data_instalacao timestamptz,
  valor_total numeric(12, 2) not null default 0 check (valor_total >= 0),
  forma_pagamento text,
  observacoes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pedido_agendado_tem_tecnico_e_data
    check (status not in ('agendado', 'em_andamento', 'concluido') or (tecnico_id is not null and data_instalacao is not null))
);

create table public.itens_pedido (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references public.pedidos(id) on delete cascade,
  produto_id uuid not null references public.produtos(id) on delete restrict,
  quantidade integer not null check (quantidade > 0),
  preco_unitario numeric(12, 2) not null check (preco_unitario >= 0),
  subtotal numeric(14, 2) generated always as (quantidade * preco_unitario) stored
);

create table public.historico_status (
  id bigint generated always as identity primary key,
  pedido_id uuid not null references public.pedidos(id) on delete cascade,
  status public.pedido_status not null,
  alterado_em timestamptz not null default now()
);

create index pedidos_status_data_idx on public.pedidos(status, data_instalacao);
create index pedidos_cliente_idx on public.pedidos(cliente_id);
create index itens_pedido_pedido_idx on public.itens_pedido(pedido_id);
create index historico_status_pedido_idx on public.historico_status(pedido_id, alterado_em desc);

create function public.validar_fluxo_pedido()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' and new.status <> 'orcamento' then
    raise exception 'Um pedido novo deve começar como orçamento.';
  end if;

  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if not (
      (old.status = 'orcamento' and new.status in ('aprovado', 'cancelado'))
      or (old.status = 'aprovado' and new.status in ('agendado', 'cancelado'))
      or (old.status = 'agendado' and new.status = 'em_andamento')
      or (old.status = 'em_andamento' and new.status = 'concluido')
    ) then
      raise exception 'Transição de status inválida: % -> %.', old.status, new.status;
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger pedidos_validar_fluxo
before insert or update of status, tecnico_id, data_instalacao on public.pedidos
for each row execute function public.validar_fluxo_pedido();

create function public.registrar_historico_status()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.historico_status (pedido_id, status)
    values (new.id, new.status);
  elsif new.status is distinct from old.status then
    insert into public.historico_status (pedido_id, status)
    values (new.id, new.status);
  end if;
  return new;
end;
$$;

create trigger pedidos_historico_status
after insert or update of status on public.pedidos
for each row execute function public.registrar_historico_status();

create function public.recalcular_total_pedido()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_pedido_id uuid;
begin
  v_pedido_id := case when tg_op = 'DELETE' then old.pedido_id else new.pedido_id end;
  update public.pedidos
  set valor_total = coalesce(
    (select sum(subtotal) from public.itens_pedido where pedido_id = v_pedido_id),
    0
  )
  where id = v_pedido_id;

  if tg_op = 'UPDATE' and old.pedido_id is distinct from new.pedido_id then
    update public.pedidos
    set valor_total = coalesce(
      (select sum(subtotal) from public.itens_pedido where pedido_id = old.pedido_id),
      0
    )
    where id = old.pedido_id;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger itens_pedido_recalcular_total
after insert or update or delete on public.itens_pedido
for each row execute function public.recalcular_total_pedido();

create function public.criar_pedido_com_itens(
  p_cliente_id uuid,
  p_observacoes text,
  p_itens jsonb
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_pedido_id uuid;
  v_inseridos integer;
begin
  if p_itens is null or jsonb_typeof(p_itens) <> 'array' or jsonb_array_length(p_itens) = 0 then
    raise exception 'Adicione pelo menos um produto ao pedido.';
  end if;

  insert into public.pedidos (cliente_id, observacoes)
  values (p_cliente_id, coalesce(p_observacoes, ''))
  returning id into v_pedido_id;

  insert into public.itens_pedido (pedido_id, produto_id, quantidade, preco_unitario)
  select v_pedido_id, p.id, item.quantidade, p.preco_unitario
  from jsonb_to_recordset(p_itens) as item(produto_id uuid, quantidade integer)
  join public.produtos p on p.id = item.produto_id and p.ativo;

  get diagnostics v_inseridos = row_count;
  if v_inseridos <> jsonb_array_length(p_itens) then
    raise exception 'Um ou mais produtos não existem ou estão inativos.';
  end if;

  return v_pedido_id;
end;
$$;

grant execute on function public.criar_pedido_com_itens(uuid, text, jsonb) to anon, authenticated;

alter table public.clientes enable row level security;
alter table public.tecnicos enable row level security;
alter table public.produtos enable row level security;
alter table public.pedidos enable row level security;
alter table public.itens_pedido enable row level security;
alter table public.historico_status enable row level security;

-- Acesso aberto somente para a demonstração técnica; antes de produção, troque por políticas autenticadas por usuário/empresa.
create policy "demo acesso clientes" on public.clientes for all to anon, authenticated using (true) with check (true);
create policy "demo acesso tecnicos" on public.tecnicos for all to anon, authenticated using (true) with check (true);
create policy "demo acesso produtos" on public.produtos for all to anon, authenticated using (true) with check (true);
create policy "demo acesso pedidos" on public.pedidos for all to anon, authenticated using (true) with check (true);
create policy "demo acesso itens" on public.itens_pedido for all to anon, authenticated using (true) with check (true);
create policy "demo acesso historico" on public.historico_status for all to anon, authenticated using (true) with check (true);

insert into public.tecnicos (id, nome, telefone, especialidade) values
  ('10000000-0000-4000-8000-000000000001', 'Lucas', '(11) 98888-1001', 'Câmeras e sensores'),
  ('10000000-0000-4000-8000-000000000002', 'Pedro', '(11) 98888-1002', 'Fechaduras e iluminação')
on conflict (id) do nothing;

insert into public.clientes (id, nome, telefone, email, endereco) values
  ('20000000-0000-4000-8000-000000000001', 'Mariana Costa', '(11) 99911-2201', 'mariana@example.com', 'Rua das Flores, 120, Pinheiros, São Paulo - SP'),
  ('20000000-0000-4000-8000-000000000002', 'André Martins', '(11) 99911-2202', 'andre@example.com', 'Av. Paulista, 845, Bela Vista, São Paulo - SP'),
  ('20000000-0000-4000-8000-000000000003', 'Camila Souza', '(11) 99911-2203', 'camila@example.com', 'Rua Harmonia, 56, Vila Madalena, São Paulo - SP'),
  ('20000000-0000-4000-8000-000000000004', 'Rogério Lima', '(11) 99911-2204', 'rogerio@example.com', 'Alameda Santos, 410, Jardins, São Paulo - SP'),
  ('20000000-0000-4000-8000-000000000005', 'Beatriz Nunes', '(11) 99911-2205', 'beatriz@example.com', 'Rua Cayowaá, 980, Perdizes, São Paulo - SP')
on conflict (id) do nothing;

insert into public.produtos (id, nome, categoria, preco_unitario, descricao) values
  ('30000000-0000-4000-8000-000000000001', 'Câmera IP Wi-Fi', 'Segurança', 450.00, 'Câmera Full HD com visão noturna'),
  ('30000000-0000-4000-8000-000000000002', 'Sensor de presença', 'Segurança', 180.00, 'Sensor inteligente de movimento'),
  ('30000000-0000-4000-8000-000000000003', 'Fechadura digital', 'Segurança', 890.00, 'Acesso por senha e cartão'),
  ('30000000-0000-4000-8000-000000000004', 'Lâmpada inteligente RGB', 'Iluminação', 95.00, 'Lâmpada Wi-Fi dimerizável'),
  ('30000000-0000-4000-8000-000000000005', 'Interruptor smart', 'Iluminação', 160.00, 'Interruptor inteligente de duas teclas'),
  ('30000000-0000-4000-8000-000000000006', 'Hub de automação', 'Automação', 520.00, 'Central de controle para dispositivos')
on conflict (id) do nothing;

do $$
declare
  v_pedido uuid;
begin
  if exists (select 1 from public.pedidos) then
    return;
  end if;

  insert into public.pedidos (id, cliente_id, observacoes, created_at) values
    ('40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Orçamento para monitoramento da entrada.', now()),
    ('40000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'Avaliar compatibilidade com o portão existente.', now()),
    ('40000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000003', 'Instalar câmera e sensor no acesso lateral.', now() - interval '2 days'),
    ('40000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000004', 'Troca de fechadura e configuração.', now() - interval '3 days'),
    ('40000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000005', 'Agendar instalação de iluminação da sala.', now()),
    ('40000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000001', 'Automação da iluminação e assistente.', now() - interval '6 days'),
    ('40000000-0000-4000-8000-000000000007', '20000000-0000-4000-8000-000000000002', 'Instalação concluída e testada.', now() - interval '10 days'),
    ('40000000-0000-4000-8000-000000000008', '20000000-0000-4000-8000-000000000003', 'Cliente optou por aguardar a reforma.', now() - interval '12 days');

  insert into public.itens_pedido (pedido_id, produto_id, quantidade, preco_unitario) values
    ('40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 2, 450.00),
    ('40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002', 1, 180.00),
    ('40000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000003', 1, 890.00),
    ('40000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000001', 2, 450.00),
    ('40000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000002', 1, 180.00),
    ('40000000-0000-4000-8000-000000000004', '30000000-0000-4000-8000-000000000003', 1, 890.00),
    ('40000000-0000-4000-8000-000000000005', '30000000-0000-4000-8000-000000000004', 4, 95.00),
    ('40000000-0000-4000-8000-000000000006', '30000000-0000-4000-8000-000000000005', 3, 160.00),
    ('40000000-0000-4000-8000-000000000006', '30000000-0000-4000-8000-000000000006', 1, 520.00),
    ('40000000-0000-4000-8000-000000000007', '30000000-0000-4000-8000-000000000001', 1, 450.00),
    ('40000000-0000-4000-8000-000000000008', '30000000-0000-4000-8000-000000000004', 2, 95.00);

  update public.pedidos set status = 'aprovado' where id in (
    '40000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000003',
    '40000000-0000-4000-8000-000000000004', '40000000-0000-4000-8000-000000000005',
    '40000000-0000-4000-8000-000000000006', '40000000-0000-4000-8000-000000000007'
  );

  update public.pedidos
  set status = 'agendado', tecnico_id = '10000000-0000-4000-8000-000000000001',
      data_instalacao = date_trunc('day', now()) + interval '1 day 10 hours'
  where id = '40000000-0000-4000-8000-000000000003';
  update public.pedidos
  set status = 'agendado', tecnico_id = '10000000-0000-4000-8000-000000000002',
      data_instalacao = date_trunc('day', now()) + interval '2 days 14 hours'
  where id = '40000000-0000-4000-8000-000000000004';
  update public.pedidos
  set status = 'agendado', tecnico_id = '10000000-0000-4000-8000-000000000002',
      data_instalacao = date_trunc('day', now()) + interval '3 days 9 hours'
  where id = '40000000-0000-4000-8000-000000000007';
  update public.pedidos set status = 'em_andamento'
  where id = '40000000-0000-4000-8000-000000000007';
  update public.pedidos set status = 'concluido', forma_pagamento = 'Pix'
  where id = '40000000-0000-4000-8000-000000000007';
  update public.pedidos set status = 'cancelado'
  where id = '40000000-0000-4000-8000-000000000008';
end;
$$;
