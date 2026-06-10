import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useDeviceStore } from '../stores/deviceStore';
import { useFocusStore } from '../stores/focusStore';
import { useSyllabusStore } from '../stores/syllabusStore';
import { getDb, getVectorClock } from '../db/client';
import { STUDENT_ID, SERVER_URL } from '../constants';

interface TaskStateRow {
  task_id: string;
  status: string;
  lamport_clock: number;
  device_id: string;
  synced: number;
  deleted_at_clock: number | null;
}

interface SinkLogEntry {
  id: number;
  session_id: string;
  student_id: string;
  payload: string;
  received_at: string;
}

export default function DevPanelScreen() {
  const {
    deviceId, isOnline, syncStatus, lastSyncedAt, pendingOpsCount,
    toggleOnline, forceSync, refreshPendingOpsCount,
  } = useDeviceStore();
  const { rewards, loadRewards, startSession, completeSession, failSession } = useFocusStore();
  const { tasks, loadTasks, updateTaskStatus, deleteTask } = useSyllabusStore();

  const [vectorClock, setVectorClock] = useState<Record<string, number>>({});
  const [taskStates, setTaskStates] = useState<TaskStateRow[]>([]);
  const [sinkLog, setSinkLog] = useState<SinkLogEntry[]>([]);
  const [sinkLogError, setSinkLogError] = useState<string | null>(null);
  const [scenarioStatus, setScenarioStatus] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([loadRewards(), refreshPendingOpsCount(), loadTasks()]);
      const vc = await getVectorClock();
      setVectorClock(vc);

      const db = getDb();
      const rows = await db.getAllAsync<TaskStateRow>(
        `SELECT task_id, status, lamport_clock, device_id, synced, deleted_at_clock
         FROM task_states WHERE student_id = ? ORDER BY task_id`,
        [STUDENT_ID]
      );
      setTaskStates(rows);

      try {
        const resp = await fetch(`${SERVER_URL}/api/notifications/sink-log`);
        if (resp.ok) {
          setSinkLog(await resp.json());
          setSinkLogError(null);
        } else {
          setSinkLogError(`Server returned ${resp.status}`);
        }
      } catch {
        setSinkLogError('Server unreachable');
      }
    } finally {
      setIsRefreshing(false);
    }
  }, [loadRewards, refreshPendingOpsCount, loadTasks]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [refresh]);

  // ── Scenarios ────────────────────────────────────────────────────────────

  async function scenarioCompleteSession() {
    setScenarioStatus('Starting 1-min session…');
    try {
      await startSession(60);
      const db = getDb();
      const active = await db.getFirstAsync<{ id: string }>(
        `SELECT id FROM sessions WHERE student_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1`,
        [STUDENT_ID]
      );
      if (active) {
        await db.runAsync(`UPDATE sessions SET actual_duration = 60 WHERE id = ?`, [active.id]);
      }
      await completeSession();
      setScenarioStatus('Completed. Syncing…');
      if (isOnline) { await forceSync(); }
      await refresh();
      setScenarioStatus('Done: 1-min session completed' + (isOnline ? ' & synced.' : ' (offline, sync later).'));
    } catch (e) { setScenarioStatus(`Error: ${String(e)}`); }
  }

  async function scenarioFailSession() {
    setScenarioStatus('Starting session to fail…');
    try {
      await startSession(120);
      await failSession('give_up');
      setScenarioStatus('Failed. Syncing…');
      if (isOnline) { await forceSync(); }
      await refresh();
      setScenarioStatus('Done: session failed (give_up)' + (isOnline ? ' & synced.' : ' (offline).'));
    } catch (e) { setScenarioStatus(`Error: ${String(e)}`); }
  }

  async function scenarioToggleFirstTask() {
    const active = tasks.filter((t) => t.deletedAtClock == null);
    if (active.length === 0) { setScenarioStatus('No active tasks.'); return; }
    const t = active[0];
    const next =
      t.status === 'not_started' ? 'in_progress' as const
      : t.status === 'in_progress' ? 'done' as const
      : 'not_started' as const;
    setScenarioStatus(`Toggling ${t.taskId.slice(-8)} → ${next}…`);
    await updateTaskStatus(t.taskId, next);
    await refresh();
    setScenarioStatus(`Done: ${t.taskId.slice(-8)} → ${next}.`);
  }

  async function scenarioDeleteFirstTask() {
    const active = tasks.filter((t) => t.deletedAtClock == null);
    if (active.length === 0) { setScenarioStatus('No tasks to delete.'); return; }
    const t = active[0];
    setScenarioStatus(`Deleting ${t.taskId.slice(-8)}…`);
    await deleteTask(t.taskId);
    await refresh();
    setScenarioStatus(`Tombstoned: ${t.taskId.slice(-8)}. Concurrent edits on other device will lose (delete-wins).`);
  }

  async function scenarioSimulateReply() {
    // Two-way reply loop: find the most recent completed session and send a 'done' reply
    // The server records it; it reconciles across devices like any other op.
    setScenarioStatus('Looking for last completed session…');
    try {
      const resp = await fetch(`${SERVER_URL}/api/sessions?studentId=${STUDENT_ID}`);
      if (!resp.ok) { setScenarioStatus('Could not fetch sessions.'); return; }
      const data = await resp.json() as { sessions: Array<{ id: string; status: string }> };
      const completed = data.sessions.find((s) => s.status === 'completed');
      if (!completed) { setScenarioStatus('No completed sessions found — complete one first.'); return; }
      const reply = await fetch(`${SERVER_URL}/api/notifications/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: completed.id, studentId: STUDENT_ID, action: 'done' }),
      });
      const result = await reply.json() as { ok: boolean; action: string };
      setScenarioStatus(`Reply sent: action=${result.action} for session …${completed.id.slice(-10)}. Both devices get this on next sync.`);
      await forceSync();
    } catch (e) { setScenarioStatus(`Error: ${String(e)}`); }
  }

  // ── Sync colour ───────────────────────────────────────────────────────────

  const syncColor =
    syncStatus === 'success' ? '#22C55E'
    : syncStatus === 'error' ? '#EF4444'
    : syncStatus === 'syncing' ? '#F97316'
    : '#9E9E9E';

  return (
    <ScrollView contentContainerStyle={styles.container}>

      {/* Identity & Network */}
      <Text style={styles.sectionTitle}>Identity & Network</Text>
      <View style={styles.card}>
        <Row label="Device ID" value={deviceId} accent />
        <Row label="Student" value={STUDENT_ID} />
        <Row label="Network" value={isOnline ? 'Online' : 'Offline (simulated)'} color={isOnline ? '#22C55E' : '#EF4444'} />
        <Row label="Sync status" value={syncStatus} color={syncColor} />
        {lastSyncedAt ? <Row label="Last synced" value={new Date(lastSyncedAt).toLocaleTimeString()} /> : null}
        <Row label="Pending ops" value={String(pendingOpsCount)} color={pendingOpsCount > 0 ? '#F97316' : '#22C55E'} />
        <View style={styles.btnRow}>
          <Btn
            label={isOnline ? 'Go Offline' : 'Go Online'}
            color={isOnline ? '#EF4444' : '#22C55E'}
            onPress={async () => { toggleOnline(); setTimeout(refresh, 300); }}
          />
          <Btn
            label="Force Sync"
            color="#6C63FF"
            disabled={!isOnline}
            onPress={async () => { await forceSync(); await refresh(); }}
          />
          <Btn label="Refresh" color="#64748B" onPress={refresh} />
        </View>
        {isRefreshing ? <ActivityIndicator size="small" color="#6C63FF" style={{ marginTop: 8 }} /> : null}
      </View>

      {/* Rewards */}
      <Text style={styles.sectionTitle}>Rewards (server-authoritative after sync)</Text>
      <View style={styles.card}>
        <Row label="Coins" value={String(rewards.coins)} bold />
        <Row label="Streak" value={`${rewards.focusStreak} day${rewards.focusStreak !== 1 ? 's' : ''}`} bold />
        <Row label="Today" value={`${rewards.todayFocusMinutes} min`} />
        <Row label="Last focus date" value={rewards.lastFocusDate ?? '—'} />
      </View>

      {/* Vector Clock */}
      <Text style={styles.sectionTitle}>Vector Clock</Text>
      <View style={styles.card}>
        {Object.keys(vectorClock).length === 0 ? (
          <Text style={styles.dimText}>Empty — no syncs yet</Text>
        ) : (
          Object.entries(vectorClock).map(([did, clock]) => (
            <Row key={did} label={`Device ${did}`} value={`L=${clock}`} mono />
          ))
        )}
      </View>

      {/* Task States Table */}
      <Text style={styles.sectionTitle}>Task States ({taskStates.length})</Text>
      <View style={styles.card}>
        {taskStates.length === 0 ? (
          <Text style={styles.dimText}>No task states yet</Text>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator>
            <View>
              <View style={styles.tableRow}>
                {['Task ID', 'Status', 'Lamport', 'Device', 'Synced', 'Deleted@L'].map((h) => (
                  <Text key={h} style={[styles.tableCell, styles.tableHeader]}>{h}</Text>
                ))}
              </View>
              {taskStates.map((r) => (
                <View key={r.task_id} style={[styles.tableRow, r.deleted_at_clock != null ? styles.deletedRow : null]}>
                  <Text style={styles.tableCell}>{r.task_id.slice(-10)}</Text>
                  <Text style={[styles.tableCell, statusStyle(r.status)]}>{r.status}</Text>
                  <Text style={[styles.tableCell, styles.mono]}>{r.lamport_clock}</Text>
                  <Text style={[styles.tableCell, styles.mono]}>{r.device_id || '—'}</Text>
                  <Text style={[styles.tableCell, { color: r.synced ? '#22C55E' : '#F97316' }]}>
                    {r.synced ? 'yes' : 'no'}
                  </Text>
                  <Text style={[styles.tableCell, { color: r.deleted_at_clock != null ? '#EF4444' : '#9E9E9E' }]}>
                    {r.deleted_at_clock != null ? `L${r.deleted_at_clock}` : '—'}
                  </Text>
                </View>
              ))}
            </View>
          </ScrollView>
        )}
      </View>

      {/* n8n Sink Log */}
      <Text style={styles.sectionTitle}>n8n Notification Sink (proves exactly-once)</Text>
      <View style={styles.card}>
        {sinkLogError ? (
          <Text style={styles.dimText}>{sinkLogError}</Text>
        ) : sinkLog.length === 0 ? (
          <Text style={styles.dimText}>No notifications delivered yet</Text>
        ) : (
          sinkLog.slice().reverse().map((entry) => {
            let p: Record<string, unknown> = {};
            try { p = JSON.parse(entry.payload); } catch { /* ignore */ }
            return (
              <View key={entry.id} style={styles.logEntry}>
                <Text style={styles.logSession}>Session …{String(entry.session_id).slice(-12)}</Text>
                <Text style={styles.logDetail}>
                  Streak {String(p.streak ?? '?')} · +50 coins · {String(p.message ?? '')}
                </Text>
                <Text style={styles.logTime}>{new Date(entry.received_at).toLocaleTimeString()}</Text>
              </View>
            );
          })
        )}
      </View>

      {/* Scenario Buttons */}
      <Text style={styles.sectionTitle}>Demo Scenarios</Text>
      <View style={styles.card}>
        <Text style={styles.hint}>
          Open two tabs: ?device=A and ?device=B. Take one offline, perform conflicting changes, then sync both to see convergence.
        </Text>
        <View style={styles.scenarioBtns}>
          <Btn label="Complete 1-min Session" color="#22C55E" onPress={scenarioCompleteSession} />
          <Btn label="Fail Session (give_up)" color="#EF4444" onPress={scenarioFailSession} />
          <Btn label="Toggle First Active Task" color="#6C63FF" onPress={scenarioToggleFirstTask} />
          <Btn label="Delete First Task (tombstone)" color="#F97316" onPress={scenarioDeleteFirstTask} />
          <Btn label="↩ Simulate Reply (done)" color="#8B5CF6" onPress={scenarioSimulateReply} />
          <Btn
            label={isOnline ? 'Go Offline (stage conflict)' : 'Go Online + Sync'}
            color={isOnline ? '#94A3B8' : '#22C55E'}
            onPress={async () => {
              if (isOnline) {
                toggleOnline();
                setScenarioStatus('Offline. Perform edits above, then press Go Online + Sync.');
              } else {
                toggleOnline();
                await new Promise((r) => setTimeout(r, 200));
                await forceSync();
                await refresh();
                setScenarioStatus('Synced. Check task states above for convergence.');
              }
            }}
          />
        </View>
        {scenarioStatus !== '' ? (
          <Text style={styles.scenarioStatus}>{scenarioStatus}</Text>
        ) : null}
      </View>

      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────

function Row({
  label, value, bold, accent, mono, color,
}: {
  label: string; value: string;
  bold?: boolean; accent?: boolean; mono?: boolean; color?: string;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[
        styles.rowValue,
        bold ? styles.bold : null,
        accent ? styles.accent : null,
        mono ? styles.mono : null,
        color ? { color } : null,
      ]}>{value}</Text>
    </View>
  );
}

function Btn({
  label, color, onPress, disabled,
}: {
  label: string; color: string; onPress: () => void; disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      style={[styles.btn, { backgroundColor: color }, disabled ? styles.btnDisabled : null]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={styles.btnText}>{label}</Text>
    </TouchableOpacity>
  );
}

function statusStyle(status: string) {
  if (status === 'done') return { color: '#22C55E' };
  if (status === 'in_progress') return { color: '#F97316' };
  return { color: '#9E9E9E' };
}

const styles = StyleSheet.create({
  container: { padding: 16, backgroundColor: '#F8F7FF', flexGrow: 1 },
  sectionTitle: {
    fontSize: 11, fontWeight: '700', color: '#6C63FF',
    textTransform: 'uppercase', letterSpacing: 1,
    marginTop: 22, marginBottom: 8,
  },
  card: {
    backgroundColor: '#FFFFFF', borderRadius: 14, padding: 14,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 4, elevation: 2,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 5 },
  rowLabel: { fontSize: 13, color: '#6B7280' },
  rowValue: { fontSize: 13, color: '#1A1A2E' },
  bold: { fontWeight: '700' },
  accent: { color: '#6C63FF', fontWeight: '800', fontSize: 15 },
  mono: { fontFamily: 'monospace', fontSize: 12 },
  dimText: { fontSize: 13, color: '#9E9E9E', fontStyle: 'italic' },
  btnRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  btn: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8, marginBottom: 4 },
  btnDisabled: { opacity: 0.35 },
  btnText: { fontSize: 12, fontWeight: '700', color: '#FFFFFF' },
  tableRow: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: '#F0F0F0' },
  tableHeader: { fontWeight: '700', color: '#6C63FF', backgroundColor: '#F8F7FF' },
  tableCell: { width: 88, paddingVertical: 5, paddingHorizontal: 4, fontSize: 11, color: '#1A1A2E' },
  deletedRow: { backgroundColor: '#FFF5F5' },
  logEntry: { paddingVertical: 8, borderBottomWidth: 0.5, borderBottomColor: '#F0F0F0' },
  logSession: { fontSize: 12, fontWeight: '600', color: '#1A1A2E', fontFamily: 'monospace' },
  logDetail: { fontSize: 12, color: '#6B7280', marginTop: 1 },
  logTime: { fontSize: 11, color: '#9E9E9E', marginTop: 2 },
  hint: { fontSize: 12, color: '#6B7280', marginBottom: 12, lineHeight: 18 },
  scenarioBtns: { gap: 8 },
  scenarioStatus: {
    marginTop: 10, fontSize: 12, color: '#1A1A2E',
    backgroundColor: '#F0EEFF', padding: 10, borderRadius: 8, lineHeight: 18,
  },
});
