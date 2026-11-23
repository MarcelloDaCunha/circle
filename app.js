'use strict';
// Circle: friends-only photo sharing. No likes, no algorithm: just people you follow + comments.
const app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = iso => {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'now'; if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h'; if (s < 604800) return Math.floor(s / 86400) + 'd';
  return new Date(iso).toLocaleDateString();
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

let sb = null, me = null, lastId = 0, myName = '';
let main = null;

if (!window.CONFIG || CONFIG.url.startsWith('PASTE') || !window.supabase) {
  app.innerHTML = '<div class="center"><h2>Almost there</h2><p class="muted">Add your Supabase URL and key to config.js.</p></div>';
} else {
  sb = supabase.createClient(CONFIG.url, CONFIG.key);
  sb.auth.onAuthStateChange((ev, session) => {
    const id = session?.user?.id ?? null;
    me = session?.user ?? null;
    if (id !== lastId) { lastId = id; boot(); }
  });
}

// ---------- signed photo urls (bucket is private) ----------
const urlCache = new Map();
async function signed(paths) {
  const need = [...new Set(paths)].filter(p => !urlCache.has(p));
  if (!need.length) return;
  const { data } = await sb.storage.from('photos').createSignedUrls(need, 3600);
  (data || []).forEach(d => { if (d.signedUrl) urlCache.set(d.path, d.signedUrl); });
}

// ---------- auth ----------
function authScreen(mode = 'login') {
  const su = mode === 'signup';
  app.innerHTML = `<div class="auth"><h1>Circle</h1><p class="sub">Photos with friends. No likes.</p>
    <form id="f">
      ${su ? '<input id="code" placeholder="Invite code" autocapitalize="none" autocorrect="off" required><input id="un" placeholder="Username (letters, numbers, _ .)" autocapitalize="none" autocorrect="off" required>' : ''}
      <input id="em" type="email" placeholder="Email" autocapitalize="none" autocorrect="off" required>
      <input id="pw" type="password" placeholder="Password (6+ characters)" minlength="6" required>
      <button class="primary" id="go">${su ? 'Create account' : 'Log in'}</button>
      <p class="err" id="err"></p>
    </form>
    <p class="muted">${su ? 'Have an account?' : 'Have an invite code?'} <a href="#" id="sw"><b>${su ? 'Log in' : 'Sign up'}</b></a></p></div>`;
  document.getElementById('sw').onclick = e => { e.preventDefault(); authScreen(su ? 'login' : 'signup'); };
  document.getElementById('f').onsubmit = async e => {
    e.preventDefault();
    const go = document.getElementById('go'), err = document.getElementById('err');
    err.textContent = ''; go.disabled = true;
    const email = document.getElementById('em').value.trim(), password = document.getElementById('pw').value;
    let r;
    if (su) {
      const username = document.getElementById('un').value.trim().toLowerCase();
      const invite_code = document.getElementById('code').value.trim().toLowerCase();
      if (!/^[a-z0-9_.]{3,20}$/.test(username)) { err.textContent = 'Username: 3–20 letters, numbers, _ or .'; go.disabled = false; return; }
      r = await sb.auth.signUp({ email, password, options: { data: { username, invite_code } } });
      if (r.error && /database error/i.test(r.error.message)) r.error.message = 'Invalid invite code, or that username is taken.';
      else if (!r.error && !r.data.session) r.error = { message: 'Check your email to confirm, then log in.' };
    } else {
      r = await sb.auth.signInWithPassword({ email, password });
    }
    if (r.error) { err.textContent = r.error.message; go.disabled = false; }
  };
}

async function boot() {
  if (!me) { authScreen(); return; }
  const { data } = await sb.from('profiles').select('username').eq('id', me.id).maybeSingle();
  myName = data?.username || '';
  app.innerHTML = `<main id="main"></main><nav>
    <a href="#/feed" data-t="feed">🏠</a><a href="#/find" data-t="find">🔍</a><a href="#/new" data-t="new">➕</a><a href="#/u/${me.id}" data-t="me">👤</a></nav>`;
  main = document.getElementById('main');
  if (!location.hash) location.hash = '#/feed';
  route();
}
window.addEventListener('hashchange', () => { if (me && main) route(); });

function route() {
  const h = location.hash.replace(/^#\/?/, '').split('/');
  const tab = h[0] === 'u' && h[1] === me.id ? 'me' : h[0] === 'new' ? 'new' : h[0] === 'find' ? 'find' : h[0] === 'feed' || h[0] === 'p' ? 'feed' : '';
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.dataset.t === tab));
  window.scrollTo(0, 0);
  if (h[0] === 'find') findView();
  else if (h[0] === 'new') newView();
  else if (h[0] === 'u' && h[1]) profileView(h[1]);
  else if (h[0] === 'p' && h[1]) postView(h[1]);
  else feedView();
}

const bar = (title, extra = '') => `<div class="top"><span>${title}</span>${extra}</div>`;
const loading = '<p class="muted center">Loading…</p>';

// ---------- post card ----------
function card(p, detail) {
  const n = p.comments?.[0]?.count || 0;
  const name = p.profiles?.username || '?';
  return `<article class="post"><header><a class="who" href="#/u/${p.user_id}"><span class="av">${esc(name[0])}</span>${esc(name)}</a><span class="muted">${ago(p.created_at)}</span></header>
    <img src="${esc(urlCache.get(p.image_path) || '')}" alt="">
    ${p.caption ? `<p class="cap"><b>${esc(name)}</b> ${esc(p.caption)}</p>` : ''}
    ${detail ? '' : `<a class="cm" href="#/p/${p.id}">${n ? `View ${n} comment${n > 1 ? 's' : ''}` : 'Add a comment'}</a>`}</article>`;
}

// ---------- feed ----------
async function feedView() {
  main.innerHTML = bar('Circle') + '<div id="list"></div><div id="more" class="center"></div>';
  const list = document.getElementById('list'), more = document.getElementById('more');
  let before = null, first = true;
  async function load() {
    more.innerHTML = '<span class="muted">Loading…</span>';
    let q = sb.from('posts').select('id,caption,image_path,created_at,user_id,profiles(username),comments(count)')
      .order('created_at', { ascending: false }).limit(10);
    if (before) q = q.lt('created_at', before);
    const { data, error } = await q;
    if (error) { more.innerHTML = `<span class="err">${esc(error.message)}</span>`; return; }
    await signed(data.map(p => p.image_path));
    list.insertAdjacentHTML('beforeend', data.map(p => card(p, false)).join(''));
    if (first && !data.length) { more.innerHTML = '<p>Your feed is empty.</p><p class="muted">Find friends to follow, or share your first photo.</p><a href="#/find"><button class="primary">Find friends</button></a>'; return; }
    first = false;
    if (data.length === 10) { before = data[data.length - 1].created_at; more.innerHTML = '<button id="mb">Load more</button>'; document.getElementById('mb').onclick = load; }
    else more.innerHTML = '<span class="muted">You\'re all caught up</span>';
  }
  load();
}

// ---------- single post + comments ----------
async function postView(id) {
  main.innerHTML = bar('<a href="javascript:history.back()">‹</a> Post') + loading;
  const [pr, cr] = await Promise.all([
    sb.from('posts').select('id,caption,image_path,created_at,user_id,profiles(username)').eq('id', id).maybeSingle(),
    sb.from('comments').select('id,body,created_at,user_id,profiles(username)').eq('post_id', id).order('created_at')
  ]);
  const p = pr.data;
  if (!p) { main.innerHTML = bar('Post') + '<p class="center muted">This post isn\'t available.</p>'; return; }
  await signed([p.image_path]);
  const mine = p.user_id === me.id;
  const cmt = c => `<div class="comment"><span class="t"><a href="#/u/${c.user_id}"><b>${esc(c.profiles?.username)}</b></a> ${esc(c.body)}</span>${c.user_id === me.id || mine ? `<button class="link" data-del="${c.id}">✕</button>` : ''}</div>`;
  main.innerHTML = bar('<a href="javascript:history.back()">‹</a> Post', mine ? '<button class="link" id="dp">Delete</button>' : '') +
    card(p, true) + '<div id="cl">' + (cr.data || []).map(cmt).join('') + '</div>' +
    '<form class="cform" id="cf"><input id="ci" placeholder="Add a comment…" maxlength="1000" autocomplete="off"><button class="primary">Post</button></form>';
  document.getElementById('cf').onsubmit = async e => {
    e.preventDefault();
    const inp = document.getElementById('ci'), body = inp.value.trim();
    if (!body) return;
    const btn = e.target.querySelector('button'); btn.disabled = true;
    const { data, error } = await sb.from('comments').insert({ post_id: id, user_id: me.id, body }).select('id,body,created_at,user_id').single();
    btn.disabled = false;
    if (error) { alert(error.message); return; }
    inp.value = '';
    data.profiles = { username: myName };
    document.getElementById('cl').insertAdjacentHTML('beforeend', cmt(data));
  };
  main.onclick = async e => {
    const d = e.target.closest('[data-del]');
    if (!d || !confirm('Delete this comment?')) return;
    const { error } = await sb.from('comments').delete().eq('id', d.dataset.del);
    if (error) alert(error.message); else d.closest('.comment').remove();
  };
  const dp = document.getElementById('dp');
  if (dp) dp.onclick = async () => {
    if (!confirm('Delete this post?')) return;
    const { error } = await sb.from('posts').delete().eq('id', id);
    if (error) { alert(error.message); return; }
    await sb.storage.from('photos').remove([p.image_path]);
    location.hash = '#/u/' + me.id;
  };
}

// ---------- new post ----------
async function compress(file, max = 1280) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
}

function newView() {
  main.innerHTML = bar('New post') + `<div class="pad">
    <input type="file" id="file" accept="image/*" style="display:none">
    <button id="pick" style="width:100%;padding:40px 0">📷 Choose a photo</button>
    <img id="pv" class="preview" style="display:none" alt="">
    <textarea id="cap" rows="3" maxlength="2000" placeholder="Write a caption…" style="display:none"></textarea>
    <button class="primary" id="share" style="width:100%;padding:13px;display:none">Share</button>
    <p class="err" id="err"></p></div>`;
  let blob = null;
  const $ = id => document.getElementById(id);
  $('pick').onclick = () => $('file').click();
  $('file').onchange = async () => {
    const f = $('file').files[0]; if (!f) return;
    $('err').textContent = '';
    try { blob = await compress(f); } catch { $('err').textContent = 'Couldn\'t read that image.'; return; }
    $('pv').src = URL.createObjectURL(blob);
    $('pv').style.display = 'block'; $('cap').style.display = 'block'; $('share').style.display = 'block';
    $('pick').textContent = '📷 Choose a different photo'; $('pick').style.padding = '10px 0';
  };
  $('share').onclick = async () => {
    if (!blob) return;
    $('share').disabled = true; $('share').textContent = 'Sharing…';
    const path = `${me.id}/${crypto.randomUUID()}.jpg`;
    const up = await sb.storage.from('photos').upload(path, blob, { contentType: 'image/jpeg' });
    if (up.error) { $('err').textContent = up.error.message; $('share').disabled = false; $('share').textContent = 'Share'; return; }
    const ins = await sb.from('posts').insert({ user_id: me.id, image_path: path, caption: $('cap').value.trim() });
    if (ins.error) { await sb.storage.from('photos').remove([path]); $('err').textContent = ins.error.message; $('share').disabled = false; $('share').textContent = 'Share'; return; }
    location.hash = '#/feed';
  };
}

// ---------- find people ----------
async function findView() {
  main.innerHTML = bar('Find friends') + '<div class="pad"><input id="q" placeholder="Search usernames" autocapitalize="none" autocorrect="off"></div><div id="res"></div>';
  const { data: fl } = await sb.from('follows').select('following').eq('follower', me.id);
  const following = new Set((fl || []).map(f => f.following));
  const res = document.getElementById('res');
  let t = null, seq = 0;
  async function search() {
    const my = ++seq, term = document.getElementById('q').value.trim().toLowerCase().replace(/[%_,()]/g, '');
    let q = sb.from('profiles').select('id,username').neq('id', me.id).order('created_at', { ascending: false }).limit(30);
    if (term) q = q.ilike('username', `%${term}%`);
    const { data } = await q;
    if (my !== seq) return;
    res.innerHTML = (data || []).map(u => `<div class="row"><a class="who" href="#/u/${u.id}"><span class="av">${esc(u.username[0])}</span>${esc(u.username)}</a>${followBtn(u.id, following.has(u.id))}</div>`).join('') || '<p class="muted center">No one found.</p>';
  }
  document.getElementById('q').oninput = () => { clearTimeout(t); t = setTimeout(search, 250); };
  main.onclick = e => followClick(e, following);
  search();
}
const followBtn = (id, on) => `<button data-follow="${id}" class="${on ? 'on' : ''}">${on ? 'Following' : 'Follow'}</button>`;
async function followClick(e, set) {
  const b = e.target.closest('[data-follow]'); if (!b) return;
  const id = b.dataset.follow, on = b.classList.contains('on');
  b.disabled = true;
  const r = on ? await sb.from('follows').delete().eq('follower', me.id).eq('following', id)
               : await sb.from('follows').insert({ follower: me.id, following: id });
  b.disabled = false;
  if (r.error) { alert(r.error.message); return; }
  b.classList.toggle('on', !on); b.textContent = on ? 'Follow' : 'Following';
  if (set) on ? set.delete(id) : set.add(id);
}

// ---------- profile ----------
async function profileView(id) {
  main.innerHTML = bar('Profile') + loading;
  const isMe = id === me.id;
  const [pr, fers, fing, rel, ps] = await Promise.all([
    sb.from('profiles').select('id,username').eq('id', id).maybeSingle(),
    sb.from('follows').select('*', { count: 'exact', head: true }).eq('following', id),
    sb.from('follows').select('*', { count: 'exact', head: true }).eq('follower', id),
    isMe ? Promise.resolve({ data: null }) : sb.from('follows').select('follower').eq('follower', me.id).eq('following', id).maybeSingle(),
    sb.from('posts').select('id,image_path').eq('user_id', id).order('created_at', { ascending: false }).limit(60)
  ]);
  const u = pr.data;
  if (!u) { main.innerHTML = bar('Profile') + '<p class="center muted">User not found.</p>'; return; }
  const posts = ps.data || [];
  await signed(posts.map(p => p.image_path));
  const following = !!rel.data;
  main.innerHTML = bar(esc(u.username), isMe ? '<button class="link" id="out">Log out</button>' : '') + `
    <div class="prof"><span class="av big">${esc(u.username[0])}</span><h2>${esc(u.username)}</h2>
    <div class="stats"><div><b>${posts.length}</b><span class="muted">posts</span></div><div><b>${fers.count ?? 0}</b><span class="muted">followers</span></div><div><b>${fing.count ?? 0}</b><span class="muted">following</span></div></div>
    ${isMe ? '' : followBtn(id, following)}</div>
    ${posts.length ? `<div class="grid">${posts.map(p => `<a href="#/p/${p.id}"><img src="${esc(urlCache.get(p.image_path) || '')}" alt=""></a>`).join('')}</div>`
      : `<p class="muted center">${isMe || following ? 'No posts yet.' : 'Follow to see their posts.'}</p>`}
    ${isMe ? `<div class="hint">Install tip: tap the Share button in Safari, then “Add to Home Screen”.</div>` : ''}`;
  main.onclick = e => followClick(e, null);
  const out = document.getElementById('out');
  if (out) out.onclick = () => { if (confirm('Log out?')) sb.auth.signOut(); };
}
