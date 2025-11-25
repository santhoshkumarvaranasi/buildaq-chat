(() => {
  const STORAGE_KEY = 'buildaq-chat:v1';
  const state = {
    passcode: null,
    messages: []
  };

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const messageList = document.getElementById('messageList');
  const template = document.getElementById('messageTemplate');
  const messageForm = document.getElementById('composer');
  const messageInput = document.getElementById('messageInput');
  const codeInput = document.getElementById('codeInput');
  const setCodeButton = document.getElementById('setCodeButton');
  const lockLabel = document.getElementById('lockLabel');
  const lockState = document.getElementById('lockState');
  const clearButton = document.getElementById('clearButton');
  const demoButton = document.getElementById('demoButton');
  const exportButton = document.getElementById('exportButton');
  const exportBox = document.getElementById('exportBox');
  const relayStatus = document.getElementById('relayStatus');
  const relayUrlInput = document.getElementById('relayUrl');
  const roomInput = document.getElementById('roomInput');
  const connectButton = document.getElementById('connectButton');
  const disconnectButton = document.getElementById('disconnectButton');

  const heroMessages = [
    'All messages are locked until you and your partner share the same code.',
    'Codes never leave your browser. Change them anytime.',
    'Use the demo button to see how a locked message looks.'
  ];

  const RELAY_KEY = 'buildaq-chat:relay';
  let signalRConn = null;
  let shouldReconnect = false;
  let reconnectTimer = null;
  let reconnectAttempts = 0;

  function uid() {
    return typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `m-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function toB64(data) {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer || data);
    let binary = '';
    bytes.forEach((b) => (binary += String.fromCharCode(b)));
    return btoa(binary);
  }

  function fromB64(str) {
    const binary = atob(str);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }

  async function deriveKey(code, salt) {
    const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(code), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptMessage(text, code, sender = 'You') {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(code, salt);
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(text));
    return {
      id: uid(),
      sender,
      at: new Date().toISOString(),
      salt: toB64(salt),
      iv: toB64(iv),
      ciphertext: toB64(cipher)
    };
  }

  async function decryptMessage(entry, code) {
    const salt = fromB64(entry.salt);
    const iv = fromB64(entry.iv);
    const cipher = fromB64(entry.ciphertext);
    const key = await deriveKey(code, salt);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return decoder.decode(plain);
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.messages));
    } catch (err) {
      console.warn('Unable to persist conversation', err);
    }
    updateExportBox(false);
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        state.messages = JSON.parse(raw);
        return;
      }
    } catch (err) {
      console.warn('Unable to load saved conversation', err);
    }
  }

  function saveRelayConfig() {
    try {
      localStorage.setItem(
        RELAY_KEY,
        JSON.stringify({ relayUrl: relayUrlInput.value.trim(), room: roomInput.value.trim() })
      );
    } catch (err) {
      console.warn('Unable to save relay config', err);
    }
  }

  function loadRelayConfig() {
    try {
      const raw = localStorage.getItem(RELAY_KEY);
      if (raw) {
        const cfg = JSON.parse(raw);
        relayUrlInput.value = cfg.relayUrl || '';
        roomInput.value = cfg.room || '';
      }
    } catch (err) {
      console.warn('Unable to load relay config', err);
    }
  }

  async function seedDemo() {
    if (state.messages.length) return;
    const intro = `This demo message is encrypted. Use code "buildaq-demo" to unlock it.\n\n` +
      heroMessages[Math.floor(Math.random() * heroMessages.length)];
    const demo = await encryptMessage(intro, 'buildaq-demo', 'buildaq');
    state.messages.push(demo);
    save();
  }

  function updateLockUI(message) {
    const unlocked = Boolean(state.passcode);
    lockLabel.textContent = unlocked ? 'Unlocked with shared code' : (message || 'Locked · enter the code');
    const icon = lockState.querySelector('.lock-state__icon');
    if (icon) icon.textContent = unlocked ? '🔓' : '🔒';
  }

  function relock(reasonText = 'Locked · enter the code') {
    state.passcode = null;
    codeInput.value = '';
    updateLockUI(reasonText);
    renderMessages();
  }

  function updateRelayStatus(label, variant = 'ghost') {
    relayStatus.textContent = label;
    relayStatus.className = `badge badge--${variant}`;
  }

  function fmtTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function cipherPreview(cipher) {
    const max = 180;
    return cipher.length > max ? `${cipher.slice(0, max)}…` : cipher;
  }

  async function renderMessages() {
    messageList.innerHTML = '';
    if (!state.messages.length) {
      const empty = document.createElement('div');
      empty.className = 'bubble bubble--locked';
      empty.innerHTML = `<div class="bubble__body">No messages yet. Set a shared code, then send a note.</div>`;
      messageList.appendChild(empty);
      return;
    }

    for (const entry of state.messages) {
      const node = template.content.firstElementChild.cloneNode(true);
      const body = node.querySelector('.bubble__body');
      const metaAuthor = node.querySelector('.bubble__author');
      const metaTime = node.querySelector('.bubble__time');
      const cipher = node.querySelector('.bubble__cipher');

      let unlocked = false;
      metaAuthor.textContent = entry.sender || 'Peer';
      metaTime.textContent = fmtTime(entry.at);

      if (state.passcode) {
        try {
          const text = await decryptMessage(entry, state.passcode);
          body.textContent = text;
          unlocked = true;
        } catch (err) {
          body.innerHTML = `<span class="badge badge--danger">Encrypted</span> Incorrect code for this message.`;
        }
      } else {
        body.innerHTML = `<span class="badge badge--ok">Encrypted</span> Enter the shared code to view.`;
      }

      cipher.textContent = cipherPreview(entry.ciphertext);
      if (!unlocked) node.classList.add('bubble--locked');
      messageList.appendChild(node);
    }
  }

  async function handleSend(event) {
    event.preventDefault();
    const text = messageInput.value.trim();
    if (!text) return;
    const code = state.passcode || codeInput.value.trim();
    if (!code) {
      codeInput.focus();
      lockLabel.textContent = 'Add a shared code before sending.';
      return;
    }
    state.passcode = code;
    updateLockUI();

    const encrypted = await encryptMessage(text, code, 'You');
    state.messages.push(encrypted);
    sendToRelay(encrypted);
    messageInput.value = '';
    save();
    renderMessages();
  }

  async function addDemoMessage() {
    const code = state.passcode || 'buildaq-demo';
    const text = heroMessages[Math.floor(Math.random() * heroMessages.length)];
    const encrypted = await encryptMessage(text, code, 'Partner');
    state.messages.push(encrypted);
    save();
    renderMessages();
  }

  function hasMessage(id) {
    return state.messages.some((m) => m.id === id);
  }

  async function handleIncoming(payload) {
    const required = ['id', 'sender', 'at', 'ciphertext', 'iv', 'salt'];
    if (!payload || required.some((k) => !payload[k])) return;
    if (hasMessage(payload.id)) return;
    state.messages.push(payload);
    save();
    renderMessages();
  }

  function sendToRelay(entry) {
    if (!signalRConn || signalRConn.state !== signalR.HubConnectionState.Connected) return;
    const room = roomInput.value.trim();
    if (!room) return;
    signalRConn.invoke('SendToRoom', { room, ...entry }).catch((err) => {
      console.warn('Relay send failed', err);
    });
  }

  function scheduleReconnect() {
    if (!shouldReconnect) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(reconnectAttempts, 5));
    reconnectAttempts += 1;
    updateRelayStatus(`Reconnecting in ${Math.round(delay / 1000)}s`, 'ghost');
    reconnectTimer = setTimeout(connectRelay, delay);
  }

  function disconnectRelay() {
    shouldReconnect = false;
    reconnectAttempts = 0;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (signalRConn) {
      signalRConn.stop();
      signalRConn = null;
    }
    updateRelayStatus('Disconnected', 'ghost');
  }

  async function connectRelay() {
    const relayUrl = relayUrlInput.value.trim().replace(/\/+$/, '');
    const room = roomInput.value.trim();
    if (!relayUrl || !room) {
      updateRelayStatus('Enter relay URL and room', 'ghost');
      return;
    }
    shouldReconnect = true;
    reconnectAttempts = 0;
    saveRelayConfig();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (signalRConn) {
      await signalRConn.stop().catch(() => {});
      signalRConn = null;
    }

    updateRelayStatus('Connecting…', 'ghost');
    signalRConn = new signalR.HubConnectionBuilder()
      .withUrl(`${relayUrl}/relay?room=${encodeURIComponent(room)}`, { withCredentials: false })
      .withAutomaticReconnect()
      .configureLogging(signalR.LogLevel.Information)
      .build();

    signalRConn.on('message', async (payload) => {
      await handleIncoming(payload);
    });

    signalRConn.onreconnecting(() => updateRelayStatus('Reconnecting…', 'ghost'));
    signalRConn.onreconnected(() => {
      reconnectAttempts = 0;
      updateRelayStatus('Connected', 'ok');
    });
    signalRConn.onclose(() => {
      updateRelayStatus('Disconnected', 'ghost');
      if (shouldReconnect) scheduleReconnect();
    });

    try {
      await signalRConn.start();
      updateRelayStatus('Connected', 'ok');
    } catch (err) {
      console.warn('SignalR connect failed', err);
      updateRelayStatus('Relay error', 'danger');
      scheduleReconnect();
    }
  }

  function updateExportBox(show = true) {
    try {
      const encoded = toB64(encoder.encode(JSON.stringify(state.messages)));
      exportBox.value = encoded;
      if (show) {
        exportBox.focus();
        exportBox.select();
      }
    } catch (err) {
      exportBox.value = '';
      console.warn('Unable to export encrypted log', err);
    }
  }

  function importFromBox() {
    const payload = exportBox.value.trim();
    if (!payload) return;
    try {
      const parsed = JSON.parse(decoder.decode(fromB64(payload)));
      if (Array.isArray(parsed)) {
        state.messages = parsed;
        save();
        renderMessages();
      }
    } catch (err) {
      alert('Import failed. Is the payload intact?');
    }
  }

  function wireEvents() {
    messageForm.addEventListener('submit', handleSend);
    setCodeButton.addEventListener('click', () => {
      const code = codeInput.value.trim();
      if (!code) return codeInput.focus();
      state.passcode = code;
      updateLockUI();
      renderMessages();
    });

    codeInput.addEventListener('keyup', (e) => {
      if (e.key === 'Enter') setCodeButton.click();
    });

    clearButton.addEventListener('click', () => {
      if (!confirm('Clear local encrypted messages?')) return;
      state.messages = [];
      save();
      renderMessages();
    });

    demoButton.addEventListener('click', addDemoMessage);
    exportButton.addEventListener('click', () => updateExportBox(true));
    exportBox.addEventListener('change', importFromBox);

    connectButton.addEventListener('click', connectRelay);
    disconnectButton.addEventListener('click', disconnectRelay);
    relayUrlInput.addEventListener('change', saveRelayConfig);
    roomInput.addEventListener('change', saveRelayConfig);

    // Auto re-lock when tab loses focus or visibility to keep plaintext from lingering.
    window.addEventListener('blur', () => relock('Locked after focus left'));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) relock('Locked after tab change');
    });
  }

  async function init() {
    load();
    loadRelayConfig();
    await seedDemo();
    wireEvents();
    updateLockUI();
    renderMessages();
    updateExportBox(false);
  }

  init();
})();
