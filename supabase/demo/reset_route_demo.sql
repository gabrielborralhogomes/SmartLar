-- Destructive demo reset: run only on a demo database after applying all migrations.
begin;

truncate table
  public.historico_status,
  public.pedido_tecnicos,
  public.itens_pedido,
  public.pedidos,
  public.clientes,
  public.produtos,
  public.tecnicos
restart identity;

insert into public.tecnicos (id, nome, telefone, especialidade, habilidades_instalacao) values
  ('10000000-0000-4000-8000-000000000001', 'Lucas', '(11) 98888-1001', 'Câmeras e sensores', array['camera_sensor']),
  ('10000000-0000-4000-8000-000000000002', 'Pedro', '(11) 98888-1002', 'Fechaduras e iluminação', array['fechadura_iluminacao']);

insert into public.clientes (id, nome, telefone, email, rua, numero, complemento, bairro) values
  ('20000000-0000-4000-8000-000000000001', 'Mariana Costa', '(11) 99911-2201', 'mariana@example.com', 'Rua dos Pinheiros', '120', null, 'Pinheiros'),
  ('20000000-0000-4000-8000-000000000002', 'Andre Martins', '(11) 99911-2202', 'andre@example.com', 'Rua Haddock Lobo', '845', 'apto 42', 'Cerqueira Cesar'),
  ('20000000-0000-4000-8000-000000000003', 'Camila Souza', '(11) 99911-2203', 'camila@example.com', 'Rua Harmonia', '56', null, 'Vila Madalena'),
  ('20000000-0000-4000-8000-000000000004', 'Rogerio Lima', '(11) 99911-2204', 'rogerio@example.com', 'Alameda Santos', '410', null, 'Jardins'),
  ('20000000-0000-4000-8000-000000000005', 'Beatriz Nunes', '(11) 99911-2205', 'beatriz@example.com', 'Rua Cayowaa', '980', null, 'Perdizes'),
  ('20000000-0000-4000-8000-000000000006', 'Paula Ribeiro', '(11) 99911-2206', 'paula@example.com', 'Rua Vergueiro', '1500', 'casa 2', 'Vila Mariana');

insert into public.produtos (id, nome, categoria, preco_unitario, descricao, habilidades_instalacao) values
  ('30000000-0000-4000-8000-000000000001', 'Camera IP Wi-Fi', 'Seguranca', 450.00, 'Camera Full HD com visao noturna', array['camera_sensor']),
  ('30000000-0000-4000-8000-000000000002', 'Sensor de presenca', 'Seguranca', 180.00, 'Sensor inteligente de movimento', array['camera_sensor']),
  ('30000000-0000-4000-8000-000000000003', 'Fechadura digital', 'Seguranca', 890.00, 'Acesso por senha e cartao', array['fechadura_iluminacao']),
  ('30000000-0000-4000-8000-000000000004', 'Lampada inteligente RGB', 'Iluminacao', 95.00, 'Lampada Wi-Fi dimerizavel', array['fechadura_iluminacao']),
  ('30000000-0000-4000-8000-000000000005', 'Interruptor smart', 'Iluminacao', 160.00, 'Interruptor inteligente de duas teclas', array['fechadura_iluminacao']),
  ('30000000-0000-4000-8000-000000000006', 'Hub de automacao', 'Automacao', 520.00, 'Central de controle que integra camera e iluminacao', array['camera_sensor', 'fechadura_iluminacao']);

insert into public.pedidos (id, cliente_id, observacoes, created_at) values
  ('40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Orcamento para monitoramento da entrada.', now()),
  ('40000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'Instalacao de fechadura digital.', now()),
  ('40000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000003', 'Camera e sensor no acesso lateral; requer Lucas.', now() - interval '2 days'),
  ('40000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000004', 'Fechadura e iluminacao; requer Pedro.', now() - interval '3 days'),
  ('40000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000005', 'Camera e lampadas; equipe dos dois tecnicos.', now()),
  ('40000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000006', 'Interruptores e hub; equipe dos dois tecnicos.', now() - interval '6 days'),
  ('40000000-0000-4000-8000-000000000007', '20000000-0000-4000-8000-000000000002', 'Orcamento aguardando confirmacao do cliente.', now() - interval '10 days'),
  ('40000000-0000-4000-8000-000000000008', '20000000-0000-4000-8000-000000000003', 'Cliente optou por aguardar a reforma.', now() - interval '12 days');

insert into public.itens_pedido (pedido_id, produto_id, quantidade, preco_unitario) values
  ('40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 2, 450.00),
  ('40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002', 1, 180.00),
  ('40000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000003', 1, 890.00),
  ('40000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000001', 1, 450.00),
  ('40000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000002', 1, 180.00),
  ('40000000-0000-4000-8000-000000000004', '30000000-0000-4000-8000-000000000003', 1, 890.00),
  ('40000000-0000-4000-8000-000000000004', '30000000-0000-4000-8000-000000000004', 2, 95.00),
  ('40000000-0000-4000-8000-000000000005', '30000000-0000-4000-8000-000000000001', 1, 450.00),
  ('40000000-0000-4000-8000-000000000005', '30000000-0000-4000-8000-000000000004', 2, 95.00),
  ('40000000-0000-4000-8000-000000000006', '30000000-0000-4000-8000-000000000005', 2, 160.00),
  ('40000000-0000-4000-8000-000000000006', '30000000-0000-4000-8000-000000000006', 1, 520.00),
  ('40000000-0000-4000-8000-000000000007', '30000000-0000-4000-8000-000000000001', 1, 450.00),
  ('40000000-0000-4000-8000-000000000008', '30000000-0000-4000-8000-000000000004', 2, 95.00);

update public.pedidos
set status = 'aprovado'
where id between '40000000-0000-4000-8000-000000000002'::uuid
  and '40000000-0000-4000-8000-000000000007'::uuid;

update public.pedidos
set status = 'cancelado'
where id = '40000000-0000-4000-8000-000000000008';

select public.agendar_pedido(
  '40000000-0000-4000-8000-000000000003',
  array['10000000-0000-4000-8000-000000000001']::uuid[],
  ((current_date + 1)::timestamp + time '09:00') at time zone 'America/Sao_Paulo',
  60
);

select public.agendar_pedido(
  '40000000-0000-4000-8000-000000000004',
  array['10000000-0000-4000-8000-000000000002']::uuid[],
  ((current_date + 1)::timestamp + time '13:00') at time zone 'America/Sao_Paulo',
  60
);

select public.agendar_pedido(
  '40000000-0000-4000-8000-000000000005',
  array[
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002'
  ]::uuid[],
  ((current_date + 1)::timestamp + time '16:00') at time zone 'America/Sao_Paulo',
  60
);

select public.agendar_pedido(
  '40000000-0000-4000-8000-000000000006',
  array[
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002'
  ]::uuid[],
  ((current_date + 2)::timestamp + time '10:00') at time zone 'America/Sao_Paulo',
  60
);

commit;

select status, count(*) as quantidade
from public.pedidos
group by status
order by status;

select
  p.id,
  p.data_instalacao at time zone 'America/Sao_Paulo' as horario_local,
  p.duracao_instalacao_minutos,
  array_agg(t.nome order by t.nome) as tecnicos
from public.pedidos p
join public.pedido_tecnicos pt on pt.pedido_id = p.id
join public.tecnicos t on t.id = pt.tecnico_id
where p.status = 'agendado'
group by p.id, p.data_instalacao, p.duracao_instalacao_minutos
order by p.data_instalacao;
