-- ============================================================================
-- Agenda Suprema: cron a cada 1 minuto (pg_cron + pg_net) → Edge Function
-- process-scheduled-messages
--
-- Após aplicar, configure UMA VEZ a URL e o token (não comite a service key):
--
--   update extensions.cron_agenda_secrets
--   set
--     function_url = 'https://<PROJECT_REF>.supabase.co/functions/v1/process-scheduled-messages',
--     bearer_token = '<SERVICE_ROLE_JWT ou ANON_KEY>'
--   where id = 1;
--
--   * PROJECT_REF: Dashboard → Settings → General → Reference ID
--   * Com verify_jwt = false em process-scheduled-messages, a anon key basta
--     para invocar; a service role também funciona.
--
-- Verificar jobs:  select * from cron.job;
-- Testar à mão:     select extensions.cron_chamar_process_scheduled_messages();
-- ============================================================================

-- Extensões: habilite no Dashboard (Database > Extensions) se a migration reclamar.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Configuração (1 linha). Valores iniciais nulos: o job roda, mas não chama
-- HTTP até você preencher (evita 404/401 na primeira aplicação).
-- bearer_token: só o JWT, sem a palavra "Bearer" (a função monta o header).
create table if not exists extensions.cron_agenda_secrets (
  id int primary key check (id = 1),
  function_url text,
  bearer_token text
);

insert into extensions.cron_agenda_secrets (id, function_url, bearer_token)
values (1, null, null)
on conflict (id) do nothing;

revoke all on table extensions.cron_agenda_secrets from public;
grant all on table extensions.cron_agenda_secrets to postgres;

create or replace function extensions.cron_chamar_process_scheduled_messages()
returns void
language plpgsql
security definer
set search_path to extensions, public, net
as $$
declare
  u text;
  t text;
begin
  select c.function_url, c.bearer_token
    into u, t
  from extensions.cron_agenda_secrets c
  where c.id = 1;

  if u is null or btrim(u) = '' or t is null or btrim(t) = '' then
    raise log 'Agenda Suprema: preencha extensions.cron_agenda_secrets (function_url + bearer_token).';
    return;
  end if;

  perform net.http_post(
    url := btrim(u),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || btrim(t)
    ),
    body := '{}'::jsonb
  );
end;
$$;

revoke all on function extensions.cron_chamar_process_scheduled_messages() from public;
grant execute on function extensions.cron_chamar_process_scheduled_messages() to postgres;

-- Remove job com o mesmo nome se já existir (reaplicar migration).
do $do$
declare
  jid bigint;
begin
  select j.jobid into jid
  from cron.job j
  where j.jobname = 'agenda_suprema_process_scheduled_minutely'
  limit 1;
  if jid is not null then
    perform cron.unschedule(jid);
  end if;
exception
  when undefined_table then
    null;
  when others then
    null;
end
$do$;

-- A cada minuto, chama a Edge Function.
select cron.schedule(
  'agenda_suprema_process_scheduled_minutely',
  '* * * * *',
  $$ select extensions.cron_chamar_process_scheduled_messages() $$
);

comment on function extensions.cron_chamar_process_scheduled_messages is
  'Chamada pelo pg_cron; preencha extensions.cron_agenda_secrets com a URL da função e o JWT.';

comment on table extensions.cron_agenda_secrets is
  'URL da Edge process-scheduled-messages + token (sem prefixo Bearer). Só o usuário interno do banco acessa.';
