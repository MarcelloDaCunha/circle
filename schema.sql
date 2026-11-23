-- Circle: run this ONCE in Supabase -> SQL Editor -> New query -> Run.
-- Before running, change 'CHANGE-ME' (bottom) to the invite code you want to hand out.

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null check (username ~ '^[a-z0-9_.]{3,20}$'),
  created_at timestamptz not null default now()
);

create table follows (
  follower uuid not null references profiles(id) on delete cascade,
  following uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower, following),
  check (follower <> following)
);

create table posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  image_path text not null,
  caption text not null default '' check (char_length(caption) <= 2000),
  created_at timestamptz not null default now()
);
create index posts_user_created on posts (user_id, created_at desc);
create index posts_created on posts (created_at desc);

create table comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references posts(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index comments_post on comments (post_id, created_at);

create table invite_codes (
  code text primary key,
  max_uses int not null default 100,
  used int not null default 0
);

-- ---------- invite-only signup ----------
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare c invite_codes%rowtype;
begin
  select * into c from invite_codes
    where code = lower(trim(new.raw_user_meta_data->>'invite_code')) for update;
  if not found or c.used >= c.max_uses then
    raise exception 'invalid invite code';
  end if;
  update invite_codes set used = used + 1 where code = c.code;
  insert into profiles (id, username) values (new.id, lower(trim(new.raw_user_meta_data->>'username')));
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- ---------- row level security ----------
alter table profiles enable row level security;
alter table follows enable row level security;
alter table posts enable row level security;
alter table comments enable row level security;
alter table invite_codes enable row level security;  -- no policies = nobody can read codes

create policy "profiles readable" on profiles for select to authenticated using (true);

create policy "follows readable" on follows for select to authenticated using (true);
create policy "follow as me" on follows for insert to authenticated with check (follower = auth.uid());
create policy "unfollow as me" on follows for delete to authenticated using (follower = auth.uid());

-- THE core rule: you only see your own posts and posts from people you follow
create policy "feed rule" on posts for select to authenticated using (
  user_id = auth.uid()
  or exists (select 1 from follows f where f.follower = auth.uid() and f.following = posts.user_id)
);
create policy "post as me" on posts for insert to authenticated with check (user_id = auth.uid());
create policy "delete my post" on posts for delete to authenticated using (user_id = auth.uid());

-- comments are visible wherever the post is visible (posts policy applies in the subquery)
create policy "comments readable" on comments for select to authenticated
  using (exists (select 1 from posts p where p.id = comments.post_id));
create policy "comment as me" on comments for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from posts p where p.id = comments.post_id));
create policy "delete comment" on comments for delete to authenticated using (
  user_id = auth.uid()
  or exists (select 1 from posts p where p.id = comments.post_id and p.user_id = auth.uid())
);

-- ---------- private photo storage ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 5242880, array['image/jpeg'])
on conflict (id) do nothing;

create policy "upload to my folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "delete my photos" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "view photos of visible posts" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and (
    (storage.foldername(name))[1] = auth.uid()::text
    or exists (select 1 from posts p where p.image_path = storage.objects.name)
  ));

-- ---------- your invite code (lowercase, up to 100 signups) ----------
insert into invite_codes (code, max_uses) values (lower('CHANGE-ME'), 100);
