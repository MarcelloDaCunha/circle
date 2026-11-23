// Supabase project URL + "anon public" key (Project Settings -> API). These are safe to be public:
// the row-level-security rules in schema.sql are what protect the data.
window.CONFIG = {
  url: 'PASTE_PROJECT_URL_HERE',
  key: 'PASTE_ANON_KEY_HERE'
};
