import { create } from 'zustand';
import { getDeviceId } from '../constants';

interface DeviceStore {
  deviceId: string;
  isOnline: boolean;
  syncStatus: 'idle' | 'syncing' | 'error' | 'success';
  lastSyncedAt: string | null;
  pendingOpsCount: number;
  setOnline: (online: boolean) => void;
  toggleOnline: () => void;
  setSyncStatus: (status: DeviceStore['syncStatus']) => void;
  setPendingOpsCount: (count: number) => void;
  refreshPendingOpsCount: () => Promise<void>;
  forceSync: () => Promise<void>;
}

// Module-level flag read by the fetch interceptor below.
// Must live outside the Zustand store so it can be read synchronously inside fetch.
let _networkIsOnline = true;

// Patch the global fetch exactly once at module load time.
// Any call to fetch while _networkIsOnline = false throws immediately,
// simulating a fully offline device without touching the actual network stack.
const _originalFetch = global.fetch;
global.fetch = function interceptedFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  if (!_networkIsOnline) {
    return Promise.reject(
      new TypeError('Network request failed: device is offline (simulated)')
    );
  }
  return _originalFetch(input, init);
} as typeof fetch;

export const useDeviceStore = create<DeviceStore>((set, get) => ({
  deviceId: getDeviceId(),
  isOnline: true,
  syncStatus: 'idle',
  lastSyncedAt: null,
  pendingOpsCount: 0,

  setOnline: (online: boolean) => {
    _networkIsOnline = online;
    set({ isOnline: online });

    if (online) {
      // Auto-sync when coming back online
      get().forceSync();
    }
  },

  toggleOnline: () => {
    get().setOnline(!get().isOnline);
  },

  setSyncStatus: (status) => {
    set({ syncStatus: status });
    if (status === 'success') {
      set({ lastSyncedAt: new Date().toISOString() });
    }
  },

  setPendingOpsCount: (count) => set({ pendingOpsCount: count }),

  refreshPendingOpsCount: async () => {
    // Lazy import to avoid circular deps at module load time
    const { syncEngine } = await import('../sync/engine');
    const count = await syncEngine.getPendingOpsCount();
    set({ pendingOpsCount: count });
  },

  forceSync: async () => {
    const { setSyncStatus, refreshPendingOpsCount } = get();
    const { syncEngine } = await import('../sync/engine');

    setSyncStatus('syncing');
    try {
      await syncEngine.sync();
      setSyncStatus('success');
      await refreshPendingOpsCount();

      // Refresh stores that depend on server-canonical data
      const { useFocusStore } = await import('./focusStore');
      const { useSyllabusStore } = await import('./syllabusStore');
      await useFocusStore.getState().loadRewards();
      await useSyllabusStore.getState().refreshAfterSync();
    } catch (_err) {
      setSyncStatus('error');
    }
  },
}));
