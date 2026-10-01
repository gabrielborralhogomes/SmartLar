alter table public.clientes
  add column if not exists rua text,
  add column if not exists numero text,
  add column if not exists complemento text,
  add column if not exists bairro text,
  add column if not exists cidade text,
  add column if not exists estado text,
  add column if not exists cep text;

create or replace function public.validar_fluxo_pedido()
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

  if new.status = 'agendado'
    and new.data_instalacao <= now()
    and (
      tg_op = 'INSERT'
      or (tg_op = 'UPDATE' and (
        new.status is distinct from old.status
        or new.data_instalacao is distinct from old.data_instalacao
      ))
    ) then
    raise exception 'A data de instalação deve ser futura.';
  end if;

  new.updated_at := now();
  return new;
end;
$$;
