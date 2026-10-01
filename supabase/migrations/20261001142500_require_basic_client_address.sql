begin;

alter table public.clientes
  drop column if exists cidade,
  drop column if exists estado,
  drop column if exists cep;

create or replace function public.validar_endereco_cliente()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if length(trim(coalesce(new.rua, ''))) = 0
    or length(trim(coalesce(new.numero, ''))) = 0
    or length(trim(coalesce(new.bairro, ''))) = 0 then
    raise exception 'Rua, número e bairro são obrigatórios.';
  end if;
  return new;
end;
$$;

drop trigger if exists clientes_validar_endereco on public.clientes;
create trigger clientes_validar_endereco
before insert or update of rua, numero, complemento, bairro on public.clientes
for each row execute function public.validar_endereco_cliente();

commit;
