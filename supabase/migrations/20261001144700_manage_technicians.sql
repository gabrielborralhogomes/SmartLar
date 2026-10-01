begin;

alter table public.tecnicos
  add column if not exists ativo boolean not null default true;

create or replace function public.validar_tecnico_ativo_em_pedido()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.tecnicos
    where id = new.tecnico_id
      and ativo
  ) then
    raise exception 'Não é possível atribuir um técnico inativo a uma instalação.';
  end if;
  return new;
end;
$$;

drop trigger if exists pedido_tecnicos_validar_ativo on public.pedido_tecnicos;
create trigger pedido_tecnicos_validar_ativo
before insert or update of tecnico_id on public.pedido_tecnicos
for each row execute function public.validar_tecnico_ativo_em_pedido();

commit;
