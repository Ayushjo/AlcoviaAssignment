import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useSyllabusStore } from '../stores/syllabusStore';
import { useDeviceStore } from '../stores/deviceStore';
import type { TaskStatus } from '../sync/types';
import type { TaskRow } from '../stores/syllabusStore';

// ─── Colours per subject ──────────────────────────────────────────────────────
const SUBJECT_COLORS: Record<string, { primary: string; bg: string; light: string }> = {
  'subj-math': { primary: '#3B82F6', bg: '#EFF6FF', light: '#DBEAFE' },
  'subj-sci':  { primary: '#10B981', bg: '#ECFDF5', light: '#D1FAE5' },
  'subj-eng':  { primary: '#8B5CF6', bg: '#F5F3FF', light: '#EDE9FE' },
};
const FALLBACK_COLOR = { primary: '#6C63FF', bg: '#F0EEFF', light: '#E8E4FF' };

// ─── Status helpers ───────────────────────────────────────────────────────────
const STATUS_ORDER: TaskStatus[] = ['not_started', 'in_progress', 'done'];

function nextStatus(current: TaskStatus): TaskStatus {
  const idx = STATUS_ORDER.indexOf(current);
  return STATUS_ORDER[(idx + 1) % STATUS_ORDER.length];
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  not_started: 'Not Started',
  in_progress: 'In Progress',
  done: 'Done',
};

const STATUS_COLORS: Record<TaskStatus, { text: string; bg: string; border: string }> = {
  not_started: { text: '#9E9E9E', bg: '#F5F5F5', border: '#E0E0E0' },
  in_progress: { text: '#F97316', bg: '#FFF7ED', border: '#FED7AA' },
  done:        { text: '#22C55E', bg: '#F0FDF4', border: '#BBF7D0' },
};

// ─── Task row ─────────────────────────────────────────────────────────────────
function TaskItem({
  task,
  onToggle,
}: {
  task: TaskRow;
  onToggle: (taskId: string, next: TaskStatus) => void;
}) {
  const sc = STATUS_COLORS[task.status];
  const next = nextStatus(task.status);

  return (
    <View style={taskStyles.row}>
      <View style={taskStyles.left}>
        <Text style={taskStyles.title}>{task.title}</Text>
        {!task.synced && (
          <Text style={taskStyles.pendingDot}>● pending sync</Text>
        )}
      </View>
      <TouchableOpacity
        style={[
          taskStyles.badge,
          { backgroundColor: sc.bg, borderColor: sc.border },
        ]}
        onPress={() => onToggle(task.taskId, next)}
        accessibilityLabel={`Status: ${STATUS_LABEL[task.status]}. Tap to change to ${STATUS_LABEL[next]}.`}
      >
        <Text style={[taskStyles.badgeText, { color: sc.text }]}>
          {task.status === 'done' ? '✓ ' : task.status === 'in_progress' ? '◐ ' : '○ '}
          {STATUS_LABEL[task.status]}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const taskStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  left: { flex: 1, marginRight: 10 },
  title: { fontSize: 13, color: '#374151', fontWeight: '500' },
  pendingDot: { fontSize: 10, color: '#F97316', marginTop: 2 },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
    minWidth: 100,
    alignItems: 'center',
  },
  badgeText: { fontSize: 11, fontWeight: '600' },
});

// ─── Chapter section ─────────────────────────────────────────────────────────
function ChapterSection({
  chapterId,
  chapterName,
  tasks,
  primaryColor,
  onToggle,
}: {
  chapterId: string;
  chapterName: string;
  tasks: TaskRow[];
  primaryColor: string;
  onToggle: (taskId: string, next: TaskStatus) => void;
}) {
  const done = tasks.filter((t) => t.status === 'done').length;
  const pct = tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0;

  return (
    <View style={chapterStyles.container}>
      <View style={chapterStyles.header}>
        <View style={chapterStyles.headerLeft}>
          <Text style={chapterStyles.name}>{chapterName}</Text>
          <Text style={chapterStyles.count}>
            {done}/{tasks.length} tasks
          </Text>
        </View>
        <Text style={[chapterStyles.pct, { color: primaryColor }]}>{pct}%</Text>
      </View>
      <View style={chapterStyles.progressBar}>
        <View
          style={[
            chapterStyles.progressFill,
            { width: `${pct}%` as `${number}%`, backgroundColor: primaryColor },
          ]}
        />
      </View>
      {tasks.map((task) => (
        <TaskItem key={task.taskId} task={task} onToggle={onToggle} />
      ))}
    </View>
  );
}

const chapterStyles = StyleSheet.create({
  container: {
    marginBottom: 8,
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  headerLeft: { flex: 1 },
  name: { fontSize: 13, fontWeight: '700', color: '#1F2937' },
  count: { fontSize: 11, color: '#9E9E9E', marginTop: 2 },
  pct: { fontSize: 16, fontWeight: '800' },
  progressBar: {
    height: 4,
    backgroundColor: '#F3F4F6',
    marginHorizontal: 14,
    marginBottom: 4,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', borderRadius: 2 },
});

// ─── Subject accordion ────────────────────────────────────────────────────────
function SubjectAccordion({
  subjectId,
  subjectName,
  percent,
  tasks,
  onToggle,
}: {
  subjectId: string;
  subjectName: string;
  percent: number;
  tasks: TaskRow[];
  onToggle: (taskId: string, next: TaskStatus) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const color = SUBJECT_COLORS[subjectId] ?? FALLBACK_COLOR;

  // Group tasks by chapter preserving definition order
  const chapterMap = new Map<string, { name: string; tasks: TaskRow[] }>();
  for (const task of tasks) {
    if (!chapterMap.has(task.chapterId)) {
      chapterMap.set(task.chapterId, { name: task.chapterName, tasks: [] });
    }
    chapterMap.get(task.chapterId)!.tasks.push(task);
  }

  const totalDone = tasks.filter((t) => t.status === 'done').length;

  return (
    <View style={[accordionStyles.card, { borderLeftColor: color.primary }]}>
      <TouchableOpacity
        style={[accordionStyles.header, { backgroundColor: color.bg }]}
        onPress={() => setExpanded((e) => !e)}
        activeOpacity={0.8}
      >
        <View style={accordionStyles.headerLeft}>
          <Text style={[accordionStyles.subjectName, { color: color.primary }]}>
            {subjectName}
          </Text>
          <Text style={accordionStyles.subjectMeta}>
            {totalDone}/{tasks.length} tasks done
          </Text>
        </View>
        <View style={accordionStyles.headerRight}>
          <View style={[accordionStyles.pctCircle, { backgroundColor: color.light }]}>
            <Text style={[accordionStyles.pctText, { color: color.primary }]}>{percent}%</Text>
          </View>
          <Text style={[accordionStyles.chevron, { color: color.primary }]}>
            {expanded ? '▲' : '▼'}
          </Text>
        </View>
      </TouchableOpacity>

      {/* Subject-level progress bar */}
      <View style={accordionStyles.progressBar}>
        <View
          style={[
            accordionStyles.progressFill,
            { width: `${percent}%` as `${number}%`, backgroundColor: color.primary },
          ]}
        />
      </View>

      {expanded && (
        <View style={[accordionStyles.body, { backgroundColor: color.bg }]}>
          {Array.from(chapterMap.entries()).map(([chapId, chapData]) => (
            <ChapterSection
              key={chapId}
              chapterId={chapId}
              chapterName={chapData.name}
              tasks={chapData.tasks}
              primaryColor={color.primary}
              onToggle={onToggle}
            />
          ))}
        </View>
      )}
    </View>
  );
}

const accordionStyles = StyleSheet.create({
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    marginBottom: 16,
    overflow: 'hidden',
    borderLeftWidth: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 6,
    elevation: 2,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  headerLeft: { flex: 1 },
  subjectName: { fontSize: 17, fontWeight: '800' },
  subjectMeta: { fontSize: 12, color: '#9E9E9E', marginTop: 2 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  pctCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pctText: { fontSize: 14, fontWeight: '800' },
  chevron: { fontSize: 12, fontWeight: '700' },
  progressBar: {
    height: 5,
    backgroundColor: '#F3F4F6',
    overflow: 'hidden',
  },
  progressFill: { height: '100%' },
  body: { padding: 12, gap: 8 },
});

// ─── Main screen ──────────────────────────────────────────────────────────────
export default function SyllabusScreen() {
  const { tasks, subjects, isLoading, loadTasks, updateTaskStatus } = useSyllabusStore();
  const { isOnline } = useDeviceStore();

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  const handleToggle = useCallback(
    (taskId: string, newStatus: TaskStatus) => {
      updateTaskStatus(taskId, newStatus);
    },
    [updateTaskStatus]
  );

  const totalTasks = tasks.length;
  const doneTasks = tasks.filter((t) => t.status === 'done').length;
  const pendingSync = tasks.filter((t) => !t.synced).length;
  const overallPct = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

  if (isLoading && tasks.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#6C63FF" />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
      {/* Header */}
      <View style={styles.headerRow}>
        <Text style={styles.screenTitle}>Syllabus</Text>
        <View style={[styles.onlineBadge, isOnline ? styles.online : styles.offline]}>
          <Text style={styles.onlineBadgeText}>{isOnline ? '● Online' : '● Offline'}</Text>
        </View>
      </View>

      {/* Overall summary card */}
      <View style={styles.summaryCard}>
        <View style={styles.summaryLeft}>
          <Text style={styles.summaryTitle}>Overall Progress</Text>
          <Text style={styles.summaryCount}>
            {doneTasks} / {totalTasks} tasks done
          </Text>
          {pendingSync > 0 && (
            <Text style={styles.pendingNote}>
              {pendingSync} change{pendingSync !== 1 ? 's' : ''} pending sync
            </Text>
          )}
        </View>
        <View style={styles.summaryRight}>
          <Text style={styles.summaryPct}>{overallPct}%</Text>
        </View>
      </View>

      {/* Overall progress bar */}
      <View style={styles.overallBar}>
        <View style={[styles.overallFill, { width: `${overallPct}%` as `${number}%` }]} />
      </View>

      {/* Subject accordions */}
      {subjects.map((subject) => {
        const subjectTasks = tasks.filter((t) => t.subjectId === subject.subjectId);
        return (
          <SubjectAccordion
            key={subject.subjectId}
            subjectId={subject.subjectId}
            subjectName={subject.subjectName}
            percent={subject.percent}
            tasks={subjectTasks}
            onToggle={handleToggle}
          />
        );
      })}

      <View style={styles.bottomPad} />
    </ScrollView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    padding: 16,
    backgroundColor: '#F8F7FF',
    flexGrow: 1,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  screenTitle: { fontSize: 22, fontWeight: '800', color: '#1A1A2E' },
  onlineBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  online: { backgroundColor: '#DCFCE7' },
  offline: { backgroundColor: '#FEE2E2' },
  onlineBadgeText: { fontSize: 12, fontWeight: '600', color: '#1A1A2E' },

  summaryCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 6,
    elevation: 2,
  },
  summaryLeft: { flex: 1 },
  summaryTitle: { fontSize: 15, fontWeight: '700', color: '#1A1A2E' },
  summaryCount: { fontSize: 13, color: '#6B7280', marginTop: 2 },
  pendingNote: { fontSize: 11, color: '#F97316', marginTop: 4 },
  summaryRight: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#F0EEFF',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 12,
  },
  summaryPct: { fontSize: 20, fontWeight: '800', color: '#6C63FF' },

  overallBar: {
    height: 6,
    backgroundColor: '#E8E4FF',
    borderRadius: 3,
    overflow: 'hidden',
    marginBottom: 20,
  },
  overallFill: { height: '100%', backgroundColor: '#6C63FF', borderRadius: 3 },
  bottomPad: { height: 24 },
});
