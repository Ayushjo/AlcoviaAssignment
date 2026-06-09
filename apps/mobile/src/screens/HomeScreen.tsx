import React, { useEffect } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { useFocusStore } from '../stores/focusStore';
import { useDeviceStore } from '../stores/deviceStore';

export default function HomeScreen() {
  const { rewards, loadRewards } = useFocusStore();
  const { deviceId, isOnline, syncStatus, pendingOpsCount, forceSync, refreshPendingOpsCount } =
    useDeviceStore();

  useEffect(() => {
    loadRewards();
    refreshPendingOpsCount();
  }, [loadRewards, refreshPendingOpsCount]);

  const syncColor =
    syncStatus === 'success'
      ? '#22C55E'
      : syncStatus === 'error'
      ? '#EF4444'
      : syncStatus === 'syncing'
      ? '#F97316'
      : '#9E9E9E';

  const syncLabel =
    syncStatus === 'syncing'
      ? 'Syncing…'
      : syncStatus === 'success'
      ? 'Synced'
      : syncStatus === 'error'
      ? 'Sync error'
      : 'Not synced';

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {/* Device identity banner */}
      <View style={styles.deviceBanner}>
        <View style={styles.deviceBadge}>
          <Text style={styles.deviceBadgeLabel}>Device</Text>
          <Text style={styles.deviceBadgeId}>{deviceId}</Text>
        </View>
        <View style={[styles.statusBadge, isOnline ? styles.onlineBg : styles.offlineBg]}>
          <Text style={styles.statusDot}>{isOnline ? '●' : '○'}</Text>
          <Text style={styles.statusText}>{isOnline ? 'Online' : 'Offline'}</Text>
        </View>
      </View>

      {/* Rewards grid */}
      <Text style={styles.sectionTitle}>Your Progress</Text>
      <View style={styles.rewardGrid}>
        <View style={[styles.rewardCard, styles.coinsCard]}>
          <Text style={styles.rewardIcon}>🪙</Text>
          <Text style={styles.rewardValue}>{rewards.coins}</Text>
          <Text style={styles.rewardLabel}>Total Coins</Text>
        </View>
        <View style={[styles.rewardCard, styles.streakCard]}>
          <Text style={styles.rewardIcon}>🔥</Text>
          <Text style={styles.rewardValue}>{rewards.focusStreak}</Text>
          <Text style={styles.rewardLabel}>Day Streak</Text>
        </View>
        <View style={[styles.rewardCard, styles.minutesCard]}>
          <Text style={styles.rewardIcon}>⏱️</Text>
          <Text style={styles.rewardValue}>{rewards.todayFocusMinutes}</Text>
          <Text style={styles.rewardLabel}>Min Today</Text>
        </View>
      </View>

      {/* Sync status card */}
      <View style={styles.syncCard}>
        <View style={styles.syncRow}>
          <Text style={styles.syncCardLabel}>Sync Status</Text>
          <Text style={[styles.syncStatus, { color: syncColor }]}>{syncLabel}</Text>
        </View>
        {pendingOpsCount > 0 && (
          <Text style={styles.pendingText}>
            {pendingOpsCount} op{pendingOpsCount !== 1 ? 's' : ''} pending
          </Text>
        )}
        {isOnline && (
          <TouchableOpacity style={styles.syncBtn} onPress={forceSync}>
            <Text style={styles.syncBtnText}>Force Sync</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Info */}
      <View style={styles.infoCard}>
        <Text style={styles.infoTitle}>How it works</Text>
        <Text style={styles.infoLine}>• Start a focus session in the Focus tab</Text>
        <Text style={styles.infoLine}>• Mark study tasks done in the Syllabus tab</Text>
        <Text style={styles.infoLine}>• All changes save offline instantly</Text>
        <Text style={styles.infoLine}>• Two devices sync to the same state when online</Text>
        <Text style={styles.infoLine}>• Use Dev Panel to test offline scenarios</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 20,
    backgroundColor: '#F8F7FF',
    flexGrow: 1,
  },
  deviceBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 24,
  },
  deviceBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  deviceBadgeLabel: { fontSize: 12, color: '#9E9E9E', fontWeight: '600' },
  deviceBadgeId: { fontSize: 16, fontWeight: '800', color: '#6C63FF' },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  onlineBg: { backgroundColor: '#DCFCE7' },
  offlineBg: { backgroundColor: '#FEE2E2' },
  statusDot: { fontSize: 10 },
  statusText: { fontSize: 13, fontWeight: '600', color: '#1A1A2E' },

  sectionTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#1A1A2E',
    marginBottom: 14,
  },
  rewardGrid: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 24,
  },
  rewardCard: {
    flex: 1,
    borderRadius: 14,
    padding: 14,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 6,
    elevation: 2,
  },
  coinsCard: { backgroundColor: '#FFFBEB' },
  streakCard: { backgroundColor: '#FFF5F5' },
  minutesCard: { backgroundColor: '#F0EEFF' },
  rewardIcon: { fontSize: 22, marginBottom: 4 },
  rewardValue: { fontSize: 26, fontWeight: '800', color: '#1A1A2E' },
  rewardLabel: { fontSize: 10, color: '#9E9E9E', marginTop: 2, textAlign: 'center' },

  syncCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  syncRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  syncCardLabel: { fontSize: 14, fontWeight: '600', color: '#1A1A2E' },
  syncStatus: { fontSize: 13, fontWeight: '600' },
  pendingText: { fontSize: 12, color: '#F97316', marginBottom: 10 },
  syncBtn: {
    backgroundColor: '#6C63FF',
    paddingVertical: 8,
    paddingHorizontal: 18,
    borderRadius: 8,
    alignSelf: 'flex-start',
    marginTop: 4,
  },
  syncBtnText: { fontSize: 13, fontWeight: '600', color: '#FFFFFF' },

  infoCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    gap: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  infoTitle: { fontSize: 14, fontWeight: '700', color: '#1A1A2E', marginBottom: 4 },
  infoLine: { fontSize: 13, color: '#6B7280', lineHeight: 20 },
});
