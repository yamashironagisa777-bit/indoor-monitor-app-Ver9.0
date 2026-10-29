
/* ThingSpeak設定。Supabaseの公開可能キーを設定してください。 */
window.MONITOR_CONFIG = {
  channelId: "3541401",
  readApiKey: "8YCJD14OU78DXBRG",
  refreshMs: 30000,
  historyResults: 100,
  supabaseUrl: "https://xrmyhdtnlfhllfttujfg.supabase.co",
  supabaseAnonKey: "sb_publishable_TfailmHwHMx4Lgq6TIyiEA_DHhCX02-",
  supabaseBucket: "recordings",
  deviceSettingsTable: "device_settings",
  latestAudioPath: "latest.wav",
  audioRefreshMs: 60000,
  // Supabase Edge Function のURLとVAPID公開鍵をセットアップ手順に従って設定
  pushFunctionUrl: "https://xrmyhdtnlfhllfttujfg.supabase.co/functions/v1/indoor-push",
  vapidPublicKey: "BFi-9fYcMSwn9gRP16UhIRB4lFmxD84zxQn2SjXzjE9bf2mROMO0BAkJQTOdU-dpcF9BLcMuBfH-NWnt006Ws-g"
};
