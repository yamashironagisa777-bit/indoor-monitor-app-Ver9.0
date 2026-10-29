(() => {
  // Supabase Authを利用したログイン。固定パスワードはクライアントに置かない。
  const cfg = window.MONITOR_CONFIG || {};
  const AUTH_STORAGE_KEY = 'indoorMonitorSupabaseAuth';
  const loginScreen = document.getElementById('loginScreen');
  const appContent = document.getElementById('appContent');
  const loginForm = document.getElementById('loginForm');
  const loginError = document.getElementById('loginError');
  const logoutButton = document.getElementById('logoutButton');
  let authSession = null;
  let authRefreshPromise = null;

  function readStoredSession() {
    try { return JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) || 'null'); }
    catch (_) { return null; }
  }
  function saveSession(session) {
    authSession = session;
    if (session) localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(AUTH_STORAGE_KEY);
  }
  function authBase() { return String(cfg.supabaseUrl || '').replace(/\/+$/, ''); }
  async function authRequest(path, body) {
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) throw new Error('config.jsのSupabase設定を確認してください。');
    const res = await fetch(`${authBase()}/auth/v1/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: cfg.supabaseAnonKey },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data.msg || data.message || data.error_description || data.error || '';
      if (res.status === 400 || res.status === 401) throw new Error('メールアドレスまたはパスワードを確認してください。');
      throw new Error(message || `認証に失敗しました (HTTP ${res.status})`);
    }
    return data;
  }
  async function getValidSession() {
    if (!authSession) authSession = readStoredSession();
    if (!authSession?.access_token) return null;
    const expiresAt = Number(authSession.expires_at || 0);
    if (expiresAt && expiresAt * 1000 > Date.now() + 60000) return authSession;
    if (!authSession.refresh_token) { saveSession(null); return null; }
    if (!authRefreshPromise) {
      authRefreshPromise = authRequest('token?grant_type=refresh_token', { refresh_token: authSession.refresh_token })
        .then(data => {
          const session = { ...data, expires_at: data.expires_at || Math.floor(Date.now()/1000) + Number(data.expires_in || 3600) };
          saveSession(session); return session;
        })
        .catch(() => { saveSession(null); return null; })
        .finally(() => { authRefreshPromise = null; });
    }
    return authRefreshPromise;
  }
  async function authHeaders(extra = {}) {
    const session = await getValidSession();
    if (!session?.access_token) throw new Error('ログインの有効期限が切れました。もう一度ログインしてください。');
    return { apikey: cfg.supabaseAnonKey, Authorization: `Bearer ${session.access_token}`, ...extra };
  }

  // 保存済みトークンが有効か、起動時・復帰時にSupabase Authで確認する。
  async function validateSession(session) {
    if (!session?.access_token || !cfg.supabaseUrl || !cfg.supabaseAnonKey) return false;
    try {
      const response = await fetch(`${authBase()}/auth/v1/user`, {
        method: 'GET',
        headers: {
          apikey: cfg.supabaseAnonKey,
          Authorization: `Bearer ${session.access_token}`
        },
        cache: 'no-store'
      });
      if (response.status === 401 || response.status === 403) {
        saveSession(null);
        return false;
      }
      // ネットワーク障害時に正しいセッションを勝手に破棄しない。
      return response.ok;
    } catch (_) {
      return true;
    }
  }

  // 同じブラウザの別タブでログアウトした場合も、画面をログイン状態に残さない。
  window.addEventListener('storage', event => {
    if (event.key !== AUTH_STORAGE_KEY) return;
    if (!event.newValue) {
      authSession = null;
      showLogin();
    } else {
      authSession = null; // 次の確認で最新セッションを読み直す
    }
  });
  function showApp() {
    if (loginScreen) loginScreen.hidden = true;
    if (appContent) appContent.hidden = false;
    startMonitorApp();
  }
  function showLogin() {
    if (appContent) appContent.hidden = true;
    if (loginScreen) loginScreen.hidden = false;
    const passwordInput = document.getElementById('loginPassword');
    if (passwordInput) passwordInput.value = '';
  }

  if (loginForm) {
    loginForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const email = document.getElementById('loginEmail')?.value.trim() || '';
      const password = document.getElementById('loginPassword')?.value || '';
      const submitButton = loginForm.querySelector('button[type="submit"]');
      if (loginError) loginError.textContent = '';
      if (submitButton) { submitButton.disabled = true; submitButton.textContent = 'ログイン中…'; }
      try {
        const data = await authRequest('token?grant_type=password', { email, password });
        saveSession({ ...data, expires_at: data.expires_at || Math.floor(Date.now()/1000) + Number(data.expires_in || 3600) });
        if (loginError) loginError.textContent = '';
        showApp();
      } catch (error) {
        if (loginError) loginError.textContent = error.message || 'ログインできませんでした。';
      } finally {
        if (submitButton) { submitButton.disabled = false; submitButton.textContent = 'ログイン'; }
      }
    });
  }
  if (logoutButton) {
    logoutButton.addEventListener('click', async () => {
      const session = await getValidSession();
      try {
        if (session?.access_token) {
          await fetch(`${authBase()}/auth/v1/logout`, {
            method: 'POST', headers: { apikey: cfg.supabaseAnonKey, Authorization: `Bearer ${session.access_token}` }
          });
        }
      } catch (error) { console.warn('サーバー側ログアウトに失敗しました:', error); }
      saveSession(null);
      showLogin();
    });
  }

  function startMonitorApp() {
    if (window.monitorAppStarted) return;
    window.monitorAppStarted = true;

    const cfg = window.MONITOR_CONFIG || {};
    const $ = id => document.getElementById(id);
    const labels = {
      1: { title: '室温の推移', legend: '室温（℃）', unit: '℃' },
      2: { title: '湿度の推移', legend: '湿度（%）', unit: '%' },
      3: { title: 'ガスセンサー値の推移', legend: 'ガスセンサー値（校正前）', unit: '' }
    };
    const AUDIO_BUCKET = cfg.supabaseBucket || 'recordings';
    const AUDIO_OBJECT = cfg.latestAudioPath || 'latest.wav';

    let audioLoading = false;
    // Field 6 の「1」を含む ThingSpeak エントリーを呼び出しイベントとして扱う。
    // エントリーID単位で確認状態を保存するため、同じイベントの再取得では赤表示に戻らず、
    // 次の呼び出し（新しい entry_id）で確実に未確認へ戻る。
    const CALL_EVENT_ID_KEY = 'indoorMonitorLatestCallEventId';
    const CALL_ACK_EVENT_ID_KEY = 'indoorMonitorAcknowledgedCallEventId';
    let latestCallEventId = localStorage.getItem(CALL_EVENT_ID_KEY) || '';
    let acknowledgedCallEventId = localStorage.getItem(CALL_ACK_EVENT_ID_KEY) || '';
    let callEventsInitialized = Boolean(latestCallEventId);

    // 自動運転の温度しきい値（変更するボタンでSupabaseへ送信）
    const TEMP_SETTINGS_KEY = 'indoorMonitorTemperatureSettings';
    const DEFAULT_TEMP_SETTINGS = { upper: 28, lower: 26 };
    let temperatureSettings = loadTemperatureSettings();

    function loadTemperatureSettings() {
      try {
        const saved = JSON.parse(localStorage.getItem(TEMP_SETTINGS_KEY) || 'null');
        if (
          saved &&
          Number.isFinite(Number(saved.upper)) &&
          Number.isFinite(Number(saved.lower)) &&
          Number(saved.upper) >= 15 &&
          Number(saved.upper) <= 40 &&
          Number(saved.lower) >= 15 &&
          Number(saved.lower) <= 40 &&
          Number(saved.upper) > Number(saved.lower)
        ) {
          return { upper: Number(saved.upper), lower: Number(saved.lower) };
        }
      } catch (error) {
        console.warn('温度設定を読み込めませんでした:', error);
      }
      return { ...DEFAULT_TEMP_SETTINGS };
    }

    function saveTemperatureSettings() {
      try {
        localStorage.setItem(TEMP_SETTINGS_KEY, JSON.stringify(temperatureSettings));
        const status = $('temperatureSettingsStatus');
        if (status) status.textContent = '変更内容をブラウザに保存しました。実機へ反映するには「変更する」を押してください。';
      } catch (error) {
        const status = $('temperatureSettingsStatus');
        if (status) status.textContent = '保存できませんでした。ブラウザの保存設定を確認してください。';
      }
    }

    const DEVICE_SETTINGS_TABLE = cfg.deviceSettingsTable || 'device_settings';

    async function sendDeviceSettings(overrides = {}) {
      if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
        throw new Error('config.js のSupabase URL／公開キーを確認してください。');
      }
      const payload = {
        id: 1,
        upper_temp: temperatureSettings.upper,
        lower_temp: temperatureSettings.lower,
        mode: dashboardSettings.fanMode === 'MANUAL' ? 'manual' : 'auto',
        manual_state: dashboardSettings.fanOn ? 'on' : 'off',
        updated_at: new Date().toISOString(),
        ...overrides
      };
      const base = String(cfg.supabaseUrl).replace(/\/+$/, '');
      const response = await fetch(`${base}/rest/v1/${encodeURIComponent(DEVICE_SETTINGS_TABLE)}?on_conflict=id`, {
        method: 'POST',
        headers: await authHeaders({
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=minimal'
        }),
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Supabaseへの送信に失敗しました (HTTP ${response.status}) ${detail}`);
      }
      return payload;
    }

    async function sendCurrentDeviceSettings(statusElementId, successMessage) {
      const status = $(statusElementId);
      try {
        if (status) status.textContent = 'Supabaseへ送信しています…';
        await sendDeviceSettings();
        if (status) status.textContent = successMessage;
        logEvent('家電', successMessage);
        return true;
      } catch (error) {
        console.error('機器設定の送信エラー:', error);
        if (status) status.textContent = `送信できませんでした：${error.message}`;
        return false;
      }
    }

    function renderTemperatureSettings() {
      if ($('autoUpperLimit')) $('autoUpperLimit').textContent = String(temperatureSettings.upper);
      if ($('autoLowerLimit')) $('autoLowerLimit').textContent = String(temperatureSettings.lower);
      document.querySelectorAll('[data-temp-target]').forEach(button => {
        const target = button.dataset.tempTarget;
        const delta = Number(button.dataset.tempDelta);
        const next = temperatureSettings[target] + delta;
        button.disabled = next < 15 || next > 40 ||
          (target === 'upper' && next <= temperatureSettings.lower) ||
          (target === 'lower' && next >= temperatureSettings.upper);
      });
    }

    function changeTemperatureSetting(target, delta) {
      const next = temperatureSettings[target] + delta;
      if (!Number.isFinite(next) || next < 15 || next > 40) return;

      if (target === 'upper' && next <= temperatureSettings.lower) {
        const status = $('temperatureSettingsStatus');
        if (status) status.textContent = '上限温度は下限温度より高く設定してください。';
        return;
      }
      if (target === 'lower' && next >= temperatureSettings.upper) {
        const status = $('temperatureSettingsStatus');
        if (status) status.textContent = '下限温度は上限温度より低く設定してください。';
        return;
      }

      temperatureSettings[target] = next;
      renderTemperatureSettings();
      saveTemperatureSettings();
    }

    function setupTemperatureSettings() {
      renderTemperatureSettings();
      document.querySelectorAll('[data-temp-target]').forEach(button => {
        button.addEventListener('click', () => {
          changeTemperatureSetting(
            button.dataset.tempTarget,
            Number(button.dataset.tempDelta)
          );
        });
      });

      const applyButton = $('applyTemperatureSettings');
      if (applyButton) {
        applyButton.addEventListener('click', async () => {
          if (temperatureSettings.upper <= temperatureSettings.lower) {
            const status = $('temperatureSettingsStatus');
            if (status) status.textContent = '上限温度は下限温度より高く設定してください。';
            return;
          }
          applyButton.disabled = true;
          try {
            const ok = await sendCurrentDeviceSettings(
              'temperatureSettingsStatus',
              'Supabaseに保存しました。Raspberry Piが設定を取得すると反映されます。'
            );
            if (ok) {
              try { localStorage.setItem(TEMP_SETTINGS_KEY, JSON.stringify(temperatureSettings)); } catch (_) {}
            }
          } finally {
            applyButton.disabled = false;
          }
        });
      }

      const resetButton = $('resetTemperatureSettings');
      if (resetButton) {
        resetButton.addEventListener('click', () => {
          temperatureSettings = { ...DEFAULT_TEMP_SETTINGS };
          renderTemperatureSettings();
          saveTemperatureSettings();
        });
      }

      const status = $('temperatureSettingsStatus');
      if (status) {
        status.textContent = '設定を読み込みました。変更後は「変更する」を押して送信してください。';
      }
    }



    // 追加ダッシュボード機能は現段階ではWebブラウザ内で動作します。
    const DASHBOARD_KEY = 'indoorMonitorDashboardSettings';
    const EVENTS_KEY = 'indoorMonitorRecentEvents';
    let selectedRangeDays = 1;
    let previousSensorState = {};
    let wakeEvents = [];
    let dashboardSettings = loadDashboardSettings();
    let recentEvents = loadEvents();

    function loadDashboardSettings() {
      const defaults = {
        fanMode: 'AUTO', fanOn: false,
        notifyDoor: true, notifyGas: true, notifyCall: true,
        gasThreshold: 400
      };
      try {
        const saved = JSON.parse(localStorage.getItem(DASHBOARD_KEY) || 'null');
        return saved ? { ...defaults, ...saved } : defaults;
      } catch (_) { return defaults; }
    }

    function saveDashboardSettings() {
      try {
        localStorage.setItem(DASHBOARD_KEY, JSON.stringify(dashboardSettings));
      } catch (error) {
        console.warn('ダッシュボード設定を保存できません:', error);
      }
    }

    function loadEvents() {
      try {
        const value = JSON.parse(localStorage.getItem(EVENTS_KEY) || '[]');
        return Array.isArray(value) ? value.slice(0, 30) : [];
      } catch (_) { return []; }
    }

    function logEvent(category, message) {
      const item = {
        time: new Date().toISOString(),
        category: String(category || '情報'),
        message: String(message || '')
      };
      recentEvents.unshift(item);
      recentEvents = recentEvents.slice(0, 30);
      try { localStorage.setItem(EVENTS_KEY, JSON.stringify(recentEvents)); } catch (_) {}
      renderEvents();
    }

    function renderEvents() {
      const list = $('recentEvents');
      if (!list) return;
      list.replaceChildren();
      if (!recentEvents.length) {
        const li = document.createElement('li');
        li.textContent = 'まだ出来事はありません。';
        list.appendChild(li);
        return;
      }
      recentEvents.slice(0, 8).forEach(event => {
        const li = document.createElement('li');
        const time = document.createElement('span');
        time.className = 'event-time';
        const d = new Date(event.time);
        time.textContent = Number.isNaN(d.getTime())
          ? '--:--'
          : d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
        const body = document.createElement('span');
        const tag = document.createElement('span');
        tag.className = 'event-tag';
        tag.textContent = event.category;
        body.append(tag, document.createTextNode(event.message));
        li.append(time, body);
        list.appendChild(li);
      });
    }

    function renderFanControls() {
      document.querySelectorAll('[data-fan-mode]').forEach(button => {
        const active = button.dataset.fanMode === dashboardSettings.fanMode;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      });
      const badge = $('fanStateBadge');
      if (badge) badge.textContent = dashboardSettings.fanOn ? 'ON指示済み' : 'OFF指示済み';
      const on = $('fanOnBtn');
      const off = $('fanOffBtn');
      if (on) on.disabled = dashboardSettings.fanMode !== 'MANUAL';
      if (off) off.disabled = dashboardSettings.fanMode !== 'MANUAL';
      const status = $('fanControlStatus');
      if (status) {
        status.textContent = dashboardSettings.fanMode === 'AUTO'
          ? '自動モードです。温度設定は「変更する」で送信し、モード変更はSupabaseへ送信します。'
          : '手動モードです。ON／OFF操作はSupabase経由でRaspberry Piへ送信します。';
      }
    }

    function setupDashboardFeatures() {
      // サーキュレーターの命令をSupabaseへ送信
      document.querySelectorAll('[data-fan-mode]').forEach(button => {
        button.addEventListener('click', async () => {
          const previousMode = dashboardSettings.fanMode;
          dashboardSettings.fanMode = button.dataset.fanMode;
          saveDashboardSettings();
          renderFanControls();
          const ok = await sendCurrentDeviceSettings(
            'fanControlStatus',
            `運転モード「${dashboardSettings.fanMode === 'AUTO' ? '自動' : '手動'}」をSupabaseへ送信しました。`
          );
          if (ok) {
            logEvent('家電', '運転モードを' + (dashboardSettings.fanMode === 'AUTO' ? '自動' : '手動') + 'に変更');
          } else {
            dashboardSettings.fanMode = previousMode;
            saveDashboardSettings();
            renderFanControls();
          }
        });
      });
      if ($('fanOnBtn')) $('fanOnBtn').addEventListener('click', async () => {
        if (dashboardSettings.fanMode !== 'MANUAL') return;
        const previous = dashboardSettings.fanOn;
        dashboardSettings.fanOn = true;
        saveDashboardSettings();
        renderFanControls();
        const ok = await sendCurrentDeviceSettings('fanControlStatus', 'ON命令をSupabaseへ送信しました。');
        if (ok) logEvent('家電', 'サーキュレーター ON命令を送信');
        else { dashboardSettings.fanOn = previous; saveDashboardSettings(); renderFanControls(); }
      });
      if ($('fanOffBtn')) $('fanOffBtn').addEventListener('click', async () => {
        if (dashboardSettings.fanMode !== 'MANUAL') return;
        const previous = dashboardSettings.fanOn;
        dashboardSettings.fanOn = false;
        saveDashboardSettings();
        renderFanControls();
        const ok = await sendCurrentDeviceSettings('fanControlStatus', 'OFF命令をSupabaseへ送信しました。');
        if (ok) logEvent('家電', 'サーキュレーター OFF命令を送信');
        else { dashboardSettings.fanOn = previous; saveDashboardSettings(); renderFanControls(); }
      });

      // 通知スイッチの保存
      ['notifyDoor', 'notifyGas', 'notifyCall'].forEach(id => {
        const input = $(id);
        if (!input) return;
        input.checked = Boolean(dashboardSettings[id]);
        input.addEventListener('change', async () => {
          dashboardSettings[id] = input.checked;
          saveDashboardSettings();
          syncServiceWorkerPreferences();
          const status = $('notificationStatus');
          if (input.checked) {
            try {
              await subscribePushNotifications();
              if (status) status.textContent = '通知を登録しました。アプリを閉じていても、サーバー設定完了後はプッシュ通知を受信できます。';
            } catch (error) {
              const permission = ('Notification' in window) ? Notification.permission : 'unsupported';
              if (status) status.textContent = '画面内通知設定は保存しましたが、バックグラウンド通知の登録に失敗しました: ' + error.message;
            }
          } else {
            try { await syncPushPreferences(); } catch (error) { console.warn(error); }
            if (status) status.textContent = 'この種類の通知をOFFにしました。';
          }
        });
      });

      if ($('testNotificationBtn')) $('testNotificationBtn').addEventListener('click', async () => {
        const status = $('notificationStatus');
        if (!('Notification' in window)) {
          if (status) status.textContent = 'このブラウザは通知APIに対応していません。';
          return;
        }
        try {
          const permission = await ensureNotificationPermission();
          if (permission === 'granted') {
            const reg = await registerPushWorker();
            await reg.showNotification('室内監視システム', { body: 'テスト通知です。', icon: './icon.svg' });
            try { await subscribePushNotifications(); } catch (e) { console.warn('Push登録は未完了:', e); }
            if (status) status.textContent = '端末内テスト通知を表示しました。アプリ終了中の通知には、READMEのサーバー設定も必要です。';
            logEvent('通知', 'テスト通知を実行');
          } else if (status) {
            status.textContent = '通知は許可されていません。ブラウザのサイト設定を確認してください。';
          }
        } catch (error) {
          if (status) status.textContent = '通知を表示できませんでした: ' + error.message;
        }
      });

      // 録音を再生できたら、その呼び出しを確認済みにする。
      if ($('playCallAudio')) $('playCallAudio').addEventListener('click', async () => {
        const player = $('latestAudio');
        if (!player || !player.src) {
          if ($('audioStatus')) $('audioStatus').textContent = '呼び出し録音を取得中です。少し待ってから再生してください。';
          return;
        }
        try {
          await player.play();
          if (latestCallEventId) {
            acknowledgedCallEventId = latestCallEventId;
            localStorage.setItem(CALL_ACK_EVENT_ID_KEY, acknowledgedCallEventId);
          }
          renderCallAlert();
          logEvent('呼び出し', '録音を再生して確認済みにした');
        } catch (error) {
          if ($('audioStatus')) $('audioStatus').textContent = '再生できませんでした。再生ボタンを押してください。';
        }
      });

      if ($('clearEventsBtn')) $('clearEventsBtn').addEventListener('click', () => {
        recentEvents = [];
        try { localStorage.removeItem(EVENTS_KEY); } catch (_) {}
        renderEvents();
      });

      // グラフ期間切替
      document.querySelectorAll('[data-range]').forEach(button => {
        button.addEventListener('click', () => {
          selectedRangeDays = Number(button.dataset.range) || 1;
          document.querySelectorAll('[data-range]').forEach(item => {
            const active = item === button;
            item.classList.toggle('active', active);
            item.setAttribute('aria-pressed', String(active));
          });
          drawChart();
        });
      });

      renderFanControls();
      renderEvents();
      renderWakeHistory();
    }

    function renderWakeHistory() {
      const current = $('wakeCurrentStatus');
      const summary = $('wakeSummary');
      const list = $('wakeHistory');
      if (current) {
        const bedText = $('bed')?.textContent || '--';
        current.textContent = bedText === '在床あり' ? '在床あり' :
          bedText === '在床なし' ? '離床中' : '在床状態を確認できません';
      }
      if (summary) summary.textContent = 'センサーの最新状態：' + (($('updatedAt')?.textContent || '').replace('最終更新：', '') || '--');
      if (!list) return;
      list.replaceChildren();
      if (!wakeEvents.length) {
        const li = document.createElement('li');
        li.textContent = 'ページを開いてからの在床状態の変化がここに表示されます。';
        list.appendChild(li);
        return;
      }
      wakeEvents.slice(0, 5).forEach(event => {
        const li = document.createElement('li');
        const time = document.createElement('span');
        time.className = 'event-time';
        time.textContent = event.time;
        const body = document.createElement('span');
        body.textContent = event.message;
        li.append(time, body);
        list.appendChild(li);
      });
    }

    function trackSensorEvents(feed) {
      if (!feed) return;
      const current = {
        door: Number(feed.field4) >= 1,
        bed: Number(feed.field5) >= 1,
        gas: Number(feed.field3)
      };
      if (previousSensorState.door !== undefined && current.door !== previousSensorState.door) {
        const message = current.door ? 'ドアが開きました' : 'ドアが閉まりました';
        logEvent('ドア', message);
        if (dashboardSettings.notifyDoor) showBrowserNotification('ドア状態', message);
      }
      if (previousSensorState.bed !== undefined && current.bed !== previousSensorState.bed) {
        const message = current.bed ? '在床を検知しました' : '離床を検知しました';
        wakeEvents.unshift({
          time: new Date().toLocaleTimeString('ja-JP', {hour:'2-digit', minute:'2-digit'}),
          message
        });
        wakeEvents = wakeEvents.slice(0, 10);
        renderWakeHistory();
        logEvent('ベッド', message);
      }
      if (Number.isFinite(current.gas) && previousSensorState.gas !== undefined &&
          current.gas >= dashboardSettings.gasThreshold && previousSensorState.gas < dashboardSettings.gasThreshold) {
        logEvent('ガス', '設定しきい値を超えました（校正前の値）');
        if (dashboardSettings.notifyGas) showBrowserNotification('ガスセンサー', 'しきい値を超えました。現地を確認してください。');
      }
      previousSensorState = current;
      renderWakeHistory();
    }

    async function registerPushWorker() {
      if (!('serviceWorker' in navigator)) throw new Error('このブラウザはService Worker非対応です。');
      return navigator.serviceWorker.register('./service-worker.js');
    }

    // 通知設定をService Workerにも保存し、アプリを閉じた状態のPush通知にも反映する。
    async function syncServiceWorkerPreferences() {
      if (!('serviceWorker' in navigator)) return;
      try {
        const registration = await navigator.serviceWorker.getRegistration('./') || await registerPushWorker();
        const worker = registration.active || registration.waiting || registration.installing;
        if (worker) worker.postMessage({
          type: 'SET_NOTIFICATION_PREFERENCES',
          preferences: {
            door: !!dashboardSettings.notifyDoor,
            gas: !!dashboardSettings.notifyGas,
            call: !!dashboardSettings.notifyCall
          }
        });
      } catch (error) { console.warn('Service Workerへの通知設定同期に失敗:', error); }
    }

    function decodeVapidKey(base64String) {
      const padding = '='.repeat((4 - base64String.length % 4) % 4);
      const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
      const raw = atob(base64);
      return Uint8Array.from([...raw].map(ch => ch.charCodeAt(0)));
    }

    async function subscribePushNotifications() {
      if (!cfg.pushFunctionUrl || !cfg.vapidPublicKey || cfg.vapidPublicKey.includes('PASTE_')) {
        throw new Error('プッシュ通知のサーバー設定が未完了です。READMEの設定手順を実施してください。');
      }
      const permission = await ensureNotificationPermission();
      if (permission !== 'granted') throw new Error('ブラウザの通知許可が必要です。');
      const registration = await registerPushWorker();
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodeVapidKey(cfg.vapidPublicKey)
        });
      }
      const response = await fetch(cfg.pushFunctionUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': cfg.supabaseAnonKey, 'Authorization': `Bearer ${cfg.supabaseAnonKey}` },
        body: JSON.stringify({ action: 'subscribe', subscription: subscription.toJSON(), preferences: { door: !!dashboardSettings.notifyDoor, gas: !!dashboardSettings.notifyGas, call: !!dashboardSettings.notifyCall }, gasThreshold: Number(dashboardSettings.gasThreshold) || 400 })
      });
      if (!response.ok) throw new Error('通知登録に失敗しました (HTTP ' + response.status + ')');
      return true;
    }

    async function syncPushPreferences() {
      if (!cfg.pushFunctionUrl || !cfg.vapidPublicKey || cfg.vapidPublicKey.includes('PASTE_')) return;
      const registration = await navigator.serviceWorker.getRegistration('./');
      const subscription = registration && await registration.pushManager.getSubscription();
      if (!subscription) return;
      const response = await fetch(cfg.pushFunctionUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': cfg.supabaseAnonKey, 'Authorization': `Bearer ${cfg.supabaseAnonKey}` },
        body: JSON.stringify({ action: 'subscribe', subscription: subscription.toJSON(), preferences: { door: !!dashboardSettings.notifyDoor, gas: !!dashboardSettings.notifyGas, call: !!dashboardSettings.notifyCall }, gasThreshold: Number(dashboardSettings.gasThreshold) || 400 })
      });
      if (!response.ok) throw new Error('通知設定の同期に失敗しました');
    }

    async function ensureNotificationPermission() {
      if (!('Notification' in window)) return 'unsupported';
      if (Notification.permission === 'default') {
        try { return await Notification.requestPermission(); }
        catch (_) { return Notification.permission; }
      }
      return Notification.permission;
    }

    function showBrowserNotification(title, body) {
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      try { new Notification(title, { body, tag: 'indoor-monitor-' + title }); } catch (_) {}
    }

    function formatAudioDate(value) {
      if (!value) return '';
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ja-JP');
    }

    // 固定ファイル latest.wav の署名付きURLを取得し、音声データ自体もキャッシュせず読み込む
    let currentAudioObjectUrl = null;
    let currentAudioHash = null;

    async function refreshLatestAudio() {
      if (audioLoading) return;

      const player = $('latestAudio');
      if (!player) return;

      if (
        !cfg.supabaseUrl ||
        !cfg.supabaseAnonKey ||
        String(cfg.supabaseUrl).includes('YOUR_') ||
        String(cfg.supabaseAnonKey).includes('YOUR_')
      ) {
        console.warn('呼び出し録音の再生には config.js のSupabase設定が必要です。');
        if ($('audioStatus')) $('audioStatus').textContent = 'Supabaseの設定を確認してください。';
        return;
      }

      audioLoading = true;
      const status = $('audioStatus');

      try {
        const base = String(cfg.supabaseUrl).replace(/\/+$/, '');
        const headers = await authHeaders({ 'Content-Type': 'application/json' });

        const encodedPath = AUDIO_OBJECT
          .split('/')
          .map(encodeURIComponent)
          .join('/');
        const signUrl =
          `${base}/storage/v1/object/sign/` +
          `${encodeURIComponent(AUDIO_BUCKET)}/${encodedPath}`;

        const signRes = await fetch(signUrl, {
          method: 'POST',
          headers,
          cache: 'no-store',
          body: JSON.stringify({ expiresIn: 600 })
        });

        if (!signRes.ok) {
          const detail = await signRes.text();
          console.error('Supabase署名付きURL取得エラー', {
            status: signRes.status,
            response: detail
          });
          if (signRes.status === 404) {
            throw new Error(`録音ファイルが見つかりません。${AUDIO_BUCKET}/${AUDIO_OBJECT} を確認してください。`);
          }
          if (signRes.status === 400 || signRes.status === 403) {
            throw new Error(`録音へのアクセスに失敗しました (HTTP ${signRes.status})。Storageの権限設定を確認してください。`);
          }
          throw new Error(`再生URLを取得できません (HTTP ${signRes.status})。`);
        }

        const signed = await signRes.json();
        const signedPath = signed.signedURL || signed.signedUrl;
        if (!signedPath) {
          throw new Error('Supabaseから署名付き再生URLが返されませんでした。');
        }

        let audioUrl;
        if (/^https?:\/\//i.test(signedPath)) {
          audioUrl = signedPath;
        } else if (signedPath.startsWith('/storage/v1/')) {
          audioUrl = `${base}${signedPath}`;
        } else {
          audioUrl = `${base}/storage/v1/${signedPath.replace(/^\/+/, '')}`;
        }

        // 署名付きURLだけでなく音声本体を取得し直す。cache:no-storeで古い録音の再利用を防ぐ。
        const audioRes = await fetch(audioUrl, {
          method: 'GET',
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache' }
        });
        if (!audioRes.ok) {
          throw new Error(`録音データを取得できません (HTTP ${audioRes.status})。`);
        }

        const audioBlob = await audioRes.blob();
        if (!audioBlob.size) throw new Error('取得した録音データが空でした。');

        // latest.wav が前回と異なる内容なら、新しい呼び出しとして確認状態を解除する。
        const audioBytes = await audioBlob.arrayBuffer();
        let audioHash;
        if (window.crypto && window.crypto.subtle) {
          const digest = await window.crypto.subtle.digest('SHA-256', audioBytes);
          audioHash = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
        } else {
          audioHash = `${audioBlob.size}:${audioBlob.type}:${audioBlob.lastModified || 0}`;
        }
        // 録音ファイルは再取得しますが、確認状態の切り替えは ThingSpeak の
        // Field 6 の新しい entry_id を基準に行います（固定 latest.wav の更新時刻だけには依存しません）。
        currentAudioHash = audioHash;

        const nextObjectUrl = URL.createObjectURL(audioBlob);
        const previousObjectUrl = currentAudioObjectUrl;
        player.src = nextObjectUrl;
        player.dataset.signedAt = String(Date.now());
        player.load();
        player.hidden = true;
        currentAudioObjectUrl = nextObjectUrl;

        if (previousObjectUrl) URL.revokeObjectURL(previousObjectUrl);
        if (status) status.textContent = `呼び出し録音を取得しました（${new Date().toLocaleTimeString('ja-JP')}）。`;
      } catch (e) {
        console.error('呼び出し録音を取得できません:', e.message || e);
        // 取得失敗時も、以前に取得できた録音は消さずに残す
        if (status) status.textContent = `録音を更新できませんでした。${e.message || '通信状態を確認してください。'}`;
      } finally {
        audioLoading = false;
      }
    }

    let selectedField = '1';
    let latestFeed = null;
    let feeds = [];
    let loading = false;

    const validConfig = () =>
      cfg.channelId &&
      cfg.readApiKey &&
      !String(cfg.channelId).includes('YOUR_') &&
      !String(cfg.readApiKey).includes('YOUR_');

    function setConnection(ok, text) {
      const dot = $('connectionDot');
      const label = $('connectionText');
      if (dot) dot.className = 'dot ' + (ok ? 'ok' : 'bad');
      if (label) label.textContent = text;
    }

    function setAlert(kind, title, detail, icon) {
      const el = $('alertCard');
      if (!el) return;
      el.className = 'alert-card' + (kind ? ' ' + kind : '');
      if ($('alertTitle')) $('alertTitle').textContent = title;
      if ($('alertDetail')) $('alertDetail').textContent = detail;
      if ($('alertIcon')) $('alertIcon').textContent = icon;
    }

    function fmtNum(v, digits = 1) {
      if (v === null || v === undefined || v === '') return '--';
      const n = Number(v);
      return Number.isFinite(n) ? n.toFixed(digits) : '--';
    }

    function statusText(v, yes, no) {
      if (v === null || v === undefined || v === '') return '--';
      return Number(v) >= 1 ? yes : no;
    }

    function renderLatest(f) {
      if (!f) return;
      if ($('temperature')) $('temperature').textContent = fmtNum(f.field1);
      if ($('humidity')) $('humidity').textContent = fmtNum(f.field2);
      if ($('gas')) $('gas').textContent = fmtNum(f.field3, 0);
      if ($('door')) $('door').textContent = statusText(f.field4, '開いています', '閉まっています');
      if ($('bed')) $('bed').textContent = statusText(f.field5, '在床あり', '在床なし');

      // Field 6 は個別の呼び出しイベントとして履歴から判定する。
      // 最新の測定データ行で Field 6 が空欄でも、呼び出し状態を解除しない。

      if (f.created_at) {
        const d = new Date(f.created_at);
        if ($('updatedAt')) {
          $('updatedAt').textContent =
            '最終更新：' +
            (Number.isNaN(d.getTime()) ? f.created_at : d.toLocaleString('ja-JP'));
        }

        const age = Date.now() - d.getTime();
        if (Number.isFinite(age) && age > 5 * 60 * 1000) {
          setAlert(
            'warning',
            'データの更新が遅れています',
            '最後の記録から5分以上経過しています。Raspberry Piとネットワークを確認してください。',
            '!'
          );
        } else {
          setAlert(
            '',
            '監視データを受信しています',
            '以下はクラウドに保存された最新の測定値です。',
            '✓'
          );
        }
      }

      if (f.field1 !== '' && Number(f.field1) >= 30) {
        setAlert(
          'warning',
          '室温が高くなっています',
          '室温が30℃以上です。現地の状況を確認してください。',
          '!'
        );
      }
    }


    function renderCallAlert() {
      const card = $('callAlert');
      if (!card) return;
      const hasCall = Boolean(latestCallEventId);
      const isAcknowledged = hasCall && acknowledgedCallEventId === latestCallEventId;
      card.classList.toggle('active', hasCall && !isAcknowledged);
      card.classList.toggle('acknowledged', hasCall && isAcknowledged);
      if ($('callAlertTitle')) {
        $('callAlertTitle').textContent = !hasCall ? '呼び出しはありません' :
          (isAcknowledged ? '呼び出しを確認済み' : '呼び出しがあります');
      }
      if ($('callAlertDetail')) {
        $('callAlertDetail').textContent = !hasCall
          ? '呼び出しボタンの通知状態を表示します。'
          : (isAcknowledged
            ? '録音を再生しました。新しい呼び出しが届くと再び通知します。'
            : '新しい呼び出しを受信しました。録音を再生して状況を確認してください。');
      }
      if ($('callAlertIcon')) $('callAlertIcon').textContent = '!';
    }

    function processCallEvents(historyFeeds) {
      // Field 6 が 1 以上の行のうち、entry_id が最も新しいものを呼び出しイベントとする。
      // 通常の測定データ行で Field 6 が空欄でも、直近の呼び出しを維持する。
      let eventFeed = null;
      for (const feed of (Array.isArray(historyFeeds) ? historyFeeds : [])) {
        if (feed.field6 !== undefined && feed.field6 !== null && feed.field6 !== '' && Number(feed.field6) >= 1) {
          if (!eventFeed || Number(feed.entry_id || 0) >= Number(eventFeed.entry_id || 0)) eventFeed = feed;
        }
      }
      if (eventFeed) {
        const eventId = String(eventFeed.entry_id || eventFeed.created_at || '');
        if (eventId && eventId !== latestCallEventId) {
          const isNewDuringThisSession = callEventsInitialized;
          latestCallEventId = eventId;
          callEventsInitialized = true;
          localStorage.setItem(CALL_EVENT_ID_KEY, latestCallEventId);
          logEvent('呼び出し', '新しい呼び出しを受信しました（ThingSpeak entry ' + latestCallEventId + '）');
          // 初回読み込み時の過去イベントでは通知せず、監視開始後に届いた新規イベントだけ通知する。
          if (isNewDuringThisSession && dashboardSettings.notifyCall) {
            //showBrowserNotification('呼び出し通知', '新しい呼び出しがありました。室内監視画面で録音を再生して確認してください。');
          }
        }
      }
      renderCallAlert();
    }

    async function api(path) {
      const url =
        `https://api.thingspeak.com/channels/${encodeURIComponent(cfg.channelId)}/${path}` +
        `${path.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(cfg.readApiKey)}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('クラウドAPIエラー: HTTP ' + res.status);
      return res.json();
    }

    async function refresh() {
      if (loading) return;

      if (!validConfig()) {
        setConnection(false, '初期設定が必要です');
        setAlert(
          'warning',
          'クラウド設定が未完了です',
          'config.js にチャンネルIDと読み取りAPIキーを設定してください。',
          '!'
        );
        if ($('chartEmpty')) {
          $('chartEmpty').textContent = 'config.js の設定後に履歴が表示されます。';
        }
        return;
      }

      loading = true;
      try {
        const [last, history] = await Promise.all([
          api('feeds/last.json'),
          api(`feeds.json?results=${Math.min(8000, Math.max(1, Number(cfg.historyResults) || 100))}`)
        ]);

        if (last && last.created_at) {
          latestFeed = last;
          renderLatest(last);
          trackSensorEvents(last);
        }
        feeds = Array.isArray(history.feeds) ? history.feeds : [];
        processCallEvents(feeds);

        if (!latestFeed && feeds.length) {
          latestFeed = feeds[feeds.length - 1];
          renderLatest(latestFeed);
          trackSensorEvents(latestFeed);
        }
        if (!latestFeed) {
          throw new Error('データがまだありません。Piから最初のデータを送信してください。');
        }

        setConnection(true, 'クラウド接続中');
        drawChart();
      } catch (e) {
        setConnection(false, '接続できません');
        if (!latestFeed) {
          setAlert(
            'error',
            'データを取得できません',
            e.message + ' チャンネルID・Read API Key・インターネット接続を確認してください。',
            '×'
          );
        }
        if ($('chartEmpty')) {
          $('chartEmpty').textContent = 'データを取得できません。設定と通信を確認してください。';
        }
      } finally {
        loading = false;
      }
    }

    function drawChart() {
      const canvas = $('historyChart');
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const w = rect.width;
      const h = rect.height;
      ctx.clearRect(0, 0, w, h);

      const cutoff = Date.now() - selectedRangeDays * 24 * 60 * 60 * 1000;
      const data = feeds
        .filter(f =>
          f['field' + selectedField] !== null &&
          f['field' + selectedField] !== '' &&
          Number.isFinite(Number(f['field' + selectedField])) &&
          f.created_at && new Date(f.created_at).getTime() >= cutoff
        )
        .slice(-500);

      const meta = labels[selectedField];
      if ($('chartTitle')) $('chartTitle').textContent = meta.title;
      if ($('legendText')) $('legendText').textContent = meta.legend;
      if ($('chartRange')) $('chartRange').textContent = data.length ? `${selectedRangeDays === 1 ? '24時間' : selectedRangeDays + '日'}・${data.length}件` : '記録なし';
      if ($('chartEmpty')) $('chartEmpty').style.display = data.length ? 'none' : 'grid';
      if (!data.length) return;

      const pad = { l: 42, r: 12, t: 14, b: 34 };
      const cw = w - pad.l - pad.r;
      const ch = h - pad.t - pad.b;
      const vals = data.map(f => Number(f['field' + selectedField]));
      let min = Math.min(...vals);
      let max = Math.max(...vals);
      if (min === max) {
        min -= 1;
        max += 1;
      }
      const margin = (max - min) * 0.12;
      min -= margin;
      max += margin;

      ctx.font = '10px system-ui, sans-serif';
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#e5ebf0';
      ctx.fillStyle = '#738391';

      for (let i = 0; i < 5; i++) {
        const y = pad.t + ch * i / 4;
        ctx.beginPath();
        ctx.moveTo(pad.l, y);
        ctx.lineTo(w - pad.r, y);
        ctx.stroke();

        const v = max - (max - min) * i / 4;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(v.toFixed(selectedField === '3' ? 0 : 1), pad.l - 7, y);
      }

      const pts = data.map((f, i) => ({
        x: pad.l + (data.length === 1 ? cw / 2 : cw * i / (data.length - 1)),
        y: pad.t + ch * (max - Number(f['field' + selectedField])) / (max - min),
        t: new Date(f.created_at)
      }));

      ctx.beginPath();
      pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.strokeStyle = '#2276a8';
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();

      if (pts.length < 60) {
        pts.forEach(p => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
          ctx.fillStyle = '#2276a8';
          ctx.fill();
        });
      }

      ctx.fillStyle = '#738391';
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillText(
        pts[0].t.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }),
        pad.l,
        h - pad.b + 12
      );
      ctx.textAlign = 'right';
      ctx.fillText(
        pts[pts.length - 1].t.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }),
        w - pad.r,
        h - pad.b + 12
      );
    }

    document.querySelectorAll('.tab').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        selectedField = b.dataset.field;
        drawChart();
      });
    });

    if ($('refreshBtn')) $('refreshBtn').addEventListener('click', refresh);
    window.addEventListener('resize', drawChart);

    // Push通知を受信するService Workerを登録する。既存登録は解除しない。
    registerPushWorker()
      .then(() => syncServiceWorkerPreferences())
      .catch(error => console.warn('Service Worker登録エラー:', error));

    setupTemperatureSettings();
    setupDashboardFeatures();

    refresh();
    refreshLatestAudio();

    const refreshInterval = Math.max(30000, Number(cfg.refreshMs) || 30000);
    setInterval(refresh, refreshInterval);

    // 音声も定期的に最新URLへ更新する。再生中は中断しない。
    const audioRefreshInterval = Math.max(30000, Number(cfg.audioRefreshMs) || 60000);
    setInterval(() => {
      const player = $('latestAudio');
      if (!player || player.paused || player.ended) {
        refreshLatestAudio();
      }
    }, audioRefreshInterval);
  }

  (async () => {
    const session = await getValidSession();
    if (session && await validateSession(session)) {
      showApp();
    } else {
      saveSession(null);
      showLogin();
    }
  })();

  // アプリを開いたまま長時間経過した場合や、別アプリから戻った場合に認証を再確認。
  let sessionValidationInProgress = false;
  async function revalidateOnReturn() {
    if (document.visibilityState !== 'visible' || sessionValidationInProgress) return;
    sessionValidationInProgress = true;
    try {
      const session = await getValidSession();
      if (!session || !(await validateSession(session))) {
        saveSession(null);
        showLogin();
      }
    } finally {
      sessionValidationInProgress = false;
    }
  }
  document.addEventListener('visibilitychange', revalidateOnReturn);
  window.addEventListener('focus', revalidateOnReturn);
})();
