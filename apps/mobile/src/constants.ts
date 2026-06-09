import { Platform } from 'react-native';

// Single hardcoded student for this assignment
export const STUDENT_ID = 'student-001';

// Each browser tab gets its own device ID via URL param ?device=A or ?device=B
// Falls back to 'A' on native
export function getDeviceId(): string {
  if (Platform.OS === 'web') {
    const params = new URLSearchParams(window.location.search);
    return params.get('device') ?? 'A';
  }
  return 'A';
}

export const SERVER_URL = 'http://localhost:3001';
