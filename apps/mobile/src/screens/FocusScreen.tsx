import React, { useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Platform,
  AppState,
  type AppStateStatus,
} from 'react-native';
import { useFocusStore } from '../stores/focusStore';
import { useDeviceStore } from '../stores/deviceStore';

const DURATION_OPTIONS = [
  { label: '25 min', value: 25 * 60 },
  { label: '45 min', value: 45 * 60 },
  { label: '60 min', value: 60 * 60 },
  { label: '90 min', value: 90 * 60 },
  { label: '120 min', value: 120 * 60 },
];

const BACKGROUND_GRACE_MS = 5000;

// ─── Ring countdown ───────────────────────────────────────────────────────────
// Works on web via inline SVG. Falls back to a plain text display on native.
function RingCountdown({ elapsed, total }: { elapsed: number; total: number }) {
  const remaining = Math.max(total - elapsed, 0);
  const progress = elapsed / total;
  const R = 90;
  const C = 2 * Math.PI * R;
  const offset = C * (1 - progress);

  const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
  const ss = String(remaining % 60).padStart(2, '0');

  if (Platform.OS === 'web') {
    return (
      <View style={styles.ringWrapper}>
        {/* @ts-ignore — SVG is valid in web runtime */}
        <svg width="220" height="220" viewBox="0 0 220 220">
          {/* @ts-ignore */}
          <circle cx="110" cy="110" r={R} fill="none" stroke="#E8E4FF" strokeWidth="14" />
          {/* @ts-ignore */}
          <circle
            cx="110"
            cy="110"
            r={R}
            fill="none"
            stroke="#6C63FF"
            strokeWidth="14"
            strokeDasharray={`${C}`}
            strokeDashoffset={`${offset}`}
            strokeLinecap="round"
            transform="rotate(-90 110 110)"
          />
        </svg>
        <View style={styles.ringCenter}>
          <Text style={styles.countdownText}>
            {mm}:{ss}
          </Text>
          <Text style={styles.countdownLabel}>remaining</Text>
        </View>
      </View>
    );
  }

  // Native fallback
  return (
    <View style={styles.nativeRing}>
      <Text style={styles.countdownText}>{mm}:{ss}</Text>
      <Text style={styles.countdownLabel}>remaining</Text>
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────
export default function FocusScreen() {
  const {
    phase,
    activeSession,
    rewards,
    lastResult,
    failReason,
    startSession,
    tickElapsed,
    persistElapsed,
    completeSession,
    failSession,
    resetToIdle,
    loadRewards,
  } = useFocusStore();

  const { isOnline, syncStatus } = useDeviceStore();

  const selectedDuration = useRef(DURATION_OPTIONS[0].value); // default 25 min
  const [selectedIndex, setSelectedIndex] = React.useState(0);

  // Track when the app was last hidden (for background detection)
  const hiddenAtRef = useRef<number | null>(null);
  // Track elapsed at last 5s persist tick
  const lastPersistRef = useRef(0);

  // Load rewards on mount
  useEffect(() => {
    loadRewards();
  }, [loadRewards]);

  // ── 1s countdown tick ──────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'running') return;

    const interval = setInterval(() => {
      const session = useFocusStore.getState().activeSession;
      if (!session) return;

      const newElapsed = session.elapsed + 1;

      // Persist to SQLite every 5 seconds
      if (newElapsed - lastPersistRef.current >= 5) {
        lastPersistRef.current = newElapsed;
        persistElapsed();
      }

      // Session complete
      if (newElapsed >= session.targetDuration) {
        clearInterval(interval);
        completeSession();
        return;
      }

      tickElapsed();
    }, 1000);

    return () => clearInterval(interval);
  }, [phase, tickElapsed, persistElapsed, completeSession]);

  // ── Background detection ───────────────────────────────────────────────────
  const handleSessionFail = useCallback(() => {
    if (useFocusStore.getState().phase === 'running') {
      failSession('app_switch');
    }
  }, [failSession]);

  useEffect(() => {
    if (phase !== 'running') return;

    if (Platform.OS === 'web') {
      // Web: visibilitychange API
      const onVisibility = () => {
        if (typeof document === 'undefined') return;
        if (document.hidden) {
          hiddenAtRef.current = Date.now();
        } else {
          hiddenAtRef.current = null;
        }
      };

      const graceCheck = setInterval(() => {
        if (hiddenAtRef.current && Date.now() - hiddenAtRef.current > BACKGROUND_GRACE_MS) {
          handleSessionFail();
        }
      }, 500);

      document.addEventListener('visibilitychange', onVisibility);
      return () => {
        document.removeEventListener('visibilitychange', onVisibility);
        clearInterval(graceCheck);
        hiddenAtRef.current = null;
      };
    } else {
      // Native: AppState API
      const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
        if (state === 'background' || state === 'inactive') {
          hiddenAtRef.current = Date.now();
        } else if (state === 'active') {
          if (hiddenAtRef.current && Date.now() - hiddenAtRef.current > BACKGROUND_GRACE_MS) {
            handleSessionFail();
          }
          hiddenAtRef.current = null;
        }
      });
      return () => sub.remove();
    }
  }, [phase, handleSessionFail]);

  // ── Render phases ─────────────────────────────────────────────────────────

  if (phase === 'idle') {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.header}>
          <Text style={styles.screenTitle}>Focus Session</Text>
          <View style={[styles.onlineBadge, isOnline ? styles.online : styles.offline]}>
            <Text style={styles.onlineBadgeText}>{isOnline ? '● Online' : '● Offline'}</Text>
          </View>
        </View>

        {/* Current rewards summary */}
        <View style={styles.rewardRow}>
          <View style={styles.rewardCard}>
            <Text style={styles.rewardValue}>{rewards.coins}</Text>
            <Text style={styles.rewardLabel}>Coins</Text>
          </View>
          <View style={styles.rewardCard}>
            <Text style={styles.rewardValue}>{rewards.focusStreak}</Text>
            <Text style={styles.rewardLabel}>Day Streak</Text>
          </View>
          <View style={styles.rewardCard}>
            <Text style={styles.rewardValue}>{rewards.todayFocusMinutes}</Text>
            <Text style={styles.rewardLabel}>Min Today</Text>
          </View>
        </View>

        <Text style={styles.sectionLabel}>Choose duration</Text>

        {/* Duration chips */}
        <View style={styles.chipRow}>
          {DURATION_OPTIONS.map((opt, i) => (
            <TouchableOpacity
              key={opt.value}
              style={[styles.chip, selectedIndex === i && styles.chipSelected]}
              onPress={() => {
                setSelectedIndex(i);
                selectedDuration.current = opt.value;
              }}
            >
              <Text style={[styles.chipText, selectedIndex === i && styles.chipTextSelected]}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <TouchableOpacity
          style={styles.startBtn}
          onPress={() => startSession(selectedDuration.current)}
        >
          <Text style={styles.startBtnText}>Start Session</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  if (phase === 'running' && activeSession) {
    const progress = activeSession.elapsed / activeSession.targetDuration;
    const pct = Math.min(Math.round(progress * 100), 100);
    const elapsedMm = String(Math.floor(activeSession.elapsed / 60)).padStart(2, '0');
    const elapsedSs = String(activeSession.elapsed % 60).padStart(2, '0');

    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.screenTitle}>Stay Focused</Text>
          <View style={[styles.onlineBadge, isOnline ? styles.online : styles.offline]}>
            <Text style={styles.onlineBadgeText}>{isOnline ? '● Online' : '● Offline'}</Text>
          </View>
        </View>

        <RingCountdown elapsed={activeSession.elapsed} total={activeSession.targetDuration} />

        <Text style={styles.elapsedText}>
          Elapsed: {elapsedMm}:{elapsedSs} &nbsp;·&nbsp; {pct}%
        </Text>

        <Text style={styles.motivationText}>Keep going — you've got this!</Text>

        <TouchableOpacity
          style={styles.giveUpBtn}
          onPress={() => failSession('give_up')}
        >
          <Text style={styles.giveUpBtnText}>Give Up</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (phase === 'success' && lastResult) {
    return (
      <View style={styles.container}>
        <View style={styles.resultCard}>
          <Text style={styles.resultIcon}>🎉</Text>
          <Text style={styles.resultTitle}>Session Complete!</Text>
          <Text style={styles.resultSubtitle}>
            You earned:
          </Text>

          <View style={styles.resultStats}>
            <View style={styles.resultStat}>
              <Text style={styles.resultStatValue}>+{lastResult.coinsEarned}</Text>
              <Text style={styles.resultStatLabel}>Coins</Text>
            </View>
            <View style={styles.resultStat}>
              <Text style={styles.resultStatValue}>{lastResult.newStreak}</Text>
              <Text style={styles.resultStatLabel}>Day Streak</Text>
            </View>
            <View style={styles.resultStat}>
              <Text style={styles.resultStatValue}>{lastResult.todayMinutes}</Text>
              <Text style={styles.resultStatLabel}>Min Today</Text>
            </View>
          </View>

          {!isOnline && (
            <Text style={styles.offlineNote}>
              Saved offline — will sync when you reconnect.
            </Text>
          )}
          {isOnline && syncStatus === 'syncing' && (
            <Text style={styles.syncNote}>Syncing…</Text>
          )}
          {isOnline && syncStatus === 'success' && (
            <Text style={styles.syncNote}>✓ Synced</Text>
          )}

          <TouchableOpacity style={styles.doneBtn} onPress={resetToIdle}>
            <Text style={styles.doneBtnText}>Done</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (phase === 'failed') {
    const reason =
      failReason === 'give_up' ? 'You gave up this session.' : 'App went to background.';
    return (
      <View style={styles.container}>
        <View style={[styles.resultCard, styles.failCard]}>
          <Text style={styles.resultIcon}>😔</Text>
          <Text style={[styles.resultTitle, styles.failTitle]}>Session Ended</Text>
          <Text style={styles.failReason}>{reason}</Text>
          <Text style={styles.failSubtext}>No rewards earned — try again!</Text>

          {!isOnline && (
            <Text style={styles.offlineNote}>
              Result saved offline — will sync when you reconnect.
            </Text>
          )}

          <TouchableOpacity style={styles.startBtn} onPress={resetToIdle}>
            <Text style={styles.startBtnText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return null;
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const C_PRIMARY = '#6C63FF';
const C_SUCCESS = '#22C55E';
const C_FAIL = '#EF4444';
const C_BG = '#F8F7FF';
const C_CARD = '#FFFFFF';
const C_TEXT = '#1A1A2E';
const C_MUTED = '#6B7280';

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: C_BG,
    alignItems: 'center',
    paddingTop: 24,
    paddingHorizontal: 20,
  },
  header: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  screenTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: C_TEXT,
  },
  onlineBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  online: { backgroundColor: '#DCFCE7' },
  offline: { backgroundColor: '#FEE2E2' },
  onlineBadgeText: { fontSize: 12, fontWeight: '600', color: C_TEXT },

  rewardRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 28,
    width: '100%',
  },
  rewardCard: {
    flex: 1,
    backgroundColor: C_CARD,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  rewardValue: { fontSize: 22, fontWeight: '700', color: C_PRIMARY },
  rewardLabel: { fontSize: 11, color: C_MUTED, marginTop: 2 },

  sectionLabel: {
    alignSelf: 'flex-start',
    fontSize: 13,
    fontWeight: '600',
    color: C_MUTED,
    marginBottom: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 32,
    width: '100%',
  },
  chip: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 20,
    backgroundColor: C_CARD,
    borderWidth: 1.5,
    borderColor: '#E0DCFF',
  },
  chipSelected: {
    backgroundColor: C_PRIMARY,
    borderColor: C_PRIMARY,
  },
  chipText: { fontSize: 14, fontWeight: '600', color: C_PRIMARY },
  chipTextSelected: { color: '#FFFFFF' },

  startBtn: {
    width: '100%',
    backgroundColor: C_PRIMARY,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    shadowColor: C_PRIMARY,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  startBtnText: { fontSize: 16, fontWeight: '700', color: '#FFFFFF' },

  // Running phase
  ringWrapper: {
    width: 220,
    height: 220,
    marginVertical: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringCenter: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  nativeRing: {
    width: 200,
    height: 200,
    borderRadius: 100,
    borderWidth: 12,
    borderColor: C_PRIMARY,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 20,
    backgroundColor: '#F0EEFF',
  },
  countdownText: { fontSize: 42, fontWeight: '800', color: C_TEXT },
  countdownLabel: { fontSize: 13, color: C_MUTED, marginTop: 2 },
  elapsedText: { fontSize: 14, color: C_MUTED, marginBottom: 8 },
  motivationText: { fontSize: 15, color: C_PRIMARY, fontWeight: '600', marginBottom: 28 },
  giveUpBtn: {
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: C_FAIL,
  },
  giveUpBtnText: { fontSize: 15, fontWeight: '600', color: C_FAIL },

  // Result phases
  resultCard: {
    width: '100%',
    backgroundColor: C_CARD,
    borderRadius: 20,
    padding: 28,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 4,
    marginTop: 20,
  },
  failCard: { borderTopWidth: 4, borderTopColor: C_FAIL },
  resultIcon: { fontSize: 52, marginBottom: 12 },
  resultTitle: { fontSize: 24, fontWeight: '800', color: C_TEXT, marginBottom: 6 },
  failTitle: { color: C_FAIL },
  resultSubtitle: { fontSize: 14, color: C_MUTED, marginBottom: 20 },

  resultStats: {
    flexDirection: 'row',
    gap: 16,
    marginBottom: 20,
    width: '100%',
    justifyContent: 'center',
  },
  resultStat: { alignItems: 'center', flex: 1 },
  resultStatValue: { fontSize: 28, fontWeight: '800', color: C_SUCCESS },
  resultStatLabel: { fontSize: 11, color: C_MUTED, marginTop: 2 },

  offlineNote: {
    fontSize: 12,
    color: '#F97316',
    textAlign: 'center',
    marginBottom: 16,
    backgroundColor: '#FFF7ED',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  syncNote: { fontSize: 12, color: C_SUCCESS, marginBottom: 16 },

  doneBtn: {
    width: '100%',
    backgroundColor: C_SUCCESS,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  doneBtnText: { fontSize: 15, fontWeight: '700', color: '#FFFFFF' },

  failReason: { fontSize: 16, color: C_FAIL, marginBottom: 6, fontWeight: '600' },
  failSubtext: { fontSize: 13, color: C_MUTED, marginBottom: 20 },
});
