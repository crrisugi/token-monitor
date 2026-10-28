'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, before, after } = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  discoverAccounts,
  detectActiveAccount,
  createDefaultLedger,
  loadLedger,
  saveLedger,
  recordAccountHeartbeat,
  attributeSession,
  attributeDay,
  assignDateRange,
  removeDateRange,
  clearDateRanges,
  filterSessionsByAccount,
  aggregateAccountUsage
} = require('../../src/shared/providers/antigravity/accountUsageLedger');

describe('Antigravity Account Usage Ledger', () => {
  let tempDir;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-test-ag-ledger-'));
  });

  after(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  });

  it('Test (a): Multi-source account discovery and active account detection across all 4 sources', () => {
    const toolsDir = path.join(tempDir, '.antigravity_tools');
    const toolsAccountsDir = path.join(toolsDir, 'accounts');
    fs.mkdirSync(toolsAccountsDir, { recursive: true });

    // 1. ~/.antigravity_tools/accounts.json
    fs.writeFileSync(
      path.join(toolsDir, 'accounts.json'),
      JSON.stringify({
        version: '2.0',
        accounts: [
          {
            id: 'tools-id-1',
            email: 'Crrisugi@gmail.com ',
            name: '孙悟空',
            disabled: false,
            last_used: 1791724317
          },
          {
            id: 'tools-id-2',
            email: 'second@gmail.com',
            name: 'Second User',
            disabled: false,
            last_used: 1791720000
          }
        ],
        current_account_id: 'tools-id-1'
      })
    );

    // Subdirectory ~/.antigravity_tools/accounts/tools-id-3.json
    fs.writeFileSync(
      path.join(toolsAccountsDir, 'tools-id-3.json'),
      JSON.stringify({
        id: 'tools-id-3',
        email: 'tools-extra@gmail.com',
        name: 'Extra Tools Account',
        last_used: 1791725000
      })
    );

    // 2. VSCode / Antigravity IDE state.vscdb
    const vscdbPath = path.join(tempDir, 'state.vscdb');
    const db = new DatabaseSync(vscdbPath);
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
      'antigravityAuthStatus',
      JSON.stringify({
        name: 'itachi Dixx',
        email: 'ITACHIDIXX@GMAIL.COM '
      })
    );
    db.close();

    // 3. Settings managed accounts
    const settings = {
      antigravityManagedAccounts: [
        {
          id: 'managed-1',
          accountEmail: 'Crrisugi@GMAIL.COM',
          accountLabel: 'Sun Wukong (Managed)'
        },
        {
          id: 'managed-2',
          accountEmail: 'managed-only@domain.com',
          accountLabel: 'Managed Only Account'
        }
      ]
    };

    // 4. RPC Probe snapshot
    const probeSnapshot = {
      accountEmail: 'PROBE-LIVE@GMAIL.COM ',
      accountPlan: 'Ultra'
    };

    const discovered = discoverAccounts({
      settings,
      probeSnapshot,
      homeDir: tempDir,
      toolsDir,
      vscdbPaths: [vscdbPath]
    });

    // Check emails and normalization
    const emails = discovered.map((d) => d.email).sort();
    assert.deepEqual(emails, [
      'crrisugi@gmail.com',
      'itachidixx@gmail.com',
      'managed-only@domain.com',
      'probe-live@gmail.com',
      'second@gmail.com',
      'tools-extra@gmail.com'
    ]);

    // Check deduplication of crrisugi@gmail.com across sources
    const crrisugi = discovered.find((d) => d.email === 'crrisugi@gmail.com');
    assert.ok(crrisugi);
    assert.equal(crrisugi.displayName, 'Sun Wukong (Managed)');
    assert.ok(crrisugi.sources.includes('managed'));
    assert.ok(crrisugi.sources.includes('antigravity_tools'));

    // Check detectActiveAccount priority sequence:
    // 1. Probe snapshot takes highest priority
    const activeWithProbe = detectActiveAccount({
      probeSnapshot,
      toolsDir,
      vscdbPaths: [vscdbPath],
      settings
    });
    assert.deepEqual(activeWithProbe, { email: 'probe-live@gmail.com', source: 'rpc_probe' });

    // 2. Tools current_account_id takes precedence when no probe
    const activeWithTools = detectActiveAccount({
      probeSnapshot: null,
      toolsDir,
      vscdbPaths: [vscdbPath],
      settings
    });
    assert.deepEqual(activeWithTools, { email: 'crrisugi@gmail.com', source: 'antigravity_tools' });

    // 3. state.vscdb takes precedence when no probe and no active tools account
    const emptyToolsDir = path.join(tempDir, 'empty_tools');
    fs.mkdirSync(emptyToolsDir, { recursive: true });
    const activeWithVscdb = detectActiveAccount({
      probeSnapshot: null,
      toolsDir: emptyToolsDir,
      vscdbPaths: [vscdbPath],
      settings
    });
    assert.deepEqual(activeWithVscdb, { email: 'itachidixx@gmail.com', source: 'state_vscdb' });

    // 4. Managed accounts fallback when single enabled
    const singleManagedSettings = {
      antigravityManagedAccounts: [
        { id: 'single-1', accountEmail: 'only-managed@domain.com', enabled: true }
      ]
    };
    const activeWithManaged = detectActiveAccount({
      probeSnapshot: null,
      toolsDir: emptyToolsDir,
      vscdbPaths: [],
      settings: singleManagedSettings
    });
    assert.deepEqual(activeWithManaged, { email: 'only-managed@domain.com', source: 'managed' });
  });

  it('Test (b): Automatic attribution of new sessions and timeline heartbeat switching between accounts', () => {
    const ledgerFile = path.join(tempDir, 'test-ledger-b.json');
    const featureActivatedAt = '2026-10-01T00:00:00.000Z';
    const ledger = createDefaultLedger(featureActivatedAt);

    // Initial heartbeat for crrisugi@gmail.com
    const hb1 = recordAccountHeartbeat(
      { email: 'crrisugi@gmail.com', source: 'rpc_probe' },
      '2026-10-01T10:00:00.000Z',
      { ledger, ledgerFile, save: true }
    );
    assert.equal(hb1.changed, true);
    assert.equal(ledger.lastActiveAccount, 'crrisugi@gmail.com');
    assert.equal(ledger.timeline.length, 1);
    assert.equal(ledger.timeline[0].email, 'crrisugi@gmail.com');
    assert.equal(ledger.timeline[0].startedAt, '2026-10-01T10:00:00.000Z');
    assert.equal(ledger.timeline[0].endedAt, null);

    // New session occurring after featureActivatedAt during crrisugi's active window
    const session1 = {
      sessionId: 'sess-new-1',
      startedAt: '2026-10-01T10:15:00.000Z',
      lastUsedAt: '2026-10-01T10:45:00.000Z'
    };
    const attr1 = attributeSession(session1, ledger, { save: false });
    assert.equal(attr1.email, 'crrisugi@gmail.com');
    assert.equal(attr1.isUnattributed, false);
    // Explicit binding was created in sessionAccounts
    assert.equal(ledger.sessionAccounts['sess-new-1'].email, 'crrisugi@gmail.com');

    // Account switch to itachidixx@gmail.com at 11:00:00
    const hb2 = recordAccountHeartbeat(
      'itachidixx@gmail.com',
      '2026-10-01T11:00:00.000Z',
      { ledger, ledgerFile, save: true }
    );
    assert.equal(hb2.changed, true);
    assert.equal(ledger.lastActiveAccount, 'itachidixx@gmail.com');
    assert.equal(ledger.timeline.length, 2);
    // First interval closed exactly at switch timestamp
    assert.equal(ledger.timeline[0].endedAt, '2026-10-01T11:00:00.000Z');
    // Second interval active
    assert.equal(ledger.timeline[1].email, 'itachidixx@gmail.com');
    assert.equal(ledger.timeline[1].startedAt, '2026-10-01T11:00:00.000Z');
    assert.equal(ledger.timeline[1].endedAt, null);

    // New session during itachi's active window
    const session2 = {
      sessionId: 'sess-new-2',
      startedAt: '2026-10-01T11:30:00.000Z',
      lastUsedAt: '2026-10-01T12:00:00.000Z'
    };
    const attr2 = attributeSession(session2, ledger, { save: false });
    assert.equal(attr2.email, 'itachidixx@gmail.com');
    assert.equal(attr2.isUnattributed, false);
    assert.equal(ledger.sessionAccounts['sess-new-2'].email, 'itachidixx@gmail.com');

    // Explicitly test saveLedger and verify persistence upon reloading
    assert.equal(saveLedger(ledger, { ledgerFile }), true);
    const loaded = loadLedger({ ledgerFile });
    assert.equal(loaded.lastActiveAccount, 'itachidixx@gmail.com');
    assert.equal(loaded.timeline.length, 2);
    assert.equal(loaded.sessionAccounts['sess-new-1'].email, 'crrisugi@gmail.com');
    assert.equal(loaded.sessionAccounts['sess-new-2'].email, 'itachidixx@gmail.com');
  });

  it('Test (c): Strict "unattributed" bucket placement for historical sessions/days prior to featureActivatedAt', () => {
    const ledger = createDefaultLedger('2026-10-01T00:00:00.000Z');
    ledger.lastActiveAccount = 'crrisugi@gmail.com';

    // Historical session from September (before featureActivatedAt on Oct 1)
    const histSession = {
      sessionId: 'sess-historical-1',
      startedAt: '2026-09-15T10:00:00.000Z',
      lastUsedAt: '2026-09-15T10:30:00.000Z',
      last_used: 1790000000 // Historical timestamp must NEVER be used to guess
    };

    const sessionAttr = attributeSession(histSession, ledger, { save: false });
    assert.deepEqual(sessionAttr, {
      email: 'unattributed',
      source: 'unattributed',
      isUnattributed: true
    });
    // Session was NOT bound in sessionAccounts
    assert.equal(ledger.sessionAccounts['sess-historical-1'], undefined);

    // Historical day prior to featureActivatedAt
    const dayAttr = attributeDay('2026-09-15', ledger);
    assert.deepEqual(dayAttr, {
      email: 'unattributed',
      source: 'unattributed',
      isUnattributed: true
    });
  });

  it('Test (d): Manual date-range assignment overriding "unattributed" and removeDateRange reverting', () => {
    const ledger = createDefaultLedger('2026-10-01T00:00:00.000Z');

    const histSession = {
      sessionId: 'sess-hist-d',
      day: '2026-09-15',
      startedAt: '2026-09-15T10:00:00.000Z'
    };

    // Before assignment: unattributed
    assert.equal(attributeSession(histSession, ledger).email, 'unattributed');
    assert.equal(attributeDay('2026-09-15', ledger).email, 'unattributed');

    // Assign date range with intentionally reversed dates (2026-09-30 -> 2026-09-01)
    assignDateRange(
      {
        startDate: '2026-09-30',
        endDate: '2026-09-01',
        email: 'Crrisugi@GMAIL.COM '
      },
      { ledger, save: false }
    );

    // Normalized assignment
    assert.equal(ledger.dateRangeAssignments.length, 1);
    assert.equal(ledger.dateRangeAssignments[0].startDate, '2026-09-01');
    assert.equal(ledger.dateRangeAssignments[0].endDate, '2026-09-30');
    assert.equal(ledger.dateRangeAssignments[0].email, 'crrisugi@gmail.com');

    // Now correctly attributed to crrisugi@gmail.com
    const assignedSessionAttr = attributeSession(histSession, ledger);
    assert.deepEqual(assignedSessionAttr, {
      email: 'crrisugi@gmail.com',
      source: 'date_range',
      isUnattributed: false
    });

    const assignedDayAttr = attributeDay('2026-09-15', ledger);
    assert.deepEqual(assignedDayAttr, {
      email: 'crrisugi@gmail.com',
      source: 'date_range',
      isUnattributed: false
    });

    // Remove the date range assignment
    removeDateRange(
      { startDate: '2026-09-01', endDate: '2026-09-30', email: 'crrisugi@gmail.com' },
      { ledger, save: false }
    );
    assert.equal(ledger.dateRangeAssignments.length, 0);

    // Reverts back to unattributed
    assert.equal(attributeSession(histSession, ledger).email, 'unattributed');
    assert.equal(attributeDay('2026-09-15', ledger).email, 'unattributed');

    // Test clearDateRanges
    assignDateRange(
      { startDate: '2026-08-01', endDate: '2026-08-31', email: 'crrisugi@gmail.com' },
      { ledger, save: false }
    );
    assert.equal(ledger.dateRangeAssignments.length, 1);
    clearDateRanges({ ledger, save: false });
    assert.equal(ledger.dateRangeAssignments.length, 0);
  });

  it('Test (e): Accurate token components and cost across Gemini and Claude/GPT models with filtering & percentage', () => {
    const ledger = createDefaultLedger('2026-10-01T00:00:00.000Z');

    // Pre-bind 2 sessions to 2 accounts
    ledger.sessionAccounts['sess-account-1'] = {
      email: 'crrisugi@gmail.com',
      boundAt: '2026-10-05T00:00:00.000Z',
      source: 'session_binding'
    };
    ledger.sessionAccounts['sess-account-2'] = {
      email: 'itachidixx@gmail.com',
      boundAt: '2026-10-05T00:00:00.000Z',
      source: 'session_binding'
    };

    // Sessions invoking Gemini models (gemini-4-argon, gemini-3.8-flash)
    const session1 = {
      client: 'antigravity',
      sessionId: 'sess-account-1',
      day: '2026-10-05',
      totalTokens: 10000,
      costUsd: 0.05,
      inputTokens: 5000,
      outputTokens: 2000,
      cacheReadTokens: 2000,
      cacheWriteTokens: 500,
      reasoningTokens: 500,
      models: {
        'gemini-4-argon': 6000,
        'gemini-3.8-flash': 4000
      },
      modelCosts: {
        'gemini-4-argon': 0.035,
        'gemini-3.8-flash': 0.015
      }
    };

    // Sessions invoking Claude/GPT models (claude-opus-5-5, claude-sonnet-5-5)
    const session2 = {
      client: 'antigravity',
      sessionId: 'sess-account-2',
      day: '2026-10-06',
      totalTokens: 20000,
      costUsd: 0.40,
      inputTokens: 8000,
      outputTokens: 4000,
      cacheReadTokens: 6000,
      cacheWriteTokens: 1000,
      reasoningTokens: 1000,
      models: {
        'claude-opus-5-5': 15000,
        'claude-sonnet-5-5': 5000
      },
      modelCosts: {
        'claude-opus-5-5': 0.35,
        'claude-sonnet-5-5': 0.05
      }
    };

    // Historical unattributed session
    const sessionHistorical = {
      client: 'antigravity',
      sessionId: 'sess-historical-unbound',
      day: '2026-09-20',
      totalTokens: 10000,
      costUsd: 0.05,
      inputTokens: 4000,
      outputTokens: 2000,
      cacheReadTokens: 3000,
      cacheWriteTokens: 500,
      reasoningTokens: 500,
      models: {
        'gemini-3.8-flash': 10000
      },
      modelCosts: {
        'gemini-3.8-flash': 0.05
      }
    };

    // Non-antigravity session (must be excluded)
    const nonAntigravitySession = {
      client: 'cursor',
      sessionId: 'sess-other',
      day: '2026-10-05',
      totalTokens: 99999,
      costUsd: 10.0
    };

    const sessions = [session1, session2, sessionHistorical, nonAntigravitySession];
    const discoveredAccounts = [
      { email: 'crrisugi@gmail.com', displayName: '孙悟空' },
      { email: 'itachidixx@gmail.com', displayName: 'itachi Dixx' },
      { email: 'idle@example.com', displayName: 'Idle Account' }
    ];

    // 1. Overall aggregate across all accounts
    const summaryAll = aggregateAccountUsage({
      sessions,
      accountFilter: 'all',
      ledger,
      discoveredAccounts
    });

    assert.equal(summaryAll.overallTotalTokens, 40000);
    assert.equal(summaryAll.totalTokens, 40000);
    assert.equal(summaryAll.costUsd, 0.50);
    assert.equal(summaryAll.inputTokens, 17000);
    assert.equal(summaryAll.outputTokens, 8000);
    assert.equal(summaryAll.cacheReadTokens, 11000);
    assert.equal(summaryAll.cacheWriteTokens, 2000);
    assert.equal(summaryAll.reasoningTokens, 2000);

    // Verify all 4 models are tracked
    assert.ok(summaryAll.models['gemini-4-argon']);
    assert.equal(summaryAll.models['gemini-4-argon'].tokens, 6000);
    assert.equal(summaryAll.models['gemini-4-argon'].costUsd, 0.035);

    assert.ok(summaryAll.models['gemini-3.8-flash']);
    assert.equal(summaryAll.models['gemini-3.8-flash'].tokens, 14000); // 4000 + 10000
    assert.equal(summaryAll.models['gemini-3.8-flash'].costUsd, 0.065);

    assert.ok(summaryAll.models['claude-opus-5-5']);
    assert.equal(summaryAll.models['claude-opus-5-5'].tokens, 15000);
    assert.equal(summaryAll.models['claude-opus-5-5'].costUsd, 0.35);

    assert.ok(summaryAll.models['claude-sonnet-5-5']);
    assert.equal(summaryAll.models['claude-sonnet-5-5'].tokens, 5000);
    assert.equal(summaryAll.models['claude-sonnet-5-5'].costUsd, 0.05);

    // Check account breakdown table and percentageOfTotal
    const byAcc = summaryAll.byAccount;
    assert.equal(byAcc['crrisugi@gmail.com'].totalTokens, 10000);
    assert.equal(byAcc['crrisugi@gmail.com'].percentageOfTotal, 25.0);
    assert.equal(byAcc['crrisugi@gmail.com'].displayName, '孙悟空');

    assert.equal(byAcc['itachidixx@gmail.com'].totalTokens, 20000);
    assert.equal(byAcc['itachidixx@gmail.com'].percentageOfTotal, 50.0);
    assert.equal(byAcc['itachidixx@gmail.com'].displayName, 'itachi Dixx');

    assert.equal(byAcc.unattributed.totalTokens, 10000);
    assert.equal(byAcc.unattributed.percentageOfTotal, 25.0);

    assert.equal(byAcc['idle@example.com'].totalTokens, 0);
    assert.equal(byAcc['idle@example.com'].percentageOfTotal, 0);

    // 2. Filter by specific account 'crrisugi@gmail.com'
    const summaryCrrisugi = aggregateAccountUsage({
      sessions,
      accountFilter: 'crrisugi@gmail.com',
      ledger,
      discoveredAccounts
    });
    assert.equal(summaryCrrisugi.totalTokens, 10000);
    assert.equal(summaryCrrisugi.costUsd, 0.05);
    assert.deepEqual(Object.keys(summaryCrrisugi.models).sort(), ['gemini-3.8-flash', 'gemini-4-argon']);

    // 3. Filter by 'unattributed'
    const summaryUnattributed = aggregateAccountUsage({
      sessions,
      accountFilter: 'unattributed',
      ledger,
      discoveredAccounts
    });
    assert.equal(summaryUnattributed.totalTokens, 10000);
    assert.equal(summaryUnattributed.costUsd, 0.05);
    assert.deepEqual(Object.keys(summaryUnattributed.models), ['gemini-3.8-flash']);

    // 4. Filter by date range (October only)
    const summaryOctRange = aggregateAccountUsage({
      sessions,
      range: { start: '2026-10-01', end: '2026-10-31' },
      accountFilter: 'all',
      ledger,
      discoveredAccounts
    });
    // Excludes sessionHistorical (from 2026-09-20)
    assert.equal(summaryOctRange.totalTokens, 30000);
    assert.equal(summaryOctRange.costUsd, 0.45);

    // 5. Test filterSessionsByAccount
    const filteredCrrisugi = filterSessionsByAccount(sessions, 'crrisugi@gmail.com', ledger);
    assert.equal(filteredCrrisugi.length, 1);
    assert.equal(filteredCrrisugi[0].sessionId, 'sess-account-1');

    const filteredUnattributed = filterSessionsByAccount(sessions, 'unattributed', ledger);
    assert.equal(filteredUnattributed.length, 1);
    assert.equal(filteredUnattributed[0].sessionId, 'sess-historical-unbound');
  });

  it('Test (f): Daily history observation deduplication with sessions on the same days', () => {
    const ledger = createDefaultLedger('2026-10-01T00:00:00.000Z');
    ledger.sessionAccounts['sess-oct-5'] = {
      email: 'crrisugi@gmail.com',
      boundAt: '2026-10-05T00:00:00.000Z',
      source: 'session_binding'
    };

    const sessions = [
      {
        client: 'antigravity',
        sessionId: 'sess-oct-5',
        day: '2026-10-05',
        totalTokens: 5000,
        costUsd: 0.02,
        models: { 'gemini-3.8-flash': 5000 }
      }
    ];

    const dailyHistory = {
      days: {
        '2026-10-05': {
          observations: {
            obs1: {
              client: 'antigravity',
              day: '2026-10-05',
              tokens: 5000,
              cost: 0.02,
              modelId: 'gemini-3.8-flash'
            }
          }
        },
        '2026-09-10': {
          observations: {
            obs2: {
              client: 'antigravity',
              day: '2026-09-10',
              tokens: 3000,
              cost: 0.01,
              modelId: 'gemini-3.8-flash'
            }
          }
        }
      }
    };

    const summary = aggregateAccountUsage({
      sessions,
      dailyHistory,
      accountFilter: 'all',
      ledger
    });

    assert.equal(summary.totalTokens, 8000);
    assert.equal(summary.costUsd, 0.03);
    assert.equal(summary.byAccount['crrisugi@gmail.com'].totalTokens, 5000);
    assert.equal(summary.byAccount.unattributed.totalTokens, 3000);
  });
});

