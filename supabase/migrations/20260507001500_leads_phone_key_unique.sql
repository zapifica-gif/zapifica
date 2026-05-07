-- ============================================================================
-- Anti-clonagem de Leads: normalização + unique key por WhatsApp (tenant+phone).
--
-- Motivação:
-- - O mesmo contato pode chegar como "551199990000" vs "5511999990000"
-- - Pode vir como JID "5511...@s.whatsapp.net"
-- - Inserts concorrentes no webhook podem criar duplicatas sem uma constraint
--
-- Estratégia:
-- - Função determinística para gerar uma chave normalizada (phone_key)
-- - Coluna GENERATED sempre derivada de leads.phone (não depende do app)
-- - Unique index por (user_id, phone_key) para bloquear duplicações na raiz
-- ============================================================================

create or replace function public.normalize_br_whatsapp_phone(p_raw text)
returns text
language plpgsql
immutable
as $$
declare
  t text;
  core text;
  digits text;
  ddd text;
  rest8 text;
  first_digit text;
begin
  if p_raw is null then
    return null;
  end if;

  t := btrim(p_raw);
  if t = '' then
    return null;
  end if;

  -- Grupos: manter o JID (é a identidade do chat)
  if position('@g.us' in t) > 0 then
    return t;
  end if;

  -- Remove sufixos tipo @s.whatsapp.net/@c.us/etc
  if position('@' in t) > 0 then
    core := split_part(t, '@', 1);
  else
    core := t;
  end if;

  digits := regexp_replace(core, '[^0-9]', '', 'g');
  if digits = '' then
    return null;
  end if;

  -- Garante DDI 55 quando vier só nacional (10/11)
  if length(digits) = 10 or length(digits) = 11 then
    digits := '55' || digits;
  end if;

  -- Normalização conservadora do 9º dígito (celular):
  -- 55 + DDD + 8 dígitos (12) → 55 + DDD + 9 + 8 dígitos (13)
  if length(digits) = 12 and left(digits, 2) = '55' then
    ddd := substr(digits, 3, 2);
    rest8 := substr(digits, 5, 8);
    first_digit := substr(rest8, 1, 1);
    if first_digit in ('6','7','8','9') then
      digits := '55' || ddd || '9' || rest8;
    end if;
  end if;

  return digits;
end;
$$;

comment on function public.normalize_br_whatsapp_phone(text) is
  'Normaliza WhatsApp BR: remove @s.whatsapp.net, mantém grupos @g.us, garante DDI 55 e injeta 9º dígito conservador (celular) quando aplicável.';

alter table public.leads
  add column if not exists phone_key text
  generated always as (public.normalize_br_whatsapp_phone(phone)) stored;

create index if not exists leads_user_phone_key_idx
  on public.leads (user_id, phone_key);

-- Única linha de defesa contra duplicação (pode falhar se já existirem duplicatas antigas).
-- Se falhar, rode uma limpeza (dedupe) e execute o index novamente.
create unique index if not exists leads_user_phone_key_uniq
  on public.leads (user_id, phone_key)
  where phone_key is not null;

