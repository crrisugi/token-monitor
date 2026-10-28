'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sharedDataDir, readJson, writeJsonAtomic } = require('../../config');
const { resolveSqlite } = require('../../sqliteReadOnly');
const { normalizeManagedAccounts } = require('./oauth');

const DEFAULT_LEDGER_FILENAME = 'antigravity-account-ledger.json';

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeDate(value) {
  if (!value) return '';
  return String(value).slice(0, 10);
}

function isAntigravityClient(client) {
  const c = String(client || '').trim().toLowerCase();
  return c === 'antigravity' || c === 'antigravity-cli' || c === 'antigravity-extension';
}

function getVscdbCandidates(options = {}) {
  if (Array.isArray(options.vscdbPaths)) {
    return options.vscdbPaths;
  }
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const paths = [];

  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    paths.push(
      path.join(appData, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'),
      path.join(appData, 'Code', 'User', 'globalStorage', 'state.vscdb'),
      path.join(appData, 'Code - Insiders', 'User', 'globalStorage', 'state.vscdb')
    );
  } else if (platform === 'darwin') {
    paths.push(
      path.join(homeDir, 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'state.vscdb'),
      path.join(homeDir, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'state.vscdb')
    );
  } else {
    const configHome = env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
    paths.push(
      path.join(configHome, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'),
      path.join(configHome, 'Code', 'User', 'globalStorage', 'state.vscdb')
    );
  }
  return paths;
}

function discoverFromVscdb(options = {}) {
  const candidates = getVscdbCandidates(options);
  const sqliteMod = resolveSqlite(options.deps || options);
  if (!sqliteMod || typeof sqliteMod.DatabaseSync !== 'function') {
    return { accounts: [], activeEmail: null };
  }

  const accounts = [];
  let activeEmail = null;

  for (const dbPath of candidates) {
    try {
      if (!fs.existsSync(dbPath)) continue;
      const db = new sqliteMod.DatabaseSync(dbPath, { readOnly: true });
      try {
        try { db.exec('PRAGMA busy_timeout = 250'); } catch (_) {}
        try { db.exec('PRAGMA query_only = ON'); } catch (_) {}
        const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('antigravityAuthStatus');
        if (row && typeof row.value === 'string') {
          const parsed = JSON.parse(row.value);
          const email = normalizeEmail(parsed?.email);
          if (email) {
            if (!activeEmail) activeEmail = email;
            accounts.push({
              email,
              displayName: (typeof parsed.name === 'string' && parsed.name.trim()) ? parsed.name.trim() : email,
              source: 'state_vscdb'
            });
          }
        }
      } finally {
        try { db.close(); } catch (_) {}
      }
    } catch (_) {}
  }
  return { accounts, activeEmail };
}

function discoverFromTools(options = {}) {
  const home = options.homeDir || os.homedir();
  const toolsDir = options.toolsDir || path.join(home, '.antigravity_tools');
  const accountsJsonPath = path.join(toolsDir, 'accounts.json');
  const data = readJson(accountsJsonPath, null);
  const accounts = [];
  let activeEmail = null;

  if (data && Array.isArray(data.accounts)) {
    const activeId = data.current_account_id || data.current_classic_account_id || null;
    for (const a of data.accounts) {
      const email = normalizeEmail(a?.email);
      if (!email) continue;
      if (activeId && a.id === activeId) {
        activeEmail = email;
      }
      accounts.push({
        email,
        displayName: (typeof a.name === 'string' && a.name.trim()) ? a.name.trim() : email,
        source: 'antigravity_tools',
        lastUsed: a.last_used || null,
        disabled: a.disabled === true
      });
    }
  }

  const accountsSubdir = path.join(toolsDir, 'accounts');
  try {
    if (fs.existsSync(accountsSubdir)) {
      const files = fs.readdirSync(accountsSubdir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const acc = readJson(path.join(accountsSubdir, file), null);
        const email = normalizeEmail(acc?.email);
        if (!email) continue;
        accounts.push({
          email,
          displayName: (typeof acc.name === 'string' && acc.name.trim()) ? acc.name.trim() : email,
          source: 'antigravity_tools',
          lastUsed: acc.last_used || null,
          disabled: acc.disabled === true
        });
      }
    }
  } catch (_) {}

  return { accounts, activeEmail };
}

function discoverFromManaged(options = {}) {
  const rawManaged = options.settings?.antigravityManagedAccounts || options.managedAccounts;
  if (!rawManaged) return [];
  const normalized = normalizeManagedAccounts(rawManaged);
  return normalized.map((a) => ({
    email: a.accountEmail,
    displayName: a.accountLabel || a.accountEmail,
    source: 'managed',
    enabled: a.enabled !== false
  }));
}

function discoverAccounts(options = {}) {
  const map = new Map();

  function addAccount(acc) {
    const email = normalizeEmail(acc?.email);
    if (!email) return;
    const existing = map.get(email);
    const source = acc.source || 'unknown';
    if (!existing) {
      map.set(email, {
        email,
        displayName: acc.displayName || email,
        sources: [source],
        lastUsed: acc.lastUsed || null
      });
    } else {
      if (source && !existing.sources.includes(source)) {
        existing.sources.push(source);
      }
      if (acc.displayName && acc.displayName !== email && (!existing.displayName || existing.displayName === email)) {
        existing.displayName = acc.displayName;
      }
      if (acc.lastUsed && (!existing.lastUsed || acc.lastUsed > existing.lastUsed)) {
        existing.lastUsed = acc.lastUsed;
      }
    }
  }

  // Source 1: Settings managed accounts
  const managed = discoverFromManaged(options);
  for (const a of managed) addAccount(a);

  // Source 2: Local RPC probe snapshot
  if (options.probeSnapshot?.accountEmail) {
    addAccount({
      email: options.probeSnapshot.accountEmail,
      displayName: options.probeSnapshot.accountPlan || '',
      source: 'rpc_probe'
    });
  }

  // Source 3: ~/.antigravity_tools/
  const tools = discoverFromTools(options);
  for (const a of tools.accounts) addAccount(a);

  // Source 4: VSCode / Antigravity IDE state.vscdb
  const vscdb = discoverFromVscdb(options);
  for (const a of vscdb.accounts) addAccount(a);

  return Array.from(map.values());
}

async function discoverAccountsAsync(options = {}) {
  let probeSnapshot = options.probeSnapshot;
  if (!probeSnapshot) {
    try {
      const probeFn = options.probe || require('./probe').probe;
      const result = await probeFn({ timeoutMs: options.timeoutMs || 1500 });
      if (result?.snapshot?.accountEmail) {
        probeSnapshot = result.snapshot;
      }
    } catch (_) {}
  }
  return discoverAccounts({ ...options, probeSnapshot });
}

function detectActiveAccount(options = {}) {
  // 1. Explicit override or live probe snapshot
  if (options.activeAccount) {
    const email = normalizeEmail(typeof options.activeAccount === 'string' ? options.activeAccount : options.activeAccount.email);
    if (email) {
      return {
        email,
        source: (typeof options.activeAccount === 'object' && options.activeAccount.source) || 'active_account'
      };
    }
  }
  if (options.probeSnapshot?.accountEmail) {
    const email = normalizeEmail(options.probeSnapshot.accountEmail);
    if (email) {
      return { email, source: 'rpc_probe' };
    }
  }

  // 2. ~/.antigravity_tools/ accounts.json current_account_id
  const tools = discoverFromTools(options);
  if (tools.activeEmail) {
    return { email: tools.activeEmail, source: 'antigravity_tools' };
  }

  // 3. state.vscdb
  const vscdb = discoverFromVscdb(options);
  if (vscdb.activeEmail) {
    return { email: vscdb.activeEmail, source: 'state_vscdb' };
  }

  // 4. Managed accounts (if single enabled account)
  const managed = discoverFromManaged(options);
  const enabled = managed.filter((a) => a.enabled !== false);
  if (enabled.length === 1) {
    return { email: enabled[0].email, source: 'managed' };
  }

  return null;
}

async function detectActiveAccountAsync(options = {}) {
  let probeSnapshot = options.probeSnapshot;
  if (!probeSnapshot && !options.activeAccount) {
    try {
      const probeFn = options.probe || require('./probe').probe;
      const result = await probeFn({ timeoutMs: options.timeoutMs || 1000 });
      if (result?.snapshot?.accountEmail) {
        probeSnapshot = result.snapshot;
      }
    } catch (_) {}
  }
  return detectActiveAccount({ ...options, probeSnapshot });
}

function ledgerPath(options = {}) {
  if (options.ledgerFile) return options.ledgerFile;
  const dir = options.dataDir || sharedDataDir(options);
  return path.join(dir, DEFAULT_LEDGER_FILENAME);
}

function createDefaultLedger(activatedAt = new Date().toISOString()) {
  return {
    version: 1,
    featureActivatedAt: activatedAt,
    lastActiveAccount: null,
    timeline: [],
    sessionAccounts: {},
    dateRangeAssignments: []
  };
}

function normalizeLedger(loaded, options = {}) {
  return {
    version: 1,
    featureActivatedAt: loaded?.featureActivatedAt || options.featureActivatedAt || new Date().toISOString(),
    lastActiveAccount: loaded?.lastActiveAccount || null,
    timeline: Array.isArray(loaded?.timeline) ? loaded.timeline : [],
    sessionAccounts: (loaded?.sessionAccounts && typeof loaded.sessionAccounts === 'object') ? loaded.sessionAccounts : {},
    dateRangeAssignments: Array.isArray(loaded?.dateRangeAssignments) ? loaded.dateRangeAssignments : []
  };
}

function loadLedger(options = {}) {
  if (options.ledger && typeof options.ledger === 'object') {
    return normalizeLedger(options.ledger, options);
  }
  const filePath = ledgerPath(options);
  const loaded = readJson(filePath, null);
  if (loaded && typeof loaded === 'object') {
    return normalizeLedger(loaded, options);
  }
  const defaultLedger = createDefaultLedger(options.featureActivatedAt);
  if (options.autoInit) {
    saveLedger(defaultLedger, options);
  }
  return defaultLedger;
}

function saveLedger(ledger, options = {}) {
  const filePath = ledgerPath(options);
  const normalized = normalizeLedger(ledger, options);
  writeJsonAtomic(filePath, normalized);
  return true;
}

function recordAccountHeartbeat(activeAccount, timestamp, options = {}) {
  const email = normalizeEmail(typeof activeAccount === 'string' ? activeAccount : activeAccount?.email);
  const ledger = options.ledger || loadLedger(options);
  if (!email) {
    return { changed: false, ledger };
  }

  const source = (typeof activeAccount === 'object' && activeAccount?.source) || 'heartbeat';
  const ts = timestamp ? new Date(timestamp).toISOString() : new Date().toISOString();
  let changed = false;

  if (!Array.isArray(ledger.timeline)) {
    ledger.timeline = [];
  }

  const lastInterval = ledger.timeline[ledger.timeline.length - 1];

  if (!lastInterval) {
    ledger.timeline.push({
      email,
      startedAt: ts,
      endedAt: null,
      source
    });
    ledger.lastActiveAccount = email;
    changed = true;
  } else if (lastInterval.email !== email) {
    if (!lastInterval.endedAt || lastInterval.endedAt < ts) {
      lastInterval.endedAt = ts;
    }
    ledger.timeline.push({
      email,
      startedAt: ts,
      endedAt: null,
      source
    });
    ledger.lastActiveAccount = email;
    changed = true;
  } else {
    // Same account
    ledger.lastActiveAccount = email;
    if (lastInterval.endedAt && ts > lastInterval.endedAt) {
      ledger.timeline.push({
        email,
        startedAt: ts,
        endedAt: null,
        source
      });
      changed = true;
    }
  }

  if (changed && options.save !== false) {
    saveLedger(ledger, options);
  }

  return { changed, ledger };
}

function attributeSession(session, ledger, options = {}) {
  if (!session || !ledger) {
    return { email: 'unattributed', source: 'unattributed', isUnattributed: true };
  }

  // Rule 1: Explicit session binding
  if (session.sessionId && ledger.sessionAccounts && ledger.sessionAccounts[session.sessionId]) {
    const binding = ledger.sessionAccounts[session.sessionId];
    return {
      email: binding.email,
      source: binding.source || 'session_binding',
      isUnattributed: false
    };
  }

  // Rule 2: Manual date-range assignment
  const sessionDate = session.day || normalizeDate(session.lastUsedAt || session.startedAt);
  if (sessionDate && Array.isArray(ledger.dateRangeAssignments)) {
    for (let i = ledger.dateRangeAssignments.length - 1; i >= 0; i -= 1) {
      const assignment = ledger.dateRangeAssignments[i];
      let start = assignment.startDate;
      let end = assignment.endDate;
      if (start > end) [start, end] = [end, start];
      if (sessionDate >= start && sessionDate <= end) {
        return {
          email: assignment.email,
          source: 'date_range',
          isUnattributed: false
        };
      }
    }
  }

  // Rule 3: Recorded timeline interval
  const timestamp = session.lastUsedAt || session.startedAt || (session.day ? `${session.day}T00:00:00.000Z` : '');
  const isPostActivation = Boolean(
    ledger.featureActivatedAt && timestamp && timestamp >= ledger.featureActivatedAt
  );

  if (timestamp && Array.isArray(ledger.timeline)) {
    for (let i = ledger.timeline.length - 1; i >= 0; i -= 1) {
      const interval = ledger.timeline[i];
      if (interval.startedAt <= timestamp && (!interval.endedAt || timestamp <= interval.endedAt)) {
        const source = interval.source || 'timeline';
        if (isPostActivation && options.bindNewSessions !== false && session.sessionId) {
          if (!ledger.sessionAccounts) ledger.sessionAccounts = {};
          ledger.sessionAccounts[session.sessionId] = {
            email: interval.email,
            boundAt: options.now || new Date().toISOString(),
            source
          };
          if (options.save === true) {
            saveLedger(ledger, options);
          }
        }
        return {
          email: interval.email,
          source,
          isUnattributed: false
        };
      }
    }
  }

  // Rule 4: New session observed while active account is known (timestamp >= featureActivatedAt)
  if (isPostActivation && options.bindNewSessions !== false) {
    const activeEmail = normalizeEmail(
      typeof options.activeAccount === 'string'
        ? options.activeAccount
        : (options.activeAccount?.email || ledger.lastActiveAccount)
    );
    if (activeEmail) {
      const source = (typeof options.activeAccount === 'object' && options.activeAccount?.source) || 'active_account';
      if (session.sessionId) {
        if (!ledger.sessionAccounts) ledger.sessionAccounts = {};
        ledger.sessionAccounts[session.sessionId] = {
          email: activeEmail,
          boundAt: options.now || new Date().toISOString(),
          source
        };
        if (options.save === true) {
          saveLedger(ledger, options);
        }
      }
      return {
        email: activeEmail,
        source,
        isUnattributed: false
      };
    }
  }

  // Rule 5: Strict historical/unbound fallback — no guessing!
  return { email: 'unattributed', source: 'unattributed', isUnattributed: true };
}

function attributeDay(dayStr, ledger) {
  const dateStr = normalizeDate(dayStr);
  if (!dateStr || !ledger) {
    return { email: 'unattributed', source: 'unattributed', isUnattributed: true };
  }

  // Rule 2: Date range assignments
  if (Array.isArray(ledger.dateRangeAssignments)) {
    for (let i = ledger.dateRangeAssignments.length - 1; i >= 0; i -= 1) {
      const assignment = ledger.dateRangeAssignments[i];
      let start = assignment.startDate;
      let end = assignment.endDate;
      if (start > end) [start, end] = [end, start];
      if (dateStr >= start && dateStr <= end) {
        return { email: assignment.email, source: 'date_range', isUnattributed: false };
      }
    }
  }

  // Rule 3: Timeline interval
  if (Array.isArray(ledger.timeline)) {
    for (let i = ledger.timeline.length - 1; i >= 0; i -= 1) {
      const interval = ledger.timeline[i];
      const startDay = normalizeDate(interval.startedAt);
      const endDay = interval.endedAt ? normalizeDate(interval.endedAt) : '';
      if (startDay <= dateStr && (!endDay || dateStr <= endDay)) {
        return { email: interval.email, source: interval.source || 'timeline', isUnattributed: false };
      }
    }
  }

  // Rule 5: No guessing on historical days
  return { email: 'unattributed', source: 'unattributed', isUnattributed: true };
}

function assignDateRange(rule, options = {}) {
  let { startDate, endDate, email } = rule || {};
  if (!startDate || !endDate || !email) {
    throw new TypeError('startDate, endDate, and email are required for assignDateRange');
  }
  startDate = normalizeDate(startDate);
  endDate = normalizeDate(endDate);
  if (startDate > endDate) {
    const tmp = startDate;
    startDate = endDate;
    endDate = tmp;
  }
  const normalizedEmail = normalizeEmail(email);
  const ledger = options.ledger || loadLedger(options);
  if (!Array.isArray(ledger.dateRangeAssignments)) {
    ledger.dateRangeAssignments = [];
  }

  // Replace or remove overlapping/covered ranges
  ledger.dateRangeAssignments = ledger.dateRangeAssignments.filter((a) => {
    let aStart = a.startDate;
    let aEnd = a.endDate;
    if (aStart > aEnd) [aStart, aEnd] = [aEnd, aStart];
    if (aStart === startDate && aEnd === endDate) return false;
    if (aStart >= startDate && aEnd <= endDate) return false;
    return true;
  });

  ledger.dateRangeAssignments.push({
    startDate,
    endDate,
    email: normalizedEmail
  });

  ledger.dateRangeAssignments.sort((a, b) => a.startDate.localeCompare(b.startDate));

  if (options.save !== false) {
    saveLedger(ledger, options);
  }

  return ledger;
}

function removeDateRange(rule, options = {}) {
  let { startDate, endDate, email } = rule || {};
  startDate = startDate ? normalizeDate(startDate) : null;
  endDate = endDate ? normalizeDate(endDate) : null;
  if (startDate && endDate && startDate > endDate) {
    const tmp = startDate;
    startDate = endDate;
    endDate = tmp;
  }
  const normalizedEmail = email ? normalizeEmail(email) : null;
  const ledger = options.ledger || loadLedger(options);

  if (Array.isArray(ledger.dateRangeAssignments)) {
    ledger.dateRangeAssignments = ledger.dateRangeAssignments.filter((a) => {
      let aStart = a.startDate;
      let aEnd = a.endDate;
      if (aStart > aEnd) [aStart, aEnd] = [aEnd, aStart];
      const dateMatch = (!startDate || aStart === startDate) && (!endDate || aEnd === endDate);
      const emailMatch = !normalizedEmail || a.email === normalizedEmail;
      return !(dateMatch && emailMatch);
    });
  }

  if (options.save !== false) {
    saveLedger(ledger, options);
  }

  return ledger;
}

function clearDateRanges(options = {}) {
  const ledger = options.ledger || loadLedger(options);
  ledger.dateRangeAssignments = [];
  if (options.save !== false) {
    saveLedger(ledger, options);
  }
  return ledger;
}

function filterSessionsByAccount(sessions, accountFilter, ledger) {
  if (!Array.isArray(sessions)) return [];
  const filter = normalizeEmail(accountFilter);
  return sessions.filter((s) => {
    if (!isAntigravityClient(s?.client)) return false;
    if (!filter || filter === 'all') return true;
    const attr = attributeSession(s, ledger, { bindNewSessions: false });
    return attr.email === filter;
  });
}

function emptyMetrics() {
  return {
    tokens: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0
  };
}

function emptyAccountBucket(email, displayName = '') {
  return {
    email,
    displayName: displayName || (email === 'unattributed' ? 'Unattributed / Default Historical' : email),
    totalTokens: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    percentageOfTotal: 0,
    models: {}
  };
}

function aggregateAccountUsage(args = {}, options = {}) {
  const {
    sessions = [],
    dailyHistory = [],
    range = null,
    accountFilter = 'all',
    discoveredAccounts = []
  } = args;

  const ledger = args.ledger || options.ledger || loadLedger(options);
  const filter = normalizeEmail(accountFilter) || 'all';

  let startDay = range?.start ? normalizeDate(range.start) : null;
  let endDay = range?.end ? normalizeDate(range.end) : null;
  if (startDay && endDay && startDay > endDay) {
    const tmp = startDay;
    startDay = endDay;
    endDay = tmp;
  }

  const byAccount = {};

  function getOrCreateAccount(email, displayName = '') {
    if (!byAccount[email]) {
      byAccount[email] = emptyAccountBucket(email, displayName);
    }
    return byAccount[email];
  }

  // Initialize discovered accounts
  for (const acc of discoveredAccounts) {
    const email = normalizeEmail(typeof acc === 'string' ? acc : acc?.email);
    if (!email) continue;
    const displayName = (typeof acc === 'object' && (acc.displayName || acc.name)) || email;
    getOrCreateAccount(email, displayName);
  }

  // 1. Process sessions if available
  const sessionDays = new Set();
  if (Array.isArray(sessions) && sessions.length > 0) {
    for (const session of sessions) {
      if (!isAntigravityClient(session?.client)) continue;
      const sessionDate = session.day || normalizeDate(session.lastUsedAt || session.startedAt);
      if (sessionDate) {
        sessionDays.add(sessionDate);
        if (startDay && sessionDate < startDay) continue;
        if (endDay && sessionDate > endDay) continue;
      }
      const attr = attributeSession(session, ledger, { bindNewSessions: options.bindNewSessions ?? false });
      const bucket = getOrCreateAccount(attr.email);

      const totalTokens = Number(session.totalTokens || session.tokens || 0);
      const costUsd = Number(session.costUsd || session.cost || 0);
      const inputTokens = Number(session.inputTokens || 0);
      const outputTokens = Number(session.outputTokens || 0);
      const cacheReadTokens = Number(session.cacheReadTokens || 0);
      const cacheWriteTokens = Number(session.cacheWriteTokens || 0);
      const reasoningTokens = Number(session.reasoningTokens || 0);

      bucket.totalTokens += totalTokens;
      bucket.costUsd += costUsd;
      bucket.inputTokens += inputTokens;
      bucket.outputTokens += outputTokens;
      bucket.cacheReadTokens += cacheReadTokens;
      bucket.cacheWriteTokens += cacheWriteTokens;
      bucket.reasoningTokens += reasoningTokens;

      if (session.models && typeof session.models === 'object' && Object.keys(session.models).length > 0) {
        const modelEntries = Object.entries(session.models);
        for (const [modelId, modelTokens] of modelEntries) {
          const mTokens = Number(modelTokens || 0);
          const mCost = Number(session.modelCosts?.[modelId] || 0);
          if (!bucket.models[modelId]) bucket.models[modelId] = emptyMetrics();
          const m = bucket.models[modelId];
          m.tokens += mTokens;
          m.costUsd += mCost;

          const ratio = (totalTokens > 0 && modelEntries.length > 1) ? (mTokens / totalTokens) : 1;
          m.inputTokens += Math.round(inputTokens * ratio);
          m.outputTokens += Math.round(outputTokens * ratio);
          m.cacheReadTokens += Math.round(cacheReadTokens * ratio);
          m.cacheWriteTokens += Math.round(cacheWriteTokens * ratio);
          m.reasoningTokens += Math.round(reasoningTokens * ratio);
        }
      } else {
        const modelId = session.modelId || session.model || 'unknown';
        if (!bucket.models[modelId]) bucket.models[modelId] = emptyMetrics();
        const m = bucket.models[modelId];
        m.tokens += totalTokens;
        m.costUsd += costUsd;
        m.inputTokens += inputTokens;
        m.outputTokens += outputTokens;
        m.cacheReadTokens += cacheReadTokens;
        m.cacheWriteTokens += cacheWriteTokens;
        m.reasoningTokens += reasoningTokens;
      }
    }
  }

  // 2. Process daily history observations if available
  let observations = [];
  if (Array.isArray(dailyHistory)) {
    observations = dailyHistory;
  } else if (dailyHistory && typeof dailyHistory === 'object' && dailyHistory.days) {
    for (const dayObj of Object.values(dailyHistory.days)) {
      if (dayObj && dayObj.observations) {
        observations.push(...Object.values(dayObj.observations));
      }
    }
  }

  if (observations.length > 0) {
    for (const obs of observations) {
      if (!isAntigravityClient(obs?.client)) continue;
      const obsDate = normalizeDate(obs.day || obs.date);
      if (obsDate) {
        if (sessionDays.has(obsDate)) continue;
        if (startDay && obsDate < startDay) continue;
        if (endDay && obsDate > endDay) continue;
      }
      const attr = attributeDay(obsDate, ledger);
      const bucket = getOrCreateAccount(attr.email);

      const obsTokens = Number(obs.tokens || obs.totalTokens || 0);
      const obsCost = Number(obs.cost || obs.costUsd || 0);
      const obsInput = Number(obs.inputTokens || 0);
      const obsOutput = Number(obs.outputTokens || 0);
      const obsCacheRead = Number(obs.cacheReadTokens || 0);
      const obsCacheWrite = Number(obs.cacheWriteTokens || 0);
      const obsReasoning = Number(obs.reasoningTokens || 0);

      bucket.totalTokens += obsTokens;
      bucket.costUsd += obsCost;
      bucket.inputTokens += obsInput;
      bucket.outputTokens += obsOutput;
      bucket.cacheReadTokens += obsCacheRead;
      bucket.cacheWriteTokens += obsCacheWrite;
      bucket.reasoningTokens += obsReasoning;

      const modelId = obs.modelId || obs.model || 'unknown';
      if (!bucket.models[modelId]) bucket.models[modelId] = emptyMetrics();
      const m = bucket.models[modelId];
      m.tokens += obsTokens;
      m.costUsd += obsCost;
      m.inputTokens += obsInput;
      m.outputTokens += obsOutput;
      m.cacheReadTokens += obsCacheRead;
      m.cacheWriteTokens += obsCacheWrite;
      m.reasoningTokens += obsReasoning;
    }
  }

  // Ensure unattributed exists if filter is unattributed
  if (filter === 'unattributed' && !byAccount.unattributed) {
    getOrCreateAccount('unattributed');
  }

  // Compute grand totals
  let overallTotalTokens = 0;
  let overallCostUsd = 0;
  let overallInputTokens = 0;
  let overallOutputTokens = 0;
  let overallCacheReadTokens = 0;
  let overallCacheWriteTokens = 0;
  let overallReasoningTokens = 0;
  const overallModels = {};

  for (const bucket of Object.values(byAccount)) {
    overallTotalTokens += bucket.totalTokens;
    overallCostUsd += bucket.costUsd;
    overallInputTokens += bucket.inputTokens;
    overallOutputTokens += bucket.outputTokens;
    overallCacheReadTokens += bucket.cacheReadTokens;
    overallCacheWriteTokens += bucket.cacheWriteTokens;
    overallReasoningTokens += bucket.reasoningTokens;

    for (const [modelId, m] of Object.entries(bucket.models)) {
      if (!overallModels[modelId]) overallModels[modelId] = emptyMetrics();
      const om = overallModels[modelId];
      om.tokens += m.tokens;
      om.costUsd += m.costUsd;
      om.inputTokens += m.inputTokens;
      om.outputTokens += m.outputTokens;
      om.cacheReadTokens += m.cacheReadTokens;
      om.cacheWriteTokens += m.cacheWriteTokens;
      om.reasoningTokens += m.reasoningTokens;
    }
  }

  // Calculate percentages and round costs
  for (const bucket of Object.values(byAccount)) {
    bucket.percentageOfTotal = overallTotalTokens > 0
      ? Number(((bucket.totalTokens / overallTotalTokens) * 100).toFixed(2))
      : 0;
    bucket.costUsd = Number(bucket.costUsd.toFixed(6));
    for (const m of Object.values(bucket.models)) {
      m.costUsd = Number(m.costUsd.toFixed(6));
    }
  }
  for (const om of Object.values(overallModels)) {
    om.costUsd = Number(om.costUsd.toFixed(6));
  }

  // Compute filtered top-level fields
  let totalTokens;
  let costUsd;
  let inputTokens;
  let outputTokens;
  let cacheReadTokens;
  let cacheWriteTokens;
  let reasoningTokens;
  let models;

  if (filter === 'all') {
    totalTokens = overallTotalTokens;
    costUsd = Number(overallCostUsd.toFixed(6));
    inputTokens = overallInputTokens;
    outputTokens = overallOutputTokens;
    cacheReadTokens = overallCacheReadTokens;
    cacheWriteTokens = overallCacheWriteTokens;
    reasoningTokens = overallReasoningTokens;
    models = overallModels;
  } else {
    const target = byAccount[filter] || emptyAccountBucket(filter);
    totalTokens = target.totalTokens;
    costUsd = target.costUsd;
    inputTokens = target.inputTokens;
    outputTokens = target.outputTokens;
    cacheReadTokens = target.cacheReadTokens;
    cacheWriteTokens = target.cacheWriteTokens;
    reasoningTokens = target.reasoningTokens;
    models = target.models;
  }

  const accounts = Object.values(byAccount);
  accounts.sort((a, b) => b.totalTokens - a.totalTokens || a.email.localeCompare(b.email));

  return {
    accountFilter: filter,
    totalTokens,
    costUsd,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    models,
    accounts,
    byAccount,
    overallTotalTokens
  };
}

module.exports = {
  aggregateAccountUsage,
  assignDateRange,
  attributeDay,
  attributeSession,
  clearDateRanges,
  createDefaultLedger,
  detectActiveAccount,
  detectActiveAccountAsync,
  discoverAccounts,
  discoverAccountsAsync,
  filterSessionsByAccount,
  getVscdbCandidates,
  isAntigravityClient,
  ledgerPath,
  loadLedger,
  normalizeDate,
  normalizeEmail,
  recordAccountHeartbeat,
  removeDateRange,
  saveLedger
};
