-- airdrop.harsath.com database setup.
-- Paste the whole file into Supabase Dashboard -> SQL Editor -> Run.
-- Safe to re-run: every statement is create-if-missing or replace.
--
-- Model
--   rooms         one row per room. public rooms: id = hash of the link key.
--                 protected rooms: id is random, joining needs a password proof.
--   room_members  which anonymous users joined which room. Every access rule
--                 (tables, storage, realtime) asks "is auth.uid() a member?".
--   files         one row per uploaded file. Bytes live in storage bucket
--                 'drops' at <room_id>/<file_id>. Names are encrypted client-side.
--   join_failures wrong-password attempts, for a simple rate limit.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------- tables

create table if not exists public.rooms (
  id              text primary key,
  kind            text not null check (kind in ('public', 'protected')),
  salt            text,          -- protected only: PBKDF2 salt (public value)
  verifier_hash   text,          -- protected only: bcrypt of the password proof
  created_at      timestamptz not null default now(),
  last_active_at  timestamptz not null default now(),
  constraint rooms_shape check (
    (kind = 'public'    and id ~ '^[0-9a-f]{32}$'        and salt is null     and verifier_hash is null) or
    (kind = 'protected' and id ~ '^[2-9a-hjkmnp-z]{10}$' and salt is not null and verifier_hash is not null)
  )
);

create table if not exists public.room_members (
  room_id    text not null references public.rooms(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  joined_at  timestamptz not null default now(),
  primary key (room_id, user_id)
);
create index if not exists room_members_user_idx on public.room_members (user_id);

create table if not exists public.join_failures (
  room_id  text not null references public.rooms(id) on delete cascade,
  user_id  uuid not null,
  at       timestamptz not null default now()
);
create index if not exists join_failures_idx on public.join_failures (room_id, user_id, at);

create table if not exists public.files (
  id          uuid primary key,                       -- chosen by the uploader; also the object name
  room_id     text not null references public.rooms(id) on delete cascade,
  uploader    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name_enc    text not null check (length(name_enc) <= 2048),  -- encrypted {name, type}
  size        bigint not null check (size between 0 and 52428800),
  burn        boolean not null default false,         -- burn after read: first downloader consumes it
  claimed_by  uuid,
  claimed_at  timestamptz,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '3 hours'
);
create index if not exists files_room_idx on public.files (room_id);
create index if not exists files_expires_idx on public.files (expires_at);

alter table public.rooms         enable row level security;
alter table public.room_members  enable row level security;
alter table public.join_failures enable row level security;
alter table public.files         enable row level security;

-- Clients never touch rooms / room_members / join_failures directly; the
-- security-definer functions below are the only way in.
revoke all on public.rooms, public.room_members, public.join_failures, public.files from anon, authenticated;
grant select, insert, delete on public.files to authenticated;

-- ---------------------------------------------------------------- helpers

create or replace function public.is_member(p_room text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.room_members m
    where m.room_id = p_room and m.user_id = (select auth.uid())
  );
$$;

-- Health check for the keep-alive workflow (stops the free project pausing).
create or replace function public.ping()
returns text language sql stable as $$ select 'pong' $$;

-- ---------------------------------------------------------------- joining rooms

-- Public room: the id is a hash of the secret in the link, so knowing the id
-- means you had the link. Created on first join.
create or replace function public.join_public_room(p_room text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_kind text;
begin
  if auth.uid() is null then return 'unauthenticated'; end if;
  if p_room !~ '^[0-9a-f]{32}$' then return 'bad_room'; end if;

  insert into public.rooms (id, kind) values (p_room, 'public') on conflict (id) do nothing;
  select kind into v_kind from public.rooms where id = p_room;
  if v_kind <> 'public' then return 'bad_room'; end if;

  insert into public.room_members (room_id, user_id) values (p_room, auth.uid()) on conflict do nothing;
  update public.rooms set last_active_at = now() where id = p_room;
  return 'ok';
end $$;

-- Protected room: the browser derives two things from password + salt:
-- an encryption key (never sent) and a proof (sent here, stored as bcrypt).
create or replace function public.create_protected_room(p_room text, p_salt text, p_proof text)
returns text language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return 'unauthenticated'; end if;
  if p_room !~ '^[2-9a-hjkmnp-z]{10}$' or length(p_salt) not between 16 and 64
     or length(p_proof) not between 32 and 128 then
    return 'bad_input';
  end if;

  insert into public.rooms (id, kind, salt, verifier_hash)
  values (p_room, 'protected', p_salt, extensions.crypt(p_proof, extensions.gen_salt('bf', 10)))
  on conflict (id) do nothing;
  if not found then return 'exists'; end if;

  insert into public.room_members (room_id, user_id) values (p_room, auth.uid());
  return 'ok';
end $$;

-- Returns the salt so the browser can derive the key, or null if no such room.
create or replace function public.protected_room_salt(p_room text)
returns text language sql stable security definer set search_path = '' as $$
  select salt from public.rooms where id = p_room and kind = 'protected';
$$;

create or replace function public.join_protected_room(p_room text, p_proof text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_hash text;
begin
  if auth.uid() is null then return 'unauthenticated'; end if;
  select verifier_hash into v_hash from public.rooms where id = p_room and kind = 'protected';
  if v_hash is null then return 'not_found'; end if;

  -- 5 wrong guesses per user per room per 15 minutes. (Returns instead of
  -- raising so the failure row below is not rolled back.)
  if (select count(*) from public.join_failures
      where room_id = p_room and user_id = auth.uid() and at > now() - interval '15 minutes') >= 5 then
    return 'rate_limited';
  end if;

  if v_hash = extensions.crypt(coalesce(p_proof, ''), v_hash) then
    insert into public.room_members (room_id, user_id) values (p_room, auth.uid()) on conflict do nothing;
    update public.rooms set last_active_at = now() where id = p_room;
    return 'ok';
  end if;

  insert into public.join_failures (room_id, user_id) values (p_room, auth.uid());
  return 'bad_password';
end $$;

-- ---------------------------------------------------------------- files

-- The server, not the client, decides who uploaded, when, and when it expires.
-- The object must already be in storage, so nobody sees a file that 404s.
create or replace function public.files_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.uploader   := auth.uid();
  new.claimed_by := null;
  new.claimed_at := null;
  new.created_at := now();
  new.expires_at := now() + interval '3 hours';
  if not exists (select 1 from storage.objects o
                 where o.bucket_id = 'drops' and o.name = new.room_id || '/' || new.id::text) then
    raise exception 'upload not found in storage';
  end if;
  return new;
end $$;

drop trigger if exists files_before_insert on public.files;
create trigger files_before_insert before insert on public.files
  for each row execute function public.files_before_insert();

-- Push file events to everyone in the room over Realtime (private channel room:<id>).
create or replace function public.files_broadcast()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform realtime.send(
      jsonb_build_object('file', jsonb_build_object(
        'id', new.id, 'room_id', new.room_id, 'uploader', new.uploader, 'name_enc', new.name_enc,
        'size', new.size, 'burn', new.burn, 'created_at', new.created_at, 'expires_at', new.expires_at)),
      'file_added', 'room:' || new.room_id, true);
  elsif tg_op = 'UPDATE' and old.claimed_by is null and new.claimed_by is not null then
    perform realtime.send(jsonb_build_object('id', new.id, 'by', new.claimed_by),
      'file_claimed', 'room:' || new.room_id, true);
  elsif tg_op = 'DELETE' then
    perform realtime.send(jsonb_build_object('id', old.id),
      'file_removed', 'room:' || old.room_id, true);
  end if;
  return null;
end $$;

drop trigger if exists files_broadcast on public.files;
create trigger files_broadcast after insert or update or delete on public.files
  for each row execute function public.files_broadcast();

drop policy if exists files_select on public.files;
create policy files_select on public.files for select to authenticated using (
  public.is_member(room_id) and expires_at > now()
  and (claimed_by is null or claimed_by = (select auth.uid()) or uploader = (select auth.uid()))
);

drop policy if exists files_insert on public.files;
create policy files_insert on public.files for insert to authenticated with check (
  public.is_member(room_id) and uploader = (select auth.uid())
);

drop policy if exists files_delete on public.files;
create policy files_delete on public.files for delete to authenticated using (
  uploader = (select auth.uid()) or claimed_by = (select auth.uid())
);

-- Burn after read: atomically hand a burn file to the first member who asks.
-- 'ok' = you may download it, 'taken' = someone else got it, 'gone' = expired/deleted.
create or replace function public.claim_file(p_file uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare f public.files;
begin
  if auth.uid() is null then return 'gone'; end if;
  select * into f from public.files where id = p_file;
  if not found or not public.is_member(f.room_id) or f.expires_at <= now() then return 'gone'; end if;
  if not f.burn or f.claimed_by = auth.uid() or f.uploader = auth.uid() then return 'ok'; end if;

  update public.files set claimed_by = auth.uid(), claimed_at = now()
  where id = p_file and claimed_by is null;
  if found then return 'ok'; end if;
  return 'taken';
end $$;

-- ---------------------------------------------------------------- storage

insert into storage.buckets (id, name, public, file_size_limit)
values ('drops', 'drops', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists drops_insert on storage.objects;
create policy drops_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'drops'
  and array_length(storage.foldername(name), 1) = 1
  and public.is_member((storage.foldername(name))[1])
);

-- Read: the uploader always; members if the file row is live and, for burn
-- files, only the member who claimed it.
drop policy if exists drops_select on storage.objects;
create policy drops_select on storage.objects for select to authenticated using (
  bucket_id = 'drops' and (
    owner_id = (select auth.uid())::text
    or exists (
      select 1 from public.files f
      where f.room_id = (storage.foldername(name))[1]
        and f.id::text = storage.filename(name)
        and (not f.burn or f.claimed_by = (select auth.uid()))
    )
  )
);

drop policy if exists drops_delete on storage.objects;
create policy drops_delete on storage.objects for delete to authenticated using (
  bucket_id = 'drops' and (
    owner_id = (select auth.uid())::text
    or exists (select 1 from public.files f
               where f.id::text = storage.filename(name) and f.claimed_by = (select auth.uid()))
  )
);

-- ---------------------------------------------------------------- realtime

-- Private channels named room:<id>: only members may listen, broadcast or track presence.
drop policy if exists room_members_receive on realtime.messages;
create policy room_members_receive on realtime.messages for select to authenticated using (
  realtime.topic() like 'room:%' and public.is_member(substr(realtime.topic(), 6))
);

drop policy if exists room_members_send on realtime.messages;
create policy room_members_send on realtime.messages for insert to authenticated with check (
  realtime.topic() like 'room:%' and public.is_member(substr(realtime.topic(), 6))
);

-- ---------------------------------------------------------------- cleanup

-- Rows: expired files, burned files 15 min after they were claimed (time for the
-- download to finish), rooms idle for 30 days with no files, old failure rows.
create or replace function public.cleanup_rows()
returns void language sql security definer set search_path = '' as $$
  delete from public.files where expires_at < now() or claimed_at < now() - interval '15 minutes';
  delete from public.rooms r
    where r.last_active_at < now() - interval '30 days'
      and not exists (select 1 from public.files f where f.room_id = r.id);
  delete from public.join_failures where at < now() - interval '1 day';
$$;

-- Objects with no live file row (older than 15 min, so an upload that is about
-- to get its row is left alone), plus anything past the 3h lifetime. Storage
-- objects must be deleted through the Storage API, so the 'cleanup' Edge
-- Function asks for this list and removes them.
create or replace function public.cleanup_targets()
returns table (name text) language sql stable security definer set search_path = '' as $$
  select o.name from storage.objects o
  where o.bucket_id = 'drops'
    and (o.created_at < now() - interval '3 hours 10 minutes'
         or (o.created_at < now() - interval '15 minutes'
             and not exists (select 1 from public.files f where f.id::text = storage.filename(o.name))))
  limit 1000;
$$;

-- Only the cron job / Edge Function may call these.
revoke execute on function public.cleanup_rows()    from public, anon, authenticated;
revoke execute on function public.cleanup_targets() from public, anon, authenticated;
grant  execute on function public.cleanup_targets() to service_role;

-- Client-callable functions.
revoke execute on function public.join_public_room(text)                  from public, anon;
revoke execute on function public.create_protected_room(text, text, text) from public, anon;
revoke execute on function public.protected_room_salt(text)               from public, anon;
revoke execute on function public.join_protected_room(text, text)         from public, anon;
revoke execute on function public.claim_file(uuid)                        from public, anon;
grant  execute on function public.join_public_room(text)                  to authenticated;
grant  execute on function public.create_protected_room(text, text, text) to authenticated;
grant  execute on function public.protected_room_salt(text)               to authenticated;
grant  execute on function public.join_protected_room(text, text)         to authenticated;
grant  execute on function public.claim_file(uuid)                        to authenticated;
grant  execute on function public.is_member(text)                         to authenticated;
grant  execute on function public.ping()                                  to anon, authenticated;

-- Every 10 minutes: delete expired rows, then have the Edge Function delete
-- the matching storage objects. cron.schedule with the same name replaces the job.
select cron.schedule('airdrop-cleanup', '*/10 * * * *', $job$
  select public.cleanup_rows();
  select net.http_post(
    url     := 'https://vakzpjtoqvzxmilqnbwr.supabase.co/functions/v1/cleanup',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb
  );
$job$);
