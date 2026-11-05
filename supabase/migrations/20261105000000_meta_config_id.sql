-- Facebook Login for Business picks permissions through a saved Login Configuration (config_id).
alter table public.app_settings drop constraint app_settings_key_check;
alter table public.app_settings add constraint app_settings_key_check check (key in (
  'META_APP_ID', 'META_APP_SECRET', 'META_CONFIG_ID', 'TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET',
  'YOUTUBE_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
  'X_CLIENT_ID', 'X_CLIENT_SECRET', 'X_BEARER_TOKEN'));
